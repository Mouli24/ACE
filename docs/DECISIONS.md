# ACE — Decision Log

Every decision that shaped the build, one row each. This file is Claude's memory between sessions
(CLAUDE.md §1) and the record of what was chosen instead of guessed.

**Rules (CLAUDE.md §3.3, §7)**

- **Append only.** Add one row at a time. Never edit or delete an existing row — if a decision is
  superseded, add a new row that says so and name the row it replaces.
- A `DECISION NEEDED` block raised in a session is answered and appended **in that same session**.
- Pull → append → push within a minute, so the two branches never collide on this file.
- Row format: `| D<n> | <title> | <decision> | <affects FR/§> | <date> | <who> |`

---

## Decisions

| ID | Title | Decision | Affects | Date | Who |
|---|---|---|---|---|---|
| D1 | Runtime and shell | TypeScript/Node engine with a Hono gateway and a React/Vite SPA; Electron desktop comes later and reuses the same engine through ports and adapters | Arch §35, ADR-003, ADR-004 | 2026-09-21 | Arhant |
| D2 | Canvas layout model | Free dragging, plus an auto-layout command — not a locked grid | FR-CAN-002, FR-CAN-008 | 2026-09-21 | Arhant |
| D3 | Loops | Loops exist only as explicit loop edges, never as implicit re-entry | FR-CON-006, FR-CON-007, Arch §19.1 | 2026-09-21 | Arhant |
| D4 | What Pause means | Pause stops new dispatch; nodes already running finish | FR-EXE-009, Arch §19.2 | 2026-09-21 | Arhant |
| D5 | Mid-run edits | Edits during a run apply to the next run, never to the one in flight | FR-NODE-009, BR-04 | 2026-09-21 | Arhant |
| D6 | Files in envelopes | Files travel as artifact references, never inlined into the prompt | BR-02, ADR-008, Arch §12.4 | 2026-09-21 | Arhant |
| D7 | Custom nodes | Both an HTTP node and a sandboxed script node | FRS OI-03, Arch §16 | 2026-09-21 | Arhant |
| D8 | Self-improvement | Out of scope for v1 | PRD scope | 2026-09-21 | Arhant |
| D9 | `GUARDRAIL_VIOLATION` failure reason | Add it, kept distinct from `RUN_FAILED` and `CONTRACT_VIOLATION` | Arch §39 D9, FRS OI-07, BR-03, BR-12 | 2026-09-21 | Arhant |
| D10 | Default guardrail strictness | Warn on content issues; block secret leaks and tool abuse | Arch §39 D10, FRS OI-08, BR-15, Arch §13.1 | 2026-09-21 | Arhant |
| D11 | Hosted authentication | A self-hosted library, not a third-party identity service | Arch §39 D11, FRS OI-09 | 2026-09-21 | Arhant |
| D12 | Router policies in v1 | Fixed and Fallback only; capability, cost and latency routing come later | Arch §39 D12, FRS OI-10, FR-RTR-003..005 | 2026-09-21 | Arhant |
| D13 | Local code sandbox | Child process, using Docker when it is available | Arch §39 D13, FRS OI-11, Arch §16 | 2026-09-21 | Arhant |
| D14 | Default web search | SearXNG | Arch §39 D14, FRS OI-12 | 2026-09-21 | Arhant |
| D15 | When hosted mode starts | After v1 launch feedback | Arch §39 D15, FRS OI-13 | 2026-09-21 | Arhant |
| D16 | MCP tools in v1 | Yes, at Should priority | Arch §39 D16, FRS OI-14 | 2026-09-21 | Arhant |
| D17 | Hosted retention by plan | 30 / 90 / 365 days | Arch §39 D17, FRS OI-15 | 2026-09-21 | Arhant |
| D18 | Port `name` for type-derived ports | `name` is the DataType literal, so the port id is `<nodeId>:out:text`. §2.4 fixes the id format and names merge/transform ports but never names the type-derived ones. Chosen because the data type is the only name that stays stable when `outputTypes` is reordered or an earlier entry removed — a positional name would renumber later ports and silently repoint saved edges | R1 §2.4, FR-NODE-006, TC-NODE-005 | 2026-09-21 | Arhant |
| D19 | `derivePorts` for `retrieval` / `guardrail` / `custom` | Return `{ inputs: [], outputs: [] }` until the round that defines them. §2.4 derives ports for six of the nine NodeKinds. Throwing would make a pure contract function fail for a kind the enum declares; defining them now would build round 5 in round 1 | R1 §2.2, §2.4, FR-NODE-006 | 2026-09-21 | Arhant |
| D20 | Module for the §2.8 REST shapes and cursor pagination | A new `packages/contracts/src/api.ts` holding the endpoint bodies, the health body and the `{ items, nextCursor? }` envelope. §2.8 names neither the schemas nor a file, and these symbols are imported by Mouli's SDK and MSW handlers, so they are seam. One module keeps §2.8 reviewable against one file; typing them in `@ace/sdk` instead would put contract outside `packages/contracts` | R1 §2.8, CLAUDE.md §3.4 rule 2 | 2026-09-21 | Arhant |
| D21 | Is `Id` format-validated | Yes — `IdSchema` enforces a strict Crockford ULID, `/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/`. §2.4 says ULID but not whether the schema checks it. Enforcing catches id drift at the seam instead of during a later debugging session; the cost is that fixtures and MSW mocks must produce real ULIDs | R1 §2.4 | 2026-09-21 | Arhant |
| D22 | `multi` on derived output ports | Output ports are `multi: true`. §2.4 states `multi` for every input port it derives but never for an output port, and `Port.multi` is required. The value is inert server-side (`isConnectionAllowed` only reads `target.multi`), but a Canvas that wires React Flow handle limits from this field would refuse the fan-out FR-CON-005 requires if it were `false` | R1 §2.4, FR-CON-005, TC-CON-005 | 2026-09-21 | Arhant |

---

## Still open

Issues the specs raise and deliberately leave undecided. Each becomes a `D<n>` row above when it is
answered — do not treat a row here as a decision.

| ID | Issue | Recommended | Needed by |
|---|---|---|---|
| OI-01 | CLI provider quotas, and whether CLI routes are in v1 | Optional in v1 | Phase 4 |
| OI-02 | Exact retrieval quality target (hit rate@k) | Set after pilot | Phase 10 |
| OI-03 | Script custom nodes in v1, or HTTP-only | Both, scripts sandboxed (see D7) | Phase 11 |
| OI-04 | Third benchmark arm, and the win/partial/loss rules | Write before freezing tasks | Phase 13 |
| OI-05 | Code signing certificates for Windows and macOS | Buy before packaging | Phase 16 |
| OI-06 | Transform node operation list | Template, JSON extract, join | Phase 3 |
| OI-16 | Guardrail accuracy targets (NFR-SAFE-02) confirmed on real corpora | Validate in Phase 14 | Phase 14 |
