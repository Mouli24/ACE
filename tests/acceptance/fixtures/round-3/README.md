# Round 3 fixtures

Workflow exports (`WorkflowExport`, round 1 §2.7) that the round 3 acceptance suites import and run
against the mock provider. Round 3 §4 item 8 lists them.

| File | Shape | What it is for |
|---|---|---|
| `review-fix.json` | Input → Writer[`mock-text`] → Reviewer[`mock-reject-twice`] → Output, loop edge Reviewer → Writer | The §1 demo's Review→Fix loop: max 3, exit `verdict == "approved"`, `onMax: continue`. Approved on iteration 3, so the loop ends on its exit condition (FR-PAR-003/004, TC-PAR-003) |
| `review-never.json` | The same graph with the Reviewer on `mock-reject-always` | Never approved, so the loop can only end at `max_iterations` and then continue downstream (FR-PAR-005/006) |
| `parallel-merge-all.json` | Input → Analyst[`mock-slow`] + Scorer[`mock-json`] → Merge(`all`) → Writer → Output | Both branches overlap; the merge waits for both and orders its output by input port (FR-PAR-001/002) |
| `parallel-merge-any.json` | The same with Merge(`any`) | The Scorer wins; the Analyst still completes and is recorded but does not feed the merge |
| `retry-429.json` | Input → Summariser[`mock-429-then-ok`] → Output, `retries: 2` | Rate limited on attempts 1 and 2, completes automatically on attempt 3 (FR-ERR-005, TC-ERR-005) |
| `auth-401.json` | Input → Gatekeeper[`mock-401`] → Downstream[`mock-text`] → Output | An auth error is never retried, and the node after it is BLOCKED rather than FAILED (FR-ERR-006) |
| `pii-ask.json` + `pii-ask.policy.json` | Input (contains an email) → Writer[`mock-json`] → Output, with an output `pii` check at `ask_user` | The node goes WAITING with an approval card; approve continues, reject is `GUARDRAIL_VIOLATION` (FR-GRD-013, TC-GRD-008/009) |
| `leak.json` | Input → Helper[`mock-leak`] → Output, default policy only | The default output `secret_leak block` catches a credential-shaped string (TC-GRD-010) |
| `budget-cap.json` + `budget-cap.project.json` | Input → Drafter[`mock-slow`, 2048 tokens] → Editor[`mock-slow`, 20000 tokens] → Output, cap $0.01 | The Drafter runs; the Editor's projected cost is over the cap, so the run halts `budget_exceeded` **mid-run** (§2.3, FR-GRD-008) |

## The placeholders a harness rewrites

A fixture cannot know an id the engine mints at runtime, so three ids are placeholders. Each is a
valid ULID and none is a real row. Rewrite them before importing:

| Placeholder | Is | Rewrite to |
|---|---|---|
| `01M3R3PV0000000000000000PV` | every agent's `config.providerId` | the mock provider the harness created |
| `01M3R3PJ0000000000000000PJ` | `pii-ask.policy.json`'s `projectId` | the project under test |
| `01M3R3PC0000000000000000PC` | the Writer's `config.guardrailPolicyId` in `pii-ask.json` | the id `POST /guardrail-policies` answered with |

Round 2's fixtures use `01M3R2PV…PV`; round 3's are `01M3R3…`, so a suite that loads both rewrites
two different strings.

## What `WorkflowExport` cannot carry

The export format holds a workflow and nothing else — no guardrail policy, no project budget. Two
fixtures therefore ship a **sidecar** the harness sends separately, rather than inventing a field:

- `pii-ask.policy.json` — a `CreateGuardrailPolicyRequest` for `POST /guardrail-policies`. POST it
  first, then rewrite `01M3R3PC0000000000000000PC` in `pii-ask.json` to the policy's real id. The
  policy holds one check (output `pii` at `ask_user`) and deliberately nothing else, so the fixture
  tests one action.
- `budget-cap.project.json` — an `UpdateProjectRequest` for `PATCH /projects/:id`, setting
  `maxCostPerRunUsd` to `0.01`.

## Why `pii-ask.json` uses `mock-json` and not `mock-text`

§4 item 8 asks for "a Writer instructed to include an email address". No deterministic mock reads
its instructions: `mock-text` answers from a seeded word list whatever it is told, so an **output**
pii check would never have anything to find. `mock-json` answers `{ echo: <input>, … }`, so putting
the address in the Input node is what actually gets it into the output, where the check runs. The
Writer's instructions still say to repeat the address, because that is the intent being modelled.

## Regenerating

```
node tests/acceptance/fixtures/round-3/generate.mjs
```

from the repo root. Every id is fixed, so the output is byte-stable and a regeneration shows up in
`git diff` only when the fixture genuinely changed.

`packages/providers/src/__tests__/fixtures-round-3.test.ts` parses every file here against the
contract's own schemas — `WorkflowExportSchema`, `CreateGuardrailPolicyRequestSchema`,
`UpdateProjectRequestSchema`, `validateLoopConfig` and `REVIEW_CONTRACT_SCHEMA` — and checks that
every model named is one the mock adapter really has. A malformed fixture fails in `pnpm test`, not
in the middle of an acceptance run.
