/**
 * Command classification for `run_command` approvals (FR-GRD-006, BR-14, D342).
 *
 * A prefix check on the raw string is not enough: `pnpm install && rm -rf ~` starts with
 * `pnpm install`. So a command line is split into segments, and every segment has to pass the
 * denylist and be covered by the node's allowlist before it may run without asking. Anything the
 * splitter cannot read confidently (substitution, `eval`, `bash -c`, heredocs, groups, unbalanced
 * quotes, a program read from stdin) is never auto-allowed. The agent shell is bash, with
 * PowerShell as a fallback (D376), so the splitter reads quoting as bash does and is not confident
 * about anything the two could read differently from it: `^`, `$'…'`, `#` comments, newlines inside
 * quotes, a backslash before a metacharacter.
 *
 * An allowlist entry names a program on the PATH, run as itself (D376). A segment that sets
 * environment variables first, runs a program by path, or redirects output to a file is something
 * else, so no entry covers it and it is never offered for Always allow; nor is a prefix that starts
 * with a wrapper or an interpreter (`sudo`, `node`, `bash`, …). Those still just ask.
 *
 * Pure: no I/O, no platform checks. Bash and PowerShell syntax are recognised well enough to fail
 * closed — when in doubt the result is "ask".
 */

export interface SplitResult {
  segments: string[];
  confident: boolean;
  reasons: string[];
}

export interface ClassifiedSegment {
  text: string;
  prefix?: string;
  /** Id of the first DENYLIST rule this segment matches. */
  denied?: string;
  /**
   * D376: why no allowlist entry can cover this segment — it sets environment variables first, runs
   * a program by path, or redirects output to a file. It still only asks; it is never auto-allowed
   * and never offered for Always allow.
   */
  uncoverable?: string;
  /** Covered by an allowlist entry, not denied and not uncoverable. */
  allowed: boolean;
}

export interface Classification {
  segments: ClassifiedSegment[];
  confident: boolean;
  reasons: string[];
  /** Ids of every DENYLIST rule the command matches, without duplicates. */
  denied: string[];
  autoAllowed: boolean;
  /** The one prefix "Always allow" would add; undefined → the UI hides "Always allow". */
  alwaysAllowPrefix?: string;
}

export interface DenyRule {
  id: string;
  description: string;
  /** `segment`: checked on every split segment. `line`: checked on the raw command line. */
  scope: "segment" | "line";
  matches: (text: string) => boolean;
}

type Separator = "&&" | "||" | "|" | ";" | "&" | "\n";

interface RawSegment {
  text: string;
  /** The separator that ended this segment; undefined for the last one. */
  sepAfter?: Separator;
}

/* -------------------------------------------------------------------------------------------- */
/* Splitting                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/** Characters a backslash escapes outside quotes (others stay literal so Windows paths survive). */
const BACKSLASH_ESCAPABLE = new Set([
  ";",
  "&",
  "|",
  "<",
  ">",
  "(",
  ")",
  "$",
  "`",
  '"',
  "'",
  "\\",
  " ",
  "\t",
  "\n",
]);

/**
 * D376: characters after a `\` that bash and PowerShell read differently — bash escapes them,
 * PowerShell keeps the `\` and acts on the character (a separator, a redirect, a quote, a newline).
 */
const SHELL_META = new Set([
  ";",
  "|",
  "&",
  ">",
  "<",
  "(",
  ")",
  "$",
  "`",
  '"',
  "'",
  "\n",
  "\r",
]);

/** D376: what may come right before a `#` that starts a comment — whitespace or an operator. */
const COMMENT_MAY_FOLLOW = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  ";",
  "&",
  "|",
  "(",
  ")",
  "<",
  ">",
]);

/* D376: the reasons a line is read without confidence because shells read it differently. */
const CARET = "caret ^ (bash reads it literally, cmd.exe as an escape)";
const DOLLAR_QUOTING = "$'…' or $\"…\" quoting";
const COMMENT = "# comment";
const NEWLINE_IN_QUOTES = "newline inside quotes";
const BACKSLASH_BEFORE_META =
  "backslash before a shell metacharacter (bash escapes it, PowerShell does not)";
const BACKSLASH_IN_DOUBLE_QUOTES =
  "backslash escape inside double quotes (bash escapes it, PowerShell does not)";

