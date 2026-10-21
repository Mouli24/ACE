# ACE — application audit (2026-10-21)

Branch `fix/app-audit`, cut from `feat/pandacode-evolve` @ `fac6fe3c` (the checkout `Start ACE.cmd` runs).
Scope: the whole repository — engine, providers, tools, storage, web app, SDK, UI kit, docs, scripts.

How this was produced:

- **Seven read-only audits in parallel**, one per area (engine execution, providers/models, security,
  canvas/run/chat UI, Forge editor, app shell + design system, dead code + dependencies). Each traced
  findings through the code to a `file:line`, and several reproduced theirs with throwaway tests that
  drive the engine's own harness (nothing was added to the repo).
- **A live walk of the product** on an isolated engine (own data dir, engine `:47490`, web `:5190`,
  Mock provider) with Playwright: first launch → onboarding → first run → reading the result → node
  chat → Forge edit/save/switch/reload → a provider failure and Retry → every top-level route, bad ids
  and an unknown URL → 1440 / 1024 / 390 px widths.
- **Baseline gates** on `fac6fe3c`: `pnpm typecheck` 0 errors · `pnpm lint` 0 · web production build OK
  (main chunk 2,058 kB / 611 kB gzip). Known pre-existing test failures on the base (from the PandaCode
  wave logs): engine `trace-usage` ×1 and `always-allow-routes` ×4, contracts ×5, web 41.

Status legend — **VERIFIED**: traced end to end in code, reproduced, or seen live. **SUSPECTED**:
plausible with partial evidence. **Design**: a subjective recommendation, not a defect.

---

## 1. Executive summary

ACE is a large (~145k lines of source: web 66k, engine 38k), well-tested, carefully documented product.
The foundations are sound and were verified, not assumed: every route and the WebSocket demand the
session token (checked live), foreign origins are refused, secrets live only in the OS keychain, file
access is confined to the project folder (`..`, drive letters, UNC, NTFS streams, junctions, `.git`
variants all refused), no untrusted HTML is ever rendered, the conflict-safe save is genuinely
conflict-safe, Stop reaches every provider call and tool, and the first-run wizard takes a new user to a
finished run in three clicks with no console errors.

What holds it back is **not missing features but trust gaps in the paths people use most**:

1. **Results go missing or are hard to find.** A Join node runs on its first input and silently drops
   the rest while the run reports COMPLETE (reproduced). A Merge(any) fails when one branch fails, even
   though another succeeded — depending on timing. The Output node's panel never shows the final result
   ("Final result appears here after a run" is hard-coded). Images and files reach a model only as a
   text label such as `[image a.png (1234 bytes, image/png)]`, though pre-flight says vision models
   accept them.
2. **Money guardrails are softer than they look.** The run cost cap counts only output tokens of the
   next attempt, ignores in-flight work, and lets queued/agentic turns keep spending after the cap
   trips; models with no price (every discovered model, Groq, Codex/Gemini CLI) count as $0, so caps
   never trip for them.
3. **Failures are often silent or misleading.** Starting a run, Retry, Re-run and approvals have no
   error path (a 409 or a network error does nothing visible, and a failed start wipes the run already
   on screen). After every engine restart an open tab says "Project not found" / "Workflow not found"
   because the token rotated. An unknown URL shows React Router's developer page. Editing a failed node
   and pressing Retry re-runs the *old* settings while the card shows the new ones.
4. **User data lives in the wrong place.** A project created without a folder (the default in the New
   project dialog, onboarding and templates) is placed under the engine's working directory —
   `wt/panda/apps/server/ace-projects/<id>` today. 11 live projects are spread across 5 checkouts;
   removing a worktree or `git clean -fdx` deletes them.
5. **Several settings do nothing** (SearXNG URL, MCP on/off, Docker sandbox, default provider), and
   Guardrails / Tools / Usage pages are reachable only from inside a workflow's "…" menu.

