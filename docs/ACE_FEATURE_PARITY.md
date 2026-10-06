# ACE feature parity — audit and plan

Date: 2026-10-06 · Branch: `ace/parity` (worktree `D:\ACE offcl\wt\parity`), stacked on
`x1/model-gateway` @ 8401695 (PR #39, draft) · Reference: <https://buildwithace.ai/docs> (the guide
"Updated 5 October 2026", one page, 20 sections).

This document compares the documented behaviour of **ACE — Agentic Coding Environment**
(buildwithace.ai) with what this repository actually implements, and orders the gaps P0 → P3.
Progress against the plan is tracked in [`ACE_IMPLEMENTATION_STATUS.md`](ACE_IMPLEMENTATION_STATUS.md).

## 1. What each side is

**This repository (before this work).** A local, single-user **workflow orchestration** app: a
React/Vite SPA (`apps/web`) over a Node/Hono engine (`apps/server`, `packages/engine`) with SQLite
(better-sqlite3 + hand-written SQL migrations, Drizzle mirror), a REST `/api/v1` + WebSocket `/ws`
seam typed by Zod contracts (`packages/contracts`), and the OS keychain for secrets. Users place
agent/model/input/output/merge/transform/retrieval nodes on a **Canvas**, connect them with typed
edges (and loop edges), and run the graph across cloud, local and mock providers. Every run is an
immutable snapshot with an append-only event log; guardrails at seven points, budgets and human
approvals are on by default. Rounds 1–5 are merged on `main`; the X1 branch (this branch's base)
adds a model gateway and **coding-agent CLI providers** (Claude Code done; Codex/Gemini adapters and
the project file/git/command tools still to come — X1 plan tasks T15–T23).

**ACE (buildwithace.ai).** A desktop **agentic coding environment**: projects backed by local Git
repositories; a **Tasks board** (Inbox → Plan → Work → Review → Done) whose App/Email/Document tasks
each have an explicit _finish line_; **Ideate** (team chat + canvas → brief → _Send to Build_);
**Build** (one agent per chat in its **own Git workspace and branch**, _Changes_ diff, _Preview_,
review, _Apply changes_ locally or _GitHub merge_); teams and workflows with Smart Actions
(Manual/Assisted/Autopilot); models through subscriptions (CLI), API billing or local models;
Skills/Plugins/Bundles; schedules and automatic progression; email intake; Suggestions; a
three-level approval choice; and named Secrets passed to runs as environment variables.

The two overlap strongly on the _agent_ half (teams = workflows on a canvas, models, approvals,
chat, memory, tools) and barely on the _work-tracking and code-delivery_ half (tasks, workspaces,
changes, review, delivery, schedules). The plan therefore **keeps the workflow engine as the
execution core** — a task's team _is_ a project workflow, and a task's plan/work stages _are_ runs
of it — and adds the task, workspace, review and delivery layer around it.

## 2. Status legend

`COMPLETE` — the important end-to-end behaviour works today · `PARTIAL` — some of it works ·
`BROKEN` — exists but does not work · `MISSING` — nothing · `N/A` — not applicable to this app
(a hosted service, the desktop shell or vendor accounts).

"Today" means the base of this branch: `main` @ 0b87f88 plus X1's committed work @ 8401695.

## 3. Feature parity matrix

### 3.1 Start here / workspace

| ACE capability                                                                                                     | Existing app (evidence)                                                                                        | Status  | Gap                                                                                 | Required work                                                                                                             | Pri                           |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| ACE account sign-in, access steps                                                                                  | Local session token printed by the engine (`apps/server/src/cli.ts`, `storage-local/src/auth.ts`); no accounts | N/A     | Hosted accounts are out of scope for a local single-user app                        | none — keep the token model                                                                                               | —                             |
| Desktop app, installers, content/desktop updates, release channels                                                 | Vite SPA + local engine; `ace-launcher/` outside the repo; Desktop is round 11 (FR-DSK-*)                      | N/A     | No Electron shell yet                                                               | Not part of this work (Arch §10.2, D1)                                                                                    | —                             |
| Home + Ace Assistant (describe a project, it proposes team/models/limits, confirm applies it and opens the canvas) | Onboarding wizard `/onboarding` with 4 templates (`apps/web/src/onboarding`, `engine/src/templates`)           | PARTIAL | No conversational setup; templates are fixed graphs                                 | Assistant: describe → proposal (template + team + models + limits) → review → confirm → project/workflow/schedule created | P2                            |
| Projects: new / open local repository / GitHub repository                                                          | `POST /projects` with optional `folderPath` (created if missing); no Git awareness (D24 deferred `git init`)   | PARTIAL | Projects are folders, not repositories; no repo detection, no init, no GitHub clone | Repo detection (branch, HEAD, clean, remote), explicit _Initialize Git_, _Clone from GitHub_ via `gh`                     | P0 (detect/init) · P1 (clone) |
| Project holds team, conversations, Tasks board, files                                                              | Holds workflows, runs, knowledge bases, chat per workflow                                                      | PARTIAL | No tasks, no files view                                                             | Tasks (P0); file browsing stays under Changes/diff                                                                        | P0                            |
| Project rail: Tasks, Ideate, Build, Assistant, preview, GitHub, Settings                                           | Top bar only: project name + workflow tabs; no project nav, no project settings page                           | MISSING | No project-level navigation or settings                                             | Project nav (Tasks · Workflows/Ideate · Build · Runs · Knowledge · Settings) + project settings page                      | P0                            |

### 3.2 Tasks board

| ACE capability                                                                         | Existing app                                            | Status  | Gap                       | Required work                                                                                                                                               | Pri      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Board columns Inbox → Plan → Work → Review → Done                                      | none (closest: runs list)                               | MISSING | No task entity at all     | `tasks` entity, persistent stage + state machine, board UI with columns                                                                                     | P0       |
| Card: assignment, worker, activity, notes, evidence                                    | none                                                    | MISSING | —                         | Task detail: brief, plan, assignee (team/agent), activity feed, runs, checks, changes, outcome                                                              | P0       |
| Search, labels, _Needs attention_                                                      | none                                                    | MISSING | —                         | Board search + label filter + needs-attention filter (waiting / failed / in review)                                                                         | P0       |
| Task types App / Email / Document sharing one lifecycle                                | none                                                    | MISSING | —                         | `type` on the task; App in P0; Document P1; Email P2                                                                                                        | P0/P1/P2 |
| Explicit finish line (review / apply locally / GitHub merge / accept doc / send email) | none                                                    | MISSING | —                         | `finishLine` per task; Done records an `outcome` — reaching Done by drag is not reaching the finish line                                                    | P0       |
| Change an inactive task's stage; Pause; Stop run; Close without verification           | Run Pause/Stop exist per run (FR-CTL-*)                 | PARTIAL | No task-level pause/close | Stage move for inactive tasks; task pause (blocks automatic stages); Stop = stop the active run; _Close without verification_ = outcome `closed_unverified` | P0       |
| Retry a failed task, keeping its history                                               | Node retry/re-run inside a run (FR-ERR-003, FR-CTL-005) | PARTIAL | No task-level retry       | Retry re-runs the failed stage on the same task and workspace                                                                                               | P0       |

### 3.3 Ideate, Build and review

| ACE capability                                                                                         | Existing app                                                                                          | Status  | Gap                                                       | Required work                                                                                                                                              | Pri |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Ideate: team canvas + chat, layout switch                                                              | Canvas + Chat column with @mentions, timeline, direct agent threads (`apps/web/src/chat`, `timeline`) | PARTIAL | Chat is per node/workflow; no brief                       | Keep; add brief handoff (below)                                                                                                                            | P1  |
| Message threads, Activity panel, generated assets                                                      | Direct threads per node; Events/Timeline tabs; media outputs render                                   | PARTIAL | —                                                         | Keep as is                                                                                                                                                 | P3  |
| Team memory (confirm/correct/forget, unverified label)                                                 | Agent memory per node (`engine/src/memory`, Memory tab)                                               | PARTIAL | Memory is per agent, not per board; no verified flag      | Project notes with verified/unverified state                                                                                                               | P2  |
| _Send to Build_ from a message, keeping source context; results return to Ideate                       | none                                                                                                  | MISSING | —                                                         | Message action → New task prefilled with the message + source thread/run reference; task outcome posted back to the workflow timeline                      | P1  |
| Build chat: one assigned agent, own coding workspace and branch                                        | none — runs touch no repository; X1 lets a CLI agent work _in the project folder itself_              | MISSING | No isolation: an agent would edit the user's working tree | Per-task Git **worktree + branch** under the data dir; the run's working folder is the worktree                                                            | P0  |
| Start now / Add to queue; capacity limits simultaneous Build agents                                    | Provider/run concurrency only (FR-PRV-009, D51)                                                       | MISSING | —                                                         | Project `buildCapacity`; a task over capacity is `queued` and starts when a slot frees                                                                     | P0  |
| Follow the conversation and work details (commands, files, interruptions)                              | Run inspector, Tool calls tab (CLI activity as `cli_*` ToolCalls via X1), Events tab                  | PARTIAL | Not reachable from a task                                 | Task _Build_ tab: the task's executions in order, each linking to its run; follow-up composer                                                              | P0  |
| Changes: file list, diff, review state, next action                                                    | none                                                                                                  | MISSING | —                                                         | Diff derived from Git (base SHA → task branch HEAD): file list with +/−, unified patch, per-file view                                                      | P0  |
| Preview the running app                                                                                | none                                                                                                  | MISSING | —                                                         | Project preview command run in the task worktree, status + URL + log tail; stop                                                                            | P1  |
| Request review / continue with a correction; a review of an earlier run does not approve later changes | none                                                                                                  | MISSING | —                                                         | Review decisions recorded against the reviewed HEAD SHA; _Request changes_ sends the note to a new work run in the same workspace                          | P0  |
| Recorded checks (tests)                                                                                | none                                                                                                  | MISSING | —                                                         | Project check commands run in the worktree after each work run; exit code + output tail recorded per HEAD SHA                                              | P0  |
| Apply changes locally (verify repository and branch)                                                   | none                                                                                                  | MISSING | —                                                         | Merge the task branch into the source repo's current branch after confirmation; refuses a dirty tree; conflicts keep the task in Review with the file list | P0  |
| GitHub delivery (open PR, confirmed merge)                                                             | none (gh CLI is available on this machine)                                                            | MISSING | —                                                         | Push branch, `gh pr create`, `gh pr merge`; _merged_ only when GitHub confirms                                                                             | P1  |
| Conflicts / failed checks / requested changes keep work in Review with an explanation                  | —                                                                                                     | MISSING | —                                                         | Part of the review state machine                                                                                                                           | P0  |

### 3.4 Teams, workflows, automation

| ACE capability                                                                                   | Existing app                                                                                                                                    | Status   | Gap | Required work                                                                                                                                                     | Pri |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Agent roles, model choice per agent, reference documents, connections                            | Agent nodes (provider, model, routing, instructions, tools, knowledge, memory, guardrail policy), typed edges, Retrieval node + knowledge bases | COMPLETE | —   | Reuse: a task's _team_ is a project workflow                                                                                                                      | —   |
| Loops and review conditions for multi-pass work                                                  | Loop edges with max iterations + exit condition; Review-and-fix template; JSON review contract (C3)                                             | COMPLETE | —   | Reuse                                                                                                                                                             | —   |
| Sequential and parallel execution, handoffs                                                      | DAG scheduler, parallel branches, Merge node, envelopes (BR-02)                                                                                 | COMPLETE | —   | Reuse                                                                                                                                                             | —   |
| Assign a task to the project team or one agent                                                   | —                                                                                                                                               | MISSING  | —   | `workflowId` on the task; templates _Single builder_ and _Plan → Build → Review_ create ready teams                                                               | P0  |
| Smart Actions: Manual / Assisted / Autopilot                                                     | —                                                                                                                                               | MISSING  | —   | Task `automation`: manual (each stage started by the user) · assisted (stages advance; final action waits) · autopilot (final action too, only under Full access) | P1  |
| Automatic progression; project and task pause; scheduled task waits on its previous run          | Run pause only                                                                                                                                  | MISSING  | —   | Engine-side progression on run completion; project/task pause stop _future_ stages                                                                                | P1  |
| Schedules: once, now, recurring, after another task's verified completion; timezone; skip missed | none (the "scheduler" is the DAG dispatcher)                                                                                                    | MISSING  | —   | Persisted schedules, an engine ticker, skip-missed on startup, _after task_ trigger                                                                               | P1  |
| Assistant-created schedules for team workflows                                                   | —                                                                                                                                               | MISSING  | —   | Follows the Assistant (P2)                                                                                                                                        | P2  |

### 3.5 Models and capabilities

| ACE capability                                                                 | Existing app                                                                                                         | Status   | Gap                                                                  | Required work                                                                                                 | Pri        |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| Connected tools: install/connect/repair a provider; readiness messages         | Providers page, Test, status states, periodic checks; X1: terminal scan for CLIs, install/login hints                | PARTIAL  | Codex/Gemini adapters not built (X1 T20/T21)                         | Finish on PR #39                                                                                              | P0 (on X1) |
| Subscription allowance (Claude/Codex/Gemini via their CLI)                     | X1: Claude Code agent route, verified against the real CLI                                                           | PARTIAL  | Codex/Gemini pending                                                 | PR #39                                                                                                        | P0 (on X1) |
| API billing (incl. OpenRouter)                                                 | Anthropic/OpenAI/Google/OpenAI-compatible adapters; price table; budgets                                             | COMPLETE | API models cannot call tools yet (X1 T15)                            | PR #39                                                                                                        | —          |
| Local models (Ollama, LM Studio)                                               | Ollama adapter + detection                                                                                           | COMPLETE | —                                                                    | —                                                                                                             | —          |
| Connected ≠ executable; per-model readiness                                    | Catalog `available`, preflight `provider_missing` / capability checks                                                | PARTIAL  | Known gaps: empty catalog until Refresh, discovered models text-only | Auto-refresh on create (noted in memory, not in scope here)                                                   | P3         |
| Assistant model selector separate from agent models                            | Agents choose models per node                                                                                        | PARTIAL  | No Assistant                                                         | With the Assistant                                                                                            | P2         |
| Skills (instructions for a kind of work), per-agent enablement                 | `AgentConfig.skillIds` exists; empty `## Skills` prompt section; _Skills — Round 6+_ placeholder in the config panel | MISSING  | No storage, API, UI or prompt rendering                              | Skills library + per-agent enablement + prompt section + snapshot                                             | P1         |
| Plugins (tools and services)                                                   | MCP servers (stdio/http) register tools; per-agent tool enablement (FR-TOOL-002/007)                                 | PARTIAL  | Library page is orphaned (no link)                                   | Link the library; treat MCP servers as plugins                                                                | P1         |
| Bundles (skills + plugin connections), import, separate install/connect/enable | none                                                                                                                 | MISSING  | —                                                                    | Bundle import (JSON): installs skills and registers (not connects) MCP servers; nothing enabled automatically | P2         |

### 3.6 Intake, suggestions, approvals, security

| ACE capability                                                                                                 | Existing app                                                                                             | Status                 | Gap                                               | Required work                                                                                                                                                                                | Pri |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Email intake from Gmail (import as task, automatic intake, investigation)                                      | none; no Gmail connection                                                                                | MISSING                | Needs a Gmail OAuth client the app does not have  | Import an email (`.eml` / pasted message) as an Inbox task, keeping sender/subject/date; Gmail connector interface for later                                                                 | P2  |
| Email tasks: draft, edit, accept, send, _Check Gmail_ on uncertain delivery                                    | none                                                                                                     | MISSING                | No mail transport                                 | Draft deliverable (to/cc/subject/body) with review + edit + accept; send behind a connector interface with an explicit `uncertain` state                                                     | P2  |
| Document tasks: Markdown, edit, accept into a project folder, never overwrite                                  | none                                                                                                     | MISSING                | —                                                 | Document deliverable + accept to a path inside the project; refuses an existing file                                                                                                         | P1  |
| Suggestions: responsibilities, Scan now / Watch, evidence, Add to Inbox / Later / Dismiss                      | none                                                                                                     | MISSING                | —                                                 | Responsibility entity; _Software health_ scan over recorded failed checks, failed tasks and (with `gh`) open GitHub issues; suggestion lifecycle; accepted → Inbox task (never auto-started) | P2  |
| Approval choice: Ask / Approve for me / Full access                                                            | Guardrail policies + approval cards per run (FR-GRD-006/013, BR-14); X1 per-CLI permission preset (D262) | PARTIAL                | No single user-level choice; no inbox across runs | `approvalMode` setting governing automatic final actions and the CLI permission ceiling; global pending-approvals inbox                                                                      | P1  |
| Open a pending request, read action + context, approve/deny                                                    | Approval cards on the run, Canvas and run page                                                           | COMPLETE               | Not reachable from a task                         | Task shows _waiting_ with a link to its approval                                                                                                                                             | P0  |
| Secrets: named env vars for runs/previews, values scrubbed from events and output, names only in agent context | Provider keys in the keychain only; secret-pattern masking (D86)                                         | MISSING                | No user secrets                                   | Secrets store (keychain values, DB names), env injection into checks/preview/CLI runs, exact-value scrubbing                                                                                 | P1  |
| Security: projects, files, workspaces stay local; inspect before applying                                      | Engine binds 127.0.0.1, token + origin guard, keychain                                                   | COMPLETE (local model) | Workspaces did not exist                          | Workspaces live under the data dir; nothing is applied without an explicit action                                                                                                            | P0  |
| Troubleshooting: messages carry recovery actions                                                               | Error cards with next-step hints for runs                                                                | PARTIAL                | —                                                 | Task failures carry the reason and a Retry action                                                                                                                                            | P0  |
| Feedback / error reports                                                                                       | Telemetry off by contract (NFR-PRIV-01)                                                                  | N/A                    | —                                                 | —                                                                                                                                                                                            | —   |

## 4. Conflicts between the ACE docs and this repository

| #   | Conflict                                                                                                                                                    | Resolution (safest)                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | ACE "Full access" runs filesystem/network/external actions without prompts; this repo's BR-14 says destructive tool actions **never** run without approval. | Full access governs **automatic final actions** (apply/merge/accept/send) and the **CLI permission ceiling** only. Destructive ACE tool calls keep their approval card (BR-14 stands).                                  |
| C2  | ACE "Build" is one agent per chat; this repo's unit of agent work is a workflow run.                                                                        | A Build conversation is a **task**; each turn is a **run** of the task's workflow (a one-agent workflow for a single agent). All run machinery — streaming, guardrails, approvals, inspector, cost — is reused.         |
| C3  | FR-GIT-002 (round 7) commits after _each node_ in the project folder; ACE isolates work in a separate workspace and branch.                                 | ACE's model is safer for the user's tree: the task worktree gets one commit **per work run** on its own branch; the project folder is only touched by an explicit _Apply_. FR-GIT-002's per-node commits are not built. |
| C4  | D24 deferred `git init`.                                                                                                                                    | Not automatic: _Initialize Git_ is an explicit button on a project that is not a repository.                                                                                                                            |
| C5  | ACE schedules run "while ACE is open"; this repo has no background service outside the engine.                                                              | Same: the engine ticks while it runs and **skips** occurrences missed while it was stopped, recording that it skipped them.                                                                                             |
| C6  | ACE Gmail send/intake needs a connected Google account; this repo has no OAuth client.                                                                      | Email drafts, review and acceptance are built; _Send_ is behind a connector interface and reports _not connected_ — never pretends.                                                                                     |
| C7  | CLAUDE.md §3 splits paths between two owners and requires contracts-first PRs; this work spans both sides.                                                  | One developer (D94): contracts land first in their own commit on this branch, then engine, then web, each with its own tests.                                                                                           |

## 5. Implementation plan

Work proceeds in vertical slices — contract → storage → engine → API/WS → SDK → web → tests →
run — and each slice keeps `pnpm typecheck && pnpm lint && pnpm test` green.

### P0 — core: tasks, workspaces, changes, review, local delivery

1. **Contracts** (`packages/contracts/src/tasks.ts`, `workspaces.ts`; `events.ts` `task.updated`):
   task, stage, state, finish line, outcome, automation, executions, checks, reviews, deliveries,
   activity; repository info; project settings fields; REST request/response schemas.
2. **Storage**: migration `…_parity_p0_tasks` — `tasks`, `task_executions`, `task_checks`,
   `task_reviews`, `task_deliveries`, `task_activity`, `task_workspaces`; project columns
   (`paused`, `build_capacity`, `check_commands`, `preview_command`); repositories.
3. **Git + command adapters** (`packages/tools/src/git/`, `packages/tools/src/process/`): repo
   inspection, init, worktree create/remove, commit-all, diff (name-status, numstat, patch), merge
   into source with conflict detection; a command runner for checks (timeout, abort, output tail).
   No shell for Git; argument arrays; `GIT_TERMINAL_PROMPT=0`.
4. **Engine task service** (`packages/engine/src/tasks/`): the state machine; Plan and Work as runs
   of the task's workflow with the brief/plan/corrections as the Input; the run's working folder is
   the task worktree (X1's `projectFolderFor` seam); on run completion commit, diff, run checks,
   move to Review; review decisions bound to the HEAD SHA; Apply locally; close; retry; stop;
   capacity queue; crash recovery; `task.updated` events.
5. **Gateway routes** under `/api/v1` (projects/:id/tasks, tasks/:id/…, projects/:id/repository).
6. **Mock coder**: a `mock-coder` model that edits files in its working folder from directives in
   its prompt, so the whole flow runs with zero keys in tests and acceptance.
7. **Web**: project navigation; Tasks board; New task dialog; task page (Overview · Build ·
   Changes · Checks · Activity) with review and delivery actions; project settings (repository,
   checks, capacity, pause); SDK methods, WS patching, MSW handlers.
8. **Tests**: contracts, storage migration + repos, git adapter against real temp repos, task
   service with fakes, gateway, a server integration test (real engine + real Git + mock coder:
   create → plan → work → changes → review → approve → apply), web component tests, an acceptance
   e2e walking the same flow in the browser.

### P1 — major product functionality

Automation levels + automatic progression + pause semantics; schedules (once / recurring /
after-task, timezone, skip-missed); approval mode setting + global approvals inbox; Skills library
and per-agent enablement (prompt `## Skills`); Plugins library linked (MCP); Secrets (keychain +
env injection + scrubbing); Preview (project command in the worktree); GitHub delivery (push, PR,
confirmed merge) and clone-from-GitHub; Document tasks; _Send to Build_ from chat; team templates.

### P2 — advanced

Email tasks (draft/review/accept; send connector with an _uncertain_ state); email import into the
Inbox; Suggestions (responsibilities, Scan now / Watch, evidence, Add to Inbox / Later / Dismiss);
team notes (verified/unverified); Bundles import; Ace Assistant project setup.

### P3 — polish

Empty/loading/error states across the new screens; keyboard shortcuts on the board; drag between
columns for inactive tasks; catalog auto-refresh on provider create.

## 6. Architecture decisions for this work

Recorded in `docs/DECISIONS.md` from D267 (D260–D266 are X1's, on this branch's base):

- **D267** Parity work stacks on X1 (`ace/parity` from `x1/model-gateway`) and starts before
  `round-4`/`round-5` are tagged, on the owner's instruction (as D236/D237/D260).
- **D268** A task's team is a project workflow; Plan and Work are runs of it; the run's working
  folder is the task's worktree (C2).
- **D269** Task workspaces are Git worktrees under `<dataDir>/workspaces/<taskId>` on branch
  `ace/task-<id>`, one commit per work run; the source folder changes only on _Apply_ (C3, C4).
- **D270** Full access governs final actions and the CLI ceiling, never ACE's destructive-tool
  approvals (C1).
- **D271** Check and preview commands are user-configured per project and run unsandboxed in the
  task worktree, like a local CI command; they are shown before they run and never come from an
  agent.
