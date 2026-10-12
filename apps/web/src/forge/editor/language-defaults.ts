import type * as Monaco from 'monaco-editor';

/**
 * TypeScript errors that only mean "that file is not loaded". Phase 1 gives Monaco one file at a
 * time; resolving imports across the project needs a batch-read route and is Phase 4 (D299
 * refinement 3). Until then these would fill Problems with false errors on every real project:
 * - 2307 Cannot find module 'x' or its corresponding type declarations;
 * - 2792 Cannot find module 'x'. Did you mean to set 'moduleResolution'…;
 * - 7016 Could not find a declaration file for module 'x';
 * - 7026 JSX element implicitly has type 'any' — React's JSX types are in the unloaded `react`;
 * - 2875 This JSX tag requires the module path 'react/jsx-runtime' to exist.
 */
export const IGNORED_TS_DIAGNOSTICS: readonly number[] = [2307, 2792, 7016, 7026, 2875];

/**
 * TypeScript 5's `moduleResolution: "bundler"`. Monaco 0.55's enum stops at NodeJs (2), but the
 * TypeScript 5.9 it bundles has it.
 */
const MODULE_RESOLUTION_BUNDLER: number = 100;

/**
 * Monaco's language services set for a real TS/React project (review I3), once, where Forge loads
 * Monaco. Every setting is merged into what is there already, never replacing it: the defaults are
 * global, and the config panel's JSON schema editor shares them.
 */
export function configureLanguageDefaults(
  monaco: Pick<typeof Monaco, 'typescript' | 'json'>,
): void {
  const { typescript, json } = monaco;
  for (const defaults of [typescript.typescriptDefaults, typescript.javascriptDefaults]) {
    defaults.setCompilerOptions({
      ...defaults.getCompilerOptions(),
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.ESNext,
      moduleResolution: MODULE_RESOLUTION_BUNDLER as Monaco.typescript.ModuleResolutionKind,
      jsx: typescript.JsxEmit.ReactJSX,
      allowJs: true,
      allowNonTsExtensions: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      strict: true,
      // N1: a parameter typed by a module Monaco has not loaded reads as implicit any (7006,
      // 7031). Strict stays on for everything else; cross-file types arrive in Phase 4.
      noImplicitAny: false,
      skipLibCheck: true,
    });
    const diagnostics = defaults.getDiagnosticsOptions();
    defaults.setDiagnosticsOptions({
      ...diagnostics,
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [
        ...new Set([...(diagnostics.diagnosticCodesToIgnore ?? []), ...IGNORED_TS_DIAGNOSTICS]),
      ],
    });
  }
  // `tsconfig.json`, `.jsonc` and VS Code's settings hold comments and trailing commas. Monaco's
  // default `comments: 'error'` overrides `allowComments`, so both are set.
  json.jsonDefaults.setDiagnosticsOptions({
    ...json.jsonDefaults.diagnosticsOptions,
    allowComments: true,
    comments: 'ignore',
    trailingCommas: 'ignore',
  });
}