Security: **no Critical or High issues.** Three Medium gaps let model- or attacker-controlled input past
an approval or a "no network" promise (imported workflows keep pre-approved command allowlists; HTTP
tools follow redirects without re-checking the allowlist; the JS sandbox can still use DNS/UDP). Dead
code is light — 0 `console.*`, `debugger`, TODO or commented-out code in product code; ~25 unused
exports, 6 unused dependencies, a handful of CSS tokens.

---

## 2. Architecture and feature inventory

| Layer | What it is | Notes from the audit |
|---|---|---|
| `apps/web` | React 18 + Vite SPA, React Flow canvas, Monaco (lazy), xterm, TanStack Query + Zustand, Tailwind v4 | 20 routes, all statically imported (one 2 MB chunk); MSW mock engine for tests/dev |
| `packages/sdk` | Typed REST client + resuming WebSocket client, run-view projection of events | every SDK call has a matching engine route (verified) |
| `packages/ui` | theme tokens (`theme.css`), shared components | token layer exists but most screens use literals (§9) |
| `apps/server` | composition root: config, adapters, Hono app, WS upgrade, token, shutdown | ~110 routes under `/api/v1` |
| `packages/engine` | graph service, run engine (pre-flight, scheduler, executor, envelopes, loops, merge), control service, approvals, chat, Domain, budgets, usage, knowledge, memory, checkpoints | 38k lines; `runs/index.ts` is ~3,900 lines |
| `packages/providers` | AI SDK adapters (Anthropic, Google, OpenAI, OpenAI-compatible), Ollama, CLI adapters (Claude Code, Codex, Gemini), Mock (29 scripted models), catalog, router | manifest lists 8 models |
| `packages/tools` | built-in tools, agent workspace tools, command runner (Git Bash, env allow-list), sandbox, MCP client, checkpoints (private git store) | path confinement verified sound |
| `packages/storage-local` | SQLite (better-sqlite3 + Drizzle), migrations, blobs, keychain secrets, FTS5 / sqlite-vec, backup | |
| `packages/guardrails`, `context`, `contracts` | policies/checks; parsing/chunking/retrieval; every Zod schema and enum | |

Main user journeys and their state after the live walk:

| Journey | State |
|---|---|
| First launch → onboarding → Mock provider → template → first run | **Works** (no console errors) |
| Read the run's final answer | **Partial** — only via the per-agent chat thread; Output node panel never shows it (L-1) |
| Node chat: pick an agent, send, switch agents | **Works** — threads are per node and swap correctly |
| Add a provider, discover models | **Partial** — HTTP providers start empty until Test/Refresh; `/v1` URLs fail (P-4, P-10) |
| Fan-in with Join / Merge(any) | **Broken** (E-1, E-2) |
| Failure → see why → Retry | **Partial** — failure card is clear; Retry after editing the node re-runs old settings (L-13) |
| Ideate ↔ Forge, edit, save, reload guard | **Works** — buffer survives the switch, `beforeunload` fires, save lands on disk |
| Fix with agent from Problems | **Partial** — sends the unsaved buffer while the agent edits the disk copy (F-1) |
| Reload after engine restart | **Broken UX** — "not found" screens (U-2) |
| Unknown URL | **Broken** — React Router developer page (U-1) |
| Phone width (390 px) shell pages | **Works** — no horizontal overflow on any page tried |

Features declared but not implemented (by the code itself, not new findings): routing policies
`capability` / `cost` / `latency` (`not_supported_yet`, D12); node kinds `guardrail` / `custom`
(refused at pre-flight); canned `web_search` unless SearXNG is wired (D-084).

---

## 3. Critical bugs and broken journeys

No Critical issue was found (no secret exposure, no crash on the main path, no corruption of saved
data). The High items, all VERIFIED:

| ID | Area | Finding | Evidence | Impact | Fix |
|---|---|---|---|---|---|
| E-1 | engine | Join transform runs on its first arriving input and drops the others | `runs/index.ts:674-678` `needed = multi ? 1 : edges`; repro Input→A,B,C→Join→Output = COMPLETE with only A's text | fan-in silently loses results | multi input ports wait for every edge (Merge keeps `isMergeReady`) |
| E-2 | engine | A failed branch blocks Merge(any) even when another branch succeeds | `blockDownstream` `runs/index.ts:1352-1380` blocks every not-yet-ready downstream node | outcome depends on timing; `any` gives no redundancy | block only nodes that can no longer become ready |
| E-4 / P-3 | engine | Cost cap is not a hard cap; unpriced models count as $0 | projection output-only `budgets/index.ts:107-113`; in-flight ignored `runs/index.ts:2670-2690`; queued turns continue after `budgetHalt`; `cost.ts:27-38` returns 0 without a price | real overspend (agentic turns, fan-out, Groq/CLI/discovered models) | count input estimate + in-flight; park the gate on halt; warn at pre-flight when a capped run uses unpriced models |
| E-8 | engine | Default project folder is `process.cwd()/ace-projects/<id>` | `graph/index.ts:158`; live: 11 projects across 5 checkouts, demo project inside `wt/panda` | `git clean`/worktree removal deletes user projects | default to `<dataDir>/projects/<id>`; ignore `ace-projects/` |
| P-1 / E-3 | providers | Media never reaches a model — only a text label | `GenerateRequest.prompt: string` `ports/model-provider.ts:98`; `renderPart` `prompts/index.ts:157-168`; adapter sends `{prompt}` | "multimodal" runs answer about a file name | pass attachments as AI SDK image/file parts; until then refuse at pre-flight |
| P-2 | providers | Discovered models are text-only, no tools, no JSON, 8k context, unpriced | `adapters/ai-sdk.ts:42-60`; live catalog: 48 models, 0 JSON, 0 priced | newer models can't serve JSON or tool nodes | family defaults + read capabilities from listings |
| L-1 | web | Output node's panel never shows the result | `config-panel/panels.tsx:579` is a static line; live run COMPLETE, panel says DONE + placeholder | the workflow's answer is not where the UI says | render the Output node's latest run output |
| L-13 | web | Retry after editing a failed node re-runs the run's old settings | live: model changed to `mock-text`, Retry → attempt 4 still `mock-503`; the card advises "add a fallback model on this node" | dead-end loop | tell the user the node changed since the run; offer "Run again with changes" |
| U-1 | web | No 404 route and no error boundary | `app/routes.tsx` has neither; live `/this-does-not-exist` shows "💿 Hey developer 👋" | any render error or bad URL replaces the whole app | `errorElement` + `*` route |
| U-2 | web | Stale token after engine restart reads as "not found" | new token each start `server.ts:325`; `ProjectPage.tsx:58`, `WorkflowLayout.tsx:70` map every error to "not found" (D-009) | looks like data loss | detect 401 → "engine restarted, open the new link"; tell 404 from other errors |
| U-3 | web+engine | SearXNG URL, MCP on/off, Docker sandbox, default provider are saved but never read | no reader outside the Settings page; `server.ts:655-662` always canned search + child-process sandbox | users configure features that do nothing | wire SearXNG + MCP flag; mark the other two "not active yet" |
| W-1 / W-2 | web | Run start, Retry, Re-run, approvals, thread delete have no error path | `useStartRunFlow.tsx:67`, `hooks.ts:146-151,209-232`, `ApprovalStack.tsx:158`; no `MutationCache` handler | a 409/network error does nothing; failed start wipes the run on screen | default error toast for every mutation without its own; restore the previous run |
| W-3 / W-4 | web perf | Approvals refetched and the whole Canvas re-rendered on every streamed token | `hooks.ts:262-268` keyed on `revision`; `Canvas.tsx:984`; `run-store.ts:357` new array per frame | network chatter + jank on large graphs | bump dedicated counters only on the frames that matter |
| W-5 | web/sdk | Runs blocked mid-run (loop guard / budget) read RUNNING with Pause offered | `sdk/run-view.ts:192-300` ignores `run.blocked`/`run.parked` (D305) | Pause answers 409, Resume never offered | handle both frames, pass reason/stayOpen to `allowedRunActions` |
| W-6 | web | Only "Undo move" is visible; deletes have no confirm or undo toast | `CanvasToolbar.tsx:115-127`; general undo only on Ctrl+Z | one misclick deletes a configured agent | Undo/Redo buttons + undo toast after delete |
| F-1 | Forge | Fix with agent / Ask agent send the unsaved buffer while the agent edits disk | `forge/panel/fix-with-agent.ts:53-55,89`; `EditorHost.tsx:110-115` | conflict bar; one choice loses work | save first when the file is dirty |

