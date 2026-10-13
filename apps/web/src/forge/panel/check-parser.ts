import type { ProblemSeverity } from './problems-store';

/** Which reader recognised a problem: `tsc`, eslint's stylish format, or the generic forms. */
export type CheckSource = 'tsc' | 'eslint' | 'check';

/** One diagnostic Run checks found in its output (design §6.4). */
export interface CheckProblem {
  /** Project-relative with forward slashes when it was under the root; otherwise as printed. */
  path: string;
  line: number;
  column: number;
  severity: ProblemSeverity;
  message: string;
  source: CheckSource;
  /** `TS2322`, an eslint rule. */
  code?: string;
}

const ESC = '\u001b';
const BEL = '\u0007';
/** OSC sequences (hyperlinks, titles) end in BEL or ST; CSI sequences are colours and cursor moves. */
const ANSI = new RegExp(
  `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]`,
  'g',
);

/** The output as a terminal would show it, without colour, cursor or hyperlink sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

const slashed = (path: string): string => path.replace(/\\/g, '/');
const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path);

/**
 * A printed path as Forge names files: under the project folder it becomes project-relative with
 * forward slashes (case-insensitively for a Windows root); a relative one loses its `./`; any
 * other — outside the root, or above it — is kept as printed, with forward slashes.
 */
export function toProjectPath(path: string, root: string): string {
  const given = slashed(path.trim());
  const base = slashed(root.trim()).replace(/\/+$/, '');
  if (isAbsolute(given)) {
    const windows = /^[A-Za-z]:\//.test(base);
    const fold = (text: string): string => (windows ? text.toLowerCase() : text);
    return base !== '' && fold(given).startsWith(`${fold(base)}/`)
      ? given.slice(base.length + 1)
      : given;
  }
  return given.replace(/^(\.\/)+/, '');
}

/**
 * Whether a captured path could be a file a tool printed, not prose: no leading space (a stack
 * frame), no parentheses, no URL; a space only inside an absolute path (`D:\ACE offcl\…`).
 */
function plausible(path: string): boolean {
  if (path === '' || /^\s/.test(path) || /[()<>|"]/.test(path) || path.includes('://')) {
    return false;
  }
  return !/\s/.test(path) || isAbsolute(slashed(path));
}

const SEVERITY: Readonly<Record<string, ProblemSeverity>> = {
  error: 'error',
  'fatal error': 'error',
  warning: 'warning',
  warn: 'warning',
  message: 'info',
  info: 'info',
  note: 'info',
  hint: 'info',
};
const severityOf = (word: string | undefined): ProblemSeverity =>
  SEVERITY[(word ?? 'error').toLowerCase()] ?? 'error';
const positive = (text: string | undefined): number => Math.max(1, Number(text ?? '1') || 1);

/** `path(line,col): error TS1234: message` — tsc's plain form. */
const TSC_CLASSIC = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
/** `path:line:col - error TS1234: message` — tsc's pretty form (`--pretty`, a TTY). */
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - (error|warning|message) (TS\d+): (.*)$/;
/** eslint stylish's row under its file header: `  line:col  error|warning  message  rule`. */
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)\s*$/;
const SEVERITY_WORDS = '(fatal error|error|warning|warn|info|note|hint)';
/** `path:line:col: (error|warning)?:? message`. */
const GENERIC_COLUMN = new RegExp(
  `^(.+?):(\\d+):(\\d+):?\\s+(?:${SEVERITY_WORDS}\\b:?\\s*)?(.*)$`,
  'i',
);
/** `path:line: message`. */
const GENERIC_LINE = new RegExp(`^(.+?):(\\d+):\\s+(?:${SEVERITY_WORDS}\\b:?\\s*)?(.*)$`, 'i');

/** A row's text and rule: eslint puts the rule last, two or more spaces after the message. */
function splitRule(rest: string): { message: string; code?: string } {
  const match = /^(.*\S)\s{2,}(\S+)$/.exec(rest);
  return match === null ? { message: rest } : { message: match[1] ?? rest, code: match[2] ?? '' };
}

/** What one line printed after a progress bar's carriage returns: its last non-empty state. */
const finalState = (line: string): string =>
  line
    .split('\r')
    .filter((part) => part !== '')
    .pop() ?? '';

/**
 * Run checks' output into problems (D299 Phase 4, design §6.4): tsc in both its forms (with the
 * chained message lines indented under a diagnostic), eslint's stylish format (a file header, then
 * its rows), and the generic `path:line:col: severity: message` and `path:line: message`. ANSI is
 * stripped first and paths become project-relative ({@link toProjectPath}). The same diagnostic
 * printed twice is read once. Pure, so the table of formats is its test.
 */
export function parseCheckOutput(output: string, root: string): CheckProblem[] {
  const problems: CheckProblem[] = [];
  const seen = new Set<string>();
  /** The last tsc diagnostic, while indented lines may still continue its message. */
  let continuing: CheckProblem | undefined;
  /** eslint stylish: the file the rows below belong to. */
  let header: string | undefined;

  const add = (problem: CheckProblem): void => {
    const key = `${problem.path}\u0000${problem.line}\u0000${problem.column}\u0000${problem.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(problem);
  };

  for (const raw of stripAnsi(output).split('\n')) {
    const line = finalState(raw).replace(/\s+$/, '');
    if (line.trim() === '') {
      continuing = undefined;
      continue;
    }

    const tsc = TSC_CLASSIC.exec(line) ?? TSC_PRETTY.exec(line);
    if (tsc !== null && plausible(tsc[1] ?? '')) {
      const problem: CheckProblem = {
        path: toProjectPath(tsc[1] ?? '', root),
        line: positive(tsc[2]),
        column: positive(tsc[3]),
        severity: severityOf(tsc[4]),
        message: tsc[6] ?? '',
        source: 'tsc',
        code: tsc[5] ?? '',
      };
      add(problem);
      continuing = problem;
      continue;
    }

    const row = ESLINT_ROW.exec(line);
    if (row !== null && header !== undefined) {
      continuing = undefined;
      add({
        path: toProjectPath(header, root),
        line: positive(row[1]),
        column: positive(row[2]),
        severity: severityOf(row[3]),
        source: 'eslint',
        ...splitRule(row[4] ?? ''),
      });
      continue;
    }

    if (/^\s{2,}\S/.test(line) && continuing !== undefined) {
      // Under the problem it was in, `seen` keeps its first message; the chain only adds to it.
      continuing.message = `${continuing.message}\n${line.trim()}`;
      continue;
    }
    continuing = undefined;

    const generic = GENERIC_COLUMN.exec(line) ?? GENERIC_LINE.exec(line);
    const column = generic?.length === 6;
    if (generic !== null && plausible(generic[1] ?? '')) {
      add({
        path: toProjectPath(generic[1] ?? '', root),
        line: positive(generic[2]),
        column: column ? positive(generic[3]) : 1,
        severity: severityOf(column ? generic[4] : generic[3]),
        message: (column ? generic[5] : generic[4]) ?? '',
        source: 'check',
      });
      continue;
    }

    // Anything else at the margin may be eslint stylish's header for the rows that follow.
    if (!/^\s/.test(line)) header = line.trim();
  }
  return problems;
}