function splitRaw(command: string): {
  raw: RawSegment[];
  reasons: Set<string>;
} {
  const reasons = new Set<string>();
  const raw: RawSegment[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  const push = (sep?: Separator): void => {
    raw.push(
      sep === undefined
        ? { text: cur.trim() }
        : { text: cur.trim(), sepAfter: sep },
    );
    cur = "";
  };

  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    const next = command.charAt(i + 1);
    const prev = i > 0 ? command.charAt(i - 1) : "";

    if (inSingle) {
      if (c === "'") inSingle = false;
      else if (c === "\n" || c === "\r") reasons.add(NEWLINE_IN_QUOTES);
      cur += c;
      continue;
    }
    if (inDouble) {
      if (c === "\\" && '"\\$`'.includes(next) && next !== "") {
        // Bash escapes these inside double quotes; PowerShell keeps the `\` and reads the next
        // character as itself — a `"` that ends the string, a `$(` that runs (D376).
        if (next !== "\\") reasons.add(BACKSLASH_IN_DOUBLE_QUOTES);
        cur += c + next;
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      else if (c === "`" || (c === "$" && next === "("))
        reasons.add("command substitution");
      else if (c === "\n" || c === "\r") reasons.add(NEWLINE_IN_QUOTES);
      cur += c;
      continue;
    }

    // D376: bash escapes a metacharacter after `\`; PowerShell keeps the `\` and acts on it.
    if (c === "\\" && SHELL_META.has(next)) reasons.add(BACKSLASH_BEFORE_META);
    if (c === "\\" && BACKSLASH_ESCAPABLE.has(next)) {
      cur += c + next;
      i++;
      continue;
    }
    // D376: a caret is cmd.exe's escape, but the agent shell is bash, where it is an ordinary
    // character — `npm test ^; rm -rf ~` is two commands. Never read with confidence.
    if (c === "^") reasons.add(CARET);
    // D376: ANSI-C `$'…'` (where `\'` is a quote) and locale `$"…"` quoting.
    if (c === "$" && (next === "'" || next === '"'))
      reasons.add(DOLLAR_QUOTING);
    // D376: a `#` that starts a word starts a comment, which can hide an opening quote.
    if (c === "#" && (prev === "" || COMMENT_MAY_FOLLOW.has(prev)))
      reasons.add(COMMENT);
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === "`" || (c === "$" && next === "("))
      reasons.add("command substitution");
    else if (c === "(" || c === ")") {
      if (!(c === "(" && prev === "$")) reasons.add("subshell parentheses");
    } else if (c === "<" && next === "<") reasons.add("heredoc");
    else if (c === "\r" && next === "\n") continue;
    else if (c === "\n" || c === "\r") {
      push("\n");
      continue;
    } else if (c === ";") {
      push(";");
      continue;
    } else if (c === "|") {
      if (prev === ">") {
        cur += c; // `>|` clobber redirection
        continue;
      }
      if (next === "|") {
        push("||");
        i++;
        continue;
      }
      if (next === "&") i++; // `|&` pipes stderr too
      push("|");
      continue;
    } else if (c === "&") {
      if (next === "&") {
        push("&&");
        i++;
        continue;
      }
      if (prev === ">" || prev === "<" || next === ">") {
        cur += c; // `2>&1`, `<&3`, `&>file`
        continue;
      }
      push("&");
      continue;
    }
    cur += c;
  }
  if (inSingle || inDouble) reasons.add("unbalanced quote");
  push();
  return { raw, reasons };
}

function dropEmpty(raw: RawSegment[], reasons: Set<string>): RawSegment[] {
  const kept: RawSegment[] = [];
  raw.forEach((seg, i) => {
    if (seg.text !== "") {
      kept.push(seg);
      return;
    }
    const before = i > 0 ? raw[i - 1]?.sepAfter : undefined;
    const after = seg.sepAfter;
    const operatorBefore = before === "&&" || before === "||" || before === "|";
    const blank =
      !operatorBefore &&
      (after === undefined || after === "\n") &&
      // A trailing `;` or `&` leaves an empty last segment, which is fine.
      true;
    if (!blank) reasons.add("empty command between separators");
  });
  return kept;
}

