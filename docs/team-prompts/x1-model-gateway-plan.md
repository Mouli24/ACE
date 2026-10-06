# X1 — Model Gateway, CLI Providers, Project Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ACE agent nodes run on Claude Code / Codex / Gemini CLIs (their own logins, no key), on API and local models with real tool calling, all through one model gateway, with new project-folder file/terminal/git tools.

**Architecture:** A thin `ModelGateway` in `packages/engine` consolidates route → adapter → gate → catalog/pricing → error stamping that `server.ts` wires today as loose closures. CLI providers are new `ProviderAdapter`s in `packages/providers/src/adapters/cli/` that spawn the real CLI per call in the project folder and translate its JSONL into `StreamChunk`s (text, a new `activity` chunk, usage with CLI-reported cost). API adapters gain real tool calling through the AI SDK so ACE's existing tool loop finally runs against real models; seven new built-in tools give that loop the project folder, terminal and git.

**Tech Stack:** TypeScript ESM, Node 20+ (24 here), pnpm workspaces (hoisted), Zod 4.6, Vercel AI SDK 7.0.109 (`ai`, `ai/test`), Hono, better-sqlite3/Drizzle, React 18 + TanStack Query + MSW, Vitest 5, Testing Library.

**Spec:** `docs/team-prompts/x1-model-gateway-design.md` (read it first; decisions D260–D266 live there).

**Repo:** `D:\ACE offcl\ACE`. Work happens in the worktree `D:\ACE offcl\wt\x1` on branch `x1/model-gateway`, which already carries this plan and the spec (the draft PR). The main checkout stays on `main`; the launcher runs it.

## Global Constraints

- One branch `x1/model-gateway`, backing the draft PR opened with this plan; commits in task order (contracts first, CLAUDE.md §3.4 rule 2), pushed after each task. Marking the PR ready for review, or merging it, is the user's call (Task 23).
- Commit messages: Conventional Commits ending in `[X1]` plus FR ids, e.g. `feat(contracts): CLI provider types and permission presets [X1] [FR-PRV-008]`, each ending with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never use `any`, `@ts-ignore` or `console.*` in engine-side code (`packages/engine|providers|tools|storage-local|contracts`, `apps/server`).
- No Node APIs (`fs`, `path`, `child_process`, `process.env`, `node:*`) in `apps/web`, `packages/ui`, `packages/sdk`. No browser APIs in engine-side code.
- Dependency rule (CLAUDE.md §3.4 rule 3): `packages/engine` imports only `@ace/contracts` and its own files; `packages/providers` and `packages/tools` import `@ace/contracts` and `@ace/engine` only — **providers never imports tools** (duplicate the 12-line `killTree` instead).
- `pnpm test` must pass with **zero env vars, no network, no installed CLI**. Real CLI runs happen only in Task 10 step "record fixtures", Task 14 and Task 22.
- `ProviderState` keeps exactly `UNKNOWN CHECKING CONNECTED AUTH_FAILED UNREACHABLE RATE_LIMITED` (D265).
- ACE never reads a CLI's credential files or tokens (D264). Login state comes only from `claude auth status --json`, `codex login status`, Gemini env vars / `~/.gemini/settings.json` auth *type*.
- Never spawn with `shell: true`. `.cmd` shims are resolved to their real target (Task 8). `run_command` is the only place a shell runs, and it spawns `cmd.exe`/`/bin/sh` explicitly.
- Claude Code base flags, exactly: `-p --output-format stream-json --verbose --include-partial-messages --setting-sources "" --strict-mcp-config --permission-prompts none` (verified 2026-10-06).
- Workspace packages resolve to their `dist/`: after changing a package that another package imports, run `pnpm --filter <that package> build` before testing the importer.
- Migrations are forward-only and timestamped; never edit an existing one.
- Coverage gates (NFR-MAIN-02): ≥ 80 % engine-side packages, ≥ 60 % `apps/web`/`packages/ui`/`packages/sdk`.

## Review Focus

1. **npm `.cmd` shims on Windows** — `claude`, `codex`, `gemini` installed with npm are `.cmd` files; spawning them without a shell fails (ENOENT/EINVAL). Expect the resolver to find the real `.exe` or `.js` behind the shim. Pinned by Task 8 tests "resolves an npm shim that points at an .exe" and "…at a .js".
2. **Stop must kill grandchildren within 2 s** — Codex's `codex.js` spawns `codex.exe`; Gemini relaunches itself. Expect Stop to end the whole tree. Pinned by Task 8 test "abort kills the process tree, grandchild included" and checked live in Task 22.
3. **Prompts with quotes, newlines, `%`, `^`, `&`, `"` and > 32 KB** — expect them to reach the CLI byte-for-byte (stdin, never argv). Pinned by Task 8 test "delivers a 64 KB prompt with shell metacharacters intact".
4. **Paths with spaces** — the repo itself lives in `D:\ACE offcl\…`. Expect cwd and tool paths with spaces to work. Pinned by Task 8 test "runs in a working directory whose name has a space" and Task 16 test "reads a file under a folder with a space".
5. **Noisy or split stdout** — CLIs print banners/warnings, CRLF line ends, and lines split across reads. Expect them skipped/joined, never a crash. Pinned by Task 8 tests for the line splitter and Task 10 test "ignores events it does not know".

## File Map

| File | Responsibility |
|---|---|
| `packages/contracts/src/enums.ts` | `PROVIDER_TYPES` += three CLI types |
| `packages/contracts/src/providers.ts` | CLI types/routes/permissions, refinements, detection schema, hints |
| `packages/contracts/src/tools.ts` | `BUILTIN_TOOL_NAMES` += seven (Task 19) |
| `packages/engine/src/models/gateway.ts` (new) | `ModelGateway` |
| `packages/engine/src/ports/model-provider.ts` | `workingDir`, `ToolResult.args`, `activity` chunk, `usage.costUsd`, `detectClis?` |
| `packages/engine/src/runs/executor.ts` | workingDir, activity → ToolCall, reported cost, tool args, `projectDir` to tools |
| `packages/engine/src/runs/index.ts` | pass `projectFolderFor` through |
| `packages/engine/src/runs/tool-loop.ts` | `ToolRunContext.projectDir` |
| `packages/engine/src/providers/index.ts` | persist `cliPermission`, `detectClis` |
| `packages/engine/src/gateway/index.ts` | `GET /providers/detect/clis`, PATCH field rules |
| `packages/storage-local/src/{schema,migrations,repository-runs}.ts` | `cli_permission` column |
| `packages/providers/src/adapters/cli/lines.ts` (new) | line splitter + JSON line parse |
| `packages/providers/src/adapters/cli/resolve.ts` (new) | PATH lookup + shim unwrapping |
| `packages/providers/src/adapters/cli/runner.ts` (new) | spawn, stdin, stdout lines, kill tree |
| `packages/providers/src/adapters/cli/detect.ts` (new) | installed/version/login per CLI, cached |
| `packages/providers/src/adapters/cli/adapter.ts` (new) | shared `createCliAdapter(dialect)` |
| `packages/providers/src/adapters/cli/claude-code.ts` (new) | Claude dialect + parser + models |
| `packages/providers/src/adapters/cli/codex.ts` (new) | Codex dialect + parser |
| `packages/providers/src/adapters/cli/gemini.ts` (new) | Gemini dialect + parser |
| `packages/providers/src/adapters/ai-sdk.ts` | tools + continuation |
| `packages/providers/src/factory.ts` | CLI cases, `detectClis` |
| `packages/tools/src/project/paths.ts` (new) | project-folder confinement |
| `packages/tools/src/builtins/project-files.ts` (new) | list/read/write/edit |
| `packages/tools/src/builtins/git.ts` (new) | git_status/git_diff |
| `packages/tools/src/builtins/run-command.ts` (new) | run_command |
| `packages/tools/src/{tool.ts,sandbox/runner.ts,builtins/factory.ts,index.ts}` | projectDir, export killTree, register |
| `apps/server/src/server.ts` | gateway, projectFolderFor, tool projectDir |
| `packages/ui/src/{tokens.ts,theme.css}` | three accents ×2 themes |
| `packages/sdk/src/client.ts` | `detectClis()` |
| `apps/web/src/providers/*` | labels, hooks, scan section, permission field, row, edit |
| `apps/web/src/mocks/{handlers-round2.ts,db.ts,tools-catalog.ts}` | scan mock, cliPermission, tool defs |
| `apps/web/src/workflows/query-keys.ts` | `cliScan` key |
| `docs/DECISIONS.md`, `CLAUDE.md` §9 | D260–D266, row X1 |

---

### Task 0: Worktree and baseline

**Files:** none changed.

- [ ] **Step 1: Use the existing worktree and branch**

The branch `x1/model-gateway` and its worktree were created with this plan (the draft PR). If the worktree is missing, recreate it from the branch:

```bash
cd "D:/ACE offcl/ACE"
git fetch origin
git worktree list | grep -q "wt/x1" || git worktree add "../wt/x1" x1/model-gateway
cd "../wt/x1"
git pull --ff-only
pnpm install --frozen-lockfile
pnpm --filter "./packages/**" build
```
Expected: install and build succeed.

- [ ] **Step 2: Baseline gates**

```bash
pnpm typecheck && pnpm lint
pnpm --filter @ace/contracts --filter @ace/engine --filter @ace/providers --filter @ace/tools --filter @ace/storage-local test
```
Expected: all green. If anything is red on a clean `origin/main`, stop and report it — do not start on a red base.

- [ ] **Step 3: Copy the Claude Code probe recordings into the worktree**

The recordings were captured from the real Claude Code 2.1.282 on 2026-10-06 (spec §5.1). Strip the user-hook events (they contain the user's own hook text) and keep the rest:

```bash
SRC="C:/Users/Vagabond/AppData/Local/Temp/claude/d--ACE-offcl/30fcb2b4-ce6b-49a8-9ace-3438e8ea8014/scratchpad/probe"
DST="packages/providers/src/adapters/cli/__tests__/fixtures"
mkdir -p "$DST"
node -e "
const fs=require('fs');
const keep=(f,o)=>fs.writeFileSync(o, fs.readFileSync(f,'utf8').split('\n').filter(Boolean)
  .filter(l=>{const e=JSON.parse(l);return !(e.type==='system'&&/^hook_/.test(e.subtype||''));}).join('\n')+'\n');
keep('$SRC/plain.jsonl','$DST/claude-plain.jsonl');
keep('$SRC/tool.jsonl','$DST/claude-read-tool.jsonl');
"
grep -c "" "$DST"/*.jsonl
```
Expected: two files; `claude-plain.jsonl` ends in a `result` line with `"result":"OK"`, `claude-read-tool.jsonl` contains one `tool_use` named `Read` and one `tool_result`. If the scratchpad files are gone, re-record them with the two commands in Task 10 Step 1.

---

### Task 1: Contract — CLI provider types, routes, permission presets

**Files:**
- Modify: `packages/contracts/src/enums.ts:81-88`
- Modify: `packages/contracts/src/providers.ts`
- Test: `packages/contracts/src/__tests__/enums.test.ts:101-106`, `packages/contracts/src/__tests__/providers.test.ts`
- Modify (forced by `Record<ProviderType, …>`): `packages/ui/src/tokens.ts:11-18,54-61`, `packages/ui/src/theme.css` (both provider blocks), `apps/web/src/providers/provider-meta.ts:7-14`
- Modify: `docs/DECISIONS.md` (append D260–D266)

**Interfaces:**
- Produces (from `@ace/contracts`): `CLI_PROVIDER_TYPES`, `CliProviderTypeSchema`, `type CliProviderType`, `isCliProviderType(type): type is CliProviderType`, `PROVIDER_ROUTES`, `type ProviderRoute`, `routeOf(type): ProviderRoute`, `CLI_PERMISSIONS`, `CliPermissionSchema`, `type CliPermission`, `DEFAULT_CLI_PERMISSION = 'edit_files'`, `DEFAULT_CLI_CONCURRENCY = 1`; `Provider.cliPermission?: CliPermission`; `CreateProviderRequest.cliPermission?`, `UpdateProviderRequest.cliPermission?`.

- [ ] **Step 1: Write the failing tests**

In `packages/contracts/src/__tests__/enums.test.ts`, change the ProviderType `expected` to:

```ts
    expected: [
      'anthropic',
      'google',
      'openai',
      'openai_compatible',
      'ollama',
      'mock',
      'claude_code',
      'codex_cli',
      'gemini_cli',
    ],
```

In `packages/contracts/src/__tests__/providers.test.ts`, extend the import from `'../providers.js'` with `CLI_PERMISSIONS, CLI_PROVIDER_TYPES, DEFAULT_CLI_CONCURRENCY, DEFAULT_CLI_PERMISSION, isCliProviderType, routeOf,` and append:

```ts
describe('FR-PRV-008 CLI providers (X1, D261–D262)', () => {
  it('accepts each CLI type with a permission level and no key', () => {
    for (const type of CLI_PROVIDER_TYPES) {
      expect(
        ProviderSchema.safeParse({ ...provider, type, cliPermission: 'edit_files' }).success,
        type,
      ).toBe(true);
      expect(
        CreateProviderRequestSchema.safeParse({ type, name: 'CLI', cliPermission: 'read_only' })
          .success,
        type,
      ).toBe(true);
    }
  });

  it('refuses an API key or a base URL on a CLI provider', () => {
    expect(
      CreateProviderRequestSchema.safeParse({ type: 'claude_code', name: 'C', apiKey: 'sk-x' })
        .success,
    ).toBe(false);
    expect(
      CreateProviderRequestSchema.safeParse({
        type: 'codex_cli',
        name: 'C',
        baseUrl: 'http://127.0.0.1:1',
      }).success,
    ).toBe(false);
  });

  it('refuses a permission level on a provider that is not a CLI', () => {
    expect(
      CreateProviderRequestSchema.safeParse({
        type: 'anthropic',
        name: 'A',
        apiKey: 'k',
        cliPermission: 'full_auto',
      }).success,
    ).toBe(false);
  });

  it('refuses a permission level outside the three presets', () => {
    expect(
      CreateProviderRequestSchema.safeParse({ type: 'gemini_cli', name: 'G', cliPermission: 'root' })
        .success,
    ).toBe(false);
    expect([...CLI_PERMISSIONS]).toEqual(['read_only', 'edit_files', 'full_auto']);
  });

  it('lets a patch change the permission level', () => {
    expect(UpdateProviderRequestSchema.parse({ cliPermission: 'full_auto' })).toEqual({
      cliPermission: 'full_auto',
    });
  });

  it('names each type’s route', () => {
    expect(routeOf('anthropic')).toBe('api');
    expect(routeOf('google')).toBe('api');
    expect(routeOf('openai')).toBe('api');
    expect(routeOf('openai_compatible')).toBe('local');
    expect(routeOf('ollama')).toBe('local');
    expect(routeOf('mock')).toBe('mock');
    for (const type of CLI_PROVIDER_TYPES) expect(routeOf(type)).toBe('cli');
    expect(isCliProviderType('gemini_cli')).toBe(true);
    expect(isCliProviderType('openai')).toBe(false);
  });

  it('starts a CLI provider at editing project files, one call at a time', () => {
    expect(DEFAULT_CLI_PERMISSION).toBe('edit_files');
    expect(DEFAULT_CLI_CONCURRENCY).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @ace/contracts exec vitest run src/__tests__/providers.test.ts src/__tests__/enums.test.ts`
Expected: FAIL — `CLI_PROVIDER_TYPES` is not exported / ProviderType list mismatch.

- [ ] **Step 3: Implement**

`packages/contracts/src/enums.ts` — replace the `PROVIDER_TYPES` array:

```ts
export const PROVIDER_TYPES = [
  'anthropic',
  'google',
  'openai',
  'openai_compatible',
  'ollama',
  'mock',
  // X1 (FR-PRV-008, D261): locally installed coding-agent CLIs, run with their own login.
  'claude_code',
  'codex_cli',
  'gemini_cli',
] as const;
```

`packages/contracts/src/providers.ts` — change the enums import to `import { ProviderStateSchema, ProviderTypeSchema, type ProviderType } from './enums.js';`, then insert this block directly after `ProviderBaseUrlSchema`:

```ts
/* -------------------------------------------------------------------------- */
/* CLI providers (X1, FR-PRV-008, D261–D265)                                   */
/* -------------------------------------------------------------------------- */

/**
 * The provider types that run a locally installed coding-agent CLI with that CLI's own login (D261,
 * D264). They take no API key and no base URL; what they may do is a permission preset (D262).
 */
export const CLI_PROVIDER_TYPES = ['claude_code', 'codex_cli', 'gemini_cli'] as const;
export const CliProviderTypeSchema = z.enum(CLI_PROVIDER_TYPES);
export type CliProviderType = z.infer<typeof CliProviderTypeSchema>;

export function isCliProviderType(type: ProviderType): type is CliProviderType {
  return (CLI_PROVIDER_TYPES as readonly string[]).includes(type);
}

/** How a provider reaches its model: a cloud API, a local service, a local CLI, or the mock. */
export const PROVIDER_ROUTES = ['api', 'local', 'cli', 'mock'] as const;
export type ProviderRoute = (typeof PROVIDER_ROUTES)[number];

const ROUTE_BY_TYPE: Readonly<Record<ProviderType, ProviderRoute>> = {
  anthropic: 'api',
  google: 'api',
  openai: 'api',
  openai_compatible: 'local',
  ollama: 'local',
  mock: 'mock',
  claude_code: 'cli',
  codex_cli: 'cli',
  gemini_cli: 'cli',
};

/** The execution route of a provider type (spec §3.1). Nothing in the runtime branches on it. */
export function routeOf(type: ProviderType): ProviderRoute {
  return ROUTE_BY_TYPE[type];
}

/** What a CLI provider may do in the project folder, mapped to each CLI's own flags (D262). */
export const CLI_PERMISSIONS = ['read_only', 'edit_files', 'full_auto'] as const;
export const CliPermissionSchema = z.enum(CLI_PERMISSIONS);
export type CliPermission = z.infer<typeof CliPermissionSchema>;
export const DEFAULT_CLI_PERMISSION: CliPermission = 'edit_files';

/** Two agents editing one folder at once collide, so a CLI provider starts at one call in flight. */
export const DEFAULT_CLI_CONCURRENCY = 1;
```

In `ProviderSchema`, add after `concurrency: ProviderConcurrencySchema,`:

```ts
  /** CLI providers only (D262): what the CLI may do in the project folder. */
  cliPermission: CliPermissionSchema.optional(),
```

Replace `CreateProviderRequestSchema` with:

```ts
/**
 * `POST /providers`. `apiKey` is stored in the keychain and never written to the DB (§2.1). A CLI
 * provider brings its own login, so it refuses a key and a base URL; only a CLI provider takes a
 * permission level (D262, D264).
 */
export const CreateProviderRequestSchema = z
  .object({
    type: ProviderTypeSchema,
    name: ProviderNameSchema,
    apiKey: z.string().min(1).optional(),
    baseUrl: ProviderBaseUrlSchema.optional(),
    concurrency: ProviderConcurrencySchema.default(DEFAULT_PROVIDER_CONCURRENCY),
    cliPermission: CliPermissionSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const cli = isCliProviderType(value.type);
    if (cli && value.apiKey !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: 'A CLI provider uses the CLI’s own login and takes no API key.',
      });
    }
    if (cli && value.baseUrl !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'A CLI provider has no base URL.' });
    }
    if (!cli && value.cliPermission !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['cliPermission'],
        message: 'Only a CLI provider takes a permission level.',
      });
    }
  });
```

In `UpdateProviderRequestSchema` add `cliPermission: CliPermissionSchema.optional(),` after `concurrency`.

- [ ] **Step 4: Run the contract tests**

Run: `pnpm --filter @ace/contracts exec vitest run`
Expected: PASS (all contract tests).

- [ ] **Step 5: Update the records the new types force**

`packages/ui/src/tokens.ts` — add to `PROVIDER_ACCENT` (Night):

```ts
  claude_code: '#f2a37f',
  codex_cli: '#7dd3fc',
  gemini_cli: '#f9a8d4',
```

and to `LIGHT_PROVIDER_ACCENT` (Paper):

```ts
  claude_code: '#94401c',
  codex_cli: '#0b6380',
  gemini_cli: '#a3245f',
```

`packages/ui/src/theme.css` — in the Night block after `--color-provider-mock: #9a99a3;` add:

```css
  --color-provider-claude_code: #f2a37f;
  --color-provider-codex_cli: #7dd3fc;
  --color-provider-gemini_cli: #f9a8d4;
```

and in the Paper block after `--color-provider-mock: #6b6972;` add:

```css
  --color-provider-claude_code: #94401c;
  --color-provider-codex_cli: #0b6380;
  --color-provider-gemini_cli: #a3245f;
```

`apps/web/src/providers/provider-meta.ts` — add to `PROVIDER_TYPE_LABEL`:

```ts
  claude_code: 'Claude Code',
  codex_cli: 'Codex CLI',
  gemini_cli: 'Gemini CLI',
```

- [ ] **Step 6: Build and run the forced suites**

```bash
pnpm --filter @ace/contracts build
pnpm --filter @ace/ui exec vitest run
pnpm --filter @ace/ui build
pnpm --filter @ace/web exec vitest run src/providers
pnpm typecheck
```
Expected: PASS. If a contrast test fails for one of the new colours, step it (Night: lighter, Paper: darker) in both `tokens.ts` and `theme.css` until it passes — never lower the threshold. `ProvidersPage.test.tsx`'s `it.each(PROVIDER_TYPES)` now also adds the three CLI types through the form (no key, no URL fields) and must pass unchanged.

- [ ] **Step 7: Record the decisions**

Append to `docs/DECISIONS.md`, one row per line, in the table's existing format (`| D<n> | <title> | <decision> | <affects> | <date> | <who> |`), using the text of spec §2 for D260–D266, date `2026-10-06`, who `Arhant (owner's instruction)`.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts packages/ui apps/web/src/providers/provider-meta.ts docs/DECISIONS.md
git commit -m "feat(contracts): CLI provider types, routes and permission presets [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Contract — the terminal scan response

**Files:**
- Modify: `packages/contracts/src/providers.ts`
- Test: `packages/contracts/src/__tests__/providers.test.ts`

**Interfaces:**
- Produces: `CLI_LOGIN_STATES`, `CliLoginStateSchema`, `type CliLoginState`, `CLI_INSTALL_HINTS: Record<CliProviderType,string>`, `CLI_LOGIN_HINTS: Record<CliProviderType,string>`, `CliDetectionSchema`, `type CliDetection = { type; installed; version?; path?; login; loginDetail?; installHint; loginHint }`, `CliDetectResponseSchema`, `type CliDetectResponse = { items: CliDetection[] }`.

- [ ] **Step 1: Write the failing test**

Add `CLI_INSTALL_HINTS, CLI_LOGIN_HINTS, CliDetectResponseSchema, CliDetectionSchema,` to the providers test import and append:

```ts
describe('FR-PRV-008 GET /providers/detect/clis', () => {
  const found = {
    type: 'claude_code',
    installed: true,
    version: '2.1.282',
    path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
    login: 'logged_in',
    loginDetail: 'claude.ai · max',
    installHint: CLI_INSTALL_HINTS.claude_code,
    loginHint: CLI_LOGIN_HINTS.claude_code,
  };

  it('reports an installed, signed-in CLI with its version', () => {
    expect(CliDetectionSchema.parse(found)).toEqual(found);
  });

  it('reports a missing CLI with only its hints', () => {
    const missing = {
      type: 'gemini_cli',
      installed: false,
      login: 'unknown',
      installHint: CLI_INSTALL_HINTS.gemini_cli,
      loginHint: CLI_LOGIN_HINTS.gemini_cli,
    };
    expect(CliDetectionSchema.safeParse(missing).success).toBe(true);
  });

  it('refuses a stray field, so nothing credential-shaped can ride along', () => {
    expect(CliDetectionSchema.safeParse({ ...found, token: 'x' }).success).toBe(false);
  });

  it('wraps the three in { items }', () => {
    expect(CliDetectResponseSchema.safeParse({ items: [found] }).success).toBe(true);
  });

  it('names the npm package and the login command for each CLI', () => {
    expect(CLI_INSTALL_HINTS).toEqual({
      claude_code: 'npm install -g @anthropic-ai/claude-code',
      codex_cli: 'npm install -g @openai/codex',
      gemini_cli: 'npm install -g @google/gemini-cli',
    });
    expect(CLI_LOGIN_HINTS).toEqual({
      claude_code: 'claude auth login',
      codex_cli: 'codex login',
      gemini_cli: 'gemini',
    });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @ace/contracts exec vitest run src/__tests__/providers.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** — append to `packages/contracts/src/providers.ts`:

```ts
/* -------------------------------------------------------------------------- */
/* The terminal scan (X1, FR-PRV-008)                                          */
/* -------------------------------------------------------------------------- */

/** Whether a CLI is signed in, as far as ACE can tell without reading its credentials (D264). */
export const CLI_LOGIN_STATES = ['logged_in', 'logged_out', 'unknown'] as const;
export const CliLoginStateSchema = z.enum(CLI_LOGIN_STATES);
export type CliLoginState = z.infer<typeof CliLoginStateSchema>;

/** What to run to install each CLI — the install hint FR-PRV-008 asks for. */
export const CLI_INSTALL_HINTS: Readonly<Record<CliProviderType, string>> = {
  claude_code: 'npm install -g @anthropic-ai/claude-code',
  codex_cli: 'npm install -g @openai/codex',
  gemini_cli: 'npm install -g @google/gemini-cli',
};

/** What to run in a terminal to sign each CLI in. Gemini signs in on its first interactive run. */
export const CLI_LOGIN_HINTS: Readonly<Record<CliProviderType, string>> = {
  claude_code: 'claude auth login',
  codex_cli: 'codex login',
  gemini_cli: 'gemini',
};

/** One CLI as the terminal scan found it. Strict: nothing credential-shaped can ride along. */
export const CliDetectionSchema = z.strictObject({
  type: CliProviderTypeSchema,
  installed: z.boolean(),
  version: z.string().optional(),
  /** The file found on PATH, for display. */
  path: z.string().optional(),
  login: CliLoginStateSchema,
  /** How it is signed in, e.g. `claude.ai · max`, `ChatGPT`, `Google sign-in` — never an identity. */
  loginDetail: z.string().optional(),
  installHint: z.string(),
  loginHint: z.string(),
});
export type CliDetection = z.infer<typeof CliDetectionSchema>;

/** `GET /providers/detect/clis` — one entry per CLI type, in `CLI_PROVIDER_TYPES` order. */
export const CliDetectResponseSchema = z.strictObject({ items: z.array(CliDetectionSchema) });
export type CliDetectResponse = z.infer<typeof CliDetectResponseSchema>;
```

- [ ] **Step 4: Run tests** — `pnpm --filter @ace/contracts exec vitest run` → PASS. Then `pnpm --filter @ace/contracts build`.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): terminal scan response for CLI providers [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The Model Gateway

**Files:**
- Create: `packages/engine/src/models/gateway.ts`
- Modify: `packages/engine/src/index.ts` (export it)
- Test: `packages/engine/src/models/__tests__/gateway.test.ts`

**Interfaces:**
- Consumes: `ProviderService['adapterFor' | 'semaphoreFor']` (`providers/index.ts`), `ModelRepository['list']` (`ports/run-repository.ts`), `RouterModel`, `ModelRouter` (`ports/model-router.ts`), `nodeErrorOf`, `AceNodeError` (`errors/kinds.ts`).
- Produces: `interface ModelGateway { adapterFor(id): Promise<ProviderAdapter>; runGated<T>(id, fn): Promise<T>; readonly router: ModelRouter; catalog(): readonly Model[]; refreshCatalog(): Promise<void>; pricingFor(providerId, modelId): ModelPricing | undefined }`, `createModelGateway(deps: ModelGatewayDeps): Promise<ModelGateway>`, `stampProvider(error, providerId): unknown`.

- [ ] **Step 1: Write the failing test** — `packages/engine/src/models/__tests__/gateway.test.ts`:

```ts
import type { Model, NodeError } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { AceNodeError, nodeErrorOf } from '../../errors/index.js';
import { LOCAL_SCOPE, type ProviderAdapter, type RouterModel, type StreamChunk } from '../../ports/index.js';
import { createSemaphore } from '../../providers/semaphore.js';
import { createModelGateway } from '../gateway.js';

const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NOW = '2026-10-06T10:00:00.000Z';

const model = (overrides: Partial<Model> = {}): Model => ({
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
  providerId: PROVIDER_ID,
  modelId: 'sonnet',
  displayName: 'Claude Sonnet',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
  ...overrides,
});

const adapterThat = (generate: ProviderAdapter['generate']): ProviderAdapter => ({
  type: 'claude_code',
  check: async () => ({ status: 'CONNECTED' }),
  listModels: async () => [],
  generate,
});

async function build(adapter?: ProviderAdapter) {
  let rows: Model[] = [model()];
  const gated: string[] = [];
  let reader: () => readonly RouterModel[] = () => [];
  const gateway = await createModelGateway({
    providers: {
      adapterFor: async () =>
        adapter ?? adapterThat(() => (async function* (): AsyncGenerator<StreamChunk> {})()),
      semaphoreFor: async (id) => {
        gated.push(id);
        return createSemaphore(1);
      },
    },
    models: { list: async () => rows },
    scope: LOCAL_SCOPE,
    createRouter: (catalog) => {
      reader = catalog;
      const refuse = () => ({ ok: false as const, code: 'unavailable_model' as const, reason: 'stub' });
      return { resolve: refuse, resolveForBench: refuse };
    },
  });
  return { gateway, gated, setRows: (next: Model[]) => (rows = next), reader: () => reader() };
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('X1 §4.1 the model gateway', () => {
  it('passes a provider’s chunks through untouched', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text', delta: 'hi' },
      { type: 'usage', tokensIn: 1, tokensOut: 1, costUsd: 0.01 },
      { type: 'finish', reason: 'stop' },
    ];
    const { gateway } = await build(adapterThat(() => (async function* () { yield* chunks; })()));
    const adapter = await gateway.adapterFor(PROVIDER_ID);
    expect(await drain(adapter.generate({ modelId: 'sonnet', prompt: 'x', outputTypes: ['text'] }, new AbortController().signal))).toEqual(chunks);
  });

  it('names the provider on a classified failure that does not', async () => {
    const declared: NodeError = { kind: 'provider', code: 'cli_exit_1', message: 'boom', retryable: false };
    const { gateway } = await build(
      adapterThat(() => (async function* (): AsyncGenerator<StreamChunk> { throw new AceNodeError(declared); })()),
    );
    const adapter = await gateway.adapterFor(PROVIDER_ID);
    const error = await drain(adapter.generate({ modelId: 'sonnet', prompt: 'x', outputTypes: ['text'] }, new AbortController().signal)).catch((e: unknown) => e);
    expect(nodeErrorOf(error)).toEqual({ ...declared, providerId: PROVIDER_ID });
  });

  it('leaves an unclassified failure for the executor to classify', async () => {
    const raw = new Error('socket hang up');
    const { gateway } = await build(adapterThat(() => (async function* (): AsyncGenerator<StreamChunk> { throw raw; })()));
    const adapter = await gateway.adapterFor(PROVIDER_ID);
    await expect(drain(adapter.generate({ modelId: 'sonnet', prompt: 'x', outputTypes: ['text'] }, new AbortController().signal))).rejects.toBe(raw);
  });

  it('runs a call inside that provider’s gate', async () => {
    const { gateway, gated } = await build();
    expect(await gateway.runGated(PROVIDER_ID, async () => 42)).toBe(42);
    expect(gated).toEqual([PROVIDER_ID]);
  });

  it('prices from the catalog and lets the router read a refreshed one', async () => {
    const priced = model({ pricing: { inputPer1k: 0.003, outputPer1k: 0.015, priceTableVersion: 'v1' } });
    const { gateway, setRows, reader } = await build();
    expect(gateway.pricingFor(PROVIDER_ID, 'sonnet')).toBeUndefined();
    setRows([priced]);
    await gateway.refreshCatalog();
    expect(gateway.pricingFor(PROVIDER_ID, 'sonnet')).toEqual(priced.pricing);
    expect(gateway.catalog()).toEqual([priced]);
    expect(reader()).toEqual([
      { providerId: PROVIDER_ID, modelId: 'sonnet', available: true, inputTypes: ['text'], outputTypes: ['text'], pricing: priced.pricing },
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @ace/engine exec vitest run src/models`
Expected: FAIL — cannot find `../gateway.js`.

- [ ] **Step 3: Implement** — `packages/engine/src/models/gateway.ts`:

```ts
import type { Id, Model, ModelPricing } from '@ace/contracts';

import { AceNodeError, nodeErrorOf } from '../errors/index.js';
import type {
  ModelRepository,
  ModelRouter,
  ProviderAdapter,
  RouterModel,
  Scope,
  StreamChunk,
} from '../ports/index.js';
import type { ProviderService } from '../providers/index.js';

/**
 * The model gateway (X1 spec §4.1): the one place the agent runtime goes for a model.
 *
 * It answers four questions the executor, the chat service and the summariser all ask — which
 * model (the router, over the gateway's catalog), through which adapter, inside which concurrency
 * slot, at what price — and it makes every classified failure name the provider it came from.
 * Nothing above it names a provider type; nothing below it knows about runs.
 */
export interface ModelGateway {
  adapterFor(providerId: Id): Promise<ProviderAdapter>;
  runGated<T>(providerId: Id, fn: () => Promise<T>): Promise<T>;
  readonly router: ModelRouter;
  catalog(): readonly Model[];
  refreshCatalog(): Promise<void>;
  pricingFor(providerId: Id, modelId: string): ModelPricing | undefined;
}

export interface ModelGatewayDeps {
  providers: Pick<ProviderService, 'adapterFor' | 'semaphoreFor'>;
  models: Pick<ModelRepository, 'list'>;
  scope: Scope;
  /** Builds the router over a catalog reader — `createRouter` from `@ace/providers`, bound by the server. */
  createRouter: (catalog: () => readonly RouterModel[]) => ModelRouter;
}

/** A classified failure without a provider gets this one; anything else passes through as thrown. */
export function stampProvider(error: unknown, providerId: Id): unknown {
  const declared = nodeErrorOf(error);
  if (declared === undefined || declared.providerId !== undefined) return error;
  return new AceNodeError({ ...declared, providerId });
}

function normalised(adapter: ProviderAdapter, providerId: Id): ProviderAdapter {
  const embed = adapter.embed;
  return {
    type: adapter.type,
    check: () => adapter.check(),
    listModels: () => adapter.listModels(),
    ...(embed === undefined ? {} : { embed: (texts, options) => embed.call(adapter, texts, options) }),
    generate(req, signal): AsyncIterable<StreamChunk> {
      const stream = adapter.generate(req, signal);
      return (async function* (): AsyncGenerator<StreamChunk> {
        try {
          yield* stream;
        } catch (error) {
          throw stampProvider(error, providerId);
        }
      })();
    },
  };
}

export async function createModelGateway(deps: ModelGatewayDeps): Promise<ModelGateway> {
  let cache: Model[] = [];
  const refreshCatalog = async (): Promise<void> => {
    cache = await deps.models.list(deps.scope, {});
  };
  await refreshCatalog();

  const router = deps.createRouter(() =>
    cache.map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      available: model.available,
      inputTypes: model.inputTypes,
      outputTypes: model.outputTypes,
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
    })),
  );

  return {
    adapterFor: async (providerId) =>
      normalised(await deps.providers.adapterFor(providerId), providerId),
    runGated: async (providerId, fn) => (await deps.providers.semaphoreFor(providerId)).run(fn),
    router,
    catalog: () => cache,
    refreshCatalog,
    pricingFor: (providerId, modelId) =>
      cache.find((model) => model.providerId === providerId && model.modelId === modelId)?.pricing,
  };
}
```

If `AceNodeError` is not exported from `errors/index.ts`, export it from `errors/kinds.ts` (it is declared there) — do not create a second class.

Add to `packages/engine/src/index.ts` after the providers export: `export * from './models/gateway.js';`

- [ ] **Step 4: Run tests** — `pnpm --filter @ace/engine exec vitest run src/models` → PASS; `pnpm --filter @ace/engine exec tsc --noEmit -p .` (or `pnpm --filter @ace/engine typecheck`) → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/models packages/engine/src/index.ts packages/engine/src/errors
git commit -m "feat(engine): model gateway over router, adapters, gates and catalog [X1]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The server goes through the gateway

**Files:**
- Modify: `apps/server/src/server.ts` (the model-serving block ~:374-407, `embedderFor` ~:624, summariser ~:697-712, run service ~:714-731, chat service ~:771-785, backup import refresh ~:927)
- Test: existing `apps/server` suite (behaviour must not change)

**Interfaces:**
- Consumes: `createModelGateway` (Task 3), `createRouter` (`@ace/providers`).

- [ ] **Step 1: Replace the catalog cache and router with the gateway**

In `server.ts`, delete the `catalogCache` / `refreshCatalogCache` / `router` block after `createProviderService(...)` and put:

```ts
  /*
   * The model gateway (X1 §4.1): route, adapter, per-provider gate, catalog and price in one place.
   * Every caller below gets its model through it; the router reads the gateway's catalog lazily, so
   * a refresh takes effect without rewiring anything.
   */
  const gateway = await createModelGateway({
    providers,
    models: repository.models,
    scope: LOCAL_SCOPE,
    createRouter: (catalog) => createRouter(catalog),
  });
  const router = gateway.router;
```

Add `createModelGateway` to the `@ace/engine` import.

- [ ] **Step 2: Point every caller at the gateway**

Make these exact substitutions in `server.ts`:
- every `await refreshCatalogCache()` → `await gateway.refreshCatalog()`
- every `catalogCache.find(` → `gateway.catalog().find(`
- `embedderFor`: `createEmbedder(await gateway.adapterFor(kb.embeddingProviderId), kb.embeddingModelId)`
- summariser: `adapterFor: (providerId) => gateway.adapterFor(providerId)`, `runGated: (providerId, fn) => gateway.runGated(providerId, fn)`, `pricingFor: async (providerId, modelId) => gateway.pricingFor(providerId, modelId)`
- run service: `adapterFor: (providerId) => gateway.adapterFor(providerId)`, `runGated: (providerId, fn) => gateway.runGated(providerId, fn)`
- chat service: same two lines.

Run `grep -n "catalogCache\|providers.adapterFor\|semaphoreFor" apps/server/src/server.ts` — expected: no matches.

- [ ] **Step 3: Run the server suite**

```bash
pnpm --filter @ace/engine build
pnpm --filter @ace/server exec vitest run
pnpm --filter @ace/server typecheck
```
Expected: PASS with the same count as the Task 0 baseline (no behaviour change).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/server.ts
git commit -m "refactor(server): every model call goes through the model gateway [X1]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Engine ports and executor — workingDir, provider actions, reported cost, tool-call args

**Files:**
- Modify: `packages/engine/src/ports/model-provider.ts` (`ToolResult`, `GenerateRequest`, `StreamChunk`)
- Modify: `packages/engine/src/runs/tool-loop.ts:50-56` (`ToolRunContext`)
- Modify: `packages/engine/src/runs/executor.ts` (deps, `attemptWith`, `generateTurn`, `runToolCall`, tool-result push)
- Modify: `packages/engine/src/runs/index.ts:~205` (`RunServiceDeps`) and `:311-327` (pass-through)
- Test: create `packages/engine/src/runs/__tests__/executor-agent-route.test.ts`; update `executor-tool-loop.test.ts:291`, `scheduler-context.test.ts:1684,1701`

**Interfaces:**
- Produces:
  - `GenerateRequest.workingDir?: string`
  - `ToolResult.args?: unknown`
  - `StreamChunk` member `{ type: 'activity'; tool: string; args: unknown; status: 'ok' | 'error'; summary: string; durationMs: number }`
  - `StreamChunk` usage member gains `costUsd?: number`
  - `NodeExecutorDeps.projectFolderFor?: (runId: Id) => Promise<string | undefined>` and the same on `RunServiceDeps`
  - `ToolRunContext.projectDir?: string`
  - `export function activityToolName(tool: string): string` from `runs/executor.ts`

- [ ] **Step 1: Write the failing test** — `packages/engine/src/runs/__tests__/executor-agent-route.test.ts`:

```ts
import {
  AgentConfigSchema,
  type Envelope,
  type Model,
  type Node,
  type ToolCall,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type GenerateRequest,
  type ModelRouter,
  type ProviderAdapter,
  type StreamChunk,
} from '../../ports/index.js';
import { activityToolName, createNodeExecutor, type ExecuteNodeInput } from '../executor.js';

const NOW = '2026-10-06T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5';
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const UPSTREAM = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';

const node: Node = {
  id: NODE_ID,
  workflowId: WORKFLOW_ID,
  kind: 'agent',
  name: 'Builder',
  position: { x: 0, y: 0 },
  inputs: [{ id: `${NODE_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${NODE_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'sonnet',
    instructions: 'Fix the failing test.',
    inputTypes: ['text'],
    outputTypes: ['text'],
  }),
};

const model: Model = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
  providerId: PROVIDER_ID,
  modelId: 'sonnet',
  displayName: 'Claude Sonnet',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
  pricing: { inputPer1k: 0.003, outputPer1k: 0.015, priceTableVersion: 'v1' },
};

const envelope: Envelope = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0ENVP',
  runId: RUN_ID,
  fromNodeId: UPSTREAM,
  toNodeId: NODE_ID,
  iteration: 1,
  reads: [{ type: 'text', text: 'the brief' }],
  context: { budgetTokens: 4000, trust: 'untrusted' },
  contract: { outputTypes: ['text'] },
  createdAt: NOW,
};

const route = { ok: true as const, route: { providerId: PROVIDER_ID, modelId: 'sonnet', viaFallback: false } };
const router: ModelRouter = { resolve: () => route, resolveForBench: () => route };

async function run(chunks: StreamChunk[], options: { projectFolder?: string } = {}) {
  const repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope: LOCAL_SCOPE, pubsub, now: () => NOW });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));

  const requests: GenerateRequest[] = [];
  const logged: ToolCall[] = [];
  const adapter: ProviderAdapter = {
    type: 'claude_code',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(req) {
      requests.push(req);
      return (async function* () {
        yield* chunks;
      })();
    },
  };
  let seq = 0;
  const executor = createNodeExecutor({
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    now: () => NOW,
    nextId: () => `01JBXQ8Z9KQ4R7N2VWXYZ0T${String(seq++).padStart(2, '0')}`,
    adapterFor: async () => adapter,
    modelsFor: async () => [model],
    router,
    runGated: async (_providerId, fn) => fn(),
    tokenBatchMs: 0,
    recordToolCall: async (_runId, call) => {
      logged.push(call);
    },
    ...(options.projectFolder === undefined
      ? {}
      : { projectFolderFor: async () => options.projectFolder }),
  });

  const input: ExecuteNodeInput = {
    runId: RUN_ID,
    workflowId: WORKFLOW_ID,
    nodeRunId: NODE_RUN_ID,
    node,
    envelopes: [envelope],
    iteration: 1,
    attempt: 1,
    runInputs: {},
    signal: new AbortController().signal,
  };
  const outcome = await executor.execute(input);
  return { outcome, requests, logged, events };
}

