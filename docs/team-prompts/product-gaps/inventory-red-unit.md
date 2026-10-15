# Product gaps, Phase 0 item 5: Vitest red tests (Phases 1–2)

Commit `f1c9dca` on `fix/pg-0-inventory`. Each red test is `it.fails` (or `it.fails.each`) and names its PG item in the describe. To check that each one fails for the right reason, every file was copied with `it.fails` changed to `it` and run. The "Fails at" column gives the assertion that failed and the message Vitest printed for it. A setup crash, type error or import error counts as the wrong reason; none of the tests failed that way. Control tests are plain `it` and pass today. They guard against over-fixing and against a red test going red for the wrong reason.

Paths: engine = `packages/engine/src`, contracts = `packages/contracts/src`, providers = `packages/providers/src`, server = `apps/server/src`, web = `apps/web/src`.

| Item | Test file | Test name | Fails at (assertion + observed message) |
|---|---|---|---|
| PG-1.3 | engine `__tests__/pg-1-3-missing-provider.test.ts` | an Agent with no provider is blocked with missing_provider, naming the node | `expect(codes(issues)).toContain('missing_provider')` → `expected [ 'missing_model' ] to include 'missing_provider'` |
| PG-1.3 | same | POST /validate (validateGraph) raises missing_provider for the same node | `toContain('missing_provider')` → `expected [ 'missing_model' ] to include 'missing_provider'` |
| PG-1.3 (guard) | same | D358: a provider with no model stays missing_model, not missing_provider | passes today |
| PG-1.3 (guard) | same | add_node of an Agent with no provider and no model is accepted | passes today (graph ops are not refused) |
| PG-1.4 | contracts `__tests__/pg-1-4-provider-group.test.ts` | providerGroup(provider) › 15 cases (cloud ×3, local ×7 incl. ollama/loopback/LAN, cli ×3, custom ×2) | `expect(typeof fn).toBe('function')` → `providerGroup is exported from @ace/contracts: expected 'undefined' to be 'function'` |
| PG-1.4 cost | engine `runs/__tests__/pg-1-4-cost-rule.test.ts` | an Ollama model is recorded at $0 even when a price row exists | `expect(usage.costUsd).toBe(0)` → `expected 0.8 to be +0` |
| PG-1.4 cost | same | a LAN openai_compatible model (LM Studio) is recorded at $0 even when priced | `expect(usage.costUsd).toBe(0)` → `expected 0.8 to be +0` |
| PG-1.4 cost | same | an unpriced remote openai_compatible model is recorded as unknown, not $0 | `expect(isUnknownCost(usage)).toBe(true)` → `expected false to be true` |
| PG-1.5 | engine `chat/__tests__/pg-1-5-failed-turn.test.ts` | a throw before the model call (reading reverted paths) stores one failed turn and emits it | `expect(stored).toHaveLength(1)` → `expected [] to have a length of 1 but got +0` |
| PG-1.5 | same | a throw while storing the reply stores one failed turn instead, and emits exactly one frame | `expect(stored).toHaveLength(1)` → `expected [] to have a length of 1 but got +0` |
| PG-1.5 | same | a user turn with no reply after it gets one failed agent turn when the engine starts | `expect(typeof recover).toBe('function')` → `expected 'undefined' to be 'function'` (`recoverOpenTurns` is a proposed name) |
| PG-1.6 | engine `chat/__tests__/pg-1-6-message-actions.test.ts` | retry: re-runs the turn, appends a new reply and keeps the old one marked superseded | `expect(response.status).toBeLessThan(300)` → `expected 404 to be less than 300` |
| PG-1.6 | same | edit: supersedes what followed the user message and sends the edited text as a new turn | same → `expected 404 to be less than 300` |
| PG-1.6 | same | DELETE: hides one message | same → `expected 404 to be less than 300` |
| PG-1.6 | same | stop: aborts the turn in flight and stores it as user_cancelled | same → `expected 404 to be less than 300` |
| PG-1.6 | same | a deleted user message is not in the next turn's prompt | same (the DELETE) → `expected 404 to be less than 300` |
| PG-1.6 | same | a superseded reply (after an edit) is not in the next turn's prompt | same (the edit) → `expected 404 to be less than 300` |
| PG-2.1 | engine `runs/__tests__/pg-2-1-output-contract.test.ts` | outputTypes [text] + a schema: non-conforming output is CONTRACT_VIOLATION | `expect(outcome.status).toBe('FAILED')` → `expected 'COMPLETED' to be 'FAILED'` |
| PG-2.1 | same | outputTypes [text] + a schema: prose that is not JSON at all is CONTRACT_VIOLATION | `expect(outcome.failureReason).toBe('CONTRACT_VIOLATION')` → `expected undefined to be 'CONTRACT_VIOLATION'` |
| PG-2.1 | same | outputTypes [text] + a schema: conforming output is parsed into a json part | `toContainEqual({ type: 'json', … })` → `expected [ { type: 'text', …(1) } ] to deep equally contain { type: 'json', value: { …(2) } }` |
| PG-2.1 | same | graph-ops accept a loop edge whose source has a schema but outputTypes [text] | `expect(response.status, body).toBe(200)` → `{"error":{…"code":"validation_failed"…"details":[{…"code":"loop_source_not_json"…}]}}: expected 400 to be 200` |
| PG-2.1 | same | a schema on a model with supportsJson:false is an error on the node (validate) | `expect(issues.length).toBeGreaterThan(0)` → `expected 0 to be greater than 0` |
| PG-2.1 | same | tools enabled on a model with supportsTools:false is an error on the node (validate) | same → `expected 0 to be greater than 0` |
| PG-2.1 | same | pre-flight blocks the same schema + supportsJson:false node | `.not.toEqual([])` → `expected [] to not deeply equal []` |
| PG-2.1 | providers `__tests__/pg-2-1-ai-sdk-json-schema.test.ts` | a request with a jsonSchema asks the model for JSON in that schema | `expect(model.doStreamCalls[0]?.responseFormat).toMatchObject({ type: 'json', schema })` → `expected undefined to match object { type: 'json', schema: { …(4) } }` |
| PG-2.2 | engine `chat/__tests__/pg-2-2-chat-budgets-tools.test.ts` | a priced chat turn shows in the day's cost the daily_budget check reads | `expect(spent).toBeGreaterThan(0)` (via `guardrailStoreFor(...).usage.costUsdForDay`) → `expected 0 to be greater than 0` |
| PG-2.2 | same | a turn over the project's cost cap ends as a failed turn that names the budget | `expect(reply.error).toBeDefined()` → `expected undefined to be defined` |
| PG-2.2 | same | a chat tool call passes the tool point, and a block stops the tool from running | `expect(seen.some((i) => i.point === 'tool')).toBe(true)` → `expected false to be true` |
| PG-2.2 | same | a tool_allowed check set to ask_user asks before the chat tool runs (as runs do) | `expect(ran).not.toContain('write_file')` → `expected [ 'write_file' ] to not include 'write_file'` |
| PG-2.3 | providers `__tests__/pg-2-3-no-full-auto.test.ts` | no source file builds Claude Code's bypassPermissions | `toEqual([])` → `expected [ 'adapters/cli/claude-code.ts' ] to deeply equal []` |
| PG-2.3 | same | no source file builds Codex's --dangerously-bypass-approvals-and-sandbox | `toEqual([])` → `expected [ 'adapters/cli/codex.ts' ] to deeply equal []` |
| PG-2.3 | same | no source file builds Gemini's yolo approval mode | `toEqual([])` → `expected [ 'adapters/cli/gemini.ts' ] to deeply equal []` |
| PG-2.3 | web `providers/pg-2-3-no-full-auto.test.tsx` | Add provider → a CLI → Permission lists Read-only and Edit project files only | `expect(screen.queryByRole('option', { name: 'Full auto' })).toBeNull()` → `expected <div role="option" …(6)>…(2)</div> to be null` |
| PG-2.3 | same | Edit provider on a CLI provider does not offer Full auto either | same → `expected <div role="option" …(6)>…(2)</div> to be null` |
| PG-2.3 | server `__tests__/pg-2-3-full-auto-migration.test.ts` | a provider saved on full_auto reads back on edit_files after a restart | `expect(…cliPermission).toBe('edit_files')` → `expected 'full_auto' to be 'edit_files'` |
| PG-2.4 | engine `checkpoints/__tests__/pg-2-4-checkpoint-start.test.ts` | writing run: no provider call is made and the run does not COMPLETE | `expect(h.calls('Writer')).toBe(0)` → `expected 1 to be +0` |
| PG-2.4 | same | writing chat turn: the write tool never runs and the turn ends saying why | `expect(ran).not.toContain('write_file')` → `expected [ 'write_file' ] to not include 'write_file'` |