/**
 * Splits a command line into segments on `&&`, `||`, `;`, `|`, `&` and newlines, respecting
 * quotes and backslash escapes as bash reads them. Redirections (`2>&1`, `&>f`, `>|`) are not
 * separators. Not confident (D376) wherever bash and PowerShell could read the line differently
 * from this: a caret, `$'…'` / `$"…"`, a `#` comment, a newline inside quotes, or a backslash
 * before a metacharacter.
 */
export function splitCommand(command: string): SplitResult {
  const { raw, reasons } = splitRaw(command);
  const kept = dropEmpty(raw, reasons);
  kept.forEach((seg, i) => {
    const pipedInto = i > 0 && kept[i - 1]?.sepAfter === "|";
    for (const r of segmentReasons(seg.text, pipedInto)) reasons.add(r);
  });
  return {
    segments: kept.map((s) => s.text),
    confident: reasons.size === 0,
    reasons: [...reasons],
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Words and programs                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** Whitespace-separated words with quotes removed. Backslashes stay literal (Windows paths). */
function tokenize(segment: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let quote: "" | '"' | "'" = "";
  for (const c of segment) {
    if (quote !== "") {
      if (c === quote) quote = "";
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur !== "") words.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (has || cur !== "") words.push(cur);
  return words;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `C:\x\npm.cmd` → `npm`; `/usr/bin/GIT` → `git`. */
function normalizeProgram(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

/** Words after leading `NAME=value` assignments, the first one normalized. */
function commandWords(segment: string): string[] {
  const words = tokenize(segment);
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i] ?? "")) i++;
  const rest = words.slice(i);
  const first = rest[0];
  if (first === undefined) return [];
  return [normalizeProgram(first), ...rest.slice(1)];
}

/** Wrappers that run another program; their own options are skipped to find it. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "time",
  "nice",
  "command",
  "exec",
  "builtin",
  "xargs",
  "timeout",
  "stdbuf",
]);

/** The program that actually runs (through sudo/env/nohup/...), and its arguments. */
function effective(segment: string): { program: string; args: string[] } {
  const words = commandWords(segment);
  let i = 0;
  while (i < words.length && WRAPPERS.has(normalizeProgram(words[i] ?? ""))) {
    const wrapper = normalizeProgram(words[i] ?? "");
    i++;
    while (i < words.length) {
      const w = words[i] ?? "";
      if (w.startsWith("-") || ASSIGNMENT.test(w)) i++;
      else if (
        (wrapper === "timeout" || wrapper === "nice") &&
        /^[\d.]+[smhd]?$/.test(w)
      )
        i++;
      else break;
    }
  }
  const program = words[i];
  if (program === undefined) return { program: "", args: [] };
  return { program: normalizeProgram(program), args: words.slice(i + 1) };
}

const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "ash",
  "busybox",
]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const INTERPRETERS = new Set([
  "node",
  "python",
  "python3",
  "py",
  "perl",
  "ruby",
  "deno",
  "bun",
]);
const STDIN_RUNNERS = new Set([
  ...SHELLS,
  ...POWERSHELLS,
  "cmd",
  "node",
  "python",
  "python3",
  "py",
  "perl",
  "ruby",
]);

function isPowerShellCommandFlag(arg: string): boolean {
  if (!/^[-/]/.test(arg)) return false;
  const a = arg.slice(1).toLowerCase();
  if (a === "") return false;
  return (
    "command".startsWith(a) ||
    "encodedcommand".startsWith(a) ||
    "commandwithargs".startsWith(a) ||
    a === "ec" ||
    a === "cwa"
  );
}

function segmentReasons(segment: string, pipedInto: boolean): string[] {
  const reasons: string[] = [];
  const words = tokenize(segment);
  if (words[0] === "{" || words[0] === "}" || words.includes("}"))
    reasons.push("{ …; } group");

  const { program, args } = effective(segment);
  if (program === "") return reasons;
  if (
    program === "eval" ||
    program === "iex" ||
    program === "invoke-expression"
  ) {
    reasons.push(`${program}: eval of a string`);
  }
  if (SHELLS.has(program) && args.some((a) => /^-[a-z]*c[a-z]*$/i.test(a))) {
    reasons.push(`${program} -c: shell runs a string`);
  }
  if (program === "cmd" && args.some((a) => /^\/[ck]$/i.test(a))) {
    reasons.push("cmd /c: shell runs a string");
  }
  if (POWERSHELLS.has(program) && args.some(isPowerShellCommandFlag)) {
    reasons.push(`${program} -Command: shell runs a string`);
  }
  if (INTERPRETERS.has(program)) {
    const inline =
      program === "python" || program === "python3" || program === "py"
        ? args.includes("-c")
        : program === "deno"
          ? args[0] === "eval"
          : args.some(
              (a) =>
                a === "-e" || a === "--eval" || a === "-p" || a === "--print",
            );
    if (inline) reasons.push(`${program}: inline code`);
  }
  if (
    STDIN_RUNNERS.has(program) &&
    !args.some((a) => !a.startsWith("-") && !a.startsWith("/"))
  ) {
    if (
      pipedInto ||
      SHELLS.has(program) ||
      POWERSHELLS.has(program) ||
      program === "cmd"
    ) {
      reasons.push(`${program} reads a program from stdin`);
    }
  }
  return reasons;
}

/* -------------------------------------------------------------------------------------------- */
/* Prefixes and the allowlist                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** Tools whose first argument is a subcommand worth keeping in the prefix (`git push`). */
const SUBCOMMAND_TOOLS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "npx",
  "pnpx",
  "bunx",
  "cargo",
  "go",
  "dotnet",
  "docker",
  "kubectl",
  "helm",
  "pip",
  "pip3",
  "poetry",
  "uv",
  "gh",
  "make",
  "rustup",
  "brew",
  "apt",
  "apt-get",
  "winget",
  "choco",
  "conda",
  "mvn",
  "gradle",
]);
/** For these, `<tool> run <script>` keeps the script name (`npm run build`). */
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUN_SUBCOMMANDS = new Set(["run", "run-script", "exec"]);
const SUBCOMMAND = /^[A-Za-z0-9@][\w:.@/+-]*$/;