const done: StreamChunk[] = [{ type: 'text', delta: 'ok' }, { type: 'finish', reason: 'stop' }];

describe('X1 §4.3 a provider’s own actions (agent route, D261)', () => {
  it('records each action as a ToolCall and a tool.call event, with no guardrail verdicts', async () => {
    const { outcome, logged, events } = await run([
      { type: 'activity', tool: 'Bash', args: { command: 'node --test' }, status: 'ok', summary: '3 passed', durationMs: 900 },
      { type: 'activity', tool: 'Edit', args: { file_path: 'src/math.js' }, status: 'error', summary: 'old_string not found', durationMs: 12 },
      { type: 'text', delta: 'Added multiply; the tests pass.' },
      { type: 'usage', tokensIn: 100, tokensOut: 20 },
      { type: 'finish', reason: 'stop' },
    ]);

    expect(outcome.status).toBe('COMPLETED');
    expect(
      logged.map((call) => [call.toolName, call.status, call.resultSummary, call.durationMs, call.verdicts]),
    ).toEqual([
      ['cli_bash', 'ok', '3 passed', 900, []],
      ['cli_edit', 'error', 'old_string not found', 12, []],
    ]);
    expect(logged[0]?.args).toEqual({ command: 'node --test' });
    expect(events.filter((event) => event.type === 'tool.call')).toHaveLength(2);
  });

  it('D263 uses the cost the provider reported instead of the price table', async () => {
    const { outcome } = await run([
      { type: 'text', delta: 'ok' },
      { type: 'usage', tokensIn: 1000, tokensOut: 1000, costUsd: 0.42 },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(outcome.usage).toMatchObject({ tokensIn: 1000, tokensOut: 1000, costUsd: 0.42 });
  });

  it('prices from the table when the provider reports no cost', async () => {
    const { outcome } = await run([
      { type: 'text', delta: 'ok' },
      { type: 'usage', tokensIn: 1000, tokensOut: 1000 },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(outcome.usage.costUsd).toBeCloseTo(0.018, 6);
  });

  it('hands the project folder to the provider as workingDir', async () => {
    const { requests } = await run(done, { projectFolder: 'D:\\ACE offcl\\demo' });
    expect(requests[0]?.workingDir).toBe('D:\\ACE offcl\\demo');
  });

  it('sends no workingDir when the run has no project folder', async () => {
    const { requests } = await run(done);
    expect(requests[0]).not.toHaveProperty('workingDir');
  });
});

describe('activityToolName', () => {
  it.each([
    ['Bash', 'cli_bash'],
    ['WebFetch', 'cli_web_fetch'],
    ['mcp__github__create_issue', 'cli_mcp_github_create_issue'],
    ['file_change', 'cli_file_change'],
    ['command', 'cli_command'],
    ['!!', 'cli_action'],
  ])('%s → %s', (tool, name) => {
    expect(activityToolName(tool)).toBe(name);
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @ace/engine exec vitest run src/runs/__tests__/executor-agent-route.test.ts`
Expected: FAIL — `activityToolName` not exported; type errors on `activity` / `costUsd` / `projectFolderFor`.

- [ ] **Step 3: Port changes** — in `packages/engine/src/ports/model-provider.ts`:

In `ToolResult`, between `name` and `result`:

```ts
  /** The arguments the model called the tool with, so an adapter can replay its call (X1 §4.4). */
  args?: unknown;
```

In `GenerateRequest`, after `iteration?: number;`:

```ts
  /**
   * The project folder this call works in (X1 §4.2). Only an agent-route provider (a coding-agent
   * CLI) reads it; without it such a provider runs read-only in a fresh temp folder.
   */
  workingDir?: string;
```

In the `StreamChunk` union, replace the usage member and add `activity`:

```ts
  | { type: 'usage'; tokensIn: number; tokensOut: number; costUsd?: number }
  /**
   * Something the provider did itself — a CLI's command, file edit or read (X1 §4.2, D261). The
   * executor records it as a ToolCall; no guardrail runs, because it has already happened.
   */
  | {
      type: 'activity';
      tool: string;
      args: unknown;
      status: 'ok' | 'error';
      summary: string;
      durationMs: number;
    }
```

In `packages/engine/src/runs/tool-loop.ts`, add to `ToolRunContext` after `sandboxDir`:

```ts
  /** X1: the project folder the run works in — the only folder the project tools may touch. */
  projectDir?: string;
```

- [ ] **Step 4: Executor changes** — in `packages/engine/src/runs/executor.ts`:

(a) Add to `NodeExecutorDeps` after `search?: SearchService;`:

```ts
  /* ------------------------------------------------------------------ X1 */

  /**
   * The project folder a run works in (X1 §4.2): handed to the provider as `workingDir` (an
   * agent-route CLI runs there) and to the project tools as `projectDir`. Absent, or failing, the
   * provider gets no folder and the project tools refuse.
   */
  projectFolderFor?: (runId: Id) => Promise<string | undefined>;
```

(b) Add next to `durationSince`:

```ts
/**
 * A provider-side action as a ToolCall name (X1 §4.3): `cli_` and the tool in snake_case, so it
 * satisfies `TOOL_NAME_REGEX` and never collides with an ACE tool — `Bash` → `cli_bash`.
 */
export function activityToolName(tool: string): string {
  const snake = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return `cli_${snake === '' ? 'action' : snake}`;
}
```

(c) In `attemptWith`, directly after `const sandboxDir = deps.sandboxDirFor?.(input.runId) ?? '';` insert:

```ts
      /* X1 §4.2: the project folder, for an agent-route provider and the project tools. */
      let workingDir: string | undefined;
      try {
        const folder = await deps.projectFolderFor?.(input.runId);
        workingDir = folder === undefined || folder === '' ? undefined : folder;
      } catch {
        workingDir = undefined;
      }
      /** What the provider said the call cost (D263), when it says; otherwise the price table. */
      let reportedCostUsd: number | undefined;
      const usageNow = (): Usage => {
        const priced = usageFor(tokensIn, tokensOut, pricing);
        return reportedCostUsd === undefined ? priced : { ...priced, costUsd: reportedCostUsd };
      };
```

(d) Inside `attemptWith` only, replace every `usageFor(tokensIn, tokensOut, pricing)` with `usageNow()` (the catch block, the cancelled branch, and `const usage = …`).

(e) In `generateTurn`'s request object, after `iteration: input.iteration,` add `...(workingDir === undefined ? {} : { workingDir }),`.

(f) In the chunk `switch`, replace the `usage` case and add `activity`:

```ts
              case 'usage':
                // Summed across turns: every generate() turn is its own billed call (Arch §12.7).
                tokensIn += chunk.tokensIn;
                tokensOut += chunk.tokensOut;
                if (chunk.costUsd !== undefined) {
                  reportedCostUsd = (reportedCostUsd ?? 0) + chunk.costUsd;
                }
                break;
              case 'activity':
                // The provider already did this (D261): logged for the inspector, never guarded.
                await logToolCall(
                  { callId: nextId(), name: activityToolName(chunk.tool), args: chunk.args },
                  {
                    status: chunk.status,
                    resultSummary: chunk.summary,
                    durationMs: chunk.durationMs,
                    verdicts: [],
                    at: deps.now?.() ?? new Date().toISOString(),
                  },
                );
                break;
```

(`nextId` and `logToolCall` are in scope there — `logToolCall` is a function declaration in the same `try` block.)

(g) In the tool loop's `toolResults.push({...})`, add `args: pendingCall.args,` between `name` and `result`.

(h) In `runToolCall`, change the `registered!.run(...)` context to:

```ts
            result = await registered!.run(call.args, {
              runId: input.runId,
              sandboxDir,
              signal: toolSignal,
              ...(workingDir === undefined ? {} : { projectDir: workingDir }),
            });
```

- [ ] **Step 5: Run service pass-through** — in `packages/engine/src/runs/index.ts`, add to `RunServiceDeps` next to `sandboxDirFor`:

```ts
  /** X1 §4.2: a run's project folder, for agent-route providers and the project tools. */
  projectFolderFor?: (runId: Id) => Promise<string | undefined>;
```

and in the `createNodeExecutor({...})` call add `...(deps.projectFolderFor === undefined ? {} : { projectFolderFor: deps.projectFolderFor }),`.

- [ ] **Step 6: Update the three existing `toolResults` expectations** (they now carry the call's args):
  - `src/runs/__tests__/executor-tool-loop.test.ts:291` → `{ callId: '01JBXQ8Z9KQ4R7N2VWXYZ0CAL1', name: 'echo', args: { text: 'hi' }, result: { text: 'echoed hi' } }`
  - `src/runs/__tests__/scheduler-context.test.ts:1684` and `:1701` → add `args: {},` to each object (the scripted call at `:1646` passes `args: {}`).

- [ ] **Step 7: Run the engine suite**

```bash
pnpm --filter @ace/engine exec vitest run
pnpm --filter @ace/engine typecheck
```
Expected: PASS, the new file included.

- [ ] **Step 8: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): provider actions, reported cost and working folder reach the executor [X1]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Storage — `cli_permission`

**Files:**
- Modify: `packages/engine/src/ports/run-repository.ts:36-45` (`ProviderPatch`), `packages/engine/src/__tests__/fake-repository.ts:~431` (`providers.update`)
- Modify: `packages/storage-local/src/schema.ts:135-152`, `migrations.ts` (new id + entry), `repository-runs.ts:57-71,160-182`
- Test: `packages/storage-local/src/__tests__/repository-runs.test.ts`; create `migration-x1.test.ts`; update `migration-round-3.test.ts:98-103,265-269`, `migration-round-4.test.ts:58`, `migration-round-5.test.ts:99`

**Interfaces:**
- Consumes: `CliPermission` (Task 1).
- Produces: `X1_CLI_PROVIDERS_MIGRATION_ID = '20261006T120000_x1_cli_providers'`; `ProviderPatch.cliPermission?: CliPermission | null`; the providers repository round-trips `cliPermission`.

- [ ] **Step 1: Write the failing tests**

Append inside the `FR-PRV-001 providers repository` describe of `repository-runs.test.ts`:

```ts
  it('X1 keeps a CLI provider’s permission level and changes it on update (D262)', async () => {
    const cli = provider({ type: 'claude_code', cliPermission: 'edit_files', concurrency: 1 });
    await db.repository.providers.create(scope, cli);
    expect(await db.repository.providers.get(scope, PROVIDER_ID)).toEqual(cli);

    const updated = await db.repository.providers.update(scope, PROVIDER_ID, {
      cliPermission: 'full_auto',
    });
    expect(updated?.cliPermission).toBe('full_auto');
  });
```

Create `packages/storage-local/src/__tests__/migration-x1.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { MIGRATIONS, X1_CLI_PROVIDERS_MIGRATION_ID } from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { scope } from './fixtures.js';

const BEFORE_X1 = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === X1_CLI_PROVIDERS_MIGRATION_ID),
);
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NOW = '2026-10-06T10:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-x1-'));
  path = join(dir, 'ace.sqlite');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('X1 migration: providers.cli_permission (D262)', () => {
  it('adds the column; a provider stored before it reads back with no permission', async () => {
    const before = openDatabase({ path, migrations: BEFORE_X1 });
    expect(before.appliedMigrations).not.toContain(X1_CLI_PROVIDERS_MIGRATION_ID);
    before.sqlite
      .prepare(
        `INSERT INTO providers (id, workspace_id, type, name, base_url, key_set, status,
           status_message, last_checked_at, concurrency, created_at, updated_at)
         VALUES (?, ?, 'mock', 'Mock', NULL, 0, 'UNKNOWN', NULL, NULL, 20, ?, ?)`,
      )
      .run(PROVIDER_ID, scope.workspaceId, NOW, NOW);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([X1_CLI_PROVIDERS_MIGRATION_ID]);
    const columns = (
      after.sqlite.prepare('PRAGMA table_info(providers)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toContain('cli_permission');

    const repository = new SqliteRepository(after.db, after.sqlite);
    const read = await repository.providers.get(scope, PROVIDER_ID);
    expect(read).not.toHaveProperty('cliPermission');
    after.sqlite.close();
  });
});
```

Update the four exact-list assertions so each ends with `X1_CLI_PROVIDERS_MIGRATION_ID` (import it from `'../migrations.js'` in each file):
- `migration-round-3.test.ts:98` list and `:265` list — append `X1_CLI_PROVIDERS_MIGRATION_ID,`
- `migration-round-4.test.ts:58` → `[ROUND_4_MIGRATION_ID, ROUND_5_MIGRATION_ID, X1_CLI_PROVIDERS_MIGRATION_ID]`
- `migration-round-5.test.ts:99` → `[ROUND_5_MIGRATION_ID, X1_CLI_PROVIDERS_MIGRATION_ID]`

- [ ] **Step 2: Run to see failures**

Run: `pnpm --filter @ace/storage-local exec vitest run src/__tests__/repository-runs.test.ts src/__tests__/migration-x1.test.ts`
Expected: FAIL — no `X1_CLI_PROVIDERS_MIGRATION_ID`; `cliPermission` not stored.

- [ ] **Step 3: Implement**

`packages/engine/src/ports/run-repository.ts` — add `type CliPermission` to the contracts import and to `ProviderPatch`: `cliPermission?: CliPermission | null;`.

`packages/engine/src/__tests__/fake-repository.ts` — the in-memory repository copies named fields only, so in `providers.update` add after the `concurrency` line:

```ts
      if (patch.cliPermission !== undefined) {
        if (patch.cliPermission === null) delete next.cliPermission;
        else next.cliPermission = patch.cliPermission;
      }
```

Then `pnpm --filter @ace/engine build`.

`packages/storage-local/src/schema.ts` — in `providers`, after `concurrency`: `cliPermission: text('cli_permission'),`

`packages/storage-local/src/migrations.ts` — next to `ROUND_5_MIGRATION_ID`:

```ts
/** X1 (D262): a CLI provider's permission preset. Named so a test can apply the chain before it. */
export const X1_CLI_PROVIDERS_MIGRATION_ID = '20261006T120000_x1_cli_providers';
```

and as the last element of `MIGRATIONS`:

```ts
  {
    id: X1_CLI_PROVIDERS_MIGRATION_ID,
    up: `
      -- X1 (D262): what a CLI provider may do in the project folder. NULL for every other type.
      ALTER TABLE providers ADD COLUMN cli_permission TEXT;
    `,
  },
```

`packages/storage-local/src/repository-runs.ts` — add `type CliPermission` to the contracts import; in `toProvider`, after `concurrency`: `...(row.cliPermission === null ? {} : { cliPermission: row.cliPermission as CliPermission }),`; in `create`'s `.values({...})` after `concurrency`: `cliPermission: provider.cliPermission ?? null,`.

- [ ] **Step 4: Run the storage suite** — `pnpm --filter @ace/storage-local exec vitest run` → PASS; `pnpm --filter @ace/storage-local typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/ports/run-repository.ts packages/engine/src/__tests__/fake-repository.ts packages/storage-local
git commit -m "feat(storage): store a CLI provider's permission preset [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Provider service and routes — permission, scan, PATCH field rules

**Files:**
- Modify: `packages/contracts/src/providers.ts` (add `cliPatchError`)
- Modify: `packages/engine/src/ports/model-provider.ts` (`ProviderAdapterFactory.detectClis?`)
- Modify: `packages/engine/src/providers/index.ts` (`ProviderService.detectClis?`, `create`, `update`, impl)
- Modify: `packages/engine/src/gateway/index.ts` (route + PATCH)
- Test: `packages/contracts/src/__tests__/providers.test.ts`, `packages/engine/src/__tests__/provider-service.test.ts`, `packages/engine/src/__tests__/gateway-runs.test.ts`

**Interfaces:**
- Consumes: Task 1/2 contract exports; `ProviderPatch.cliPermission` (Task 6).
- Produces: `cliPatchError(type: ProviderType, patch: UpdateProviderRequest): string | undefined` (contracts); `ProviderAdapterFactory.detectClis?(): Promise<CliDetectResponse>`; `ProviderService.detectClis?(): Promise<CliDetectResponse>`; `GET /api/v1/providers/detect/clis`.

- [ ] **Step 1: Write the failing tests**

Contracts (`providers.test.ts`, import `cliPatchError`):

```ts
describe('FR-PRV-008 what a patch may change on each kind of provider', () => {
  it('refuses a key or a base URL for a CLI provider', () => {
    expect(cliPatchError('claude_code', { apiKey: 'sk-x' })).toMatch(/no API key/);
    expect(cliPatchError('codex_cli', { baseUrl: 'http://127.0.0.1:1' })).toMatch(/no base URL/);
  });
  it('refuses a permission level for any other provider', () => {
    expect(cliPatchError('openai', { cliPermission: 'full_auto' })).toMatch(/Only a CLI provider/);
  });
  it('accepts everything else', () => {
    expect(cliPatchError('gemini_cli', { cliPermission: 'read_only', name: 'G' })).toBeUndefined();
    expect(cliPatchError('anthropic', { apiKey: 'sk-new' })).toBeUndefined();
  });
});
```

Provider service (`provider-service.test.ts`) — in `build()`'s stub factory add `detectClis: async () => ({ items: [] }),`, then append:

```ts
describe('FR-PRV-008 CLI providers in the service (X1)', () => {
  it('stores the default permission for a CLI provider created without one', async () => {
    const created = await harness.service.create({ type: 'claude_code', name: 'Claude Code', concurrency: 1 });
    expect(created.cliPermission).toBe('edit_files');
    expect((await harness.service.get(created.id))?.cliPermission).toBe('edit_files');
  });

  it('keeps the permission it was given, and a patch changes it', async () => {
    const created = await harness.service.create({
      type: 'codex_cli',
      name: 'Codex',
      concurrency: 1,
      cliPermission: 'read_only',
    });
    expect(created.cliPermission).toBe('read_only');
    const updated = await harness.service.update(created.id, { cliPermission: 'full_auto' });
    expect(updated?.cliPermission).toBe('full_auto');
  });

  it('gives a non-CLI provider no permission at all', async () => {
    expect(await harness.created()).not.toHaveProperty('cliPermission');
  });

  it('passes the factory’s terminal scan through', async () => {
    expect(await harness.service.detectClis?.()).toEqual({ items: [] });
  });
});
```

Gateway routes (`gateway-runs.test.ts`) — in the providers stub add:

```ts
      detectClis: async () => ({
        items: [
          {
            type: 'claude_code',
            installed: true,
            version: '2.1.282',
            login: 'logged_in',
            loginDetail: 'claude.ai',
            installHint: 'npm install -g @anthropic-ai/claude-code',
            loginHint: 'claude auth login',
          },
        ],
      }),
```

and append:

```ts
describe('FR-PRV-008 the terminal scan route (X1)', () => {
  it('answers the scan, and does not read "detect" as a provider id', async () => {
    const response = await get('/providers/detect/clis');
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ items: [{ type: 'claude_code', installed: true }] });
  });

  it('needs the session token', async () => {
    expect((await app.request('/api/v1/providers/detect/clis')).status).toBe(401);
  });

  it('refuses a permission level on a provider that is not a CLI', async () => {
    const response = await patch(`/providers/${PROVIDER_ID}`, { cliPermission: 'full_auto' });
    expect(response.status).toBe(400);
  });
});
```

(The stub's `get` returns a `mock` provider for `PROVIDER_ID`, so the last test exercises the refusal.)

- [ ] **Step 2: Run to see failures**

```bash
pnpm --filter @ace/contracts exec vitest run src/__tests__/providers.test.ts
pnpm --filter @ace/engine exec vitest run src/__tests__/provider-service.test.ts src/__tests__/gateway-runs.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Contracts — append to `providers.ts`:

```ts
/**
 * Why a patch does not fit the provider it targets, or `undefined` when it does (X1, D262/D264).
 * A patch carries no type, so the engine checks it against the stored provider before applying it.
 */
export function cliPatchError(
  type: ProviderType,
  patch: UpdateProviderRequest,
): string | undefined {
  const cli = isCliProviderType(type);
  if (cli && patch.apiKey !== undefined) {
    return 'A CLI provider uses the CLI’s own login and takes no API key.';
  }
  if (cli && patch.baseUrl !== undefined) return 'A CLI provider has no base URL.';
  if (!cli && patch.cliPermission !== undefined) {
    return 'Only a CLI provider takes a permission level.';
  }
  return undefined;
}
```

Engine port (`model-provider.ts`) — add `type CliDetectResponse` to the contracts import and to `ProviderAdapterFactory`:

```ts
  /** X1 (FR-PRV-008): which coding-agent CLIs are installed and signed in. */
  detectClis?(): Promise<CliDetectResponse>;
```

Provider service (`providers/index.ts`) — import `type CliDetectResponse, DEFAULT_CLI_PERMISSION, isCliProviderType` from `@ace/contracts`; add to the `ProviderService` interface after `detect()`:

```ts
  /** X1 (FR-PRV-008): the terminal scan — installed, version and sign-in per CLI. */
  detectClis?(): Promise<CliDetectResponse>;
```

In `create`, add to the `provider` object after `concurrency`:

```ts
        ...(isCliProviderType(input.type)
          ? { cliPermission: input.cliPermission ?? DEFAULT_CLI_PERMISSION }
          : {}),
```

In `update`, add to the patch passed to `repository.providers.update`, after `concurrency`:

```ts
        ...(patch.cliPermission === undefined ? {} : { cliPermission: patch.cliPermission }),
```

and add next to `detect`:

```ts
    detectClis: async () => (await factory.detectClis?.()) ?? { items: [] },
```

Gateway (`gateway/index.ts`) — import `cliPatchError` from `@ace/contracts`. Right after the `/providers/detect` route add:

```ts
  /** X1 (FR-PRV-008): the terminal scan. Three segments, so `/providers/:id` never swallows it. */
  api.get('/providers/detect/clis', async (c) => {
    const service = providers(c);
    return c.json(service.detectClis === undefined ? { items: [] } : await service.detectClis());
  });
```

Replace the PATCH handler with:

```ts
  api.patch('/providers/:id', async (c) => {
    const patch = UpdateProviderRequestSchema.parse(await readJson(c));
    const existing = await providers(c).get(c.req.param('id'));
    if (existing === null) throw notFound(`provider ${c.req.param('id')}`);
    // A patch carries no type, so whether a key or a permission fits is decided by the stored row.
    const misfit = cliPatchError(existing.type, patch);
    if (misfit !== undefined) throw new HttpError('invalid_config', 'validation_failed', misfit);

    const provider = await providers(c).update(c.req.param('id'), patch);
    if (provider === null) throw notFound(`provider ${c.req.param('id')}`);
    return c.json(provider);
  });
```

(`HttpError` is already in scope in that file — it is used at `:290`.)

- [ ] **Step 4: Run tests and rebuild**

```bash
pnpm --filter @ace/contracts exec vitest run
pnpm --filter @ace/engine exec vitest run
pnpm --filter @ace/contracts build && pnpm --filter @ace/engine build
pnpm typecheck
```
Expected: PASS. (`detectClis` is optional on both interfaces, so other stubs still compile.)

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/engine
git commit -m "feat(engine): CLI permission on providers and the terminal scan route [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: CLI plumbing — line reader, command resolver, process runner

**Files:**
- Create: `packages/providers/src/adapters/cli/lines.ts`, `resolve.ts`, `runner.ts`
- Create: `packages/providers/src/adapters/cli/__tests__/fixtures/fake-cli.mjs`
- Test: create `packages/providers/src/adapters/cli/__tests__/lines.test.ts`, `resolve.test.ts`, `runner.test.ts`
- Modify (only if lint flags the fixture): `packages/providers/eslint.config.js`

**Interfaces:**
- Produces:
  - `createLineSplitter(): { push(chunk: string): string[]; end(): string[] }`
  - `parseJsonLine(line: string): Record<string, unknown> | undefined`
  - `interface ResolvedCommand { command: string; prefixArgs: string[]; path: string }`
  - `resolveCommand(name: string, options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; nodeBinary?: string }): ResolvedCommand | undefined`
  - `interface CliExit { code: number | null; signal: NodeJS.Signals | null; stderrTail: string; spawnError?: NodeJS.ErrnoException; killed: boolean }`
  - `runCli(options: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; signal: AbortSignal; platform?: NodeJS.Platform }): { lines: AsyncIterable<string>; exit: Promise<CliExit> }`
  - `killTree(pid: number, platform: NodeJS.Platform): void`, `STDERR_TAIL_CHARS = 8192`

- [ ] **Step 1: Create the fake CLI** — `packages/providers/src/adapters/cli/__tests__/fixtures/fake-cli.mjs`:

```js
// A stand-in for claude / codex / gemini in tests. FAKE_CLI_MODE picks the behaviour.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const mode = process.env.FAKE_CLI_MODE ?? 'echo-stdin';
const readStdin = () =>
  new Promise((resolve) => {
    const parts = [];
    process.stdin.on('data', (chunk) => parts.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === 'echo-stdin') {
  const input = await readStdin();
  const report = JSON.stringify({
    type: 'stdin',
    length: input.length,
    text: input.length <= 2000 ? input : undefined,
    sha: createHash('sha256').update(input).digest('hex'),
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    env: { GEMINI_CLI_NO_RELAUNCH: process.env.GEMINI_CLI_NO_RELAUNCH ?? null },
  });
  // Adapter tests read this back after a call that (rightly) fails for want of a result event.
  if (process.env.FAKE_CLI_ECHO_FILE) writeFileSync(process.env.FAKE_CLI_ECHO_FILE, report);
  process.stdout.write(report + '\n');
} else if (mode === 'replay') {
  // Plays a recorded JSONL file back in 7-character pieces, so lines arrive split.
  await readStdin();
  const text = readFileSync(process.env.FAKE_CLI_FILE, 'utf8');
  for (let i = 0; i < text.length; i += 7) {
    process.stdout.write(text.slice(i, i + 7));
    if (i % 700 === 0) await sleep(1);
  }
  process.exitCode = Number(process.env.FAKE_CLI_EXIT ?? 0);
} else if (mode === 'stderr-exit') {
  await readStdin();
  process.stderr.write('x'.repeat(20_000) + 'END');
  process.exitCode = 3;
} else if (mode === 'hang-with-child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.FAKE_CLI_PIDFILE, String(child.pid));
  process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
  setInterval(() => {}, 1000);
} else if (mode === 'print') {
  // Detection probes: print what the test asks for, exit with its code.
  process.stdout.write(process.env.FAKE_CLI_STDOUT ?? '');
  process.stderr.write(process.env.FAKE_CLI_STDERR ?? '');
  process.exitCode = Number(process.env.FAKE_CLI_EXIT ?? 0);
}
```

- [ ] **Step 2: Write the failing tests**

`lines.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createLineSplitter, parseJsonLine } from '../lines.js';

describe('X1 CLI stdout lines (review focus 5)', () => {
  it('joins a line split across reads and splits CRLF', () => {
    const splitter = createLineSplitter();
    expect(splitter.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\n\n')).toEqual(['{"b":2}']);
    expect(splitter.push('{"c":3}')).toEqual([]);
    expect(splitter.end()).toEqual(['{"c":3}']);
  });

  it('skips banners, arrays and broken JSON instead of failing', () => {
    expect(parseJsonLine('Loading Claude Code…')).toBeUndefined();
    expect(parseJsonLine('[1,2]')).toBeUndefined();
    expect(parseJsonLine('{"type":')).toBeUndefined();
    expect(parseJsonLine('  {"type":"result"}  ')).toEqual({ type: 'result' });
  });
});
```

`resolve.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCommand } from '../resolve.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace resolve '));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Byte-for-byte the shim npm wrote for Claude Code 2.1.282 on this machine. */
const NATIVE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  '',
].join('\r\n');

/** The shape npm writes for a CLI whose entry point is a .js file (Codex, Gemini). */
const NODE_SHIM = [
  '@ECHO off',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  '',
].join('\r\n');

function file(path: string, content = ''): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('X1 finding a CLI without a shell (review focus 1)', () => {
  it('resolves an npm shim that points at an .exe', () => {
    const bin = join(root, 'npm');
    file(join(bin, 'claude.cmd'), NATIVE_SHIM);
    const exe = file(join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));

    expect(
      resolveCommand('claude', { platform: 'win32', env: { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' } }),
    ).toEqual({ command: exe, prefixArgs: [], path: join(bin, 'claude.cmd') });
  });

  it('resolves an npm shim that points at a .js, run by the given node', () => {
    const bin = join(root, 'npm');
    file(join(bin, 'codex.cmd'), NODE_SHIM);
    const script = file(join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));

    expect(
      resolveCommand('codex', { platform: 'win32', env: { PATH: bin }, nodeBinary: 'C:\\node\\node.exe' }),
    ).toEqual({ command: 'C:\\node\\node.exe', prefixArgs: [script], path: join(bin, 'codex.cmd') });
  });

  it('prefers a real .exe over a shim, and searches PATH in order (a dir with a space included)', () => {
    const first = join(root, 'first dir');
    const second = join(root, 'second');
    const exe = file(join(first, 'gemini.exe'));
    file(join(second, 'gemini.cmd'), NODE_SHIM);
    expect(
      resolveCommand('gemini', { platform: 'win32', env: { PATH: `${first};${second}` } })?.command,
    ).toBe(exe);
  });

  it('skips a .cmd it cannot unwrap rather than open a shell', () => {
    const bin = join(root, 'npm');
    file(join(bin, 'claude.cmd'), '@echo off\r\necho hello\r\n');
    expect(resolveCommand('claude', { platform: 'win32', env: { PATH: bin } })).toBeUndefined();
  });

  it('answers undefined when the CLI is not on PATH', () => {
    expect(
      resolveCommand('claude', { platform: 'win32', env: { PATH: join(root, 'empty') } }),
    ).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('finds a POSIX executable', () => {
    const bin = join(root, 'bin');
    const exe = file(join(bin, 'claude'));
    expect(resolveCommand('claude', { platform: 'linux', env: { PATH: bin } })).toEqual({
      command: exe,
      prefixArgs: [],
      path: exe,
    });
  });
});
```

`runner.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../runner.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-runner-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function start(
  mode: string,
  options: { stdin?: string; cwd?: string; env?: Record<string, string>; signal?: AbortSignal } = {},
) {
  return runCli({
    command: process.execPath,
    args: [FAKE],
    cwd: options.cwd ?? dir,
    env: { ...process.env, FAKE_CLI_MODE: mode, ...options.env },
    stdin: options.stdin ?? '',
    signal: options.signal ?? new AbortController().signal,
  });
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('X1 running a CLI (review focus 2–4)', () => {
  it('delivers a 64 KB prompt with shell metacharacters intact', async () => {
    const prompt = `"quoted" %PATH% ^caret & amp | pipe < > \n`.repeat(1600);
    expect(prompt.length).toBeGreaterThan(64_000);
    const run = start('echo-stdin', { stdin: prompt });
    const [line] = await collect(run.lines);
    const echoed = JSON.parse(line!) as { length: number; sha: string };
    expect(echoed.length).toBe(prompt.length);
    expect(echoed.sha).toBe(createHash('sha256').update(prompt).digest('hex'));
    expect((await run.exit).code).toBe(0);
  });

  it('runs in a working directory whose name has a space', async () => {
    const spaced = join(dir, 'ACE offcl', 'demo project');
    mkdirSync(spaced, { recursive: true });
    const [line] = await collect(start('echo-stdin', { cwd: spaced }).lines);
    expect(realpathSync((JSON.parse(line!) as { cwd: string }).cwd)).toBe(realpathSync(spaced));
  });

  it('yields whole lines when the output arrives in pieces', async () => {
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, '{"type":"a","text":"one"}\r\nnot json\n{"type":"b","text":"two"}\n');
    const lines = await collect(start('replay', { env: { FAKE_CLI_FILE: file } }).lines);
    expect(lines).toEqual(['{"type":"a","text":"one"}', 'not json', '{"type":"b","text":"two"}']);
  });

  it('keeps the tail of stderr and the exit code', async () => {
    const run = start('stderr-exit');
    await collect(run.lines);
    const exit = await run.exit;
    expect(exit.code).toBe(3);
    expect(exit.stderrTail.length).toBeLessThanOrEqual(8192);
    expect(exit.stderrTail.endsWith('END')).toBe(true);
  });

  it('abort kills the process tree, grandchild included, within 2 s', async () => {
    const pidFile = join(dir, 'grandchild.pid');
    const controller = new AbortController();
    const run = start('hang-with-child', { env: { FAKE_CLI_PIDFILE: pidFile }, signal: controller.signal });
    const iterator = run.lines[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('{"type":"ready"}');
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);

    const stoppedAt = Date.now();
    controller.abort();
    const exit = await run.exit;
    expect(exit.killed).toBe(true);
    for (let i = 0; i < 40 && alive(grandchild); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(alive(grandchild)).toBe(false);
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
  });

  it('reports a binary that does not exist instead of throwing', async () => {
    const run = runCli({
      command: join(dir, 'missing.exe'),
      args: [],
      cwd: dir,
      env: process.env,
      stdin: '',
      signal: new AbortController().signal,
    });
    expect(await collect(run.lines)).toEqual([]);
    expect((await run.exit).spawnError?.code).toBe('ENOENT');
  });
});
```

- [ ] **Step 3: Run to see failures** — `pnpm --filter @ace/providers exec vitest run src/adapters/cli` → FAIL (modules missing).

- [ ] **Step 4: Implement**

`packages/providers/src/adapters/cli/lines.ts`:

```ts
/**
 * Coding-agent CLIs speak JSONL on stdout (X1 spec §5). A read can end mid-line and a CLI can print
 * a banner or warning between events, so lines are reassembled first and a line that is not a JSON
 * object is skipped — never fatal (review focus 5).
 */
export function createLineSplitter(): { push(chunk: string): string[]; end(): string[] } {
  let rest = '';
  return {
    push(chunk) {
      rest += chunk;
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? '';
      return parts.filter((line) => line.trim() !== '');
    },
    end() {
      const last = rest.trim();
      rest = '';
      return last === '' ? [] : [last];
    },
  };
}

export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
```

`packages/providers/src/adapters/cli/resolve.ts`:

```ts
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

/**
 * Turns a CLI name into something `spawn` can start **without a shell** (X1 §5, Node DEP0190).
 *
 * npm installs a CLI on Windows as a `.cmd` shim, which only a shell can run. A shim is a few lines
 * that end by calling the real program — a native `.exe`, or `node` on a `.js` entry point — so the
 * shim is read and its target spawned directly. A `.cmd` that cannot be unwrapped is skipped: a
 * shell is exactly what this exists to avoid (review focus 1).
 */
export interface ResolvedCommand {
  /** The executable to spawn. */
  command: string;
  /** Arguments that go before the CLI's own — the script path when `command` is node. */
  prefixArgs: string[];
  /** The file found on PATH, for display. */
  path: string;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The Node binary that runs a `.js` entry point; the engine's own by default. */
  nodeBinary?: string;
}

const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The program an npm `.cmd` shim ends by running, or `undefined` when it names none we can find. */
function shimTarget(shim: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shim, 'utf8');
  } catch {
    return undefined;
  }
  const matches = [...text.matchAll(/"%~?dp0%?([^"]+?\.(?:exe|cjs|mjs|js))"/gi)];
  const relative = matches.at(-1)?.[1];
  if (relative === undefined) return undefined;
  const target = join(dirname(shim), ...relative.split(/[\\/]+/).filter((part) => part !== ''));
  return isFile(target) ? target : undefined;
}

function toCommand(
  file: string,
  platform: NodeJS.Platform,
  nodeBinary: string,
): ResolvedCommand | undefined {
  const extension = extname(file).toLowerCase();
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    const target = shimTarget(file);
    if (target === undefined) return undefined;
    return SCRIPT_EXTENSIONS.has(extname(target).toLowerCase())
      ? { command: nodeBinary, prefixArgs: [target], path: file }
      : { command: target, prefixArgs: [], path: file };
  }
  if (SCRIPT_EXTENSIONS.has(extension)) {
    return { command: nodeBinary, prefixArgs: [file], path: file };
  }
  return { command: file, prefixArgs: [], path: file };
}

export function resolveCommand(
  name: string,
  options: ResolveOptions = {},
): ResolvedCommand | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const pathValue = env['PATH'] ?? env['Path'] ?? '';
  const pathExt = (env['PATHEXT'] ?? '').toLowerCase().split(';').filter((ext) => ext !== '');
  const extensions = platform === 'win32' ? [...new Set(['.exe', '.cmd', '.bat', ...pathExt])] : [''];

  for (const dir of pathValue.split(platform === 'win32' ? ';' : ':')) {
    if (dir.trim() === '') continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (!isFile(candidate)) continue;
      const command = toCommand(candidate, platform, nodeBinary);
      if (command !== undefined) return command;
    }
  }
  return undefined;
}
```

`packages/providers/src/adapters/cli/runner.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';

import { createLineSplitter } from './lines.js';

/**
 * Runs one CLI call (X1 §5): the prompt goes on stdin (no quoting, no 32 K command-line limit —
 * review focus 3), stdout comes back a line at a time, and an abort kills the whole process tree,
 * because these CLIs start children of their own (review focus 2). Never a shell.
 */

export const STDERR_TAIL_CHARS = 8 * 1024;
/** How long an aborted call waits for the process to close before giving up on it. */
const KILL_SETTLE_MS = 1_500;

export interface CliRunOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  signal: AbortSignal;
  platform?: NodeJS.Platform;
}

export interface CliExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The last {@link STDERR_TAIL_CHARS} characters of stderr, for an error message. */
  stderrTail: string;
  /** Set when the process never started — ENOENT for a missing binary or working folder. */
  spawnError?: NodeJS.ErrnoException;
  /** The call was aborted and the tree killed. */
  killed: boolean;
}