---

## 4. UI/UX issues

| ID | Sev | Screen | Finding (status) | Recommended fix |
|---|---|---|---|---|
| L-10 / U-7 | Med | global | Guardrails, Tools, Usage, Help only in the workflow "…" menu; three hand-kept link lists already differ (VERIFIED) | one `APP_LINKS` list used by the gear, the workspace menu and the compact menu |
| L-2 | Med | Canvas | after a run completes nothing in the top bar says so (README promises "run complete") (VERIFIED) | completion pill with the final output link |
| L-11 | Low | Home | "Describe it once — Ace assembles the team" with no input; all three cards open the same dialog (VERIFIED) | copy that matches the actions |
| L-12 | Med | New project | "Folder path (optional)" — blank goes to the engine's cwd (VERIFIED, see E-8) | say where it will go |
| W-8 | Med | Canvas | Run from here / Start from this node start a second concurrent run (VERIFIED) | disable while a run is active |
| W-9 | Med | Chat | one-click thread/message delete, 16 px target (VERIFIED) | confirm; 24 px target |
| W-10 | Med | Canvas | "show node" selects but doesn't scroll to it (VERIFIED) | `focusNode` from every "show node" |
| W-11 | Med | Inspector/chat | a failed query reads as "not run yet" / empty chat (VERIFIED) | error state with Retry |
| W-12 | Med | Canvas | engine offline → repeated "engine refused that edit" toasts (VERIFIED) | one persistent "N edits waiting" toast |
| W-13 | Med | Chat | forced scroll to bottom on every token (VERIFIED) | only when the reader is at the bottom |
| W-16 | Low | Canvas | halt note / pre-flight banner give advice without buttons; banner not dismissible (VERIFIED) | action buttons, dismiss |
| W-17 | Low | Canvas | viewport carries over between workflows (SUSPECTED) | key the flow provider by workflow |
| W-18 | Med | various | three run-control bars, four approval UIs, two error displays, four output viewers (VERIFIED) | one `useRunActions`, `ErrorCard` everywhere (Design) |
| U-4 | Med | `/` | a deleted last-opened project hijacks the landing page (VERIFIED) | check it exists; clear on delete |
| U-9 | Med | all | engine down → no retry, no instructions; queries never refetch after reconnect (VERIFIED) | invalidate on reconnect; shared error with Retry |
| U-15 | Low | header | theme set in three places; toggle overwrites "system" (VERIFIED) | |
| U-16 | Low | Home | no nudge when no provider exists (VERIFIED) | "No model provider yet — Add one" |
| U-17 | Low | various | providers tab/onboarding step not in URL; not-found workflow keeps live Run controls (VERIFIED) | |
| U-18 | Low | boot | near-black flash before the light theme paints (VERIFIED) | pre-paint theme script |
| P-4 | Med | Providers | `…/v1` base URLs (LM Studio, Groq, OpenRouter as documented) become `/v1/v1` (VERIFIED, reproduced) | accept a trailing `/v1` |
| P-7 | Med | Providers | a bad Google key shows grey "unknown"; the reason hides in a tooltip; Test never shows its error (VERIFIED) | map to AUTH_FAILED; show the message inline |
| P-10 | Med | Providers | HTTP providers aren't checked on create/key change; the node picker stays empty (VERIFIED) | check on create/update; refresh models on status |
| P-6 | Med | model picker | whisper/TTS/guard/embedding models offered for chat nodes (VERIFIED live) | mark non-chat models unavailable |
| F-2 | Med | Forge | an agent write to the open file resets the cursor to 1:1 and wipes undo (VERIFIED) | apply as an edit, keep view state |
| F-3 | Med | Forge | single-file Revert has no confirmation and can delete the agent's new file (VERIFIED) | confirm |
| F-5 | Med | Forge | open files under ignored paths (`.env`, `dist`) never refresh (VERIFIED) | refetch the active file on focus/activation |
| F-6 | Med | Forge | every Ideate→Forge switch re-walks the project and reloads type sources (VERIFIED) | keep them across modes |
| F-7 | Med | Forge | fixed-width panes, nothing resizable (D299 says resizable) (VERIFIED) | resizable panels |