/**
 * The approval prefix of one segment: the program (path and `.exe`/`.cmd`/`.bat` stripped,
 * lower-cased) plus its subcommand for tools that have them, after leading env assignments.
 *
 * - `git push origin main` → `git push`; `pnpm install x` → `pnpm install`; `npm test` → `npm test`
 * - `npm run build` / `pnpm run lint` / `yarn run dev` / `pnpm exec tsc` → keeps the script
 * - `python -m pytest` → `python -m pytest`
 * - `node file.js`, `ls -la` → `node`, `ls`; an option where the subcommand would be → just the tool
 * - `sudo pnpm install` → `sudo` (a wrapper is never folded into the tool it runs)
 */
export function commandPrefix(segment: string): string | undefined {
  const words = commandWords(segment);
  const program = words[0];
  if (program === undefined || program === "") return undefined;
  const sub = words[1];
  if (
    SUBCOMMAND_TOOLS.has(program) &&
    sub !== undefined &&
    SUBCOMMAND.test(sub)
  ) {
    const script = words[2];
    if (
      SCRIPT_RUNNERS.has(program) &&
      RUN_SUBCOMMANDS.has(sub) &&
      script !== undefined &&
      SUBCOMMAND.test(script)
    ) {
      return `${program} ${sub} ${script}`;
    }
    return `${program} ${sub}`;
  }
  if (
    (program === "python" || program === "python3" || program === "py") &&
    sub === "-m"
  ) {
    const mod = words[2];
    if (mod !== undefined && SUBCOMMAND.test(mod))
      return `${program} -m ${mod}`;
  }
  return program;
}

/* -------------------------------------------------------------------------------------------- */
/* What an allowlist entry can never cover (D376)                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * Whether a segment writes a file through a redirection — `>`, `>>`, `1>`, `2>`, `&>`, `>|`, `<>`,
 * `>&file` — outside quotes and escapes, read the way the splitter reads them. Input (`<`) and a
 * descriptor duplication or close (`2>&1`, `>&2`, `>&-`) write no file.
 */
