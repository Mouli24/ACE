# Round 2 fixtures

Workflow exports (`WorkflowExport`, round 1 §2.7) that the acceptance suites import and run
against the mock provider.

| File | Shape | What it is for |
|---|---|---|
| `linear-mock.json` | Input → Agent[`mock-text`] → Output | The §1 demo script's happy path (TC-EXE-001) |
| `fallback.json` | Agent primary `mock-503`, fallback `mock-text` | TC-RTR-002 / TC-RTR-004 |
| `contract-violation.json` | Agent `mock-bad-json` with a JSON output contract | TC-EXE-005 |
| `budget.json` | Input of ~50k tokens → Agent with a 4000-token budget | TC-EXE-006 |
| `slow.json` | Agent `mock-slow` | TC-EXE-007, TC-EXE-013, streaming and reconnect |

**The provider id is a placeholder.** Every agent node names
`01M3R2PV0000000000000000PV`, which is a valid ULID and no real provider. A harness creates the
mock provider, then rewrites that id to the real one before importing — a fixture cannot know an
id the engine will mint at runtime.

Regenerate with `node tests/acceptance/fixtures/round-2/generate.mjs` from the repo root. Every id
is fixed, so the output is byte-stable and a regeneration shows up in `git diff` only when the
fixture genuinely changed.