## 5. Accessibility and responsive design

| ID | Sev | Finding (status) | Fix |
|---|---|---|---|
| U-5 | Med | `text-[#c94c27]` used 162× for error text = 4.07:1 on the light canvas (fails AA); the AA token `--danger-ink` is used 4× (VERIFIED) | point `--color-danger` at `--danger-ink`, replace the literal |
| U-6 | Med | focus ring literal `#ef6b3f` ×128 = 2.71:1 on the light canvas (<3:1); inputs signal focus only with a 1 px border (VERIFIED) | `--focus` token per theme |
| W-14 | Med | keyboard focus on a node card is invisible (React Flow removes the outline) (VERIFIED) | `:focus-visible` ring on the card |
| W-15 | Low | streaming text inside `aria-live`; old failures re-announced as alerts on every mount (VERIFIED) | announce once on completion |
| U-12 | Low | reduced motion covers 3 classes; ~13 infinite animations ignore it (VERIFIED) | global reduce rule |
| U-13 | Low | no skip link; page title always "ACE"; 18 px footer targets (VERIFIED) | |
| L-4 | Low | edges' accessible names are raw ULIDs (VERIFIED live) | use node names |
| F-12 | Low | mode switch has no tab stop in Domain (VERIFIED) | |
| U-14 | Low | workspace header can clip between 641 and ~850 px (SUSPECTED, width arithmetic) | `min-w-0`, icon-only run controls below `lg` |
| — | — | 390 px: Home, project, providers, settings, run detail, Forge render without horizontal overflow (VERIFIED live) | — |

## 6. Dead code and dependency cleanup candidates

Verified with knip 5.88.1 plus a whole-word search per symbol (tests, docs, configs, dynamic imports
included). Product code has 0 `console.*`, 0 `debugger`, 0 TODO/FIXME, 0 commented-out code blocks.

- **Unused exports/files:** `apps/web/src/responsive/index.ts` (barrel), `useFocusedNodeParam`,
  `toolsBySource`, `modelsByProvider`, `providerAccent`, `providerStatusColor`, `FIELD_LABEL`, theme
  prototype leftovers (`PLABEL`, `CTYPES`, `PERMS`, `HARNESS`, `short`), three mock getters, engine
  `toRouterModels` and `hasCycle`, two unused type re-exports, two unused test helpers.
- **Unused dependencies:** `apps/server` → `zod`; `storage-local` → `ulid`, `drizzle-kit`; `context` →
  `@ace/contracts`; `engine` → `ws`, `@types/ws`.