export interface CliRun {
  lines: AsyncIterable<string>;
  exit: Promise<CliExit>;
}

/**
 * The code sandbox's rule (`packages/tools/src/sandbox/runner.ts`), repeated here because providers
 * may not import tools (CLAUDE.md §3.4 rule 3): `taskkill /T` on Windows, the process group elsewhere.
 */
export function killTree(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => undefined);
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

/** A minimal async queue: pushes until closed, then drains and ends. */
function createChannel<T>(): AsyncIterable<T> & { push(item: T): void; close(): void } {
  const items: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    push(item) {
      if (closed) return;
      items.push(item);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length > 0) {
          yield items.shift() as T;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

export function runCli(options: CliRunOptions): CliRun {
  const platform = options.platform ?? process.platform;
  const output = createChannel<string>();
  const splitter = createLineSplitter();
  let stderrTail = '';
  let killed = false;
  let child: ChildProcess | undefined;
  let settle: (result: Omit<CliExit, 'stderrTail' | 'killed'>) => void = () => undefined;

  const onAbort = (): void => {
    killed = true;
    if (child?.pid !== undefined) killTree(child.pid, platform);
    // A process that ignores the kill must not hang the call.
    setTimeout(() => settle({ code: null, signal: 'SIGKILL' }), KILL_SETTLE_MS).unref();
  };

  const exit = new Promise<CliExit>((resolve) => {
    let settled = false;
    settle = (result) => {
      if (settled) return;
      settled = true;
      for (const line of splitter.end()) output.push(line);
      output.close();
      options.signal.removeEventListener('abort', onAbort);
      resolve({ ...result, stderrTail, killed });
    };
  });

  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: lead a process group, so one kill reaches everything the CLI started.
      detached: platform !== 'win32',
    });
  } catch (error) {
    settle({ code: null, signal: null, spawnError: error as NodeJS.ErrnoException });
    return { lines: output, exit };
  }

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    for (const line of splitter.push(chunk)) output.push(line);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  child.on('error', (error: NodeJS.ErrnoException) =>
    settle({ code: null, signal: null, spawnError: error }),
  );
  child.on('close', (code, signal) => settle({ code, signal }));

  // A CLI that exits before reading everything closes the pipe; that is its answer, not a crash.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(options.stdin, 'utf8');

  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener('abort', onAbort, { once: true });

  return { lines: output, exit };
}
```

- [ ] **Step 5: Run tests and lint**

```bash
pnpm --filter @ace/providers exec vitest run src/adapters/cli
pnpm --filter @ace/providers lint
```
Expected: tests PASS. If lint reports `fake-cli.mjs` (e.g. `no-undef` on `process`/`Buffer`), change `packages/providers/eslint.config.js` to:

```js
import { engineAdapter } from '@ace/config/eslint.config.js';

export default [{ ignores: ['src/**/__tests__/fixtures/**'] }, ...engineAdapter];
```

and re-run lint → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/providers
git commit -m "feat(providers): run a CLI without a shell — resolver, runner, line reader [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The terminal scan — installed, version, sign-in

**Files:**
- Create: `packages/providers/src/adapters/cli/detect.ts`
- Test: create `packages/providers/src/adapters/cli/__tests__/detect.test.ts`

**Interfaces:**
- Consumes: `resolveCommand`, `ResolvedCommand` (Task 8); `CLI_PROVIDER_TYPES`, `CLI_INSTALL_HINTS`, `CLI_LOGIN_HINTS`, `CliDetection`, `CliDetectResponse`, `CliProviderType` (Task 2).
- Produces:
  - `CLI_BINARIES: Record<CliProviderType, string>` = `{ claude_code: 'claude', codex_cli: 'codex', gemini_cli: 'gemini' }`
  - `interface ProbeResult { code: number | null; stdout: string; stderr: string }`
  - `interface DetectDeps { resolve?: (bin: string) => ResolvedCommand | undefined; probe?: (command: ResolvedCommand, args: string[], timeoutMs: number) => Promise<ProbeResult>; env?: NodeJS.ProcessEnv; homeDir?: string }`
  - `probeCommand(command, args, timeoutMs): Promise<ProbeResult>`
  - `detectCli(type: CliProviderType, deps?: DetectDeps): Promise<CliDetection>`
  - `interface CliDetector { detect(type, options?: { force?: boolean }): Promise<CliDetection>; detectAll(options?: { force?: boolean }): Promise<CliDetectResponse> }`
  - `createCliDetector(deps?: DetectDeps & { ttlMs?: number; now?: () => number }): CliDetector`

- [ ] **Step 1: Write the failing test** — `detect.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliDetector, detectCli, type ProbeResult } from '../detect.js';
import type { ResolvedCommand } from '../resolve.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ace-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const found = (bin: string): ResolvedCommand => ({
  command: `/usr/bin/${bin}`,
  prefixArgs: [],
  path: `/usr/bin/${bin}`,
});

/** A probe that answers by the arguments it was given. */
function probes(answers: Record<string, ProbeResult>) {
  const asked: string[] = [];
  return {
    asked,
    probe: async (_command: ResolvedCommand, args: string[]): Promise<ProbeResult> => {
      const key = args.join(' ');
      asked.push(key);
      return answers[key] ?? { code: 1, stdout: '', stderr: 'unknown command' };
    },
  };
}