function writesToFile(segment: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charAt(i);
    const next = segment.charAt(i + 1);
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === "\\" && next !== "") i++;
      else if (c === '"') inDouble = false;
      continue;
    }
    // A caret is an ordinary character to bash (D376), so it escapes nothing here.
    if (c === "\\" && BACKSLASH_ESCAPABLE.has(next)) {
      i++;
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === ">") {
      let j = i + 1;
      if (segment.charAt(j) === ">" || segment.charAt(j) === "|") j++;
      if (segment.charAt(j) !== "&") return true;
      // `>&N` / `>&-`: a duplication or a close, when nothing but a separator follows.
      const dup = /^(\d+|-)(?=$|[\s;|&<>])/.exec(segment.slice(j + 1));
      if (dup === null) return true;
      i = j + dup[0].length;
    }
  }
  return false;
}

/**
 * D376: why an allowlist entry — a program on the PATH, run as itself — can never cover this
 * segment, or `undefined`. A leading `NAME=value` (`NODE_OPTIONS`, `LD_PRELOAD`) loads other code
 * into the allowed program; a program word with `/` or `\` is some other file of that name; an
 * output redirection writes wherever it points (`npm test > ~/.bashrc`).
 */
function uncoverableReason(segment: string): string | undefined {
  const words = tokenize(segment);
  const first = words[0];
  if (first !== undefined && ASSIGNMENT.test(first))
    return "sets environment variables first";
  if (first !== undefined && /[\\/]/.test(first))
    return "runs a program by path";
  if (writesToFile(segment)) return "redirects output to a file";
  return undefined;
}

/**
 * D376: programs whose prefix is never offered for Always allow — the wrappers, shells and
 * interpreters this file already knows, and the other launchers that run whatever they are given
 * (`.`, `source`, `npx` and kin, `tsx`, `wsl`, `ssh`). They ask every time; an entry the person
 * types into the node's allowed commands still covers them.
 */
const NEVER_OFFERED: ReadonlySet<string> = new Set([
  ...WRAPPERS,
  ...SHELLS,
  ...POWERSHELLS,
  ...INTERPRETERS,
  "cmd",
  "nodejs",
  "php",
  ".",
  "source",
  "npx",
  "pnpx",
  "bunx",
  "tsx",
  "wsl",
  "ssh",
]);

/** D376: `python3.12`, `pypy3`, `php8.2`, `node18` and the like. */
const VERSIONED_INTERPRETER = /^(python|pypy|php|ruby|perl|node)[0-9.]*$/;

/** Whether a prefix starts with a program in {@link NEVER_OFFERED} or a versioned interpreter. */
function neverOffered(prefix: string): boolean {
  const first = normalizeProgram(prefix.split(" ")[0] ?? "");
  return NEVER_OFFERED.has(first) || VERSIONED_INTERPRETER.test(first);
}

