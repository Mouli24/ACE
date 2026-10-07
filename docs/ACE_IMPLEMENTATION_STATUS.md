# ACE parity — implementation status

Branch `ace/parity` (worktree `D:\ACE offcl\wt\parity`), stacked on `x1/model-gateway` (D267).
Gap analysis, plan and the post-implementation matrix: [`ACE_FEATURE_PARITY.md`](ACE_FEATURE_PARITY.md).
P0 design: [`team-prompts/p0-tasks-build-design.md`](team-prompts/p0-tasks-build-design.md).
Decisions D267–D284 in [`DECISIONS.md`](DECISIONS.md).

_Last updated: 2026-10-07._ Nothing on this branch is pushed.

## Summary

| Priority | Scope                                                                                                                                                                                                                                                     | State                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| P0       | Tasks board, task worktrees and branches, Plan/Work as runs of the team workflow, Changes and diff, checks, review bound to a SHA, Apply locally with a confirmed destination, capacity queue, automation levels, pause, crash recovery, project settings | Done — engine, storage, Git, web, server end-to-end test, browser e2e                      |
| P1       | Skills and Bundles; Secrets; approval mode, approvals inbox and CLI ceiling; Document and Email deliverables; GitHub PR and confirmed merge; Clone from GitHub; Preview; Schedules; Send to Build; team templates                                         | Done — engine, storage, web; GitHub covered with a fake `gh`                               |
| P2       | Responsibilities and Suggestions (Scan now / Watch), team notes, email import, Ace Assistant                                                                                                                                                              | Done — engine, storage, web screens, server end-to-end test, browser e2e                   |
| P3       | Polish                                                                                                                                                                                                                                                    | Partly — empty/loading/error states on the new screens; no drag between columns (see gaps) |

## Implemented — P0 (tasks, workspaces, changes, review, local delivery)