describe('FR-PRV-008 the terminal scan (X1)', () => {
  it('reports Claude Code installed and signed in, keeping no identity (D264)', async () => {
    const { probe } = probes({
      '--version': { code: 0, stdout: '2.1.282 (Claude Code)\n', stderr: '' },
      'auth status --json': {
        code: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'me@example.com',
          orgName: 'Me',
          subscriptionType: 'max',
        }),
        stderr: '',
      },
    });
    const result = await detectCli('claude_code', { resolve: found, probe, env: {}, homeDir: home });
    expect(result).toEqual({
      type: 'claude_code',
      installed: true,
      version: '2.1.282',
      path: '/usr/bin/claude',
      login: 'logged_in',
      loginDetail: 'claude.ai · max',
      installHint: 'npm install -g @anthropic-ai/claude-code',
      loginHint: 'claude auth login',
    });
    expect(JSON.stringify(result)).not.toContain('me@example.com');
  });

  it('reports Claude Code installed but signed out', async () => {
    const { probe } = probes({
      '--version': { code: 0, stdout: '2.1.282 (Claude Code)', stderr: '' },
      'auth status --json': {
        code: 1,
        stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
        stderr: '',
      },
    });
    expect(
      (await detectCli('claude_code', { resolve: found, probe, env: {}, homeDir: home })).login,
    ).toBe('logged_out');
  });

  it('reports a CLI that is not on PATH with only its hints, running nothing', async () => {
    const { probe, asked } = probes({});
    expect(
      await detectCli('codex_cli', { resolve: () => undefined, probe, env: {}, homeDir: home }),
    ).toEqual({
      type: 'codex_cli',
      installed: false,
      login: 'unknown',
      installHint: 'npm install -g @openai/codex',
      loginHint: 'codex login',
    });
    expect(asked).toEqual([]);
  });

  it('reads Codex sign-in from `codex login status` (stderr), or CODEX_API_KEY', async () => {
    const signedIn = probes({
      '--version': { code: 0, stdout: 'codex-cli 0.160.1', stderr: '' },
      'login status': { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' },
    });
    expect(
      await detectCli('codex_cli', { resolve: found, probe: signedIn.probe, env: {}, homeDir: home }),
    ).toMatchObject({ version: '0.160.1', login: 'logged_in', loginDetail: 'ChatGPT' });

    const signedOut = probes({
      '--version': { code: 0, stdout: 'codex-cli 0.160.1', stderr: '' },
      'login status': { code: 1, stdout: '', stderr: 'Not logged in' },
    });
    expect(
      (await detectCli('codex_cli', { resolve: found, probe: signedOut.probe, env: {}, homeDir: home })).login,
    ).toBe('logged_out');
    expect(
      await detectCli('codex_cli', {
        resolve: found,
        probe: signedOut.probe,
        env: { CODEX_API_KEY: 'k' },
        homeDir: home,
      }),
    ).toMatchObject({ login: 'logged_in', loginDetail: 'CODEX_API_KEY' });
  });

  it('reads Gemini’s sign-in method from env or settings, never its tokens', async () => {
    const { probe } = probes({ '--version': { code: 0, stdout: '0.62.0', stderr: '' } });
    expect(
      await detectCli('gemini_cli', { resolve: found, probe, env: { GEMINI_API_KEY: 'k' }, homeDir: home }),
    ).toMatchObject({ version: '0.62.0', login: 'logged_in', loginDetail: 'GEMINI_API_KEY' });

    mkdirSync(join(home, '.gemini'));
    writeFileSync(
      join(home, '.gemini', 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
    );
    expect(
      await detectCli('gemini_cli', { resolve: found, probe, env: {}, homeDir: home }),
    ).toMatchObject({ login: 'unknown', loginDetail: 'Google sign-in (oauth-personal)' });

    rmSync(join(home, '.gemini'), { recursive: true });
    expect(
      (await detectCli('gemini_cli', { resolve: found, probe, env: {}, homeDir: home })).login,
    ).toBe('logged_out');
  });

  it('caches a scan for its TTL and refreshes when forced', async () => {
    let now = 0;
    const { probe, asked } = probes({
      '--version': { code: 0, stdout: '2.1.282', stderr: '' },
      'auth status --json': { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
    });
    const detector = createCliDetector({
      resolve: found,
      probe,
      env: {},
      homeDir: home,
      ttlMs: 60_000,
      now: () => now,
    });
    await detector.detect('claude_code');
    await detector.detect('claude_code');
    expect(asked.filter((arg) => arg === '--version')).toHaveLength(1);
    now = 61_000;
    await detector.detect('claude_code');
    await detector.detect('claude_code', { force: true });
    expect(asked.filter((arg) => arg === '--version')).toHaveLength(3);
  });

  it('scans all three in CLI_PROVIDER_TYPES order', async () => {
    const { probe } = probes({});
    const detector = createCliDetector({ resolve: () => undefined, probe, env: {}, homeDir: home });
    expect((await detector.detectAll()).items.map((item) => item.type)).toEqual([
      'claude_code',
      'codex_cli',
      'gemini_cli',
    ]);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm --filter @ace/providers exec vitest run src/adapters/cli/__tests__/detect.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `packages/providers/src/adapters/cli/detect.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_INSTALL_HINTS,
  CLI_LOGIN_HINTS,
  CLI_PROVIDER_TYPES,
  type CliDetectResponse,
  type CliDetection,
  type CliProviderType,
} from '@ace/contracts';

import { resolveCommand, type ResolvedCommand } from './resolve.js';

/**
 * The terminal scan (X1, FR-PRV-008): is each CLI on PATH, which version, is it signed in?
 *
 * Sign-in comes only from what the CLI itself reports (`claude auth status`, `codex login status`)
 * or, for Gemini, which has no status command, from which sign-in *method* is configured. ACE never
 * opens a credential file (D264), and keeps no identity — an email or org name is dropped here.
 */

export const CLI_BINARIES: Readonly<Record<CliProviderType, string>> = {
  claude_code: 'claude',
  codex_cli: 'codex',
  gemini_cli: 'gemini',
};

/** Each probe gets this long; a CLI that hangs on `--version` is reported found, version unknown. */
const PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_TTL_MS = 60_000;

export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface DetectDeps {
  resolve?: (bin: string) => ResolvedCommand | undefined;
  probe?: (command: ResolvedCommand, args: string[], timeoutMs: number) => Promise<ProbeResult>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** Runs a short command without a shell and collects what it printed. Never throws. */
export function probeCommand(
  command: ResolvedCommand,
  args: string[],
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    try {
      child = spawn(command.command, [...command.prefixArgs, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: timeoutMs,
      });
    } catch {
      resolve({ code: null, stdout, stderr });
      return;
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => resolve({ code: null, stdout, stderr }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const versionIn = (text: string): string | undefined => /\d+\.\d+\.\d+[\w.-]*/.exec(text)?.[0];

type Login = { login: CliDetection['login']; loginDetail?: string };
type Probe = NonNullable<DetectDeps['probe']>;

async function claudeLogin(command: ResolvedCommand, probe: Probe): Promise<Login> {
  const status = await probe(command, ['auth', 'status', '--json'], PROBE_TIMEOUT_MS);
  let parsed: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown } = {};
  try {
    parsed = JSON.parse(status.stdout) as typeof parsed;
  } catch {
    parsed = {};
  }
  // Only the method and the plan — never the email or org the status also prints (D264).
  const detail = [parsed.authMethod, parsed.subscriptionType]
    .filter((part): part is string => typeof part === 'string' && part !== '' && part !== 'none')
    .join(' · ');
  if (status.code === 0 && parsed.loggedIn !== false) {
    return { login: 'logged_in', ...(detail === '' ? {} : { loginDetail: detail }) };
  }
  return status.code === null ? { login: 'unknown' } : { login: 'logged_out' };
}

async function codexLogin(
  command: ResolvedCommand,
  probe: Probe,
  env: NodeJS.ProcessEnv,
): Promise<Login> {
  const status = await probe(command, ['login', 'status'], PROBE_TIMEOUT_MS);
  if (status.code === 0) {
    const said = `${status.stdout}\n${status.stderr}`.trim();
    const detail = /logged in using (.+)/i.exec(said)?.[1]?.trim().split(/\s+-\s+/)[0];
    return { login: 'logged_in', ...(detail === undefined ? {} : { loginDetail: detail }) };
  }
  if ((env['CODEX_API_KEY'] ?? '') !== '') {
    return { login: 'logged_in', loginDetail: 'CODEX_API_KEY' };
  }
  return status.code === null ? { login: 'unknown' } : { login: 'logged_out' };
}

function geminiLogin(env: NodeJS.ProcessEnv, homeDir: string): Login {
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const) {
    if ((env[key] ?? '') !== '') return { login: 'logged_in', loginDetail: key };
  }
  if ((env['GOOGLE_GENAI_USE_VERTEXAI'] ?? '') === 'true') {
    return { login: 'logged_in', loginDetail: 'Vertex AI' };
  }
  try {
    const settings = JSON.parse(readFileSync(join(homeDir, '.gemini', 'settings.json'), 'utf8')) as {
      security?: { auth?: { selectedType?: unknown } };
      selectedAuthType?: unknown;
    };
    const method = settings.security?.auth?.selectedType ?? settings.selectedAuthType;
    if (typeof method === 'string' && method !== '') {
      // A method is configured; whether its sign-in is still valid shows on the first run.
      return { login: 'unknown', loginDetail: `Google sign-in (${method})` };
    }
  } catch {
    // No settings: Gemini has never been signed in on this machine.
  }
  return { login: 'logged_out' };
}

export async function detectCli(
  type: CliProviderType,
  deps: DetectDeps = {},
): Promise<CliDetection> {
  const env = deps.env ?? process.env;
  const probe = deps.probe ?? probeCommand;
  const hints = { installHint: CLI_INSTALL_HINTS[type], loginHint: CLI_LOGIN_HINTS[type] };
  const resolve = deps.resolve ?? ((bin: string) => resolveCommand(bin, { env }));
  const command = resolve(CLI_BINARIES[type]);
  if (command === undefined) return { type, installed: false, login: 'unknown', ...hints };

  const versionProbe = await probe(command, ['--version'], PROBE_TIMEOUT_MS);
  const version = versionIn(`${versionProbe.stdout} ${versionProbe.stderr}`);
  const login: Login =
    type === 'claude_code'
      ? await claudeLogin(command, probe)
      : type === 'codex_cli'
        ? await codexLogin(command, probe, env)
        : geminiLogin(env, deps.homeDir ?? homedir());

  return {
    type,
    installed: true,
    ...(version === undefined ? {} : { version }),
    path: command.path,
    login: login.login,
    ...(login.loginDetail === undefined ? {} : { loginDetail: login.loginDetail }),
    ...hints,
  };
}

export interface CliDetector {
  detect(type: CliProviderType, options?: { force?: boolean }): Promise<CliDetection>;
  detectAll(options?: { force?: boolean }): Promise<CliDetectResponse>;
}

/**
 * A scan is a handful of process starts, so it is cached: the 60 s provider health check reads the
 * cache, and the Add-provider scan forces a fresh one.
 */
export function createCliDetector(
  deps: DetectDeps & { ttlMs?: number; now?: () => number } = {},
): CliDetector {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<CliProviderType, { at: number; value: Promise<CliDetection> }>();

  const detect: CliDetector['detect'] = (type, options = {}) => {
    const hit = cache.get(type);
    if (hit !== undefined && options.force !== true && now() - hit.at < ttl) return hit.value;
    const value = detectCli(type, deps);
    cache.set(type, { at: now(), value });
    // A failed scan must not stay cached.
    value.catch(() => cache.delete(type));
    return value;
  };

  return {
    detect,
    detectAll: async (options = {}) => ({
      items: await Promise.all(CLI_PROVIDER_TYPES.map((type) => detect(type, options))),
    }),
  };
}
```

- [ ] **Step 4: Run tests** — `pnpm --filter @ace/providers exec vitest run src/adapters/cli` → PASS; `pnpm --filter @ace/providers typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/adapters/cli
git commit -m "feat(providers): terminal scan — installed, version and sign-in per CLI [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The shared CLI adapter and the Claude Code dialect

**Files:**
- Create: `packages/providers/src/adapters/cli/adapter.ts`, `packages/providers/src/adapters/cli/claude-code.ts`
- Modify: `packages/providers/src/index.ts` (exports)
- Test: create `packages/providers/src/adapters/cli/__tests__/claude-code.test.ts`, `packages/providers/src/adapters/cli/__tests__/claude-code.provider.test.ts` (real, excluded from `pnpm test`)
- Fixtures: `__tests__/fixtures/claude-plain.jsonl`, `claude-read-tool.jsonl` (Task 0 Step 3)

**Interfaces:**
- Consumes: `runCli`, `CliExit` (Task 8); `parseJsonLine` (Task 8); `resolveCommand`, `ResolvedCommand` (Task 8); `ProviderCallError`, `abortedCallError`, `mapProviderError` (`adapter.ts`); `CliDetection`, `CliPermission`, `CliProviderType`, `CLI_INSTALL_HINTS` (Tasks 1–2); `StreamChunk.activity`, `usage.costUsd`, `GenerateRequest.workingDir` (Task 5).
- Produces:
  - `interface CliParser { onEvent(event: Record<string, unknown>): StreamChunk[]; finish(exit: CliExit): StreamChunk[] }`
  - `interface CliDialect { type: CliProviderType; bin: string; label: string; args(req: GenerateRequest, permission: CliPermission): string[]; stdin(req: GenerateRequest): string; env?(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv; createParser(): CliParser; listModels(resolve: () => ResolvedCommand | undefined): Promise<ModelInfo[]> }`
  - `interface CliAdapterOptions { permission: CliPermission; detect: () => Promise<CliDetection>; resolve?: () => ResolvedCommand | undefined; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }`
  - `createCliAdapter(dialect: CliDialect, options: CliAdapterOptions): ProviderAdapter`
  - `cliModel(modelId: string, displayName: string): ModelInfo`, `tokenCount(value: unknown): number`, `cliExitError(label: string, exit: CliExit): NodeError`, `summariseToolOutput(content: unknown): string`, `withSystem(req: GenerateRequest): string`
  - `CLAUDE_CODE_BASE_ARGS`, `CLAUDE_CODE_MODELS`, `claudeCodeDialect`, `createClaudeCodeParser(now?)`, `claudeResultError(result)`, `createClaudeCodeAdapter(options: CliAdapterOptions): ProviderAdapter`

- [ ] **Step 1: Re-record the fixtures if Task 0 Step 3 could not copy them** (real Claude Code, two short Haiku calls; skip if both fixture files exist):

```bash
P="$(mktemp -d)"; cd "$P"; printf 'hello from ace\n' > hello.txt
echo "Reply with the single word OK." | claude -p --output-format stream-json --verbose --include-partial-messages --setting-sources "" --strict-mcp-config --permission-prompts none --permission-mode dontAsk --tools "" --model haiku > plain.jsonl
echo "Use the Read tool to read hello.txt, then reply with its exact content." | claude -p --output-format stream-json --verbose --include-partial-messages --setting-sources "" --strict-mcp-config --permission-prompts none --permission-mode dontAsk --tools "Read" --model haiku > tool.jsonl
cp plain.jsonl "D:/ACE offcl/wt/x1/packages/providers/src/adapters/cli/__tests__/fixtures/claude-plain.jsonl"
cp tool.jsonl "D:/ACE offcl/wt/x1/packages/providers/src/adapters/cli/__tests__/fixtures/claude-read-tool.jsonl"
```

- [ ] **Step 2: Write the failing test** — `claude-code.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliDetection } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StreamChunk } from '../../../adapter.js';
import { parseJsonLine } from '../lines.js';
import {
  CLAUDE_CODE_BASE_ARGS,
  claudeCodeDialect,
  claudeResultError,
  createClaudeCodeAdapter,
  createClaudeCodeParser,
} from '../claude-code.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-claude-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const signedIn: CliDetection = {
  type: 'claude_code',
  installed: true,
  version: '2.1.282',
  login: 'logged_in',
  loginDetail: 'claude.ai · max',
  installHint: 'npm install -g @anthropic-ai/claude-code',
  loginHint: 'claude auth login',
};

/** Feeds a recorded JSONL file through the parser, as the adapter would. */
function replay(name: string): StreamChunk[] {
  const parser = createClaudeCodeParser(() => 0);
  const chunks: StreamChunk[] = [];
  for (const line of readFileSync(fixture(name), 'utf8').split('\n')) {
    const event = parseJsonLine(line);
    if (event !== undefined) chunks.push(...parser.onEvent(event));
  }
  chunks.push(...parser.finish({ code: 0, signal: null, stderrTail: '', killed: false }));
  return chunks;
}

const textOf = (chunks: StreamChunk[]): string =>
  chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.delta] : [])).join('');

function fakeAdapter(env: Record<string, string>, permission: 'read_only' | 'edit_files' | 'full_auto' = 'edit_files') {
  return createClaudeCodeAdapter({
    permission,
    detect: async () => signedIn,
    resolve: () => ({ command: process.execPath, prefixArgs: [FAKE], path: FAKE }),
    env: { ...process.env, ...env },
  });
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('X1 Claude Code flags (spec §5.1, verified 2026-10-06)', () => {
  const req = { modelId: 'sonnet', prompt: 'p', outputTypes: ['text' as const], system: 'You are a node.' };

  it('keeps the user’s hooks and plugins out and never prompts', () => {
    expect([...CLAUDE_CODE_BASE_ARGS]).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--setting-sources', '', '--strict-mcp-config', '--permission-prompts', 'none',
    ]);
  });

  it.each([
    ['read_only', ['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob']],
    ['edit_files', ['--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Grep,Glob']],
    ['full_auto', ['--permission-mode', 'bypassPermissions']],
  ] as const)('maps %s to its preset flags', (permission, flags) => {
    expect(claudeCodeDialect.args(req, permission)).toEqual([
      ...CLAUDE_CODE_BASE_ARGS,
      ...flags,
      '--model',
      'sonnet',
      '--append-system-prompt',
      'You are a node.',
    ]);
  });

  it('leaves the model to the CLI for "default", and sends the prompt on stdin only', () => {
    const args = claudeCodeDialect.args({ ...req, modelId: 'default', system: '' }, 'read_only');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--append-system-prompt');
    expect(claudeCodeDialect.stdin(req)).toBe('p');
  });
});