/** Whole-word prefix match; the program name compares case-insensitively, the rest exactly. */
function allowlistCovers(
  segment: string,
  allowlist: readonly string[],
): boolean {
  const words = commandWords(segment);
  if (words.length === 0) return false;
  return allowlist.some((entry) => {
    const want = commandWords(entry);
    if (want.length === 0 || want.length > words.length) return false;
    return want.every((w, i) => words[i] === w);
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Denylist                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** `/`, `/*`, `~`, `~/`, `$HOME`, `%USERPROFILE%`, `C:\`, `/c/` … after stripping `*` and slashes. */
function isRootTarget(target: string): boolean {
  if (target === "") return false;
  const t = target
    .toLowerCase()
    .replace(/\*+$/, "")
    .replace(/[\\/]+$/, "");
  return (
    t === "" ||
    t === "~" ||
    t === "$home" ||
    t === "${home}" ||
    t === "%userprofile%" ||
    t === "$env:userprofile" ||
    t === "%homedrive%%homepath%" ||
    t === "%systemdrive%" ||
    t === "$env:systemdrive" ||
    /^[a-z]:$/.test(t) ||
    /^\/[a-z]$/.test(t) ||
    /^\/mnt\/[a-z]$/.test(t)
  );
}

const DELETERS = new Set([
  "rm",
  "del",
  "erase",
  "rd",
  "rmdir",
  "remove-item",
  "ri",
]);

function isRecursiveDelete(program: string, arg: string): boolean {
  const a = arg.toLowerCase();
  if (a === "--recursive" || a === "--no-preserve-root") return true;
  if (a === "/s") return program !== "rm";
  if (a.length >= 2 && "-recurse".startsWith(a)) return true; // PowerShell -Recurse / -r
  return program === "rm" && /^-[a-z]+$/i.test(arg) && /r/i.test(arg);
}

const DISK_TOOLS = new Set([
  "format",
  "diskpart",
  "fdisk",
  "sfdisk",
  "gdisk",
  "parted",
  "wipefs",
  "format-volume",
  "clear-disk",
  "initialize-disk",
]);
const POWER_TOOLS = new Set([
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "restart-computer",
  "stop-computer",
]);
const REGISTRY_CMDLETS = new Set([
  "set-itemproperty",
  "new-itemproperty",
  "remove-itemproperty",
  "rename-itemproperty",
  "set-item",
  "new-item",
  "remove-item",
  "sp",
  "ni",
  "ri",
]);
const REGISTRY_PATH = /^(hklm|hkcu|hkcr|hku|hkcc):|^registry::/i;

function shortFlags(args: readonly string[]): string {
  return args.filter((a) => /^-[a-z]+$/i.test(a)).join("");
}

/**
 * A short list of commands that always need approval, whatever the allowlist says.
 *
 * THIS IS A SPEED BUMP, NOT A SECURITY BOUNDARY. Each rule matches the obvious spelling of a
 * catastrophic command so a model cannot run it unasked; anything obfuscated (variables, aliases,
 * scripts, another interpreter) gets past it. Commands run as the user and can reach anything the
 * user can — real confinement is D-083. The allowlist and "ask by default" (D342) are what keep
 * commands in check; this list only stops "Always allow" from ever covering these.
 */
export const DENYLIST: readonly DenyRule[] = [
  {
    id: "disk-format",
    description:
      "Formatting or partitioning a disk: format, mkfs*, diskpart, fdisk/sfdisk/gdisk/parted, wipefs, Format-Volume, Clear-Disk, Initialize-Disk, dd onto /dev/*.",
    scope: "segment",
    matches: (text) => {
      const { program, args } = effective(text);
      if (DISK_TOOLS.has(program) || program.startsWith("mkfs")) return true;
      return program === "dd" && args.some((a) => /^of=\/dev\//i.test(a));
    },
  },
  {
    id: "recursive-delete-root",
    description:
      "A recursive delete of a filesystem root, a drive root or the home folder: rm -r/-rf/-fr/-r -f, del /s, rd /s, Remove-Item -Recurse on /, /*, ~, ~/, $HOME, %USERPROFILE%, C:\\ (and rm --no-preserve-root anywhere).",
    scope: "segment",
    matches: (text) => {
      const { program, args } = effective(text);
      if (!DELETERS.has(program)) return false;
      if (program === "rm" && args.includes("--no-preserve-root")) return true;
      if (!args.some((a) => isRecursiveDelete(program, a))) return false;
      // cmd switches (`/s`, `/q`) would otherwise read as Git Bash drive paths (`/c`).
      const cmdStyle =
        program === "del" ||
        program === "erase" ||
        program === "rd" ||
        program === "rmdir";
      return args.some(
        (a) => !(cmdStyle && /^\/[a-z]$/i.test(a)) && isRootTarget(a),
      );
    },
  },
  {
    id: "recursive-permissions-root",
    description:
      "chmod / chown / chgrp -R on a root or home folder (e.g. chmod -R 777 /).",
    scope: "segment",
    matches: (text) => {
      const { program, args } = effective(text);
      if (program !== "chmod" && program !== "chown" && program !== "chgrp")
        return false;
      const recursive = args.some(
        (a) => a === "--recursive" || (/^-[a-z]+$/i.test(a) && a.includes("R")),
      );
      return recursive && args.some(isRootTarget);
    },
  },
  {
    id: "git-force-push",
    description:
      "git push --force / -f / --force-with-lease / --force-if-includes, or a +refspec.",
    scope: "segment",
    matches: (text) => {
      const { program, args } = effective(text);
      if (program !== "git") return false;
      const at = args.indexOf("push");
      if (at < 0) return false;
      const rest = args.slice(at + 1);
      return rest.some(
        (a) =>
          a === "--force" ||
          a.startsWith("--force-with-lease") ||
          a === "--force-if-includes" ||
          (/^-[a-z]+$/i.test(a) && a.includes("f")) ||
          /^\+[^+]/.test(a),
      );
    },
  },
  {
    id: "git-clean-ignored",
    description:
      "git clean -f with -x or -X: deletes ignored files (.env, node_modules, local config) that no checkpoint holds. Plain git clean -fd is not listed.",
    scope: "segment",
    matches: (text) => {
      const { program, args } = effective(text);
      if (program !== "git" || !args.includes("clean")) return false;
      const flags = shortFlags(args.slice(args.indexOf("clean") + 1));
      return (
        /[xX]/.test(flags) && (flags.includes("f") || args.includes("--force"))
      );
    },
  },
  {
    id: "registry-edit",
    description:
      "Windows registry edits: reg add/delete/import/load/unload/restore/copy, regedit, and PowerShell item cmdlets on HKLM:/HKCU:/HKCR:/HKU:/HKCC:/Registry::.",
    scope: "segment",
    matches: (text) => {
      const { program, args } = effective(text);
      if (program === "regedit" || program === "regedt32") return true;
      if (program === "reg") {
        return /^(add|delete|import|load|unload|restore|copy)$/i.test(
          args[0] ?? "",
        );
      }
      return (
        REGISTRY_CMDLETS.has(program) && args.some((a) => REGISTRY_PATH.test(a))
      );
    },
  },
  {
    id: "shutdown",
    description:
      "Shutting down or restarting the machine: shutdown, reboot, halt, poweroff, Restart-Computer, Stop-Computer, systemctl reboot/poweroff/halt, init 0/6.",
    scope: "segment",
    matches: (text) => {
      const { program, args } = effective(text);
      if (POWER_TOOLS.has(program)) return true;
      if (program === "systemctl")
        return args.some((a) => /^(reboot|poweroff|halt|kexec)$/i.test(a));
      return program === "init" && (args[0] === "0" || args[0] === "6");
    },
  },
  {
    id: "fork-bomb",
    description:
      "A shell fork bomb such as :(){ :|:& };: (checked on the whole line).",
    scope: "line",
    matches: (text) =>
      /([\w:]+)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1\s*&/.test(text),
  },
];

function deniedBy(segment: string): string | undefined {
  return DENYLIST.find(
    (rule) => rule.scope === "segment" && rule.matches(segment),
  )?.id;
}

/* -------------------------------------------------------------------------------------------- */
/* Classification                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * Classifies a `run_command` line against a node's allowlist (D342: there is no "Full auto").
 *
 * `autoAllowed` only when the line is read confidently, no segment hits the DENYLIST or is
 * uncoverable (D376: env assignments first, a path program, an output redirection) and every
 * segment is covered by an allowlist entry. `alwaysAllowPrefix` is offered only when the line is
 * confident, nothing is denied or uncoverable, all segments share one prefix and that prefix does
 * not start with a wrapper or an interpreter (`NEVER_OFFERED`).
 */
export function classifyCommand(
  command: string,
  allowlist: readonly string[],
): Classification {
  const split = splitCommand(command);
  const denied = new Set<string>();
  const segments = split.segments.map((text): ClassifiedSegment => {
    const prefix = commandPrefix(text);
    const rule = deniedBy(text);
    if (rule !== undefined) denied.add(rule);
    const uncoverable = uncoverableReason(text);
    const allowed =
      rule === undefined &&
      uncoverable === undefined &&
      allowlistCovers(text, allowlist);
    return {
      text,
      ...(prefix !== undefined ? { prefix } : {}),
      ...(rule !== undefined ? { denied: rule } : {}),
      ...(uncoverable !== undefined ? { uncoverable } : {}),
      allowed,
    };
  });
  for (const rule of DENYLIST) {
    if (rule.scope === "line" && rule.matches(command)) denied.add(rule.id);
  }

  const clean = split.confident && denied.size === 0 && segments.length > 0;
  const autoAllowed = clean && segments.every((s) => s.allowed);
  const prefixes = new Set(segments.map((s) => s.prefix));
  const only = prefixes.size === 1 ? [...prefixes][0] : undefined;
  const offerable =
    clean &&
    segments.every((s) => s.uncoverable === undefined) &&
    only !== undefined &&
    !neverOffered(only);
  const result: Classification = {
    segments,
    confident: split.confident,
    reasons: split.reasons,
    denied: [...denied],
    autoAllowed,
  };
  if (offerable && only !== undefined) result.alwaysAllowPrefix = only;
  return result;
}