- **Unused CSS:** `--ace-glow-k`, `--ace-hi`, `--ace-ground`, `--btn`, `--btnInk`, `.ace-spin`.
- **Unused config:** the `@` path alias.
- **Stale scripts/config:** root `test:acceptance:e2e` (dead round-1 guard), matching guards in
  `.github/workflows/ci.yml`, stale comment in `tests/acceptance/playwright.config.ts`.
- **Keep (look unused, are not):** `apps/web/src/mocks/**` (mock mode + tests), MSW worker, manual
  scripts documented in D316, test-only exports, fixtures read from disk.
- **Needs an owner call:** `NodeRunActions` (planned per-node Stop), `dropGraphSync` (should be *wired*
  — graph-sync controllers are never disposed), the Forge output store (its panel was removed in
  D334), `DOMAIN_GRAPH_ISSUE_CODES`, root `ACE-UI-inventory.md`, `docs/team-prompts/CLAUDE.md`.
- **Duplicate logic:** 11 USD formatters, 6 duration formatters, ~10 "project-relative path" helpers,
  4 token estimators, two diverged `writtenPaths`. Consolidate opportunistically.

## 7. Security and performance

**Security** (no Critical/High; `pnpm audit --prod`: 0 critical, 0 high, 18 moderate):

| ID | Sev | Finding (status) | Fix |
|---|---|---|---|
| S-1 | Med | an imported workflow keeps `workspace.access`, `allowedCommands`, `allowedDomains` → Import + Run can execute commands with no approval card (VERIFIED, code) | strip command allow-lists and clamp access on import; tell the user |
| S-2 | Med | `http_request`/`web_fetch` follow redirects without re-checking the allow-list and can reach loopback/LAN (e.g. Ollama's API) (VERIFIED) | manual redirects, re-check each hop, refuse private addresses |
| S-3 | Med | `code_sandbox` ("no network") still allows UDP and DNS (VERIFIED, reproduced) | deny `dgram`/`dns` in the sandbox prelude |
| S-4 | Low | Windows ignores `mode: 0o600`; the session token inherits extra principals' read access (VERIFIED, `icacls`) | restrict the ACL on the token file |
| S-5 | Low | MCP stdio servers inherit the engine's full environment (VERIFIED) | use the agent env allow-list |
| S-6 | Low | artifact content route lacks `nosniff` / CSP sandbox though its URL carries the token (VERIFIED) | add the headers |
| S-7 | Low | no Host-header check (DNS-rebinding second layer) (VERIFIED live) | allow only 127.0.0.1/localhost |
| S-8 | Low | session token in browser/download history via artifact URLs (VERIFIED) | artifact-scoped signature (larger change) |
| S-9 | Low | unbounded request bodies, zip decompression, `web_fetch` body (VERIFIED) | body limits, decompressed-size cap |
| S-10 | Low | Markdown inline regex is quadratic: one 20k-char line freezes a render for 1.3 s (VERIFIED, timed) | bound the quantifiers / skip long lines |

**Performance:** W-3/W-4 (per-token refetch and Canvas re-render), U-8 (no route-level code
splitting; xterm in the first chunk), F-6 (project re-walk on every mode switch), F-8 (sequential
`stat` per directory entry, uncapped filter list), W-20 (trace polling during a live run), E-12 (small
per-run leaks: `workflowOfRun` map, backoff abort listeners).

## 8. Technical debt and architectural risks

| ID | Sev | Finding (status) | Note |
|---|---|---|---|
| E-5 | Med | run controls read-then-write with no status check: two Retries start two drives; a Pause landing as a run finishes turns COMPLETE into PAUSED forever (VERIFIED, reproduced) | compare-and-set on run status |
| E-6 | Med | crash recovery leaves PAUSED rows; HALTED `crash` shows Pause/Stop and $0 totals (VERIFIED, reproduced) | write `allowedActions`/totals on halt |
| E-7 | Med | a normal engine shutdown ends open Domain runs, contradicting D323 (VERIFIED, reproduced) | keep `stayOpen` runs open on shutdown |
| E-9 | Med | an agent's reads budget is applied per envelope, not across all inputs (VERIFIED, code) | split the budget across incoming edges |
| E-10 | Med | summary calls have no timeout and run inside the upstream node's finish (missing timeout VERIFIED) | timeout + fall back to truncation |
| E-11 / E-13 | Low | run totals not written while running; BLOCKED rows get iteration 1; retry leaves IDLE rows behind (VERIFIED) | |
| P-5 | Med | a failed model refresh replaces the discovered catalog with the stale manifest (VERIFIED) | keep rows, mark unavailable |
| P-8 / P-9 | Med | every transport error reads "fetch failed" (cause dropped); logged errors serialise as `{}` (VERIFIED, reproduced) | read `cause`; serialise `Error` |
| — | — | very large modules: `runs/index.ts` ~3,900 lines, `Canvas.tsx` 2,402, `EdgeLayer.tsx` 940 | split along existing seams when next touched (Design) |
| — | — | ownership map in CLAUDE.md §3 (engine vs web) no longer matches who builds what (D94) | owner decision |

## 9. Design-system recommendations

The token layer in `packages/ui/src/theme.css` is good and complete for both themes; screens mostly
bypass it (5,066 arbitrary Tailwind values, 651 hex literals, 20 font sizes, 17 radii, `--radius-*`
tokens unused, Tooltip component exported but never used against 158 native `title=`). Recommended,
preserving the current look:

1. One colour vocabulary: the `--ink/--muted/--line/--surface…` variables plus the AA text tokens
   (`--danger-ink`, `--accent-ink`, `--ok-ink`) as the *only* coloured text; add `--focus`.
2. A 7-step type scale (9.5, 11, 12, 13, 14, 16, 20) and the existing radius tokens.
3. Primitives in `packages/ui`: `IconButton` (requires a label, wraps Tooltip), `Switch`, one
   `ConfirmDialog`, `toolbar`/`chip`/`link` Button variants replacing ~25 local class constants.
4. One `AppHeader` instead of `SiteHeader` + `HomeHeader`; one `APP_LINKS` list.

## 10. Prioritised implementation plan

Five parallel tracks on branches off `fix/app-audit`, merged back in order, then a cleanup pass:

| Track | Branch | Items |
|---|---|---|
| A — engine correctness | `audit/engine` | E-1, E-2, E-4 + P-3, E-5, E-6, E-7, E-8, E-10, E-11, E-12, E-13, S-1, U-3 (engine side), U-4 (engine side) |
| B — security + providers | `audit/secprov` | S-2, S-3, S-4, S-5, S-6, S-7, S-9, S-10, P-4, P-5, P-6, P-7, P-8, P-9, P-10, P-13–P-18 |
| C — web shell + states | `audit/webshell` | U-1, U-2 (+D-009), U-3 (web side), U-4, U-7/L-10, U-8 (routes), U-9, U-12, U-13, U-15–U-18, L-11, L-12, global mutation error handling (W-1/W-2) |
| D — canvas, runs, chat | `audit/webwork` | L-1, L-2, L-4, L-13, W-1 (restore run), W-3, W-4 (partial), W-5, W-6, W-8–W-17, W-20 |
| E — Forge | `audit/forge` | F-1–F-6, F-10–F-13, U-8 (terminal) |
| Cleanup | `fix/app-audit` | §6 dead code and dependencies, U-5/U-6 token codemods, stale scripts |

Larger items deliberately left for a separate decision (see §11): P-1 real media parts, P-2
capability discovery, S-8 artifact-scoped credentials, F-7 resizable panes, W-7 settings edits in
undo history, W-18 consolidating duplicate run/approval/output UIs, the design-system migration beyond
the two token codemods.

## 11. Outcome

_Filled in after implementation — see below._