describe('X1 Claude Code stream (recorded from the real CLI)', () => {
  it('streams the answer and reports usage with the CLI’s own cost (D263)', () => {
    const chunks = replay('claude-plain.jsonl');
    expect(textOf(chunks)).toBe('OK');
    expect(chunks.at(-2)).toEqual({ type: 'usage', tokensIn: 7854, tokensOut: 330, costUsd: 0.018303 });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('records the CLI’s own tool use as activity', () => {
    const chunks = replay('claude-read-tool.jsonl');
    const activity = chunks.filter((chunk) => chunk.type === 'activity');
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ type: 'activity', tool: 'Read', status: 'ok', summary: '1 hello from ace 2' });
    expect(textOf(chunks)).toContain('hello from ace');
  });

  it('ignores events it does not know and text from a sub-agent', () => {
    const parser = createClaudeCodeParser(() => 0);
    expect(parser.onEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toEqual([]);
    expect(parser.onEvent({ type: 'system', subtype: 'thinking_tokens' })).toEqual([]);
    expect(
      parser.onEvent({
        type: 'stream_event',
        parent_tool_use_id: 'toolu_sub',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub-agent chatter' } },
      }),
    ).toEqual([]);
  });

  it('separates the answer’s messages with a blank line', () => {
    const parser = createClaudeCodeParser(() => 0);
    const delta = (text: string) => ({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
    const start = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } };
    const out = [start, delta('I will edit it.'), start, delta('Done.')].flatMap((e) => parser.onEvent(e));
    expect(textOf(out)).toBe('I will edit it.\n\nDone.');
  });
});

describe('X1 Claude Code failures (spec §5.2)', () => {
  it('reads "not logged in" as an auth failure', () => {
    expect(
      claudeResultError({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }),
    ).toMatchObject({ kind: 'auth', code: 'cli_not_signed_in', retryable: false });
  });

  it('reads a plan limit as a retryable 429', () => {
    expect(
      claudeResultError({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: '5-hour limit reached' }),
    ).toMatchObject({ kind: 'provider', code: 'http_429', retryable: true });
  });

  it('reads the turn limit as the agent’s own failure', () => {
    expect(claudeResultError({ type: 'result', subtype: 'error_max_turns', is_error: true })).toMatchObject({
      kind: 'agent',
      code: 'cli_max_turns',
    });
  });

  it('turns an exit with no result into an error carrying the stderr tail', async () => {
    const error = await drain(
      fakeAdapter({ FAKE_CLI_MODE: 'stderr-exit' }).generate(
        { modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: dir },
        new AbortController().signal,
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ nodeError: { kind: 'provider', code: 'cli_exit_3', retryable: false } });
    expect((error as { nodeError: { message: string } }).nodeError.message).toContain('END');
  });

  it('never retries a call that already acted, even on a plan limit', async () => {
    const file = join(dir, 'acted-then-limited.jsonl');
    writeFileSync(
      file,
      [
        { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.js' } }] } },
        { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'limit reached' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    );
    const error = await drain(
      fakeAdapter({ FAKE_CLI_MODE: 'replay', FAKE_CLI_FILE: file }).generate(
        { modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: dir },
        new AbortController().signal,
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ nodeError: { code: 'http_429', retryable: false } });
  });
});

describe('X1 the Claude Code adapter end to end, against a fake CLI', () => {
  it('replays a recorded run as chunks', async () => {
    const chunks = await drain(
      fakeAdapter({ FAKE_CLI_MODE: 'replay', FAKE_CLI_FILE: fixture('claude-read-tool.jsonl') }).generate(
        { modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: dir },
        new AbortController().signal,
      ),
    );
    expect(chunks.some((chunk) => chunk.type === 'activity')).toBe(true);
    expect(chunks.find((chunk) => chunk.type === 'usage')).toMatchObject({ costUsd: expect.any(Number) });
  });

  it('runs read-only in a throwaway folder when there is no project folder', async () => {
    const echo = join(dir, 'echo.json');
    await drain(
      fakeAdapter({ FAKE_CLI_MODE: 'echo-stdin', FAKE_CLI_ECHO_FILE: echo }, 'full_auto').generate(
        { modelId: 'haiku', prompt: 'hello', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    ).catch(() => undefined);
    const seen = JSON.parse(readFileSync(echo, 'utf8')) as { argv: string[]; cwd: string; text: string };
    expect(seen.text).toBe('hello');
    expect(seen.argv).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
    expect(seen.argv).not.toContain('bypassPermissions');
    expect(seen.cwd).toContain('ace-cli-');
    expect(existsSync(seen.cwd)).toBe(false);
  });

  it('refuses a project folder that does not exist', async () => {
    const error = await drain(
      fakeAdapter({ FAKE_CLI_MODE: 'echo-stdin' }).generate(
        { modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: join(dir, 'gone') },
        new AbortController().signal,
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ nodeError: { kind: 'invalid_config', code: 'project_folder_missing' } });
  });

  it('a Stop ends the call as user_cancelled and kills the CLI', async () => {
    const controller = new AbortController();
    const pending = drain(
      fakeAdapter({ FAKE_CLI_MODE: 'hang-with-child', FAKE_CLI_PIDFILE: join(dir, 'pid') }).generate(
        { modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: dir },
        controller.signal,
      ),
    ).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 300);
    expect(await pending).toMatchObject({ nodeError: { kind: 'user_cancelled' } });
  });

  it('reports a missing CLI with its install hint', async () => {
    const adapter = createClaudeCodeAdapter({ permission: 'edit_files', detect: async () => signedIn, resolve: () => undefined });
    const error = await drain(
      adapter.generate({ modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: dir }, new AbortController().signal),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ nodeError: { code: 'cli_not_found', retryable: false } });
    expect((error as { nodeError: { message: string } }).nodeError.message).toContain('npm install -g @anthropic-ai/claude-code');
  });
});

describe('X1 check() reads the terminal scan (D265)', () => {
  const adapterWith = (found: CliDetection) =>
    createClaudeCodeAdapter({ permission: 'edit_files', detect: async () => found });

  it('installed and signed in → CONNECTED, with version and sign-in method', async () => {
    expect(await adapterWith(signedIn).check()).toEqual({ status: 'CONNECTED', message: 'v2.1.282 · claude.ai · max' });
  });
  it('signed out → AUTH_FAILED, saying what to run', async () => {
    expect(await adapterWith({ ...signedIn, login: 'logged_out' }).check()).toMatchObject({
      status: 'AUTH_FAILED',
      message: expect.stringContaining('claude auth login'),
    });
  });
  it('not installed → UNREACHABLE, saying how to install', async () => {
    expect(await adapterWith({ ...signedIn, installed: false }).check()).toMatchObject({
      status: 'UNREACHABLE',
      message: expect.stringContaining('npm install -g @anthropic-ai/claude-code'),
    });
  });
});
```

- [ ] **Step 3: Run to see it fail** — `pnpm --filter @ace/providers exec vitest run src/adapters/cli/__tests__/claude-code.test.ts` → FAIL (modules missing).

- [ ] **Step 4: Implement the shared adapter** — `packages/providers/src/adapters/cli/adapter.ts`:

```ts
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_INSTALL_HINTS,
  type CliDetection,
  type CliPermission,
  type CliProviderType,
  type NodeError,
} from '@ace/contracts';

import {
  ProviderCallError,
  abortedCallError,
  mapProviderError,
  type GenerateRequest,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderStatus,
  type StreamChunk,
} from '../../adapter.js';
import { parseJsonLine } from './lines.js';
import { resolveCommand, type ResolvedCommand } from './resolve.js';
import { runCli, type CliExit } from './runner.js';

/**
 * One adapter for every coding-agent CLI (X1 spec §5, D261): spawn the real CLI in the project
 * folder with the provider's permission preset, feed the prompt on stdin, and translate its JSONL
 * into `StreamChunk`s. Each CLI supplies only a {@link CliDialect} — its flags and its parser.
 */

/** Turns one CLI's events into chunks. A fresh parser per call. */
export interface CliParser {
  onEvent(event: Record<string, unknown>): StreamChunk[];
  /** After stdout ends: the closing usage and finish chunks, or a thrown `ProviderCallError`. */
  finish(exit: CliExit): StreamChunk[];
}

export interface CliDialect {
  type: CliProviderType;
  /** The command on PATH. */
  bin: string;
  /** How messages name it. */
  label: string;
  args(req: GenerateRequest, permission: CliPermission): string[];
  stdin(req: GenerateRequest): string;
  env?(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  createParser(): CliParser;
  /** The models it offers; `resolve` finds the binary, for a CLI that can list its own. */
  listModels(resolve: () => ResolvedCommand | undefined): Promise<ModelInfo[]>;
}

export interface CliAdapterOptions {
  permission: CliPermission;
  /** The terminal scan for this CLI — what `check()` reports. */
  detect: () => Promise<CliDetection>;
  /** Finds the binary; `resolveCommand(dialect.bin)` by default. Tests point it at a fake. */
  resolve?: () => ResolvedCommand | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** A CLI model: text in, text out, the CLI's own tools rather than ACE's (spec §5.1). */
export function cliModel(modelId: string, displayName: string): ModelInfo {
  return {
    modelId,
    displayName,
    inputTypes: ['text'],
    outputTypes: ['text', 'json', 'code'],
    contextWindow: 200_000,
    supportsTools: false,
    supportsJson: false,
  };
}

/** ACE's system section first, then the prompt — for CLIs with no system-prompt flag. */
export function withSystem(req: GenerateRequest): string {
  return req.system === undefined || req.system === '' ? req.prompt : `${req.system}\n\n${req.prompt}`;
}

/** What a tool returned, as one line for the inspector (FR-TOOL-009 keeps 500 characters). */
export function summariseToolOutput(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : '',
            )
            .join(' ')
        : JSON.stringify(content ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** A token count from a CLI's JSON, or 0 when it is missing or not a number. */
export const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** A CLI that ended without its result event. */
export function cliExitError(label: string, exit: CliExit): NodeError {
  if (exit.spawnError !== undefined) {
    return {
      kind: 'provider',
      code: exit.spawnError.code === 'ENOENT' ? 'cli_not_found' : 'cli_spawn_failed',
      message: `${label} could not be started: ${exit.spawnError.message}`,
      retryable: false,
    };
  }
  const tail = exit.stderrTail.trim().split(/\r?\n/).slice(-5).join(' ').slice(-500);
  const how = exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `code ${exit.code}`;
  return {
    kind: 'provider',
    code: `cli_exit_${exit.code ?? 'signal'}`,
    message: `${label} exited with ${how}${tail === '' ? ' and no output' : `: ${tail}`}`,
    retryable: false,
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createCliAdapter(dialect: CliDialect, options: CliAdapterOptions): ProviderAdapter {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const resolve = options.resolve ?? (() => resolveCommand(dialect.bin, { env, platform }));

  return {
    type: dialect.type,

    async check(): Promise<ProviderStatus> {
      const found = await options.detect();
      if (!found.installed) {
        return { status: 'UNREACHABLE', message: `${dialect.label} is not installed — ${found.installHint}` };
      }
      if (found.login === 'logged_out') {
        return {
          status: 'AUTH_FAILED',
          message: `${dialect.label} is not signed in — run \`${found.loginHint}\` in a terminal.`,
        };
      }
      const parts = [
        found.version === undefined ? undefined : `v${found.version}`,
        found.loginDetail,
        found.login === 'unknown' ? 'sign-in confirmed on the first run' : undefined,
      ].filter((part): part is string => part !== undefined);
      return { status: 'CONNECTED', ...(parts.length === 0 ? {} : { message: parts.join(' · ') }) };
    },

    listModels: () => dialect.listModels(resolve),

    generate(req: GenerateRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
      return (async function* (): AsyncGenerator<StreamChunk> {
        const command = resolve();
        if (command === undefined) {
          throw new ProviderCallError({
            kind: 'provider',
            code: 'cli_not_found',
            message: `${dialect.label} is not installed — ${CLI_INSTALL_HINTS[dialect.type]}`,
            retryable: false,
          });
        }
        if (req.workingDir !== undefined && !isDirectory(req.workingDir)) {
          throw new ProviderCallError({
            kind: 'invalid_config',
            code: 'project_folder_missing',
            message: `The project folder does not exist: ${req.workingDir}`,
            retryable: false,
          });
        }

        // No project folder (direct chat, a summary): a throwaway folder, read-only (spec §4.2).
        const scratch = req.workingDir === undefined ? mkdtempSync(join(tmpdir(), 'ace-cli-')) : undefined;
        const cwd = req.workingDir ?? (scratch as string);
        const permission: CliPermission = scratch === undefined ? options.permission : 'read_only';

        const run = runCli({
          command: command.command,
          args: [...command.prefixArgs, ...dialect.args(req, permission)],
          cwd,
          env: dialect.env?.(env) ?? env,
          stdin: dialect.stdin(req),
          signal,
          platform,
        });
        const parser = dialect.createParser();
        let acted = false;

        try {
          for await (const line of run.lines) {
            const event = parseJsonLine(line);
            if (event === undefined) continue;
            for (const chunk of parser.onEvent(event)) {
              if (chunk.type === 'activity') acted = true;
              yield chunk;
            }
          }
          const exit = await run.exit;
          if (signal.aborted) throw new ProviderCallError(abortedCallError(undefined, { signal }));
          yield* parser.finish(exit);
        } catch (error) {
          const nodeError = signal.aborted
            ? abortedCallError(error, { signal })
            : mapProviderError(error, { signal });
          // Once the CLI has acted it may have changed files: running it again is not a retry (§5.2).
          throw new ProviderCallError(acted ? { ...nodeError, retryable: false } : nodeError);
        } finally {
          if (scratch !== undefined) {
            try {
              rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
            } catch {
              // A killed CLI can hold the folder a moment longer; the OS reclaims temp itself.
            }
          }
        }
      })();
    },
  };
}
```

- [ ] **Step 5: Implement the Claude Code dialect** — `packages/providers/src/adapters/cli/claude-code.ts`:

```ts
import type { CliPermission, NodeError } from '@ace/contracts';

import { ProviderCallError, type ModelInfo, type ProviderAdapter, type StreamChunk } from '../../adapter.js';
import {
  cliExitError,
  cliModel,
  createCliAdapter,
  summariseToolOutput,
  tokenCount,
  type CliAdapterOptions,
  type CliDialect,
  type CliParser,
} from './adapter.js';

/**
 * Claude Code in print mode (X1 spec §5.1). The flags were verified against Claude Code 2.1.282 on
 * 2026-10-06: `--setting-sources ""` keeps the user's own hooks and plugins (a SessionStart hook
 * that injects instructions, say) out of an agent run, and `--permission-prompts none` denies
 * anything the preset does not allow instead of waiting for a person who is not there.
 */
export const CLAUDE_CODE_BASE_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--permission-prompts',
  'none',
] as const;

/** D262's presets. `edit_files` drops the shell entirely: on Windows there is no shell sandbox. */
const PERMISSION_ARGS: Readonly<Record<CliPermission, readonly string[]>> = {
  read_only: ['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob'],
  edit_files: ['--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Grep,Glob'],
  full_auto: ['--permission-mode', 'bypassPermissions'],
};

/** Claude Code takes model aliases; `default` leaves the choice to the CLI's own setting. */
export const CLAUDE_CODE_MODELS: readonly ModelInfo[] = [
  cliModel('default', 'Claude Code default'),
  cliModel('opus', 'Claude Opus'),
  cliModel('sonnet', 'Claude Sonnet'),
  cliModel('haiku', 'Claude Haiku'),
];

type Block = Record<string, unknown>;

const blocksOf = (event: Record<string, unknown>): Block[] => {
  const message = event['message'] as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as Block[]) : [];
};

/** A `result` event that says the call failed, as the error kind it deserves (Arch §28). */
export function claudeResultError(result: Record<string, unknown>): NodeError {
  const said = [
    typeof result['result'] === 'string' ? result['result'] : '',
    ...(Array.isArray(result['errors']) ? result['errors'].map(String) : []),
  ]
    .join(' ')
    .trim();
  const status = typeof result['api_error_status'] === 'number' ? result['api_error_status'] : undefined;
  const subtype = typeof result['subtype'] === 'string' ? result['subtype'] : 'error';

  if (status === 401 || status === 403 || /not logged in|\/login|invalid api key|authenticat/i.test(said)) {
    return {
      kind: 'auth',
      code: 'cli_not_signed_in',
      message: `Claude Code is not signed in — run \`claude auth login\`. ${said}`.trim(),
      retryable: false,
    };
  }
  if (status === 429 || /usage limit|rate limit|limit reached|out of credits/i.test(said)) {
    return {
      kind: 'provider',
      code: 'http_429',
      message: `Claude Code plan limit reached: ${said === '' ? 'try again later' : said}`,
      retryable: true,
    };
  }
  if (subtype === 'error_max_turns') {
    return {
      kind: 'agent',
      code: 'cli_max_turns',
      message: `Claude Code stopped at its turn limit. ${said}`.trim(),
      retryable: false,
    };
  }
  return {
    kind: 'provider',
    code: `cli_${subtype}`,
    message: `Claude Code failed (${subtype})${said === '' ? '' : `: ${said}`}`,
    retryable: false,
  };
}

export function createClaudeCodeParser(now: () => number = Date.now): CliParser {
  const pending = new Map<string, { tool: string; args: unknown; startedAt: number }>();
  /** Partial deltas arrived, so an `assistant` text block only repeats them. */
  let streamed = false;
  let wroteText = false;
  let newMessage = false;
  let result: Record<string, unknown> | undefined;

  const text = (delta: string): StreamChunk => {
    const prefix = newMessage && wroteText ? '\n\n' : '';
    newMessage = false;
    wroteText = true;
    return { type: 'text', delta: `${prefix}${delta}` };
  };

  return {
    onEvent(event) {
      // A sub-agent's turns carry its parent's tool id; only the main agent's words are the answer.
      const parent = event['parent_tool_use_id'];
      if (parent !== undefined && parent !== null) return [];

      switch (event['type']) {
        case 'stream_event': {
          const inner = event['event'] as
            | { type?: unknown; delta?: { type?: unknown; text?: unknown } }
            | undefined;
          if (inner?.type === 'message_start') {
            newMessage = true;
            return [];
          }
          if (
            inner?.type === 'content_block_delta' &&
            inner.delta?.type === 'text_delta' &&
            typeof inner.delta.text === 'string'
          ) {
            streamed = true;
            return [text(inner.delta.text)];
          }
          return [];
        }
        case 'assistant': {
          const out: StreamChunk[] = [];
          for (const block of blocksOf(event)) {
            if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
              pending.set(block['id'], {
                tool: typeof block['name'] === 'string' ? block['name'] : 'tool',
                args: block['input'] ?? {},
                startedAt: now(),
              });
            } else if (block['type'] === 'text' && !streamed && typeof block['text'] === 'string') {
              newMessage = true;
              out.push(text(block['text']));
            }
          }
          return out;
        }
        case 'user': {
          const out: StreamChunk[] = [];
          for (const block of blocksOf(event)) {
            if (block['type'] !== 'tool_result' || typeof block['tool_use_id'] !== 'string') continue;
            const started = pending.get(block['tool_use_id']);
            if (started === undefined) continue;
            pending.delete(block['tool_use_id']);
            out.push({
              type: 'activity',
              tool: started.tool,
              args: started.args,
              status: block['is_error'] === true ? 'error' : 'ok',
              summary: summariseToolOutput(block['content']),
              durationMs: Math.max(0, now() - started.startedAt),
            });
          }
          return out;
        }
        case 'result':
          result = event;
          return [];
        default:
          return [];
      }
    },

    finish(exit) {
      if (result === undefined) throw new ProviderCallError(cliExitError('Claude Code', exit));
      if (result['is_error'] === true || result['subtype'] !== 'success') {
        throw new ProviderCallError(claudeResultError(result));
      }
      const usage = (result['usage'] ?? {}) as Record<string, unknown>;
      const cost = result['total_cost_usd'];
      return [
        {
          type: 'usage',
          tokensIn:
            tokenCount(usage['input_tokens']) +
            tokenCount(usage['cache_read_input_tokens']) +
            tokenCount(usage['cache_creation_input_tokens']),
          tokensOut: tokenCount(usage['output_tokens']),
          ...(typeof cost === 'number' ? { costUsd: cost } : {}),
        },
        { type: 'finish', reason: 'stop' },
      ];
    },
  };
}

export const claudeCodeDialect: CliDialect = {
  type: 'claude_code',
  bin: 'claude',
  label: 'Claude Code',
  args: (req, permission) => [
    ...CLAUDE_CODE_BASE_ARGS,
    ...PERMISSION_ARGS[permission],
    ...(req.modelId === 'default' ? [] : ['--model', req.modelId]),
    ...(req.system === undefined || req.system === '' ? [] : ['--append-system-prompt', req.system]),
  ],
  stdin: (req) => req.prompt,
  createParser: () => createClaudeCodeParser(),
  listModels: async () => [...CLAUDE_CODE_MODELS],
};

export function createClaudeCodeAdapter(options: CliAdapterOptions): ProviderAdapter {
  return createCliAdapter(claudeCodeDialect, options);
}
```

Add to `packages/providers/src/index.ts`:

```ts
export * from './adapters/cli/adapter.js';
export * from './adapters/cli/claude-code.js';
export * from './adapters/cli/detect.js';
export * from './adapters/cli/resolve.js';
export * from './adapters/cli/runner.js';
```

- [ ] **Step 6: Run tests** — `pnpm --filter @ace/providers exec vitest run src/adapters/cli` → PASS. If a recorded-fixture expectation (token sum, cost) differs because the fixtures were re-recorded in Step 1, update the numbers in the two recorded-stream tests to the new `result` line's values — never loosen the assertions to `any`.

- [ ] **Step 7: The real-CLI check** — create `claude-code.provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { StreamChunk } from '../../../adapter.js';
import { createClaudeCodeAdapter } from '../claude-code.js';
import { createCliDetector } from '../detect.js';

describe('@provider Claude Code, the real CLI (X1)', () => {
  it('is installed and signed in, and answers a read-only prompt with usage and cost', async () => {
    const detection = await createCliDetector().detect('claude_code', { force: true });
    expect(detection.installed).toBe(true);
    const adapter = createClaudeCodeAdapter({ permission: 'read_only', detect: async () => detection });
    expect((await adapter.check()).status).toBe('CONNECTED');

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.generate(
      { modelId: 'haiku', prompt: 'Reply with the single word OK.', outputTypes: ['text'] },
      AbortSignal.timeout(120_000),
    )) {
      chunks.push(chunk);
    }
    const text = chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.delta] : [])).join('');
    expect(text).toMatch(/OK/);
    expect(chunks.find((chunk) => chunk.type === 'usage')).toMatchObject({ costUsd: expect.any(Number) });
  }, 180_000);
});
```

Run (real call, small Haiku usage): `pnpm --filter @ace/providers test:providers -- claude-code`
Expected: PASS on this machine. Paste the output into the task report.

- [ ] **Step 8: Commit**

```bash
git add packages/providers
git commit -m "feat(providers): Claude Code as an agent-route provider [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Wire CLI providers into the factory and the server

**Files:**
- Modify: `packages/providers/src/factory.ts`
- Modify: `apps/server/src/server.ts` (`StartEngineOptions.cliDetector`, factory options, `projectFolderFor`, run service)
- Test: `packages/providers/src/__tests__/factory.test.ts`, create `apps/server/src/__tests__/x1-cli-providers.test.ts`

**Interfaces:**
- Consumes: `createClaudeCodeAdapter` (Task 10), `createCliDetector`, `CliDetector` (Task 9), `projectFolderFor` dep (Task 5), `detectClis` (Task 7).
- Produces: `ProviderFactoryOptions.cliDetector?: CliDetector`; `StartEngineOptions.cliDetector?: CliDetector`; the engine answers `GET /providers/detect/clis` with the real scan and hands runs their project folder.

- [ ] **Step 1: Write the failing tests**

`packages/providers/src/__tests__/factory.test.ts` — append (import `createProviderAdapterFactory` is already there; add `import type { CliDetector } from '../adapters/cli/detect.js';` and `import type { Provider } from '@ace/contracts';` if missing):

```ts
describe('X1 CLI providers in the factory', () => {
  const scan = {
    type: 'claude_code' as const,
    installed: true,
    version: '2.1.282',
    login: 'logged_in' as const,
    installHint: 'npm install -g @anthropic-ai/claude-code',
    loginHint: 'claude auth login',
  };
  const detector: CliDetector = {
    detect: async () => scan,
    detectAll: async () => ({ items: [scan] }),
  };
  const row = (overrides: Partial<Provider> = {}): Provider => ({
    id: '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD',
    type: 'claude_code',
    name: 'Claude Code',
    keySet: false,
    status: 'UNKNOWN',
    concurrency: 1,
    cliPermission: 'read_only',
    createdAt: '2026-10-06T10:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z',
    ...overrides,
  });

  it('builds a Claude Code adapter whose check reads the scan', async () => {
    const adapter = createProviderAdapterFactory({ cliDetector: detector }).create(row(), undefined);
    expect(adapter.type).toBe('claude_code');
    expect(await adapter.check()).toEqual({ status: 'CONNECTED', message: 'v2.1.282' });
    expect((await adapter.listModels()).map((model) => model.modelId)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
  });

  it('passes the terminal scan through', async () => {
    expect(await createProviderAdapterFactory({ cliDetector: detector }).detectClis?.()).toEqual({ items: [scan] });
  });
});
```

`apps/server/src/__tests__/x1-cli-providers.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliDetection } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

const scan: CliDetection[] = [
  { type: 'claude_code', installed: true, version: '2.1.282', login: 'logged_in', loginDetail: 'claude.ai', installHint: 'npm install -g @anthropic-ai/claude-code', loginHint: 'claude auth login' },
  { type: 'codex_cli', installed: false, login: 'unknown', installHint: 'npm install -g @openai/codex', loginHint: 'codex login' },
  { type: 'gemini_cli', installed: false, login: 'unknown', installHint: 'npm install -g @google/gemini-cli', loginHint: 'gemini' },
];

let dir: string;
let engine: RunningEngine;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ace-x1-server-'));
  engine = await startEngine({
    dataDir: dir,
    port: 0,
    env: {},
    cliDetector: {
      detect: async (type) => scan.find((item) => item.type === type)!,
      detectAll: async () => ({ items: scan }),
    },
  });
});
afterEach(async () => {
  await engine.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer.
  }
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${engine.url}/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${engine.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

describe('FR-PRV-008 CLI providers through the real engine (X1)', () => {
  it('answers the terminal scan', async () => {
    const response = await api('/providers/detect/clis');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: CliDetection[] }).items.map((item) => item.type)).toEqual([
      'claude_code',
      'codex_cli',
      'gemini_cli',
    ]);
  });

  it('adds Claude Code with no key, checks it CONNECTED, and lists its models', async () => {
    const created = (await (
      await api('/providers', { method: 'POST', body: JSON.stringify({ type: 'claude_code', name: 'Claude Code', concurrency: 1 }) })
    ).json()) as { id: string; cliPermission: string; keySet: boolean };
    expect(created).toMatchObject({ cliPermission: 'edit_files', keySet: false });

    const check = (await (await api(`/providers/${created.id}/check`, { method: 'POST' })).json()) as { status: string };
    expect(check.status).toBe('CONNECTED');

    await api(`/providers/${created.id}/refresh-models`, { method: 'POST' });
    const models = (await (await api(`/models?providerId=${created.id}`)).json()) as { items: { modelId: string }[] };
    expect(models.items.map((model) => model.modelId).sort()).toEqual(['default', 'haiku', 'opus', 'sonnet']);
  });

  it('refuses a key on a CLI provider', async () => {
    const response = await api('/providers', {
      method: 'POST',
      body: JSON.stringify({ type: 'claude_code', name: 'C', apiKey: 'sk-x' }),
    });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to see failures**

```bash
pnpm --filter @ace/providers exec vitest run src/__tests__/factory.test.ts
pnpm --filter @ace/providers build
pnpm --filter @ace/server exec vitest run src/__tests__/x1-cli-providers.test.ts
```
Expected: FAIL (no CLI case in the factory; no `cliDetector` option).

- [ ] **Step 3: Implement the factory** — in `packages/providers/src/factory.ts`:

Add imports:

```ts
import { DEFAULT_CLI_PERMISSION, type Model, type Provider, type ProviderType } from '@ace/contracts';
import { createClaudeCodeAdapter } from './adapters/cli/claude-code.js';
import { createCliDetector, type CliDetector } from './adapters/cli/detect.js';
```

Add to `ProviderFactoryOptions`:

```ts
  /** X1: the terminal scan; tests inject a fake so `pnpm test` never runs a real CLI. */
  cliDetector?: CliDetector;
```

At the top of `createProviderAdapterFactory`, after `const fetchImpl = options.fetchImpl;`:

```ts
  const cli = options.cliDetector ?? createCliDetector();
```

In the `switch (provider.type)` before `default:`:

```ts
        case 'claude_code':
          return createClaudeCodeAdapter({
            permission: provider.cliPermission ?? DEFAULT_CLI_PERMISSION,
            detect: () => cli.detect('claude_code'),
          });
```

and add to the returned object after `detect`:

```ts
    // The Add-provider scan is always fresh; health checks read the 60 s cache.
    detectClis: () => cli.detectAll({ force: true }),
```

- [ ] **Step 4: Implement the server wiring** — in `apps/server/src/server.ts`:

Add to `StartEngineOptions` (next to `mockProvider`):

```ts
  /** X1: the terminal scan. Tests inject a fake; the real one runs the installed CLIs. */
  cliDetector?: CliDetector;
```

(import `type CliDetector` from `@ace/providers`). Change the factory line to:

```ts
  const factory = createProviderAdapterFactory({
    mock: mockProvider,
    ...(options.cliDetector === undefined ? {} : { cliDetector: options.cliDetector }),
  });
```

Before `createRunService`, add:

```ts
  /* X1 §4.2: a run's project folder — where an agent-route CLI works, and the project tools reach. */
  const projectFolderFor = async (runId: Id): Promise<string | undefined> => {
    const run = await repository.runs.get(LOCAL_SCOPE, runId);
    if (run === null) return undefined;
    const project = await repository.projects.get(LOCAL_SCOPE, run.projectId);
    return project === null || project.folderPath === '' ? undefined : project.folderPath;
  };
```

and pass `projectFolderFor,` in the `createRunService({...})` call.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @ace/providers exec vitest run
pnpm --filter @ace/providers build
pnpm --filter @ace/server exec vitest run
pnpm typecheck
```
Expected: PASS (whole server suite, new file included).

- [ ] **Step 6: Commit**

```bash
git add packages/providers apps/server
git commit -m "feat(server): Claude Code providers and project folders reach the engine [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Web data layer — SDK, hooks, mocks

**Files:**
- Modify: `packages/sdk/src/client.ts` (`detectClis`)
- Test: `packages/sdk/src/__tests__/client-round2.test.ts`
- Modify: `apps/web/src/workflows/query-keys.ts` (`cliScan`), `apps/web/src/providers/hooks.ts` (`useCliScan`)
- Create: `apps/web/src/mocks/cli-scan.ts`
- Modify: `apps/web/src/mocks/handlers-round2.ts` (scan route, PATCH rule), `apps/web/src/mocks/db.ts` (`cliPermission`)
- Test: create `apps/web/src/mocks/cli-scan.test.ts`

**Interfaces:**
- Produces: `client.detectClis(): Promise<CliDetectResponse>`; `queryKeys.cliScan()` = `['cli-scan']`; `useCliScan()`; `MOCK_CLI_SCAN`; MockDb `createProvider({ …, cliPermission? })`, `updateProvider(id, { …, cliPermission? })`.

- [ ] **Step 1: Write the failing tests**

SDK (`client-round2.test.ts`, inside the round-2 describe):

```ts
  it('X1 detectClis asks GET /providers/detect/clis', async () => {
    const { calls, client } = recorder([{ items: [] }]);
    expect(await client.detectClis()).toEqual({ items: [] });
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`)).toEqual([
      'GET /providers/detect/clis',
    ]);
  });
```

Mocks — create `apps/web/src/mocks/cli-scan.test.ts`:

```ts
import { CliDetectResponseSchema } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { MOCK_CLI_SCAN } from './cli-scan';
import { MockDb } from './db';

describe('X1 the mock engine’s terminal scan and CLI providers', () => {
  it('serves a scan the contract accepts: one signed in, one signed out, one missing', () => {
    expect(CliDetectResponseSchema.parse(MOCK_CLI_SCAN).items.map((item) => [item.type, item.installed, item.login])).toEqual([
      ['claude_code', true, 'logged_in'],
      ['codex_cli', true, 'logged_out'],
      ['gemini_cli', false, 'unknown'],
    ]);
  });

  it('gives a CLI provider the default permission, and a patch changes it', () => {
    const db = new MockDb();
    const created = db.createProvider({ type: 'claude_code', name: 'Claude Code', concurrency: 1 });
    expect(created.cliPermission).toBe('edit_files');
    expect(db.updateProvider(created.id, { cliPermission: 'full_auto' })?.cliPermission).toBe('full_auto');
    expect(db.createProvider({ type: 'mock', name: 'Mock' })).not.toHaveProperty('cliPermission');
  });
});
```

(`MockDb` is the class `mocks/db.ts` exports at `:167`.)

- [ ] **Step 2: Run to see failures**

```bash
pnpm --filter @ace/sdk exec vitest run src/__tests__/client-round2.test.ts
pnpm --filter @ace/web exec vitest run src/mocks/cli-scan.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/sdk/src/client.ts` — import `CliDetectResponseSchema, type CliDetectResponse` from `@ace/contracts`; after `detectProviders`:

```ts
    /** X1 (FR-PRV-008): which coding-agent CLIs the engine's machine has, and their sign-in. */
    detectClis: (): Promise<CliDetectResponse> =>
      request('GET', '/providers/detect/clis', CliDetectResponseSchema),
```

`apps/web/src/workflows/query-keys.ts` — add `cliScan: () => ['cli-scan'] as const,` (its own root, so invalidating `['providers']` never re-runs the scan).

`apps/web/src/providers/hooks.ts` — add:

```ts
/**
 * X1 (FR-PRV-008): the terminal scan behind Add provider. Fresh every time the dialog opens — a
 * CLI installed or signed in a moment ago must show — so nothing is kept between opens.
 */
export function useCliScan() {
  return useQuery({
    queryKey: queryKeys.cliScan(),
    queryFn: () => api().detectClis(),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
```

`apps/web/src/mocks/cli-scan.ts`:

```ts
import { CLI_INSTALL_HINTS, CLI_LOGIN_HINTS, type CliDetectResponse } from '@ace/contracts';

/** The mock engine's terminal scan: Claude Code ready, Codex signed out, Gemini missing (X1). */
export const MOCK_CLI_SCAN: CliDetectResponse = {
  items: [
    {
      type: 'claude_code',
      installed: true,
      version: '2.1.282',
      path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
      login: 'logged_in',
      loginDetail: 'claude.ai · max',
      installHint: CLI_INSTALL_HINTS.claude_code,
      loginHint: CLI_LOGIN_HINTS.claude_code,
    },
    {
      type: 'codex_cli',
      installed: true,
      version: '0.160.1',
      path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
      login: 'logged_out',
      installHint: CLI_INSTALL_HINTS.codex_cli,
      loginHint: CLI_LOGIN_HINTS.codex_cli,
    },
    {
      type: 'gemini_cli',
      installed: false,
      login: 'unknown',
      installHint: CLI_INSTALL_HINTS.gemini_cli,
      loginHint: CLI_LOGIN_HINTS.gemini_cli,
    },
  ],
};
```

`apps/web/src/mocks/handlers-round2.ts` — import `MOCK_CLI_SCAN` and `cliPatchError`; add next to the `/providers/detect` handler:

```ts
    http.get(
      `${API}/providers/detect/clis`,
      guard(() => HttpResponse.json(MOCK_CLI_SCAN)),
    ),
```

and in the PATCH `/providers/:id` handler, after `parsed.success` is checked and before `db.updateProvider`:

```ts
        const existing = db.getProvider(param(ctx, 'id'));
        if (!existing) return notFound('Provider');
        const misfit = cliPatchError(existing.type, parsed.data);
        if (misfit !== undefined) return error(400, 'invalid_config', 'validation_failed', misfit, []);
```

`apps/web/src/mocks/db.ts` — import `DEFAULT_CLI_PERMISSION, isCliProviderType, type CliPermission` from `@ace/contracts`; in `createProvider`'s input type add `cliPermission?: CliPermission;` and in the built `provider` after `concurrency`:

```ts
      ...(isCliProviderType(input.type)
        ? { cliPermission: input.cliPermission ?? DEFAULT_CLI_PERMISSION }
        : {}),
```

In `updateProvider`'s patch type add `cliPermission?: CliPermission` and in its body: `if (patch.cliPermission !== undefined) provider.cliPermission = patch.cliPermission;`.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ace/sdk exec vitest run
pnpm --filter @ace/sdk build
pnpm --filter @ace/web exec vitest run src/mocks src/providers
pnpm --filter @ace/web typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk apps/web/src/mocks apps/web/src/providers/hooks.ts apps/web/src/workflows/query-keys.ts
git commit -m "feat(web): terminal scan in the SDK, hooks and mock engine [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Web — scan section, permission field, provider row, edit dialog

**Files:**
- Create: `apps/web/src/providers/CliScanSection.tsx`
- Modify: `apps/web/src/providers/provider-meta.ts` (permission labels/hints)
- Modify: `apps/web/src/providers/ProviderDialogs.tsx` (Add + Edit dialogs, `PermissionField`)
- Modify: `apps/web/src/providers/ProvidersPage.tsx` (row)
- Test: create `apps/web/src/providers/CliScan.test.tsx`

**Interfaces:**
- Consumes: `useCliScan` (Task 12), `CLI_PERMISSIONS`, `DEFAULT_CLI_PERMISSION`, `DEFAULT_CLI_CONCURRENCY`, `isCliProviderType`, `CliPermission`, `CliProviderType`, `CliDetection` (Tasks 1–2).
- Produces: `CliScanSection({ onAdd })`, `CLI_PERMISSION_LABEL`, `CLI_PERMISSION_HINT`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/providers/CliScan.test.tsx`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

async function openAddDialog(user: ReturnType<typeof userEvent.setup>) {
  renderApp('/providers');
  await user.click(await screen.findByRole('button', { name: /add provider/i }));
  return screen.getByRole('dialog');
}

describe('FR-PRV-008 the terminal scan in Add provider (X1)', () => {
  it('lists each CLI with what to do next', async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);

    const claude = await within(dialog).findByTestId('cli-scan-claude_code');
    expect(claude).toHaveTextContent('v2.1.282');
    expect(claude).toHaveTextContent('signed in (claude.ai · max)');
    expect(within(claude).getByRole('button', { name: 'Add Claude Code' })).toBeEnabled();

    const codex = within(dialog).getByTestId('cli-scan-codex_cli');
    expect(codex).toHaveTextContent('not signed in');
    expect(codex).toHaveTextContent('codex login');
    expect(within(codex).queryByRole('button', { name: 'Add Codex CLI' })).toBeNull();

    const gemini = within(dialog).getByTestId('cli-scan-gemini_cli');
    expect(gemini).toHaveTextContent('not installed');
    expect(gemini).toHaveTextContent('npm install -g @google/gemini-cli');
  });

  it('adds a scanned CLI with no key, editing project files, one call at a time', async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Add Claude Code' }));

    expect(within(dialog).queryByLabelText('API key')).toBeNull();
    expect(within(dialog).getByLabelText('Concurrency')).toHaveValue(1);
    expect(within(dialog).getByRole('combobox', { name: 'Permission' })).toHaveTextContent('Edit project files');

    await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(db.listProviders()).toHaveLength(1));
    expect(db.listProviders()[0]).toMatchObject({
      type: 'claude_code',
      name: 'Claude Code',
      keySet: false,
      concurrency: 1,
      cliPermission: 'edit_files',
    });
  });

  it('warns before Full auto', async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Add Claude Code' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Permission' }));
    await user.click(await screen.findByRole('option', { name: 'Full auto' }));
    expect(within(dialog).getByTestId('cli-permission-hint')).toHaveTextContent(/any command on your machine/);
  });

  it('shows a CLI provider’s permission where others show the key, and edits it', async () => {
    const user = userEvent.setup();
    const created = db.createProvider({ type: 'claude_code', name: 'Claude Code', concurrency: 1, cliPermission: 'read_only' });
    renderApp('/providers');

    expect(await screen.findByTestId(`provider-permission-${created.id}`)).toHaveTextContent('Read-only');
    await user.click(screen.getByRole('button', { name: 'Actions for Claude Code' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText(/API key/)).toBeNull();

    await user.click(within(dialog).getByRole('combobox', { name: 'Permission' }));
    await user.click(await screen.findByRole('option', { name: 'Full auto' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.getProvider(created.id)?.cliPermission).toBe('full_auto'));
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm --filter @ace/web exec vitest run src/providers/CliScan.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/providers/provider-meta.ts` — add (import `type CliPermission` from `@ace/contracts`):

```ts
/** D262's three presets, as the dialogs name them. */
export const CLI_PERMISSION_LABEL: Readonly<Record<CliPermission, string>> = {
  read_only: 'Read-only',
  edit_files: 'Edit project files',
  full_auto: 'Full auto',
};

export const CLI_PERMISSION_HINT: Readonly<Record<CliPermission, string>> = {
  read_only: 'Reads the project folder. Never writes a file or runs a command.',
  edit_files: 'Reads and edits files in the project folder. Runs no shell commands.',
  full_auto:
    'Runs any command on your machine without asking — on Windows with no sandbox. Use only for projects you trust.',
};
```

`apps/web/src/providers/CliScanSection.tsx`:

```tsx
import type { CliDetection, CliProviderType } from '@ace/contracts';
import { Button } from '@ace/ui';
import { useState } from 'react';

import { useCliScan } from './hooks';
import { PROVIDER_TYPE_LABEL } from './provider-meta';

/** A command the user runs in their own terminal, with a copy button (FR-PRV-008's hint). */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard (an insecure context, a test): the command is still on screen to copy.
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-machine text-xs">{text}</code>
      <Button type="button" variant="ghost" size="sm" aria-label={`Copy ${text}`} onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

function ScanRow({ cli, onAdd }: { cli: CliDetection; onAdd: (type: CliProviderType) => void }) {
  const label = PROVIDER_TYPE_LABEL[cli.type];
  const version = cli.version === undefined ? '' : `v${cli.version} · `;
  const detail = cli.loginDetail === undefined ? '' : ` (${cli.loginDetail})`;

  return (
    <li data-testid={`cli-scan-${cli.type}`} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-28 shrink-0 font-human">{label}</span>
      {!cli.installed ? (
        <>
          <span className="text-fg-muted">not installed — install with</span>
          <Command text={cli.installHint} />
        </>
      ) : cli.login === 'logged_out' ? (
        <>
          <span className="text-fg-muted">{version}not signed in — run</span>
          <Command text={cli.loginHint} />
          <span className="text-fg-muted">in a terminal, then scan again</span>
        </>
      ) : (
        <>
          <span className="flex-1">
            {version}
            {cli.login === 'logged_in' ? 'signed in' : 'sign-in not verified'}
            {detail}
          </span>
          <Button type="button" size="sm" variant="secondary" aria-label={`Add ${label}`} onClick={() => onAdd(cli.type)}>
            Add
          </Button>
        </>
      )}
    </li>
  );
}

/**
 * "Found in your terminal" (X1, FR-PRV-008): the coding-agent CLIs on the engine's machine. One that
 * is installed and signed in is one click from being a provider; the others say what to run.
 */
export function CliScanSection({ onAdd }: { onAdd: (type: CliProviderType) => void }) {
  const scan = useCliScan();

  return (
    <section
      aria-labelledby="cli-scan-title"
      data-testid="cli-scan"
      className="flex flex-col gap-2 rounded-card border border-border bg-card px-3 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="cli-scan-title" className="text-sm font-semibold">
          Found in your terminal
        </h3>
        <Button type="button" variant="ghost" size="sm" disabled={scan.isFetching} onClick={() => void scan.refetch()}>
          {scan.isFetching ? 'Scanning…' : 'Scan again'}
        </Button>
      </div>
      {scan.isPending && <p className="text-sm text-fg-muted">Scanning your terminal…</p>}
      {scan.isError && (
        <p role="alert" className="text-sm text-danger">
          Could not scan: {scan.error.message}
        </p>
      )}
      {scan.data !== undefined && (
        <ul className="flex flex-col gap-1.5">
          {scan.data.items.map((cli) => (
            <ScanRow key={cli.type} cli={cli} onAdd={onAdd} />
          ))}
        </ul>
      )}
    </section>
  );
}
```

`apps/web/src/providers/ProviderDialogs.tsx`:

(a) Imports — add to the contracts import `CLI_PERMISSIONS, DEFAULT_CLI_CONCURRENCY, DEFAULT_CLI_PERMISSION, isCliProviderType, type CliPermission, type CliProviderType`; import `CliScanSection` from `./CliScanSection`; add `CLI_PERMISSION_HINT, CLI_PERMISSION_LABEL` to the `./provider-meta` import.

(b) Add above `AddProviderDialog`:

```tsx
/** D262's preset, with what it lets the CLI do spelled out under it. */
function PermissionField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: CliPermission;
  onChange: (next: CliPermission) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Permission</Label>
      <Select value={value} onValueChange={(next) => onChange(next as CliPermission)}>
        <SelectTrigger id={id} aria-label="Permission">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CLI_PERMISSIONS.map((level) => (
            <SelectItem key={level} value={level}>
              {CLI_PERMISSION_LABEL[level]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p
        data-testid="cli-permission-hint"
        className={value === 'full_auto' ? 'text-xs text-danger' : 'text-xs text-fg-muted'}
      >
        {CLI_PERMISSION_HINT[value]}
      </p>
    </div>
  );
}
```

(c) In `AddProviderDialog`: add state `const [permission, setPermission] = useState<CliPermission>(DEFAULT_CLI_PERMISSION);` and `const isCli = isCliProviderType(type);`. Replace `pickType` with:

```tsx
  const pickType = (next: ProviderType) => {
    setType(next);
    // The address is per type, so switching away from a local provider must not carry it over.
    setBaseUrl(next === 'ollama' ? (detectedOllamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL) : '');
    if (!name.trim()) setName(PROVIDER_TYPE_LABEL[next]);
    if (isCliProviderType(next)) {
      // A CLI brings its own sign-in, and two agents in one folder collide (D262).
      setApiKey('');
      setPermission(DEFAULT_CLI_PERMISSION);
      setConcurrency(String(DEFAULT_CLI_CONCURRENCY));
    }
  };

  /** "Add" on a scanned CLI: the form, filled in for it. */
  const addFromScan = (next: CliProviderType) => {
    setName(PROVIDER_TYPE_LABEL[next]);
    pickType(next);
  };
```

In `submit`'s body object, replace the `apiKey` line with `...(!isCli && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),` and add `...(isCli ? { cliPermission: permission } : {}),`.

Change the `DialogDescription` text to: `Keys are stored in the OS keychain and never shown again. A coding-agent CLI found in your terminal uses its own sign-in.` and render `<CliScanSection onAdd={addFromScan} />` directly after `</DialogHeader>`. After the Name field add:

```tsx
          {isCli && (
            <PermissionField id="provider-cli-permission" value={permission} onChange={setPermission} />
          )}
```

(d) In `EditProviderDialog`: add `const isCli = isCliProviderType(provider.type);` and `const [permission, setPermission] = useState<CliPermission>(provider.cliPermission ?? DEFAULT_CLI_PERMISSION);`. In `submit`, replace the apiKey line with `...(!isCli && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),` and add `...(isCli ? { cliPermission: permission } : {}),`. Make the description `{isCli ? 'Uses the CLI’s own sign-in; ACE stores no key for it.' : provider.keySet ? …existing… : …existing…}`. Wrap the key field in `{!isCli && ( … )}` and add after the Name field `{isCli && <PermissionField id="edit-provider-cli-permission" value={permission} onChange={setPermission} />}`.

`apps/web/src/providers/ProvidersPage.tsx` — import `DEFAULT_CLI_PERMISSION, isCliProviderType` from `@ace/contracts` and `CLI_PERMISSION_LABEL` from `./provider-meta`; replace the "key set" span with:

```tsx
      {isCliProviderType(provider.type) ? (
        <span className="font-machine text-xs" data-testid={`provider-permission-${provider.id}`}>
          permission: {CLI_PERMISSION_LABEL[provider.cliPermission ?? DEFAULT_CLI_PERMISSION]}
        </span>
      ) : (
        /* FR-PRV-002: whether a key exists, never the key. */
        <span className="font-machine text-xs" data-testid={`provider-key-set-${provider.id}`}>
          key set: {provider.keySet ? 'yes' : 'no'}
        </span>
      )}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ace/web exec vitest run src/providers
pnpm --filter @ace/web typecheck && pnpm --filter @ace/web lint
```
Expected: PASS — the new file and the existing `ProvidersPage.test.tsx` (its `it.each(PROVIDER_TYPES)` adds the three CLI types through the form with no key field).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/providers
git commit -m "feat(web): Add provider scans the terminal for coding-agent CLIs [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Real run — Claude Code end to end through ACE

**Files:** none changed (verification). Record what you saw in the task report.

- [ ] **Step 1: Build and start the worktree's ACE** (stop the launcher's ACE first — `D:\ACE offcl\Stop ACE.cmd` — both use ports 4747/5173):

```bash
cd "D:/ACE offcl/wt/x1"
pnpm build
ACE_DATA_DIR="$(cygpath -m "$TEMP")/ace-x1-data" pnpm dev
```
Expected: the engine prints its `?token=` URL. Open it.

- [ ] **Step 2: Make the demo project** (in a second terminal):

```bash
DEMO="$(cygpath -m "$TEMP")/ace x1 demo"
mkdir -p "$DEMO/src" "$DEMO/test" && cd "$DEMO"
cat > package.json <<'EOF'
{ "name": "x1-demo", "type": "module", "scripts": { "test": "node --test" } }
EOF
cat > src/math.js <<'EOF'
export const add = (a, b) => a + b;
EOF
cat > test/math.test.js <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, multiply } from '../src/math.js';
test('add', () => assert.equal(add(2, 3), 5));
test('multiply', () => assert.equal(multiply(4, 5), 20));
EOF
git init -q && git add -A && git commit -qm "demo: multiply is missing"
node --test || echo "fails as intended"
```
(The folder name has spaces on purpose — review focus 4.)

- [ ] **Step 3: Add Claude Code through the scan.** Providers → Add provider. Expected: "Found in your terminal" lists Claude Code `v2.1.282 · signed in (claude.ai · max)`, Codex and Gemini "not installed" with their npm commands. Click **Add Claude Code**, set Permission **Full auto** (it must run the tests), Add. Press **Test** → CONNECTED. Models tab → Refresh models for Claude Code → `default, opus, sonnet, haiku`.

- [ ] **Step 4: Run a real coding task.** New project with folder = the demo folder. Workflow: Input → Agent → Output. Agent: provider Claude Code, model Claude Sonnet, execution timeout 600000, instructions `You are working in this project folder.`. Input text: `Add a function multiply(a, b) to src/math.js so test/math.test.js passes. Run node --test, then run git diff, and report what changed and whether the tests pass.` Run.

Expected and to record:
- Text streams onto the Agent card while it works.
- Inspector → Tool calls lists `cli_read`, `cli_edit` (or `cli_write`), `cli_bash` rows with summaries.
- The node completes; its output reports the diff and passing tests; Usage shows tokens and a non-zero cost.
- In the demo folder, `git diff` shows `multiply` added and `node --test` passes.

- [ ] **Step 5: Stop really stops it.** `git -C "$DEMO" checkout -- .`, run again, press **Stop** within ~5 s of the node starting. Expected: node STOPPED within 2 s; `tasklist | findstr /i claude.exe` shows no `claude.exe` started after the run began (compare against a listing taken before the run — your own interactive Claude sessions are older).

- [ ] **Step 6: Restart the launcher's ACE** (`Start ACE.cmd`) when done.

---

### Task 15: API and local models call ACE's tools

**Files:**
- Modify: `packages/providers/src/adapters/ai-sdk.ts` (imports, two helpers, `generate`)
- Test: create `packages/providers/src/__tests__/ai-sdk-tools.test.ts`

**Interfaces:**
- Consumes: `GenerateRequest.tools`, `GenerateRequest.toolResults` with `args` (Task 5), `ToolDefinition` (contracts).
- Produces: `toToolSet(tools?: readonly ToolDefinition[]): ToolSet | undefined`, `continuationMessages(req: GenerateRequest): ModelMessage[] | undefined`; every AI-SDK adapter (anthropic, openai, google, openai_compatible, ollama) now emits `tool_call` chunks.

- [ ] **Step 1: Write the failing test** — `packages/providers/src/__tests__/ai-sdk-tools.test.ts`:

```ts
import type { ToolDefinition } from '@ace/contracts';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';

import type { StreamChunk } from '../adapter.js';
import { createAiSdkAdapter } from '../adapters/ai-sdk.js';

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const readFile: ToolDefinition = {
  name: 'read_file',
  description: 'Reads a text file in the project folder.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  permissions: { network: false, fsPaths: ['<project>'], destructive: false },
  timeoutMs: 10_000,
  source: 'builtin',
};

const adapterOver = (model: MockLanguageModelV4) =>
  createAiSdkAdapter({
    type: 'anthropic',
    model: () => model,
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
  });

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const saysDone = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Done.' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: usage(20, 2) },
      ]),
    }),
  });

describe('X1 §4.4 API and local models call ACE’s tools (FR-TOOL-003)', () => {
  it('offers the enabled tools and surfaces the model’s call for ACE to run', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: '{"path":"src/math.js"}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: usage(12, 3) },
        ]),
      }),
    });

    const chunks = await drain(
      adapterOver(model).generate(
        { modelId: 'm', prompt: 'Fix it.', outputTypes: ['text'], tools: [readFile] },
        new AbortController().signal,
      ),
    );

    expect(chunks).toContainEqual({
      type: 'tool_call',
      callId: 'call_1',
      name: 'read_file',
      args: { path: 'src/math.js' },
    });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
    const offered = model.doStreamCalls[0]?.tools ?? [];
    expect(offered.map((tool) => ('name' in tool ? tool.name : undefined))).toEqual(['read_file']);
  });

  it('continues after a tool result, replaying the call before its result', async () => {
    const model = saysDone();
    const chunks = await drain(
      adapterOver(model).generate(
        {
          modelId: 'm',
          prompt: 'Fix it.',
          outputTypes: ['text'],
          tools: [readFile],
          toolResults: [
            { callId: 'call_1', name: 'read_file', args: { path: 'src/math.js' }, result: { content: 'export const add' } },
          ],
        },
        new AbortController().signal,
      ),
    );

    expect(chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.delta] : [])).join('')).toBe('Done.');
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(prompt.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(JSON.stringify(prompt[1])).toContain('call_1');
    expect(JSON.stringify(prompt[1])).toContain('src/math.js');
    expect(JSON.stringify(prompt[2])).toContain('export const add');
  });

  it('a call with no tools is a single prompt with no tools, as before', async () => {
    const model = saysDone();
    await drain(adapterOver(model).generate({ modelId: 'm', prompt: 'Hi.', outputTypes: ['text'] }, new AbortController().signal));
    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([]);
    expect((model.doStreamCalls[0]?.prompt ?? []).map((message) => message.role)).toEqual(['user']);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm --filter @ace/providers exec vitest run src/__tests__/ai-sdk-tools.test.ts` → FAIL (no `tool_call` chunk; no tools offered).

- [ ] **Step 3: Implement** — in `packages/providers/src/adapters/ai-sdk.ts`:

Replace the `ai` import and add the contracts type:

```ts
import type { ProviderType, ToolDefinition } from '@ace/contracts';
import {
  jsonSchema,
  streamText,
  tool,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
```

Add above `createAiSdkAdapter`:

```ts
/**
 * ACE's enabled tools, offered **without** `execute` (X1 §4.4): the SDK surfaces the model's call as
 * a `tool-call` part and ACE's own loop runs it, under the tool-point guardrails and approvals
 * (Arch §12.7). The SDK never runs a tool itself.
 */
export function toToolSet(tools: readonly ToolDefinition[] | undefined): ToolSet | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return Object.fromEntries(
    tools.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
      }),
    ]),
  );
}

const toJsonValue = (value: unknown): JSONValue =>
  JSON.parse(JSON.stringify(value ?? null)) as JSONValue;

/**
 * The turns so far, rebuilt from the executor's tool results (X1 §4.4): the prompt, then each call
 * the model made and what it returned. `undefined` for a first turn, which stays a single prompt.
 */
export function continuationMessages(req: GenerateRequest): ModelMessage[] | undefined {
  if (req.toolResults === undefined || req.toolResults.length === 0) return undefined;
  const messages: ModelMessage[] = [{ role: 'user', content: req.prompt }];
  for (const result of req.toolResults) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: result.callId, toolName: result.name, input: result.args ?? {} }],
    });
    messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: result.callId,
          toolName: result.name,
          output: { type: 'json', value: toJsonValue(result.result) },
        },
      ],
    });
  }
  return messages;
}
```

In `generate`, before `streamText`, add:

```ts
          const tools = toToolSet(req.tools);
          const messages = continuationMessages(req);
          const input = messages === undefined ? { prompt: req.prompt } : { messages };
```

and in the `streamText({...})` call replace `prompt: req.prompt,` with:

```ts
            ...input,
            ...(tools === undefined ? {} : { tools }),
```

In the `for await (const part of result.fullStream)` loop, after the `text-delta` branch, add:

```ts
            if (part.type === 'tool-call') {
              yield { type: 'tool_call', callId: part.toolCallId, name: part.toolName, args: part.input };
              continue;
            }
```

- [ ] **Step 4: Run tests** — `pnpm --filter @ace/providers exec vitest run` → PASS (the existing `http-adapters.test.ts` still passes: a call without tools is unchanged). `pnpm --filter @ace/providers typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/providers
git commit -m "feat(providers): API and local models call ACE's tools [X1] [FR-TOOL-003]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Project folder confinement and the file tools

**Files:**
- Create: `packages/tools/src/project/paths.ts`, `packages/tools/src/builtins/project-files.ts`
- Modify: `packages/tools/src/tool.ts` (`ToolContext.projectDir`), `packages/tools/src/index.ts` (exports)
- Modify: `apps/server/src/server.ts` (`toolProvider` passes `projectDir`)
- Test: create `packages/tools/src/project/paths.test.ts`, `packages/tools/src/builtins/project-files.test.ts`

**Interfaces:**
- Consumes: `resolveInsideSandbox` (`sandbox/paths.ts`), `ToolError`, `RegisteredTool`, `makeContext` test helper, `ToolRunContext.projectDir` (Task 5).
- Produces: `ToolContext.projectDir?: string`; `assertInsideProject(options): string`; `assertWritable(projectDir, absolute, toolName): void`; `projectRelative(projectDir, absolute): string`; `LIST_FILES_DEFINITION`, `READ_FILE_DEFINITION`, `WRITE_FILE_DEFINITION`, `EDIT_FILE_DEFINITION`; `createListFilesTool()`, `createReadFileTool()`, `createWriteFileTool()`, `createEditFileTool()`.

- [ ] **Step 1: Write the failing tests**

`packages/tools/src/project/paths.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../errors.js';
import { RecordingToolLogger } from '../logging.js';
import { assertInsideProject, assertWritable, projectRelative } from './paths.js';

let root: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-project-'));
  project = join(root, 'my project');
  mkdirSync(join(project, 'src'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const resolveIn = (candidate: string | undefined) =>
  assertInsideProject({
    projectDir: project,
    candidate,
    toolName: 'write_file',
    operation: 'write',
    logger: new RecordingToolLogger(),
    runId: 'run-1',
  });

describe('FR-TOOL-008 paths stay inside the project folder', () => {
  it('resolves a relative path, and the root itself', () => {
    expect(resolveIn('src/math.js')).toBe(join(resolve(project), 'src', 'math.js'));
    expect(resolveIn(undefined)).toBe(resolve(project));
    expect(resolveIn('.')).toBe(resolve(project));
  });

  it('TC-TOOL-009 refuses a write to the parent folder, an absolute path and a home path', () => {
    for (const candidate of ['../outside.txt', 'src/../../outside.txt', resolve(root, 'x.txt'), '~/x']) {
      expect(() => resolveIn(candidate), candidate).toThrow(ToolError);
    }
  });

  it('refuses when the run has no project folder', () => {
    expect(() =>
      assertInsideProject({ projectDir: undefined, candidate: 'a', toolName: 'read_file', operation: 'read', logger: new RecordingToolLogger(), runId: 'r' }),
    ).toThrow(/needs a project folder/);
  });

  it('keeps writes out of .git and .ace', () => {
    expect(() => assertWritable(project, join(project, '.git', 'config'), 'write_file')).toThrow(/\.git/);
    expect(() => assertWritable(project, join(project, '.ace', 'x'), 'write_file')).toThrow(/\.ace/);
    expect(() => assertWritable(project, join(project, 'src', 'a.js'), 'write_file')).not.toThrow();
  });

  it('shows paths to the model relative, with forward slashes', () => {
    expect(projectRelative(project, join(project, 'src', 'a.js'))).toBe('src/a.js');
    expect(projectRelative(project, project)).toBe('.');
  });
});
```

`packages/tools/src/builtins/project-files.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import {
  EDIT_FILE_DEFINITION,
  READ_FILE_DEFINITION,
  WRITE_FILE_DEFINITION,
  createEditFileTool,
  createListFilesTool,
  createReadFileTool,
  createWriteFileTool,
} from './project-files.js';

let root: string;
let project: string;
let cleanups: (() => void)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-files-'));
  project = join(root, 'demo project');
  mkdirSync(join(project, 'src', 'deep'), { recursive: true });
  mkdirSync(join(project, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(project, 'src', 'deep', 'note.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(project, 'package.json'), '{}\n');
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  rmSync(root, { recursive: true, force: true });
});

const ctx = () => {
  const context = makeContext({ projectDir: project });
  cleanups.push(context.cleanup);
  return context;
};

describe('FR-TOOL-008 list_files', () => {
  it('lists the project root, skipping .git and node_modules', async () => {
    expect(await createListFilesTool().implementation({}, ctx())).toEqual({
      entries: ['package.json', 'src/'],
      truncated: false,
    });
  });

  it('lists recursively, and stops at maxEntries', async () => {
    const all = (await createListFilesTool().implementation({ recursive: true }, ctx())) as { entries: string[] };
    expect(all.entries).toEqual(['package.json', 'src/', 'src/deep/', 'src/deep/note.txt', 'src/math.js']);
    expect(await createListFilesTool().implementation({ recursive: true, maxEntries: 2 }, ctx())).toEqual({
      entries: ['package.json', 'src/'],
      truncated: true,
    });
  });
});

describe('FR-TOOL-008 read_file', () => {
  it('reads a file under a folder with a space (review focus 4)', async () => {
    expect(await createReadFileTool().implementation({ path: 'src/math.js' }, ctx())).toMatchObject({
      path: 'src/math.js',
      content: 'export const add = (a, b) => a + b;\n',
      truncated: false,
    });
  });

  it('reads a window of lines', async () => {
    expect(
      await createReadFileTool().implementation({ path: 'src/deep/note.txt', offset: 2, limit: 1 }, ctx()),
    ).toMatchObject({ content: 'two', totalLines: 4 });
  });

  it('refuses a binary file and a missing one', async () => {
    writeFileSync(join(project, 'img.bin'), Buffer.from([0, 1, 2, 0]));
    await expect(createReadFileTool().implementation({ path: 'img.bin' }, ctx())).rejects.toThrow(/binary/);
    await expect(createReadFileTool().implementation({ path: 'nope.txt' }, ctx())).rejects.toThrow(/not a file/);
  });

  it('is not destructive', () => {
    expect(READ_FILE_DEFINITION.permissions.destructive).toBe(false);
  });
});

describe('FR-TOOL-008 write_file', () => {
  it('creates a file and its folders', async () => {
    expect(await createWriteFileTool().implementation({ path: 'src/new/util.js', content: 'x\n' }, ctx())).toEqual({
      path: 'src/new/util.js',
      bytes: 2,
      created: true,
    });
    expect(readFileSync(join(project, 'src', 'new', 'util.js'), 'utf8')).toBe('x\n');
  });

  it('TC-TOOL-009 refuses the parent folder, and logs the attempt', async () => {
    const context = ctx();
    await expect(createWriteFileTool().implementation({ path: '../outside.txt', content: 'x' }, context)).rejects.toThrow(
      /inside the project folder/,
    );
    expect(context.logger.lines.some((line) => line.level === 'warn')).toBe(true);
  });

  it('refuses .git', async () => {
    await expect(createWriteFileTool().implementation({ path: '.git/config', content: 'x' }, ctx())).rejects.toThrow(/\.git/);
    expect(WRITE_FILE_DEFINITION.permissions.destructive).toBe(false);
  });
});

describe('FR-TOOL-008 edit_file', () => {
  it('replaces exactly one match, taking $ literally', async () => {
    expect(
      await createEditFileTool().implementation(
        { path: 'src/math.js', oldString: 'a + b', newString: 'a + b; // $& stays' },
        ctx(),
      ),
    ).toEqual({ path: 'src/math.js', replacements: 1 });
    expect(readFileSync(join(project, 'src', 'math.js'), 'utf8')).toContain('a + b; // $& stays');
  });

  it('refuses no match, and an ambiguous one unless replaceAll', async () => {
    await expect(
      createEditFileTool().implementation({ path: 'src/math.js', oldString: 'nothing', newString: 'x' }, ctx()),
    ).rejects.toThrow(/not found/);
    writeFileSync(join(project, 'twice.txt'), 'a a');
    await expect(
      createEditFileTool().implementation({ path: 'twice.txt', oldString: 'a', newString: 'b' }, ctx()),
    ).rejects.toThrow(/matches 2 times/);
    expect(
      await createEditFileTool().implementation({ path: 'twice.txt', oldString: 'a', newString: 'b', replaceAll: true }, ctx()),
    ).toEqual({ path: 'twice.txt', replacements: 2 });
    expect(EDIT_FILE_DEFINITION.permissions.destructive).toBe(false);
  });
});

describe('the project tools without a project folder', () => {
  it('refuse instead of guessing a folder', async () => {
    const context = makeContext();
    cleanups.push(context.cleanup);
    await expect(createListFilesTool().implementation({}, context)).rejects.toThrow(/needs a project folder/);
  });
});
```

- [ ] **Step 2: Run to see failures** — `pnpm --filter @ace/tools exec vitest run src/project src/builtins/project-files.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`packages/tools/src/tool.ts` — add to `ToolContext` after `sandboxDir`:

```ts
  /**
   * X1 (FR-TOOL-008): the project folder the run works in — the only folder the project tools
   * (`list_files`, `read_file`, `write_file`, `edit_file`, `git_*`, `run_command`) may touch. Absent
   * when the run has no project folder; those tools then refuse.
   */
  readonly projectDir?: string;
```

`packages/tools/src/project/paths.ts`:

```ts
import { relative, resolve, sep } from 'node:path';

import { ToolError } from '../errors.js';
import { type ToolLogger } from '../logging.js';
import { resolveInsideSandbox } from '../sandbox/paths.js';

/**
 * Project-folder confinement (X1, FR-TOOL-008, TC-TOOL-009): the sandbox's own lexical and symlink
 * rules (`resolveInsideSandbox`), except that the project root itself is a valid answer — listing
 * the project with no path lists the root.
 */

/** A path as the model sees it: relative to the project, with forward slashes. */
export function projectRelative(projectDir: string, absolute: string): string {
  const rel = relative(resolve(projectDir), absolute);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

export interface AssertInsideProjectOptions {
  readonly projectDir: string | undefined;
  readonly candidate: string | undefined;
  readonly toolName: string;
  readonly operation: string;
  readonly logger: ToolLogger;
  readonly runId: string;
}

export function assertInsideProject(options: AssertInsideProjectOptions): string {
  const projectDir = options.projectDir ?? '';
  if (projectDir === '') {
    throw new ToolError(
      'unavailable',
      options.toolName,
      `${options.toolName} needs a project folder, and this run has none.`,
    );
  }
  const candidate = (options.candidate ?? '').trim();
  if (candidate === '' || candidate === '.' || candidate === './' || candidate === '.\\') {
    return resolve(projectDir);
  }
  const resolution = resolveInsideSandbox(projectDir, candidate);
  if (resolution.ok) return resolution.path;

  // The reason, never the value the model passed (FR-GRD-014).
  options.logger.warn(
    { tool: options.toolName, operation: options.operation, reason: resolution.reason, runId: options.runId },
    'project path refused',
  );
  throw new ToolError(
    'denied',
    options.toolName,
    `${options.toolName} may not ${options.operation} that path (${resolution.reason}) — every path stays inside the project folder.`,
    { reason: resolution.reason, operation: options.operation },
  );
}

/** Writes never touch git's own data or ACE's per-project folder. */
export function assertWritable(projectDir: string, absolute: string, toolName: string): void {
  const top = projectRelative(projectDir, absolute).split('/')[0];
  if (top === '.git' || top === '.ace') {
    throw new ToolError('denied', toolName, `${toolName} may not write inside ${top}/.`, {
      reason: 'protected_folder',
    });
  }
}
```

`packages/tools/src/builtins/project-files.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type ToolDefinition } from '@ace/contracts';
import { z } from 'zod';

import { ToolError } from '../errors.js';
import { assertInsideProject, assertWritable, projectRelative } from '../project/paths.js';
import { type RegisteredTool } from '../registry.js';
import { type ToolContext } from '../tool.js';

/**
 * The project file tools (X1, FR-TOOL-008): list, read, write and edit files in the run's project
 * folder. Every path is confined by {@link assertInsideProject} (TC-TOOL-009); writes stay out of
 * `.git` and `.ace`. None is destructive — a write is recoverable through git — so none waits for an
 * approval; `run_command` is the one that does.
 */

const PROJECT = '<project>';
const READ_LIMIT_CHARS = 256 * 1024;
const SKIPPED = new Set(['.git', 'node_modules', '.ace']);

function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema: { type: 'object' },
    permissions: { network: false, fsPaths: [PROJECT], destructive: false },
    timeoutMs: 10_000,
    source: 'builtin',
  };
}

function parse<T>(schema: z.ZodType<T>, args: unknown, tool: string, usage: string): T {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new ToolError('invalid_args', tool, `${tool} needs ${usage}.`, {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}

const where = (context: ToolContext, tool: string, operation: string, path: string | undefined) =>
  assertInsideProject({
    projectDir: context.projectDir,
    candidate: path,
    toolName: tool,
    operation,
    logger: context.logger,
    runId: context.runId,
  });

/* ------------------------------------------------------------------ list_files */

const ListArgs = z.strictObject({
  path: z.string().optional(),
  recursive: z.boolean().optional(),
  maxEntries: z.number().int().min(1).max(2000).optional(),
});

export const LIST_FILES_DEFINITION = definition(
  'list_files',
  'Lists files and folders in the project folder (skips .git, node_modules and .ace). Folders end in "/".',
  {
    path: { type: 'string', description: 'Folder relative to the project; the project root when omitted.' },
    recursive: { type: 'boolean' },
    maxEntries: { type: 'integer', minimum: 1, maximum: 2000 },
  },
  [],
);

export function createListFilesTool(): RegisteredTool {
  return {
    definition: LIST_FILES_DEFINITION,
    implementation: async (args, context) => {
      const { path, recursive = false, maxEntries = 500 } = parse(ListArgs, args, 'list_files', '{ path?, recursive?, maxEntries? }');
      const start = where(context, 'list_files', 'list', path);
      const projectDir = context.projectDir as string;
      const entries: string[] = [];
      let truncated = false;

      const walk = (dir: string): void => {
        const children = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (child.isDirectory() && SKIPPED.has(child.name)) continue;
          if (entries.length >= maxEntries) {
            truncated = true;
            return;
          }
          const full = join(dir, child.name);
          entries.push(`${projectRelative(projectDir, full)}${child.isDirectory() ? '/' : ''}`);
          if (recursive && child.isDirectory()) walk(full);
        }
      };
      walk(start);
      return { entries, truncated };
    },
  };
}

/* ------------------------------------------------------------------- read_file */

const ReadArgs = z.strictObject({
  path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});

export const READ_FILE_DEFINITION = definition(
  'read_file',
  'Reads a UTF-8 text file in the project folder. Use offset/limit (1-based lines) for a window.',
  {
    path: { type: 'string', description: 'File path relative to the project folder.' },
    offset: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 5000 },
  },
  ['path'],
);

export function createReadFileTool(): RegisteredTool {
  return {
    definition: READ_FILE_DEFINITION,
    implementation: async (args, context) => {
      const { path, offset, limit } = parse(ReadArgs, args, 'read_file', '{ path, offset?, limit? }');
      const target = where(context, 'read_file', 'read', path);
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new ToolError('invalid_args', 'read_file', `read_file: ${path} is not a file.`);
      }
      const bytes = readFileSync(target);
      if (bytes.includes(0)) {
        throw new ToolError('invalid_args', 'read_file', `read_file: ${path} looks binary; it reads text only.`);
      }
      const lines = bytes.toString('utf8').split(/\r?\n/);
      const from = (offset ?? 1) - 1;
      const window = limit === undefined ? lines.slice(from) : lines.slice(from, from + limit);
      let content = offset === undefined && limit === undefined ? bytes.toString('utf8') : window.join('\n');
      const truncated = content.length > READ_LIMIT_CHARS;
      if (truncated) content = content.slice(0, READ_LIMIT_CHARS);
      return {
        path: projectRelative(context.projectDir as string, target),
        content,
        totalLines: lines.length,
        truncated,
      };
    },
  };
}

/* ------------------------------------------------------------------ write_file */

const WriteArgs = z.strictObject({ path: z.string(), content: z.string() });

export const WRITE_FILE_DEFINITION = definition(
  'write_file',
  'Creates or overwrites a text file in the project folder, creating its folders.',
  {
    path: { type: 'string', description: 'File path relative to the project folder.' },
    content: { type: 'string' },
  },
  ['path', 'content'],
);

export function createWriteFileTool(): RegisteredTool {
  return {
    definition: WRITE_FILE_DEFINITION,
    implementation: async (args, context) => {
      const { path, content } = parse(WriteArgs, args, 'write_file', '{ path, content }');
      const target = where(context, 'write_file', 'write', path);
      assertWritable(context.projectDir as string, target, 'write_file');
      const created = !existsSync(target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
      return {
        path: projectRelative(context.projectDir as string, target),
        bytes: Buffer.byteLength(content, 'utf8'),
        created,
      };
    },
  };
}

/* ------------------------------------------------------------------- edit_file */

const EditArgs = z.strictObject({
  path: z.string(),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

export const EDIT_FILE_DEFINITION = definition(
  'edit_file',
  'Replaces exact text in a file in the project folder. oldString must match exactly once unless replaceAll is true.',
  {
    path: { type: 'string', description: 'File path relative to the project folder.' },
    oldString: { type: 'string' },
    newString: { type: 'string' },
    replaceAll: { type: 'boolean' },
  },
  ['path', 'oldString', 'newString'],
);

export function createEditFileTool(): RegisteredTool {
  return {
    definition: EDIT_FILE_DEFINITION,
    implementation: async (args, context) => {
      const { path, oldString, newString, replaceAll = false } = parse(
        EditArgs,
        args,
        'edit_file',
        '{ path, oldString, newString, replaceAll? }',
      );
      const target = where(context, 'edit_file', 'edit', path);
      assertWritable(context.projectDir as string, target, 'edit_file');
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new ToolError('invalid_args', 'edit_file', `edit_file: ${path} is not a file.`);
      }
      const text = readFileSync(target, 'utf8');
      const matches = text.split(oldString).length - 1;
      if (matches === 0) {
        throw new ToolError('invalid_args', 'edit_file', 'edit_file: oldString was not found in the file.');
      }
      if (matches > 1 && !replaceAll) {
        throw new ToolError(
          'invalid_args',
          'edit_file',
          `edit_file: oldString matches ${matches} times; give more context or set replaceAll.`,
          { matches },
        );
      }
      // A function replacement, so `$&` and friends in newString stay literal.
      const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
      writeFileSync(target, next, 'utf8');
      return {
        path: projectRelative(context.projectDir as string, target),
        replacements: replaceAll ? matches : 1,
      };
    },
  };
}
```

`packages/tools/src/index.ts` — add `export * from './project/paths.js';` and `export * from './builtins/project-files.js';`.

`apps/server/src/server.ts` — in the `toolProvider`'s `run: (args, ctx) => registered.implementation(args, {...})` add `...(ctx.projectDir === undefined ? {} : { projectDir: ctx.projectDir }),`.

- [ ] **Step 4: Run tests** — `pnpm --filter @ace/tools exec vitest run` → PASS; `pnpm --filter @ace/tools typecheck && pnpm --filter @ace/server typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/tools apps/server/src/server.ts
git commit -m "feat(tools): project folder confinement and list/read/write/edit file tools [X1] [FR-TOOL-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Git tools

**Files:**
- Create: `packages/tools/src/builtins/git.ts`
- Modify: `packages/tools/src/index.ts`
- Test: create `packages/tools/src/builtins/git.test.ts`

**Interfaces:**
- Consumes: `assertInsideProject`, `projectRelative` (Task 16).
- Produces: `GIT_STATUS_DEFINITION`, `GIT_DIFF_DEFINITION`, `createGitStatusTool()`, `createGitDiffTool()`.

- [ ] **Step 1: Write the failing test** — `git.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import { GIT_DIFF_DEFINITION, GIT_STATUS_DEFINITION, createGitDiffTool, createGitStatusTool } from './git.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
let project: string;
let cleanups: (() => void)[] = [];

const git = (...args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8' });

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'ace git '));
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  rmSync(project, { recursive: true, force: true });
});

const ctx = () => {
  const context = makeContext({ projectDir: project });
  cleanups.push(context.cleanup);
  return context;
};

function repo(): void {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ace@example.invalid');
  git('config', 'user.name', 'ACE test');
  writeFileSync(join(project, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
}

describe.skipIf(!hasGit)('FR-TOOL-008 git tools', () => {
  it('git_status reports the branch and changed files', async () => {
    repo();
    writeFileSync(join(project, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(project, 'b.txt'), 'new\n');
    expect(await createGitStatusTool().implementation({}, ctx())).toEqual({
      branch: 'main',
      entries: [' M a.txt', '?? b.txt'],
      clean: false,
    });
  });

  it('git_diff shows unstaged and staged changes, and one path', async () => {
    repo();
    writeFileSync(join(project, 'a.txt'), 'one\ntwo\n');
    const unstaged = (await createGitDiffTool().implementation({}, ctx())) as { diff: string };
    expect(unstaged.diff).toContain('+two');
    git('add', 'a.txt');
    expect(((await createGitDiffTool().implementation({}, ctx())) as { diff: string }).diff).toBe('');
    expect(((await createGitDiffTool().implementation({ staged: true, path: 'a.txt' }, ctx())) as { diff: string }).diff).toContain('+two');
  });

  it('refuses a path outside the project, and says when there is no repository', async () => {
    repo();
    await expect(createGitDiffTool().implementation({ path: '../x' }, ctx())).rejects.toThrow(/inside the project folder/);
    rmSync(join(project, '.git'), { recursive: true, force: true });
    await expect(createGitStatusTool().implementation({}, ctx())).rejects.toThrow(/not a git repository/);
  });

  it('neither tool is destructive', () => {
    expect(GIT_STATUS_DEFINITION.permissions.destructive).toBe(false);
    expect(GIT_DIFF_DEFINITION.permissions.destructive).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm --filter @ace/tools exec vitest run src/builtins/git.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `packages/tools/src/builtins/git.ts`:

```ts
import { spawn } from 'node:child_process';

import { type ToolDefinition } from '@ace/contracts';
import { z } from 'zod';

import { ToolError } from '../errors.js';
import { assertInsideProject, projectRelative } from '../project/paths.js';
import { type RegisteredTool } from '../registry.js';
import { type ToolContext } from '../tool.js';

/**
 * `git_status` and `git_diff` (X1, FR-TOOL-008): read-only views of the project's repository. git
 * runs with an argument array (no shell), never prompts, never pages, and takes no optional locks.
 */

const OUTPUT_LIMIT_CHARS = 256 * 1024;
const GIT_TIMEOUT_MS = 15_000;

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function runGit(args: string[], cwd: string, tool: string, signal: AbortSignal | undefined): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length >= OUTPUT_LIMIT_CHARS) {
        truncated = true;
        return;
      }
      stdout += chunk;
      if (stdout.length > OUTPUT_LIMIT_CHARS) {
        stdout = stdout.slice(0, OUTPUT_LIMIT_CHARS);
        truncated = true;
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'ENOENT'
          ? new ToolError('unavailable', tool, `${tool}: git is not installed or not on PATH.`)
          : new ToolError('failed', tool, `${tool}: ${error.message}`),
      ),
    );
    child.on('close', (code) => resolve({ code, stdout, stderr, truncated }));
  });
}

function failed(tool: string, result: GitResult): ToolError {
  if (/not a git repository/i.test(result.stderr)) {
    return new ToolError('invalid_args', tool, `${tool}: the project folder is not a git repository.`);
  }
  return new ToolError('failed', tool, `${tool}: git exited ${result.code ?? 'by signal'}: ${result.stderr.trim().slice(-500)}`);
}

const projectRoot = (context: ToolContext, tool: string) =>
  assertInsideProject({
    projectDir: context.projectDir,
    candidate: undefined,
    toolName: tool,
    operation: 'read',
    logger: context.logger,
    runId: context.runId,
  });

const readOnly = (name: string, description: string, properties: Record<string, unknown>): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required: [], additionalProperties: false },
  outputSchema: { type: 'object' },
  permissions: { network: false, fsPaths: ['<project>'], destructive: false },
  timeoutMs: GIT_TIMEOUT_MS,
  source: 'builtin',
});

export const GIT_STATUS_DEFINITION = readOnly(
  'git_status',
  'Shows the project repository’s branch and changed files (git status --porcelain).',
  {},
);

export function createGitStatusTool(): RegisteredTool {
  return {
    definition: GIT_STATUS_DEFINITION,
    implementation: async (_args, context) => {
      const cwd = projectRoot(context, 'git_status');
      const result = await runGit(['status', '--porcelain=v1', '-b'], cwd, 'git_status', context.signal);
      if (result.code !== 0) throw failed('git_status', result);
      const [head = '', ...entries] = result.stdout.split(/\r?\n/).filter((line) => line !== '');
      const branch = head.replace(/^## /, '').split('...')[0] ?? '';
      return { branch, entries, clean: entries.length === 0 };
    },
  };
}

const DiffArgs = z.strictObject({ staged: z.boolean().optional(), path: z.string().optional() });

export const GIT_DIFF_DEFINITION = readOnly(
  'git_diff',
  'Shows the project’s uncommitted changes as a unified diff; staged: true for what is staged.',
  {
    staged: { type: 'boolean' },
    path: { type: 'string', description: 'Limit to one path, relative to the project folder.' },
  },
);

export function createGitDiffTool(): RegisteredTool {
  return {
    definition: GIT_DIFF_DEFINITION,
    implementation: async (args, context) => {
      const parsed = DiffArgs.safeParse(args ?? {});
      if (!parsed.success) throw new ToolError('invalid_args', 'git_diff', 'git_diff needs { staged?, path? }.');
      const cwd = projectRoot(context, 'git_diff');
      const path =
        parsed.data.path === undefined
          ? undefined
          : projectRelative(
              cwd,
              assertInsideProject({
                projectDir: context.projectDir,
                candidate: parsed.data.path,
                toolName: 'git_diff',
                operation: 'read',
                logger: context.logger,
                runId: context.runId,
              }),
            );
      const result = await runGit(
        ['diff', '--no-color', ...(parsed.data.staged === true ? ['--cached'] : []), ...(path === undefined ? [] : ['--', path])],
        cwd,
        'git_diff',
        context.signal,
      );
      if (result.code !== 0) throw failed('git_diff', result);
      return { diff: result.stdout, truncated: result.truncated };
    },
  };
}
```

`packages/tools/src/index.ts` — add `export * from './builtins/git.js';`.

- [ ] **Step 4: Run tests** — `pnpm --filter @ace/tools exec vitest run src/builtins/git.test.ts` → PASS (or SKIPPED where git is absent).

- [ ] **Step 5: Commit**

```bash
git add packages/tools
git commit -m "feat(tools): git_status and git_diff over the project repository [X1] [FR-TOOL-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: `run_command`

**Files:**
- Modify: `packages/tools/src/sandbox/runner.ts` (export `killTree`)
- Create: `packages/tools/src/builtins/run-command.ts`
- Modify: `packages/tools/src/index.ts`
- Test: create `packages/tools/src/builtins/run-command.test.ts`

**Interfaces:**
- Consumes: `assertInsideProject` (Task 16), `killTree` (now exported).
- Produces: `RUN_COMMAND_DEFINITION` (`destructive: true`), `createRunCommandTool(options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): RegisteredTool`.

- [ ] **Step 1: Write the failing test** — `run-command.test.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import { RUN_COMMAND_DEFINITION, createRunCommandTool } from './run-command.js';

let root: string;
let project: string;
let cleanups: (() => void)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-run-'));
  project = join(root, 'demo project');
  mkdirSync(join(project, 'sub'), { recursive: true });
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const ctx = (signal?: AbortSignal) => {
  const context = makeContext({ projectDir: project, ...(signal === undefined ? {} : { signal }) });
  cleanups.push(context.cleanup);
  return context;
};

/** A `node -e` command line that survives both cmd.exe and /bin/sh. */
const node = (script: string) => `"${process.execPath}" -e "${script}"`;
const run = createRunCommandTool();

describe('FR-TOOL-008 run_command (X1, D266)', () => {
  it('is destructive, so every call asks for approval', () => {
    expect(RUN_COMMAND_DEFINITION.permissions.destructive).toBe(true);
  });

  it('runs in the project folder (a path with spaces) and returns the exit code and output', async () => {
    const result = (await run.implementation({ command: node('console.log(process.cwd())') }, ctx())) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(project));
  });

  it('runs in a sub-folder, and refuses one outside the project', async () => {
    const result = (await run.implementation({ command: node('console.log(process.cwd())'), cwd: 'sub' }, ctx())) as { stdout: string };
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(join(project, 'sub')));
    await expect(run.implementation({ command: node('1'), cwd: '..' }, ctx())).rejects.toThrow(/inside the project folder/);
  });

  it('returns a failing exit code rather than throwing, and keeps quotes and & intact', async () => {
    expect(await run.implementation({ command: node('process.exit(4)') }, ctx())).toMatchObject({ exitCode: 4 });
    const result = (await run.implementation({ command: node("console.log('a & b')") }, ctx())) as { stdout: string };
    expect(result.stdout.trim()).toBe('a & b');
  });

  it('keeps only the tail of a flood of output', async () => {
    const result = (await run.implementation({ command: node("process.stdout.write('x'.repeat(200000))") }, ctx())) as {
      stdout: string;
      truncated: boolean;
    };
    expect(result.stdout.length).toBe(64 * 1024);
    expect(result.truncated).toBe(true);
  });

  it('times out and kills the command', async () => {
    await expect(
      run.implementation({ command: node('setInterval(() => {}, 1000)'), timeoutMs: 1_000 }, ctx()),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('a Stop ends it within 2 s', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = run.implementation({ command: node('setInterval(() => {}, 1000)') }, ctx(controller.signal));
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toThrow(/stopped/);
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm --filter @ace/tools exec vitest run src/builtins/run-command.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`packages/tools/src/sandbox/runner.ts` — change `function killTree(` to `export function killTree(` (no other change).

`packages/tools/src/builtins/run-command.ts`:

```ts
import { spawn } from 'node:child_process';

import { type ToolDefinition } from '@ace/contracts';
import { z } from 'zod';

import { ToolError } from '../errors.js';
import { assertInsideProject } from '../project/paths.js';
import { type RegisteredTool } from '../registry.js';
import { killTree } from '../sandbox/runner.js';

/**
 * `run_command` (X1, FR-TOOL-008, D266): one shell command in the project folder — `cmd.exe` on
 * Windows, `/bin/sh` elsewhere — returning its exit code and the tail of its output. It is
 * **destructive**, so under the default policy every call waits for an approval card: on Windows it
 * runs with no sandbox at all (the D-083 risk). A Stop or the timeout kills the whole process tree.
 */

const OUTPUT_TAIL_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

const RunArgs = z.strictObject({
  command: z.string().min(1).max(8_000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export const RUN_COMMAND_DEFINITION: ToolDefinition = {
  name: 'run_command',
  description:
    'Runs a shell command in the project folder (cmd.exe on Windows, /bin/sh elsewhere) and returns its exit code and output. Destructive: every call asks for approval.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line, e.g. "pnpm test".' },
      cwd: { type: 'string', description: 'Folder relative to the project; the project root when omitted.' },
      timeoutMs: { type: 'integer', minimum: 1_000, maximum: 600_000 },
    },
    required: ['command'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  permissions: { network: true, fsPaths: ['<project>'], destructive: true },
  timeoutMs: 600_000,
  source: 'builtin',
};

export interface RunCommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function createRunCommandTool(options: RunCommandOptions = {}): RegisteredTool {
  return {
    definition: RUN_COMMAND_DEFINITION,
    implementation: async (args, context) => {
      const parsed = RunArgs.safeParse(args ?? {});
      if (!parsed.success) {
        throw new ToolError('invalid_args', 'run_command', 'run_command needs { command, cwd?, timeoutMs? }.', {
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }
      const cwd = assertInsideProject({
        projectDir: context.projectDir,
        candidate: parsed.data.cwd,
        toolName: 'run_command',
        operation: 'run in',
        logger: context.logger,
        runId: context.runId,
      });
      const platform = options.platform ?? process.platform;
      const env = options.env ?? process.env;
      const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // cmd.exe /s strips exactly the outer quotes we add, so the line runs as written.
      const [shell, argv] =
        platform === 'win32'
          ? [env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${parsed.data.command}"`]]
          : ['/bin/sh', ['-c', parsed.data.command]];

      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;
        let settled = false;
        const keep = (current: string, chunk: string): string => {
          const next = current + chunk;
          if (next.length <= OUTPUT_TAIL_CHARS) return next;
          truncated = true;
          return next.slice(-OUTPUT_TAIL_CHARS);
        };

        const child = spawn(shell, argv, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: platform === 'win32',
          // POSIX: lead a process group so one kill reaches everything the command started.
          detached: platform !== 'win32',
        });
        const stop = (): void => {
          if (child.pid !== undefined) killTree(child.pid, platform);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        const onAbort = (): void => stop();
        context.signal?.addEventListener('abort', onAbort, { once: true });

        const finish = (settle: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context.signal?.removeEventListener('abort', onAbort);
          settle();
        };

        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout = keep(stdout, chunk);
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr = keep(stderr, chunk);
        });
        child.on('error', (error) =>
          finish(() => reject(new ToolError('failed', 'run_command', `Could not start the shell: ${error.message}`))),
        );
        child.on('close', (code) =>
          finish(() => {
            if (timedOut) {
              reject(
                new ToolError('timeout', 'run_command', `The command did not finish within ${timeoutMs} ms.`, {
                  stdoutTail: stdout.slice(-2_000),
                  stderrTail: stderr.slice(-2_000),
                }),
              );
            } else if (context.signal?.aborted === true) {
              reject(new ToolError('failed', 'run_command', 'The command was stopped.'));
            } else {
              resolve({ exitCode: code, stdout, stderr, truncated });
            }
          }),
        );
      });
    },
  };
}
```

`packages/tools/src/index.ts` — add `export * from './builtins/run-command.js';`.

- [ ] **Step 4: Run tests** — `pnpm --filter @ace/tools exec vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tools
git commit -m "feat(tools): run_command in the project folder, destructive by definition [X1] [FR-TOOL-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Register the seven tools everywhere

**Files:**
- Modify: `packages/contracts/src/tools.ts:107-124` (`BUILTIN_TOOL_NAMES` + comment), `packages/contracts/src/__tests__/tools.test.ts:184-191`
- Modify: `packages/tools/src/builtins/factory.ts` (`createBuiltinTools`, doc comments)
- Modify: `apps/web/src/mocks/tools-catalog.ts` (`BUILTIN_TOOL_DEFINITIONS`)
- Test: existing `packages/tools/src/builtins/factory.test.ts`, `packages/tools/src/registry.test.ts`, `apps/web/src/mocks/handlers-round4.test.ts`, `apps/web/src/library/__tests__/ToolsLibraryPage.test.tsx` (all key off `BUILTIN_TOOL_NAMES`)

**Interfaces:**
- Produces: `BUILTIN_TOOL_NAMES` = the six, then `'list_files', 'read_file', 'write_file', 'edit_file', 'git_status', 'git_diff', 'run_command'`; the registry, `GET /tools` and the web mock list all thirteen in that order.

- [ ] **Step 1: Write the failing test** — in `packages/contracts/src/__tests__/tools.test.ts:184`, make the expected list:

```ts
    expect([...BUILTIN_TOOL_NAMES]).toEqual([
      'echo',
      'code_sandbox',
      'sandbox_delete',
      'http_request',
      'web_search',
      'web_fetch',
      'list_files',
      'read_file',
      'write_file',
      'edit_file',
      'git_status',
      'git_diff',
      'run_command',
    ]);
```

- [ ] **Step 2: Run to see it fail** — `pnpm --filter @ace/contracts exec vitest run src/__tests__/tools.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`packages/contracts/src/tools.ts` — replace the list and its comment:

```ts
/**
 * The built-in tool names, in §2.2's order and then X1's (FR-TOOL-008, D266). Frozen and shared, so
 * the engine's registry, an agent's `tools.enabled` list and the web app's tools screen cannot
 * disagree about what a built-in tool is called (D52's reasoning). `sandbox_delete` and
 * `run_command` are the destructive ones, so they are the ones that ask for approval (FR-GRD-006).
 */
export const BUILTIN_TOOL_NAMES = [
  'echo',
  'code_sandbox',
  'sandbox_delete',
  'http_request',
  'web_search',
  'web_fetch',
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'git_status',
  'git_diff',
  'run_command',
] as const;
```

`packages/tools/src/builtins/factory.ts` — import the new creators and append them to `createBuiltinTools`'s array, in this order, after `createWebFetchTool()`:

```ts
    createListFilesTool(),
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createGitStatusTool(),
    createGitDiffTool(),
    createRunCommandTool(),
```

and change "six" to "thirteen" in that file's doc comments.

`apps/web/src/mocks/tools-catalog.ts` — add this helper above `BUILTIN_TOOL_DEFINITIONS` (and change "six built-ins" in the file's comment to "built-ins"):

```ts
/** X1's project tools (FR-TOOL-008), shaped as the engine registers them; `run_command` asks for approval. */
const projectTool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  outputSchema: { type: 'object' },
  permissions: {
    network: name === 'run_command',
    fsPaths: ['<project>'],
    destructive: name === 'run_command',
  },
  timeoutMs: name === 'run_command' ? 600_000 : 10_000,
  source: 'builtin',
});
```

and append to the `BUILTIN_TOOL_DEFINITIONS` array, after `web_fetch`:

```ts
  projectTool('list_files', 'List files and folders in the project folder.', { path: { type: 'string' }, recursive: { type: 'boolean' } }, []),
  projectTool('read_file', 'Read a text file in the project folder.', { path: { type: 'string' } }, ['path']),
  projectTool('write_file', 'Create or overwrite a file in the project folder.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  projectTool('edit_file', 'Replace exact text in a file in the project folder.', { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } }, ['path', 'oldString', 'newString']),
  projectTool('git_status', 'Show the project repository’s branch and changed files.', {}, []),
  projectTool('git_diff', 'Show the project’s uncommitted changes.', { staged: { type: 'boolean' }, path: { type: 'string' } }, []),
  projectTool('run_command', 'Run a shell command in the project folder. Asks for approval.', { command: { type: 'string' } }, ['command']),
```

(`projectTool` is a `const` arrow, so declare it above the array that uses it.)

- [ ] **Step 4: Run every suite that keys off the list**

```bash
pnpm --filter @ace/contracts exec vitest run && pnpm --filter @ace/contracts build
pnpm --filter @ace/tools exec vitest run && pnpm --filter @ace/tools build
pnpm --filter @ace/server exec vitest run
pnpm --filter @ace/web exec vitest run src/mocks src/library src/config-panel
```
Expected: PASS. If a web or server test asserted exactly one destructive built-in, or a count of six, update it to the new truth (`sandbox_delete` and `run_command`; thirteen) — the change is the contract's, not a weakened test.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/tools apps/web/src/mocks apps/server
git commit -m "feat(tools): register the project file, git and command tools [X1] [FR-TOOL-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: Codex CLI dialect

**Files:**
- Create: `packages/providers/src/adapters/cli/codex.ts`
- Modify: `packages/providers/src/factory.ts` (case `codex_cli`), `packages/providers/src/index.ts`
- Test: create `packages/providers/src/adapters/cli/__tests__/codex.test.ts`

**Interfaces:**
- Consumes: `createCliAdapter`, `CliDialect`, `CliParser`, `cliModel`, `cliExitError`, `summariseToolOutput`, `tokenCount`, `withSystem` (Task 10); `probeCommand` (Task 9).
- Produces: `CODEX_BASE_ARGS`, `codexDialect`, `createCodexParser(now?)`, `codexError(message)`, `codexModelsFrom(stdout)`, `createCodexAdapter(options)`.

Codex's `exec --json` schema comes from its docs and source (spec §5.1); it is not installed here, so these tests are the only check until it is (Task 22 lists the real check).

- [ ] **Step 1: Write the failing test** — `codex.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StreamChunk } from '../../../adapter.js';
import { CODEX_BASE_ARGS, codexDialect, codexError, codexModelsFrom, createCodexAdapter, createCodexParser } from '../codex.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-codex-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The shape `codex exec --json` documents (spec §5.1). */
const RUN = [
  { type: 'thread.started', thread_id: 'th_1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'I will add multiply.' } },
  { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'node --test', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'node --test', aggregated_output: '# pass 2\n# fail 0', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'src/math.js', kind: 'update' }], status: 'completed' } },
  { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Done: tests pass.' } },
  { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90, reasoning_output_tokens: 40 } },
];

