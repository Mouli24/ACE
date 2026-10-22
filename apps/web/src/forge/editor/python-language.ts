import type { LanguageRequest } from '@ace/contracts';
import type * as Monaco from 'monaco-editor';

import { api } from '../../app/api';
import { getModel, isRegistryModel, onRegistryChange, pathOfUri } from './models';

/*
 * Python IntelliSense in Forge, the way Pylance gives it in VS Code: completions (with auto-imports),
 * their docs, hover, parameter hints and problems, from the project's Pyright language server in
 * the engine (`POST /projects/:id/language/python`). Every question carries the file's text as it
 * is now, so unsaved edits count. Monaco answers TS/JS/CSS/HTML/JSON on its own.
 */

type MonacoApi = typeof Monaco;
type Model = Monaco.editor.ITextModel;

/* The LSP shapes this reads, as Pyright sends them. */
interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
type LspMarkup = string | { kind?: string; language?: string; value: string };
interface LspTextEdit {
  range: LspRange;
  newText: string;
}
interface LspCompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: LspMarkup;
  deprecated?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LspTextEdit | { newText: string; insert: LspRange; replace: LspRange };
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  command?: { title: string; command: string };
}
interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}
interface LspHover {
  contents: LspMarkup | LspMarkup[];
  range?: LspRange;
}
interface LspSignatureHelp {
  signatures: {
    label: string;
    documentation?: LspMarkup;
    parameters?: { label: string | [number, number]; documentation?: LspMarkup }[];
    activeParameter?: number;
  }[];
  activeSignature?: number;
  activeParameter?: number;
}
interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  codeDescription?: { href: string };
  source?: string;
  message: string;
  tags?: number[];
}

/** LSP's CompletionItemKind, 1-based, by the name Monaco's enum uses. */
const KINDS = [
  'Text',
  'Text',
  'Method',
  'Function',
  'Constructor',
  'Field',
  'Variable',
  'Class',
  'Interface',
  'Module',
  'Property',
  'Unit',
  'Value',
  'Enum',
  'Keyword',
  'Snippet',
  'Color',
  'File',
  'Reference',
  'Folder',
  'EnumMember',
  'Constant',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
] as const;

const OWNER = 'pyright';
/** After an error, a project's questions wait this long, so a missing server is not asked per key. */
const BACKOFF_MS = 30_000;
const DIAGNOSTICS_DELAY_MS = 400;

const resting = new Map<string, number>();
let registered = false;

/** The open Forge file a model is, when it is a Python one. */
function fileOf(model: Model): { projectId: string; path: string } | undefined {
  if (model.getLanguageId() !== 'python' || !isRegistryModel(model)) return undefined;
  return pathOfUri(model.uri);
}