## Notes for the fix phases

- **Existing tests that assert today's behaviour.** Phase 0 left these alone, because no existing test may be weakened. Each fix has to change them:
  - `engine checkpoints/__tests__/run-checkpoints.test.ts` › "still runs when the checkpoint cannot begin". The run in that test enables no tools, so PG-2.4 decides whether such a run counts as writing.
  - `web providers/CliScan.test.tsx` › "warns before Full auto" and "shows a CLI provider's permission … and edits it". Both pick and save Full auto, which conflicts with PG-2.3.
- **Shapes these tests assume.** The fix may choose a different shape. If it does, update the test in the same commit as the fix:
  - PG-1.5: the startup entry point is `chatService.recoverOpenTurns()`.
  - PG-1.6: rows carry `superseded: true` and `deleted: true` flags, or a deleted message is simply gone from `getThread`. Each route answers with a status below 300.
  - PG-1.4: "unknown" cost is any one of: `costKnown: false` (D359), a truthy `costUnknown`, `unknown` or `priceUnknown` flag, or a `costUsd` that is not a number.
  - PG-2.1: the blocked-combination issue codes are left open. The tests check for any `error` issue on the node.
- **PG-1.5 throws on paths D287 does not cover.** Both throws escape to the log-only `done.catch` today: one from `checkpoints.takeRevertedPaths` before the inner try, the other from the final `store()` append. A throw from the model call is already stored as a failed turn, so a test built on one would not be red.
- **PG-2.1 loop test.** The Reviewer keeps only its `text` output port, and the loop edge starts from that port. If the fix derives a `json` port from the schema instead, the edge's `from.portId` in the test must follow.