function replay(events: object[]): StreamChunk[] {
  const parser = createCodexParser(() => 0);
  const chunks = events.flatMap((event) => parser.onEvent(event as Record<string, unknown>));
  return [...chunks, ...parser.finish({ code: 0, signal: null, stderrTail: '', killed: false })];
}

describe('X1 Codex CLI flags', () => {
  const req = { modelId: 'gpt-6.1-sol', prompt: 'p', outputTypes: ['text' as const], system: 'S' };

  it.each([
    ['read_only', ['--sandbox', 'read-only']],
    ['edit_files', ['--sandbox', 'workspace-write']],
    ['full_auto', ['--dangerously-bypass-approvals-and-sandbox']],
  ] as const)('maps %s, reads the prompt from stdin', (permission, flags) => {
    expect(codexDialect.args(req, permission)).toEqual([...CODEX_BASE_ARGS, ...flags, '-m', 'gpt-6.1-sol', '-']);
  });

  it('puts ACE’s system section before the prompt, and leaves "default" to the CLI', () => {
    expect(codexDialect.stdin(req)).toBe('S\n\np');
    expect(codexDialect.args({ ...req, modelId: 'default' }, 'read_only')).not.toContain('-m');
    expect([...CODEX_BASE_ARGS]).toEqual(['exec', '--json', '--skip-git-repo-check', '--color', 'never']);
  });
});