function abortOn(token: Monaco.CancellationToken): AbortSignal {
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

/** One question to the engine; `undefined` when there is no answer (cancelled, failed, resting). */
async function ask<T>(
  projectId: string,
  request: LanguageRequest,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if ((resting.get(projectId) ?? 0) > Date.now()) return undefined;
  try {
    const { result } = await api().languageRequest(projectId, 'python', request, signal);
    return (result ?? undefined) as T | undefined;
  } catch (error) {
    if (signal?.aborted !== true) {
      resting.set(projectId, Date.now() + BACKOFF_MS);
      console.warn('[forge] Python IntelliSense is unavailable for now:', error);
    }
    return undefined;
  }
}

export function registerPythonLanguage(monaco: MonacoApi): void {
  if (registered) return;
  registered = true;

  const range = (r: LspRange): Monaco.IRange =>
    new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
  const position = (p: Monaco.Position): LspPosition => ({
    line: p.lineNumber - 1,
    character: p.column - 1,
  });
  const markdown = (doc: LspMarkup | undefined): Monaco.IMarkdownString | undefined => {
    if (doc === undefined) return undefined;
    if (typeof doc === 'string') return { value: doc };
    if (doc.language !== undefined) return { value: `\`\`\`${doc.language}\n${doc.value}\n\`\`\`` };
    return { value: doc.value };
  };
  const kind = (lsp: number | undefined): Monaco.languages.CompletionItemKind =>
    monaco.languages.CompletionItemKind[KINDS[lsp ?? 1] ?? 'Text'];

  /** Monaco's item for Pyright's, keeping the original for `completionItem/resolve`. */
  interface Suggestion extends Monaco.languages.CompletionItem {
    lsp: LspCompletionItem;
    projectId: string;
    path: string;
  }

  const fill = (
    target: Monaco.languages.CompletionItem,
    item: LspCompletionItem,
  ): Monaco.languages.CompletionItem => {
    const documentation = markdown(item.documentation);
    if (documentation !== undefined) target.documentation = documentation;
    if (item.detail !== undefined) target.detail = item.detail;
    if (item.additionalTextEdits !== undefined) {
      target.additionalTextEdits = item.additionalTextEdits.map((edit) => ({
        range: range(edit.range),
        text: edit.newText,
      }));
    }
    return target;
  };

  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '[', '"', "'"],
    async provideCompletionItems(model, at, context, token) {
      const file = fileOf(model);
      if (file === undefined) return undefined;
      const answer = await ask<LspCompletionList | LspCompletionItem[]>(
        file.projectId,
        {
          method: 'completion',
          path: file.path,
          text: model.getValue(),
          position: position(at),
          context: {
            triggerKind: context.triggerKind + 1,
            ...(context.triggerCharacter === undefined
              ? {}
              : { triggerCharacter: context.triggerCharacter }),
          },
        },
        abortOn(token),
      );
      if (answer === undefined) return undefined;
      const items = Array.isArray(answer) ? answer : answer.items;
      const word = model.getWordUntilPosition(at);
      const fallback = {
        insert: new monaco.Range(at.lineNumber, word.startColumn, at.lineNumber, at.column),
        replace: new monaco.Range(at.lineNumber, word.startColumn, at.lineNumber, word.endColumn),
      };
      const suggestions = items.map((item): Suggestion => {
        const edit = item.textEdit;
        const suggestion: Suggestion = {
          label:
            item.labelDetails === undefined
              ? item.label
              : { label: item.label, ...item.labelDetails },
          kind: kind(item.kind),
          insertText: edit?.newText ?? item.insertText ?? item.label,
          range:
            edit === undefined
              ? fallback
              : 'range' in edit
                ? range(edit.range)
                : { insert: range(edit.insert), replace: range(edit.replace) },
          lsp: item,
          projectId: file.projectId,
          path: file.path,
        };
        if (item.insertTextFormat === 2) {
          suggestion.insertTextRules =
            monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
        }
        if (item.sortText !== undefined) suggestion.sortText = item.sortText;
        if (item.filterText !== undefined) suggestion.filterText = item.filterText;
        if (item.commitCharacters !== undefined)
          suggestion.commitCharacters = item.commitCharacters;
        if (item.deprecated === true || item.tags?.includes(1) === true) {
          suggestion.tags = [monaco.languages.CompletionItemTag.Deprecated];
        }
        if (item.command !== undefined) {
          suggestion.command = { id: item.command.command, title: item.command.title };
        }
        fill(suggestion, item);
        return suggestion;
      });
      return { suggestions, incomplete: !Array.isArray(answer) && answer.isIncomplete };
    },
    async resolveCompletionItem(item, token) {
      const { lsp, projectId, path } = item as Suggestion;
      if (lsp === undefined || (lsp.documentation !== undefined && lsp.detail !== undefined)) {
        return item;
      }
      const resolved = await ask<LspCompletionItem>(
        projectId,
        { method: 'completionResolve', path, item: lsp },
        abortOn(token),
      );
      return resolved === undefined ? item : fill(item, resolved);
    },
  });

  monaco.languages.registerHoverProvider('python', {
    async provideHover(model, at, token) {
      const file = fileOf(model);
      if (file === undefined) return undefined;
      const hover = await ask<LspHover>(
        file.projectId,
        { method: 'hover', path: file.path, text: model.getValue(), position: position(at) },
        abortOn(token),
      );
      if (hover === undefined) return undefined;
      const contents = (Array.isArray(hover.contents) ? hover.contents : [hover.contents])
        .map(markdown)
        .filter((content): content is Monaco.IMarkdownString => content !== undefined);
      return hover.range === undefined ? { contents } : { contents, range: range(hover.range) };
    },
  });

  monaco.languages.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, at, token, context) {
      const file = fileOf(model);
      if (file === undefined) return undefined;
      const help = await ask<LspSignatureHelp>(
        file.projectId,
        {
          method: 'signatureHelp',
          path: file.path,
          text: model.getValue(),
          position: position(at),
          context: {
            triggerKind: context.triggerKind,
            isRetrigger: context.isRetrigger,
            ...(context.triggerCharacter === undefined
              ? {}
              : { triggerCharacter: context.triggerCharacter }),
          },
        },
        abortOn(token),
      );
      if (help === undefined || help.signatures.length === 0) return undefined;
      return {
        value: {
          activeSignature: help.activeSignature ?? 0,
          activeParameter: help.activeParameter ?? 0,
          signatures: help.signatures.map((signature) => {
            const documentation = markdown(signature.documentation);
            return {
              label: signature.label,
              ...(documentation === undefined ? {} : { documentation }),
              ...(signature.activeParameter === undefined
                ? {}
                : { activeParameter: signature.activeParameter }),
              parameters: (signature.parameters ?? []).map((parameter) => {
                const doc = markdown(parameter.documentation);
                return {
                  label: parameter.label,
                  ...(doc === undefined ? {} : { documentation: doc }),
                };
              }),
            };
          }),
        },
        dispose: () => undefined,
      };
    },
  });

  /* Problems: each open Python file is checked when it opens and shortly after every edit. */
  const severity = (lsp: number | undefined): Monaco.MarkerSeverity =>
    lsp === 1
      ? monaco.MarkerSeverity.Error
      : lsp === 2
        ? monaco.MarkerSeverity.Warning
        : lsp === 3
          ? monaco.MarkerSeverity.Info
          : monaco.MarkerSeverity.Hint;

  const check = async (model: Model): Promise<void> => {
    const file = fileOf(model);
    if (file === undefined) return;
    const version = model.getVersionId();
    const diagnostics = await ask<LspDiagnostic[]>(file.projectId, {
      method: 'diagnostics',
      path: file.path,
      text: model.getValue(),
    });
    // A newer edit has its own check coming; this answer is about older text.
    if (diagnostics === undefined || model.isDisposed() || model.getVersionId() !== version) return;
    monaco.editor.setModelMarkers(
      model,
      OWNER,
      diagnostics.map((diagnostic) => ({
        ...range(diagnostic.range),
        severity: severity(diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source ?? 'Pyright',
        ...(diagnostic.code === undefined
          ? {}
          : {
              code:
                diagnostic.codeDescription === undefined
                  ? String(diagnostic.code)
                  : {
                      value: String(diagnostic.code),
                      target: monaco.Uri.parse(diagnostic.codeDescription.href),
                    },
            }),
        ...(diagnostic.tags === undefined
          ? {}
          : { tags: diagnostic.tags.filter((tag) => tag === 1 || tag === 2) }),
      })),
    );
  };

  const watched = new WeakSet<Model>();
  const watch = (model: Model | undefined): void => {
    if (model === undefined || watched.has(model) || fileOf(model) === undefined) return;
    watched.add(model);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void check(model), DIAGNOSTICS_DELAY_MS);
    };
    model.onDidChangeContent(later);
    model.onWillDispose(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    void check(model);
  };

  onRegistryChange((projectId, path, open) => {
    // The registry says so before Monaco hands the model out, so look once the call is done.
    if (open) queueMicrotask(() => watch(getModel(projectId, path)));
  });
  for (const model of monaco.editor.getModels()) watch(model);
}