| Slice          | What works                                                                                                                                                                                                                                                                                                                          | Where                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Contract       | Task, stages/states, finish lines, outcomes, automation, executions, checks, reviews, deliveries, activity, changes, repository info; project Build settings; approval mode; `task.updated`/`task.deleted`/`project.changed`; error codes                                                                                           | `packages/contracts/src/tasks.ts` (+ `graph.ts`, `api.ts`, `settings.ts`, `events.ts`, `errors.ts`) |
| Storage        | Migration `20261006T180000_parity_p0_tasks`: seven task tables + project columns; repositories; backup import copies tasks                                                                                                                                                                                                          | `packages/storage-local/src/repository-tasks.ts`, `migrations.ts`                                   |
| Git + commands | Git port over the `git` binary (inspect, init, worktrees, commit-all, changes with renames/binaries, per-file diff, merge with conflict abort; 5-minute timeout; ACE's own commits unsigned) and the check-command runner (platform shell, tree kill, output tail)                                                                  | `packages/tools/src/git/`, `packages/tools/src/process/`                                            |
| Task service   | The state machine: plan/work runs of the team workflow in the task worktree (run id chosen first, so the working folder is never the project folder), a commit per work run, checks per head, review bound to a SHA, Apply with destination confirmation and conflict handling, Close, capacity queue, automation + pause, recovery | `packages/engine/src/tasks/`                                                                        |
| Mock coder     | `mock-coder` edits files in its working folder from `ace-mock:` directives — the whole flow runs with no key                                                                                                                                                                                                                        | `packages/providers/src/adapters/mock-coder.ts`                                                     |
| Web            | Tasks board (five columns, search, labels, Needs attention, paused banner), New task dialog, task page (Overview, Build, Changes + diff, Checks, Activity, Review panel), project navigation and settings, approval mode in Settings, live `task.updated` patches                                                                   | `apps/web/src/tasks/`, `apps/web/src/projects/`                                                     |
| Team templates | _Single builder_ (mock coder) and _Plan, build and review_                                                                                                                                                                                                                                                                          | `packages/engine/src/templates/`                                                                    |

## Implemented — P1

| Feature (decision)                    | What works                                                                                                                                                                                                                                                                     | Where                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Skills (D272)                         | Library with five built-ins (read-only, duplicable), user skills with versions; an agent enables skills by id; pre-flight refuses a missing one; the run snapshot freezes them; the prompt renders `## Skills`; the prompt version folds in `name@version`                     | `engine/src/skills/`, `storage-local/src/repository-skills.ts`, `web/src/library/`, agent config panel |
| Bundles (D273)                        | Import an `ace-bundle` JSON: installs its skills, records its MCP server definitions without connecting them; delete removes its skills                                                                                                                                        | same                                                                                                   |
| Plugins                               | The Library page (Tools · Skills · Plugins · Bundles) is linked from the top bar; MCP servers are the plugins                                                                                                                                                                  | `web/src/library/`                                                                                     |
| Secrets (D274)                        | Values only in the OS keychain, names/descriptions/project scope in the DB; injected as env into setup/check commands, previews and CLI-route runs; names (never values) in the prompt's `### Environment`; exact values scrubbed from events, check output and tool-call rows | `engine/src/secrets/`, `storage-local/src/repository-secrets.ts`, Settings › Secrets                   |
| Approval mode + inbox (D270)          | `ask` / `auto_review` / `full_access`; Autopilot's final action only under Full access; the CLI permission ceiling follows the mode; `GET /approvals` across runs and an approvals inbox in the top bar                                                                        | `engine/src/approvals/inbox.ts`, `providers/src/adapters/cli/`, `web/src/runs/approvals/`              |
| Document and Email tasks (D275, D284) | The work run writes the Markdown or the draft; review edits it; Accept writes a document into the project folder and never over a file (`file_exists`); an email draft is accepted, Send answers `not_connected` and Accept stays available                                    | `engine/src/tasks/deliverables.ts`, `web/src/tasks/TaskDraft.tsx`                                      |
| GitHub delivery (D276)                | Push + `gh pr create`; merge only after the client repeats the repository and base; `merged` only when GitHub reports it (else `uncertain`); `--repo` passed explicitly; Clone from GitHub creates a project                                                                   | `engine/src/tasks/github-delivery.ts`, `tools/src/github/`                                             |
| Preview (D278)                        | The project's preview command in the task worktree on a free `PORT`, URL from `{port}`, output tail, stop, exit recorded                                                                                                                                                       | `engine/src/tasks/previews.ts`, `tools/src/process/preview-runner.ts`, Preview tab                     |
| Schedules (D277)                      | `once`, `recurring` (cron + timezone, one task per occurrence, skipped while the last is not Done), `after_task` (on a verified outcome); missed occurrences skipped and counted; a refused trigger creates no task                                                            | `engine/src/tasks/scheduler.ts`, `cron.ts`, Schedule card, Timing in New task                          |
| Send to Build                         | A chat reply's action opens New task prefilled with the message and its source; the outcome is posted back to the workflow's timeline                                                                                                                                          | `web/src/chat/SendToBuild.tsx`, `postNote` in `apps/server/src/server.ts`                              |

## Implemented — P2

| Feature (decision)                   | What works                                                                                                                                                                                                                                                      | Where                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Responsibilities, Suggestions (D280) | A responsibility (what, why, what good looks like); _Software health_ scans failed checks, failed tasks and, with `gh`, open issues and failed CI runs; evidence; fingerprint dedupe; Scan now / Cancel / Watch; Add to Inbox (never started) / Later / Dismiss | `engine/src/suggestions/`, `storage-local/src/repository-suggestions.ts`; project tab _Suggestions_ (`web/src/suggestions/`) |
| Team notes (D281)                    | Project notes, verified or unverified, written into task runs' prompts (verified first)                                                                                                                                                                         | same, `engine/src/tasks/prompts.ts`; project tab _Notes_ (`web/src/suggestions/NotesPage.tsx`)                               |
| Email import (D282)                  | `.eml` or pasted message → Inbox task keeping sender, subject and date; headers decoded; attachments dropped; never starts an agent                                                                                                                             | `engine/src/suggestions/email.ts`; _Import email_ on the board (`web/src/tasks/ImportEmailDialog.tsx`)                       |
| Ace Assistant (D283)                 | Describe a project → proposal (project, team template, agents, models, budget) from a connected model's JSON or from rules, saying which → Apply creates the project, the team and its settings                                                                 | `engine/src/assistant/`; the composer on the projects page (`web/src/assistant/AssistantPanel.tsx`)                          |

## Fixed while integrating

- A task created with a refused trigger left an unscheduled task in the Inbox — the trigger is now checked first (`a1eba58`).
- The kernel's `commandEnv` lost its project id when the secrets slice changed its signature, so previews got no secrets — fixed and tested (`bd44bf6`).
- An Email task whose finish line is Send could never finish — Accept is offered for it (D284, `a3b9d2b`).
- The skills migration test wrote a project with columns that do not exist yet at that point of the chain (`971418f`).
- Acceptance TC-ERR-002 was marked `test.fail()` for a provider missing from error records; X1's model gateway now stamps it, so the marker is removed (`cd3e029`).
- Keyboard connect (NFR-USE-02) dropped a connection when Enter on an input came before the canvas re-rendered the arming; the armed port is now read from a ref (`85f00fb`, with a unit test that reproduces the race). It passes on the X1 base and began failing here once the canvas did more work per render.

## Known limitations

- No mail connector: Send reports `not_connected` (C6); Gmail intake is import-only.
- GitHub delivery is verified against a fake `gh` (tools and engine suites), not a real repository.
- No drag between board columns (inactive tasks move with the stage action); no board keyboard shortcuts.
- The Assistant does not create schedules (D283).
- Preview status is polled on the task page while a preview runs; no event carries it.
- Check, setup and preview commands run unsandboxed in the worktree with the user's environment plus the project's secrets (D271, D274) — the trust of a local CI script; they are never written by an agent.
- CLI agents receive real secret values by design; under Full access a `full_auto` CLI could print or send them. Exact-value scrubbing covers events, check output and tool-call rows, not node-run output columns or logs.
- Pre-existing, not changed here: deleting a project leaves its workflows and nodes in the database, so a provider they name still counts as in use.
- A recurring cosmetic diff: some contract/engine files were reformatted with the shared Prettier config.

## Test status

Final run on 2026-10-08, on `ace/parity` after every slice was integrated. `pnpm -r build`,
`pnpm -r typecheck` and `pnpm -r lint` are clean.

| Suite                             | Result                                                   |
| --------------------------------- | -------------------------------------------------------- |
| contracts                         | 1129 passed                                              |
| storage-local                     | 405 passed                                               |
| engine                            | 1706 passed                                              |
| providers                         | 436 passed, 1 skipped, 3 todo                            |
| tools                             | 274 passed, 1 skipped                                    |
| sdk                               | 189 passed                                               |
| server (real engine, real Git)    | 171 passed                                               |
| web                               | 1065 passed                                              |
| acceptance — Vitest half          | 182 passed, 1 todo                                       |
| acceptance — Playwright (real UI) | 99 passed, 2 skipped (`test.fixme` in round 3), 0 failed |

The parity browser tests are `tests/acceptance/parity/tasks-flow.e2e.ts` (P0) and
`suggestions-assistant.e2e.ts` (P2). Acceptance rows that wait on autosave within 10 s can time
out while other suites load the machine; every row passed in the final run.

## How to run

```sh
cd "D:/ACE offcl/wt/parity"
pnpm install
pnpm --filter "./packages/**" build   # the engine resolves workspace packages from dist/
pnpm dev                              # engine on 127.0.0.1:4747, web on localhost:5173
```

Open the `?token=` URL the engine prints. To try the Build loop with no key: add the _Mock_
provider, press _Refresh models_, open a project on a Git repository (or _Initialize Git_ in its
settings), add the _Single builder_ team from the templates, then _New task_ on the Tasks board.
A brief containing `ace-mock:write <path>` … `ace-mock:end` makes the mock coder write that file.

Gates: `pnpm typecheck && pnpm lint && pnpm test`; acceptance: `pnpm test:acceptance`.