describe('X1 Codex CLI stream', () => {
  it('turns messages into text, commands and edits into activity, and reports usage with no cost', () => {
    const chunks = replay(RUN);
    expect(chunks.flatMap((c) => (c.type === 'text' ? [c.delta] : [])).join('')).toBe('I will add multiply.\n\nDone: tests pass.');
    expect(chunks.filter((c) => c.type === 'activity')).toEqual([
      { type: 'activity', tool: 'command', args: { command: 'node --test' }, status: 'ok', summary: '# pass 2 # fail 0', durationMs: 0 },
      { type: 'activity', tool: 'file_change', args: { changes: [{ path: 'src/math.js', kind: 'update' }] }, status: 'ok', summary: 'update src/math.js', durationMs: 0 },
    ]);
    expect(chunks.at(-2)).toEqual({ type: 'usage', tokensIn: 1200, tokensOut: 90 });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('marks a failed command as an error', () => {
    const chunks = replay([
      { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'npm test', aggregated_output: 'boom', exit_code: 1, status: 'failed' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(chunks[0]).toMatchObject({ type: 'activity', status: 'error' });
  });

  it('a failed turn is an error, mapped by what it says', () => {
    const parser = createCodexParser(() => 0);
    parser.onEvent({ type: 'turn.failed', error: { message: 'You exceeded your usage limit (429)' } });
    expect(() => parser.finish({ code: 1, signal: null, stderrTail: '', killed: false })).toThrow(/usage limit/);
    expect(codexError('Not logged in')).toMatchObject({ kind: 'auth', code: 'cli_not_signed_in' });
    expect(codexError('rate limit 429')).toMatchObject({ code: 'http_429', retryable: true });
    expect(codexError('model not found')).toMatchObject({ kind: 'provider', code: 'cli_turn_failed', retryable: false });
  });
});

describe('X1 Codex model list', () => {
  it('reads ids from `codex debug models` JSON, tolerating shapes', () => {
    expect(codexModelsFrom('{"models":[{"slug":"gpt-6.1-sol"},{"id":"gpt-6-luna"}]}')).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(codexModelsFrom('["a","b"]')).toEqual(['a', 'b']);
    expect(codexModelsFrom('not json')).toEqual([]);
  });
});

describe('X1 the Codex adapter against a fake CLI', () => {
  it('replays a run', async () => {
    const file = join(dir, 'run.jsonl');
    writeFileSync(file, RUN.map((e) => JSON.stringify(e)).join('\n'));
    const adapter = createCodexAdapter({
      permission: 'edit_files',
      detect: async () => ({ type: 'codex_cli', installed: true, login: 'logged_in', installHint: 'i', loginHint: 'l' }),
      resolve: () => ({ command: process.execPath, prefixArgs: [FAKE], path: FAKE }),
      env: { ...process.env, FAKE_CLI_MODE: 'replay', FAKE_CLI_FILE: file },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.generate({ modelId: 'default', prompt: 'x', outputTypes: ['text'], workingDir: dir }, new AbortController().signal)) {
      chunks.push(chunk);
    }
    expect(chunks.filter((c) => c.type === 'activity')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm --filter @ace/providers exec vitest run src/adapters/cli/__tests__/codex.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `packages/providers/src/adapters/cli/codex.ts`:

```ts
import type { CliPermission, NodeError } from '@ace/contracts';

import { ProviderCallError, type ProviderAdapter, type StreamChunk } from '../../adapter.js';
import {
  cliExitError,
  cliModel,
  createCliAdapter,
  summariseToolOutput,
  tokenCount,
  withSystem,
  type CliAdapterOptions,
  type CliDialect,
  type CliParser,
} from './adapter.js';
import { probeCommand } from './detect.js';

/**
 * Codex CLI's `exec` mode (X1 spec §5.1, from Codex's docs and source; not installed on the dev
 * machine, so verified against a fake CLI only). `exec` never asks for approval; the sandbox flag
 * is the preset. Codex reports whole messages, not deltas, and tokens but no cost (D263).
 */
export const CODEX_BASE_ARGS = ['exec', '--json', '--skip-git-repo-check', '--color', 'never'] as const;

const PERMISSION_ARGS: Readonly<Record<CliPermission, readonly string[]>> = {
  read_only: ['--sandbox', 'read-only'],
  edit_files: ['--sandbox', 'workspace-write'],
  full_auto: ['--dangerously-bypass-approvals-and-sandbox'],
};

const messageOf = (value: unknown): string => {
  if (typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return typeof value === 'string' ? value : JSON.stringify(value ?? 'unknown error');
};

export function codexError(message: string): NodeError {
  if (/not logged in|unauthori[sz]ed|\b401\b|please log ?in/i.test(message)) {
    return { kind: 'auth', code: 'cli_not_signed_in', message: `Codex CLI is not signed in — run \`codex login\`. ${message}`, retryable: false };
  }
  if (/rate limit|\b429\b|usage limit|quota/i.test(message)) {
    return { kind: 'provider', code: 'http_429', message: `Codex CLI limit reached: ${message}`, retryable: true };
  }
  return { kind: 'provider', code: 'cli_turn_failed', message: `Codex CLI failed: ${message}`, retryable: false };
}

export function createCodexParser(now: () => number = Date.now): CliParser {
  const started = new Map<string, number>();
  let wroteText = false;
  let usage: StreamChunk | undefined;
  let turnFailure: string | undefined;
  let lastError: string | undefined;

  const took = (id: unknown): number => {
    if (typeof id !== 'string') return 0;
    const at = started.get(id);
    return at === undefined ? 0 : Math.max(0, now() - at);
  };

  return {
    onEvent(event) {
      const item = (event['item'] ?? {}) as Record<string, unknown>;
      switch (event['type']) {
        case 'item.started':
          if (typeof item['id'] === 'string') started.set(item['id'], now());
          return [];
        case 'item.completed': {
          switch (item['type']) {
            case 'agent_message': {
              if (typeof item['text'] !== 'string' || item['text'] === '') return [];
              const delta = `${wroteText ? '\n\n' : ''}${item['text']}`;
              wroteText = true;
              return [{ type: 'text', delta }];
            }
            case 'command_execution':
              return [
                {
                  type: 'activity',
                  tool: 'command',
                  args: { command: item['command'] },
                  status: item['exit_code'] === 0 && item['status'] !== 'failed' && item['status'] !== 'declined' ? 'ok' : 'error',
                  summary: summariseToolOutput(item['aggregated_output'] ?? ''),
                  durationMs: took(item['id']),
                },
              ];
            case 'file_change': {
              const changes = Array.isArray(item['changes']) ? (item['changes'] as { path?: unknown; kind?: unknown }[]) : [];
              return [
                {
                  type: 'activity',
                  tool: 'file_change',
                  args: { changes },
                  status: item['status'] === 'failed' ? 'error' : 'ok',
                  summary: changes.map((change) => `${String(change.kind ?? 'update')} ${String(change.path ?? '')}`).join(', ').slice(0, 500),
                  durationMs: took(item['id']),
                },
              ];
            }
            case 'mcp_tool_call':
              return [
                {
                  type: 'activity',
                  tool: `mcp_${String(item['server'] ?? 'server')}_${String(item['tool'] ?? 'tool')}`,
                  args: item['arguments'] ?? {},
                  status: item['error'] === undefined || item['error'] === null ? 'ok' : 'error',
                  summary: summariseToolOutput(item['error'] ?? item['result'] ?? ''),
                  durationMs: took(item['id']),
                },
              ];
            case 'web_search':
              return [
                {
                  type: 'activity',
                  tool: 'web_search',
                  args: { query: item['query'] },
                  status: 'ok',
                  summary: String(item['query'] ?? ''),
                  durationMs: took(item['id']),
                },
              ];
            default:
              return [];
          }
        }
        case 'turn.completed': {
          const counts = (event['usage'] ?? {}) as Record<string, unknown>;
          usage = { type: 'usage', tokensIn: tokenCount(counts['input_tokens']), tokensOut: tokenCount(counts['output_tokens']) };
          return [];
        }
        case 'turn.failed':
          turnFailure = messageOf(event['error']);
          return [];
        case 'error':
          // Sometimes a recoverable notice; it only decides the outcome if the turn never completes.
          lastError = messageOf(event);
          return [];
        default:
          return [];
      }
    },

    finish(exit) {
      if (turnFailure !== undefined) throw new ProviderCallError(codexError(turnFailure));
      if (usage !== undefined) return [usage, { type: 'finish', reason: 'stop' }];
      if (lastError !== undefined) throw new ProviderCallError(codexError(lastError));
      throw new ProviderCallError(cliExitError('Codex CLI', exit));
    },
  };
}

/** Model ids from `codex debug models` — an array, or `{ models: [...] }`, of ids or objects. */
export function codexModelsFrom(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : [];
    return list
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (typeof entry === 'object' && entry !== null) {
          const record = entry as Record<string, unknown>;
          const id = record['slug'] ?? record['id'] ?? record['model'];
          return typeof id === 'string' ? id : '';
        }
        return '';
      })
      .filter((id) => id !== '' && id !== 'default');
  } catch {
    return [];
  }
}

export const codexDialect: CliDialect = {
  type: 'codex_cli',
  bin: 'codex',
  label: 'Codex CLI',
  args: (req, permission) => [
    ...CODEX_BASE_ARGS,
    ...PERMISSION_ARGS[permission],
    ...(req.modelId === 'default' ? [] : ['-m', req.modelId]),
    '-',
  ],
  stdin: withSystem,
  createParser: () => createCodexParser(),
  listModels: async (resolve) => {
    const fallback = [cliModel('default', 'Codex default')];
    const command = resolve();
    if (command === undefined) return fallback;
    const listed = await probeCommand(command, ['debug', 'models', '--bundled'], 10_000);
    return [...fallback, ...codexModelsFrom(listed.stdout).map((id) => cliModel(id, id))];
  },
};

export function createCodexAdapter(options: CliAdapterOptions): ProviderAdapter {
  return createCliAdapter(codexDialect, options);
}
```

In `factory.ts` add `import { createCodexAdapter } from './adapters/cli/codex.js';` and the case:

```ts
        case 'codex_cli':
          return createCodexAdapter({
            permission: provider.cliPermission ?? DEFAULT_CLI_PERMISSION,
            detect: () => cli.detect('codex_cli'),
          });
```

In `packages/providers/src/index.ts` add `export * from './adapters/cli/codex.js';`.

- [ ] **Step 4: Run tests** — `pnpm --filter @ace/providers exec vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/providers
git commit -m "feat(providers): Codex CLI as an agent-route provider [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: Gemini CLI dialect

**Files:**
- Create: `packages/providers/src/adapters/cli/gemini.ts`
- Modify: `packages/providers/src/factory.ts` (case `gemini_cli`), `packages/providers/src/index.ts`
- Test: create `packages/providers/src/adapters/cli/__tests__/gemini.test.ts`

**Interfaces:**
- Consumes: Task 10's helpers.
- Produces: `GEMINI_BASE_ARGS`, `GEMINI_MODELS`, `geminiDialect`, `createGeminiParser(now?)`, `geminiError(message, exitCode?)`, `createGeminiAdapter(options)`.

Gemini's `-o stream-json` schema comes from its docs and source (spec §5.1); verified against a fake CLI only.

- [ ] **Step 1: Write the failing test** — `gemini.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StreamChunk } from '../../../adapter.js';
import { GEMINI_BASE_ARGS, createGeminiAdapter, createGeminiParser, geminiDialect, geminiError } from '../gemini.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-gemini-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RUN = [
  { type: 'init', session_id: 's', model: 'gemini-2.5-pro' },
  { type: 'message', role: 'user', content: 'p' },
  { type: 'message', role: 'assistant', content: 'Reading ', delta: true },
  { type: 'message', role: 'assistant', content: 'the file.', delta: true },
  { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { absolute_path: 'a.js' } },
  { type: 'tool_result', tool_id: 't1', status: 'success', output: 'export const add' },
  { type: 'message', role: 'assistant', content: 'Done.', delta: true },
  { type: 'result', status: 'success', stats: { total_tokens: 140, input_tokens: 120, output_tokens: 20 } },
];

function replay(events: object[], exitCode = 0): StreamChunk[] {
  const parser = createGeminiParser(() => 0);
  const chunks = events.flatMap((event) => parser.onEvent(event as Record<string, unknown>));
  return [...chunks, ...parser.finish({ code: exitCode, signal: null, stderrTail: '', killed: false })];
}

describe('X1 Gemini CLI flags', () => {
  const req = { modelId: 'pro', prompt: 'p', outputTypes: ['text' as const], system: 'S' };

  it.each([
    ['read_only', 'plan'],
    ['edit_files', 'auto_edit'],
    ['full_auto', 'yolo'],
  ] as const)('maps %s to --approval-mode %s', (permission, mode) => {
    expect(geminiDialect.args(req, permission)).toEqual([...GEMINI_BASE_ARGS, '--approval-mode', mode, '-m', 'pro']);
  });

  it('prompts on stdin with the system section first, and stops the self-relaunch', () => {
    expect(geminiDialect.stdin(req)).toBe('S\n\np');
    expect(geminiDialect.env?.({ PATH: 'x' })).toEqual({ PATH: 'x', GEMINI_CLI_NO_RELAUNCH: 'true' });
    expect([...GEMINI_BASE_ARGS]).toEqual(['-o', 'stream-json', '--skip-trust']);
  });
});

describe('X1 Gemini CLI stream', () => {
  it('streams assistant deltas, records tool use, reports usage with no cost', () => {
    const chunks = replay(RUN);
    expect(chunks.flatMap((c) => (c.type === 'text' ? [c.delta] : [])).join('')).toBe('Reading the file.\n\nDone.');
    expect(chunks.filter((c) => c.type === 'activity')).toEqual([
      { type: 'activity', tool: 'read_file', args: { absolute_path: 'a.js' }, status: 'ok', summary: 'export const add', durationMs: 0 },
    ]);
    expect(chunks.at(-2)).toEqual({ type: 'usage', tokensIn: 120, tokensOut: 20 });
  });

  it('maps its exit codes: 41 is a sign-in failure, 55 an untrusted folder', () => {
    expect(() => replay([], 41)).toThrow(/not signed in/);
    expect(() => replay([], 55)).toThrow(/trust/);
    expect(geminiError('Quota exceeded (429)')).toMatchObject({ code: 'http_429', retryable: true });
  });

  it('a result with status error is an error', () => {
    expect(() => replay([{ type: 'result', status: 'error', error: { type: 'x', message: 'model not found' } }], 1)).toThrow(/model not found/);
  });
});

describe('X1 the Gemini adapter against a fake CLI', () => {
  it('runs with GEMINI_CLI_NO_RELAUNCH set', async () => {
    const echo = join(dir, 'echo.json');
    const adapter = createGeminiAdapter({
      permission: 'read_only',
      detect: async () => ({ type: 'gemini_cli', installed: true, login: 'unknown', installHint: 'i', loginHint: 'l' }),
      resolve: () => ({ command: process.execPath, prefixArgs: [FAKE], path: FAKE }),
      env: { ...process.env, FAKE_CLI_MODE: 'echo-stdin', FAKE_CLI_ECHO_FILE: echo },
    });
    const drained: StreamChunk[] = [];
    await (async () => {
      for await (const chunk of adapter.generate({ modelId: 'default', prompt: 'x', outputTypes: ['text'], workingDir: dir }, new AbortController().signal)) drained.push(chunk);
    })().catch(() => undefined);
    expect((JSON.parse(readFileSync(echo, 'utf8')) as { env: { GEMINI_CLI_NO_RELAUNCH: string } }).env.GEMINI_CLI_NO_RELAUNCH).toBe('true');
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm --filter @ace/providers exec vitest run src/adapters/cli/__tests__/gemini.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `packages/providers/src/adapters/cli/gemini.ts`:

```ts
import type { CliPermission, NodeError } from '@ace/contracts';

import { ProviderCallError, type ModelInfo, type ProviderAdapter, type StreamChunk } from '../../adapter.js';
import {
  cliExitError,
  cliModel,
  createCliAdapter,
  summariseToolOutput,
  tokenCount,
  withSystem,
  type CliAdapterOptions,
  type CliDialect,
  type CliParser,
} from './adapter.js';

/**
 * Gemini CLI headless (X1 spec §5.1, from its docs and source; not installed on the dev machine, so
 * verified against a fake CLI only). It runs headless when stdin is not a terminal; `--skip-trust`
 * stops an untrusted folder forcing the approval mode back to default, and GEMINI_CLI_NO_RELAUNCH
 * keeps it one process, so a Stop's tree kill reaches it. Tokens, no cost (D263).
 */
export const GEMINI_BASE_ARGS = ['-o', 'stream-json', '--skip-trust'] as const;

const APPROVAL_MODE: Readonly<Record<CliPermission, string>> = {
  read_only: 'plan',
  edit_files: 'auto_edit',
  full_auto: 'yolo',
};

export const GEMINI_MODELS: readonly ModelInfo[] = [
  cliModel('default', 'Gemini CLI default'),
  cliModel('pro', 'Gemini Pro'),
  cliModel('flash', 'Gemini Flash'),
  cliModel('flash-lite', 'Gemini Flash-Lite'),
];

export function geminiError(message: string, exitCode?: number | null): NodeError {
  if (exitCode === 41 || /not signed in|login|credential|api key|authenticat/i.test(message)) {
    return { kind: 'auth', code: 'cli_not_signed_in', message: `Gemini CLI is not signed in — run \`gemini\` in a terminal and sign in. ${message}`.trim(), retryable: false };
  }
  if (exitCode === 55 || /untrusted|trust/i.test(message)) {
    return { kind: 'invalid_config', code: 'cli_untrusted_folder', message: `Gemini CLI does not trust this folder. ${message}`.trim(), retryable: false };
  }
  if (exitCode === 53) {
    return { kind: 'agent', code: 'cli_max_turns', message: `Gemini CLI stopped at its turn limit. ${message}`.trim(), retryable: false };
  }
  if (/quota|\b429\b|rate limit|resource exhausted/i.test(message)) {
    return { kind: 'provider', code: 'http_429', message: `Gemini CLI limit reached: ${message}`, retryable: true };
  }
  return { kind: 'provider', code: 'cli_failed', message: `Gemini CLI failed: ${message}`, retryable: false };
}

export function createGeminiParser(now: () => number = Date.now): CliParser {
  const pending = new Map<string, { tool: string; args: unknown; startedAt: number }>();
  let streamed = false;
  let wroteText = false;
  let newTurn = false;
  let lastError: string | undefined;
  let result: Record<string, unknown> | undefined;

  const text = (content: string): StreamChunk => {
    const prefix = newTurn && wroteText ? '\n\n' : '';
    newTurn = false;
    wroteText = true;
    return { type: 'text', delta: `${prefix}${content}` };
  };

  return {
    onEvent(event) {
      switch (event['type']) {
        case 'message': {
          if (event['role'] !== 'assistant' || typeof event['content'] !== 'string') return [];
          if (event['delta'] === true) {
            streamed = true;
            return [text(event['content'])];
          }
          // A whole message after its deltas repeats them.
          return streamed ? [] : [text(event['content'])];
        }
        case 'tool_use':
          if (typeof event['tool_id'] === 'string') {
            pending.set(event['tool_id'], {
              tool: typeof event['tool_name'] === 'string' ? event['tool_name'] : 'tool',
              args: event['parameters'] ?? {},
              startedAt: now(),
            });
          }
          newTurn = true;
          return [];
        case 'tool_result': {
          if (typeof event['tool_id'] !== 'string') return [];
          const started = pending.get(event['tool_id']);
          if (started === undefined) return [];
          pending.delete(event['tool_id']);
          const error = event['error'] as { message?: unknown } | undefined;
          return [
            {
              type: 'activity',
              tool: started.tool,
              args: started.args,
              status: event['status'] === 'success' ? 'ok' : 'error',
              summary: summariseToolOutput(event['output'] ?? error?.message ?? ''),
              durationMs: Math.max(0, now() - started.startedAt),
            },
          ];
        }
        case 'error':
          if (event['severity'] === 'error' && typeof event['message'] === 'string') lastError = event['message'];
          return [];
        case 'result':
          result = event;
          return [];
        default:
          return [];
      }
    },

    finish(exit) {
      if (result !== undefined && result['status'] !== 'error') {
        const stats = (result['stats'] ?? {}) as Record<string, unknown>;
        return [
          { type: 'usage', tokensIn: tokenCount(stats['input_tokens']), tokensOut: tokenCount(stats['output_tokens']) },
          { type: 'finish', reason: 'stop' },
        ];
      }
      const said = (result?.['error'] as { message?: unknown } | undefined)?.message;
      const message = typeof said === 'string' ? said : (lastError ?? '');
      if (message !== '' || (exit.code !== null && [41, 53, 55].includes(exit.code))) {
        throw new ProviderCallError(geminiError(message, exit.code));
      }
      throw new ProviderCallError(cliExitError('Gemini CLI', exit));
    },
  };
}

export const geminiDialect: CliDialect = {
  type: 'gemini_cli',
  bin: 'gemini',
  label: 'Gemini CLI',
  args: (req, permission) => [
    ...GEMINI_BASE_ARGS,
    '--approval-mode',
    APPROVAL_MODE[permission],
    ...(req.modelId === 'default' ? [] : ['-m', req.modelId]),
  ],
  stdin: withSystem,
  env: (base) => ({ ...base, GEMINI_CLI_NO_RELAUNCH: 'true' }),
  createParser: () => createGeminiParser(),
  listModels: async () => [...GEMINI_MODELS],
};

export function createGeminiAdapter(options: CliAdapterOptions): ProviderAdapter {
  return createCliAdapter(geminiDialect, options);
}
```

In `factory.ts` add `import { createGeminiAdapter } from './adapters/cli/gemini.js';` and the case:

```ts
        case 'gemini_cli':
          return createGeminiAdapter({
            permission: provider.cliPermission ?? DEFAULT_CLI_PERMISSION,
            detect: () => cli.detect('gemini_cli'),
          });
```

In `packages/providers/src/index.ts` add `export * from './adapters/cli/gemini.js';`.

- [ ] **Step 4: Run tests, then cover all three types through the real engine**

`pnpm --filter @ace/providers exec vitest run` → PASS. Then in `apps/server/src/__tests__/x1-cli-providers.test.ts` add (the fake scan there marks Codex and Gemini not installed):

```ts
  it.each([
    ['claude_code', 'CONNECTED'],
    ['codex_cli', 'UNREACHABLE'],
    ['gemini_cli', 'UNREACHABLE'],
  ])('adds %s with no key and the default permission; Test says %s', async (type, status) => {
    const created = (await (
      await api('/providers', { method: 'POST', body: JSON.stringify({ type, name: type, concurrency: 1 }) })
    ).json()) as { id: string; cliPermission: string; keySet: boolean };
    expect(created).toMatchObject({ cliPermission: 'edit_files', keySet: false });
    const check = (await (await api(`/providers/${created.id}/check`, { method: 'POST' })).json()) as { status: string };
    expect(check.status).toBe(status);
  });
```

Run `pnpm --filter @ace/providers build && pnpm --filter @ace/server exec vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/providers apps/server/src/__tests__/x1-cli-providers.test.ts
git commit -m "feat(providers): Gemini CLI as an agent-route provider [X1] [FR-PRV-008]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 22: Verification — gates and real runs

**Files:** none changed unless a gate fails (then fix in the owning task's files and commit separately).

- [ ] **Step 1: Full gates, zero env vars**

```bash
cd "D:/ACE offcl/wt/x1"
pnpm build
pnpm typecheck && pnpm lint && pnpm test
pnpm -r test:coverage
```
Expected: all green; coverage ≥ 80 % for contracts/engine/providers/tools/storage-local/server and ≥ 60 % for web/ui/sdk. Paste the real summaries.

- [ ] **Step 2: Suites that drive the UI and the real engine**

```bash
pnpm test:e2e
pnpm test:acceptance
```
Expected: green. A web e2e spec that adds a provider through the dialog may now see the scan section first — fix the spec's locator, not the product, and only if the spec's intent is unchanged.

- [ ] **Step 3: Real Claude Code coding task again on the final build** — repeat Task 14 Steps 1–5 against the final commit. Record: streamed text, the `cli_*` ToolCalls, cost, the diff, Stop.

- [ ] **Step 4: Real tool loop through an API provider (if a stored key answers)** — in the same running ACE, Providers → press **Test** on OpenAI "v1" and Google "v1 test". For the first that is CONNECTED: on the demo project (reset with `git checkout -- .`), an Agent on its tool-capable model (`gpt-5` or `gemini-2.5-pro`) with tools `list_files, read_file, edit_file, run_command, git_diff` enabled, same Input text. Expected: Tool calls tab shows `read_file` → `edit_file` → `run_command` (an approval card appears — approve it) → `git_diff`; the node completes and `node --test` passes. If neither key answers, record "not verified — no working API key" (do not fake it).

- [ ] **Step 5: Record what could not be verified here** — Codex CLI and Gemini CLI real runs (not installed), Ollama (not installed). For each, the exact commands to enable it are in the hand-off (Task 23).

---

### Task 23: Feature log and hand-off

**Files:**
- Modify: `CLAUDE.md` §9 (append row X1 under the Feature Log table)

- [ ] **Step 1: Add the Feature Log row** — append after the last round-5 row:

```markdown
| X1 | X1 | Model gateway + CLI providers (Claude Code, Codex, Gemini) + project file/terminal/git tools | Arhant | `x1/model-gateway` | IN REVIEW | — | 2026-10-06 | — | D260–D266. Claude Code verified for real (Task 14/22); Codex and Gemini verified against fake CLIs only (not installed); API tool loop: <record Task 22 Step 4 outcome>. |
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: feature log row for X1 [X1]

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Hand-off report to the user**, in the brief's A–G shape: architecture (spec §3 with real paths), files changed (`git diff --stat origin/main...`), the provider flow traced through real functions, configuration and commands per provider (below), how to test, and remaining limitations (spec §11 plus anything Task 22 could not verify). Then **ask** before marking the draft PR ready for review or merging it — both are the user's call.

Per-provider enablement to include verbatim:

| Provider | Install | Sign in | In ACE |
|---|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude auth login` | Add provider → Found in your terminal → Add |
| Codex CLI | `npm install -g @openai/codex` | `codex login` (or set `CODEX_API_KEY`) | same; on Windows, `edit_files` needs Codex's one-time sandbox setup (run `codex`, then `/setup-default-sandbox`) |
| Gemini CLI | `npm install -g @google/gemini-cli` | run `gemini` once and choose a sign-in (or set `GEMINI_API_KEY`) | same |
| Ollama | install from ollama.com, `ollama pull llama3.2` | none | the "Ollama detected" banner → Add it |
| Anthropic / OpenAI / Google API | — | an API key | Add provider → type → key (stored in the OS keychain) |
