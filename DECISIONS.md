# ACE — Decisions Log

**This is the amendment log to `ACE-PRD.md`, `ACE-FRS.md` and `ARCHITECTURE.md`.** Where a row here and a spec disagree, the row here wins — that is its entire purpose. It is the only project memory that survives `/clear`; Claude reads it at the start of every session.

## Rules

1. **Append-only.** Never edit or delete a row. To change a decision, add a new row that says `Supersedes Dnn` and set the old row's status to `Superseded by Dnn` — that one-word status change is the only permitted edit to an existing row.
2. **Same session.** Every answered `DECISION NEEDED` is appended in the session where it was answered, even when the answer is "take the recommended option".
3. **Name the FR.** A decision that narrows, widens or changes a requirement names the FR ID(s) it affects.
4. **Pull → append one row → commit → push, inside one minute.** On a conflict, keep both rows and renumber the later one.
5. **Commit message:** `docs(decisions): D18 transform node operations`.

## Status values

| Status | Meaning |
|---|---|
| `Accepted` | Locked by an accepted ADR or explicit spec text. Build to it. |
| `Confirmed` | Was `Recommended`; both developers signed off below. Build to it. |
| `Recommended` | The spec's recommendation. **Must be confirmed before the phase that needs it starts.** |
| `Open` | No answer yet. Claude must post `DECISION NEEDED` on reaching it — never guess. |
| `Superseded by Dnn` | No longer in force. Read the newer row. |

---

## 1. Foundational decisions — D1–D8

> **Provenance note.** Arch §39 lists D1–D8 by topic only and defers their answers to *Build Blueprint §1.1*, which was not available when this file was drafted. The answers below are **derived** from the ADRs, FRS requirements and business rules cited in each row. They are consistent with the specs as written, but they are drafts: confirm each one against the Blueprint if you have it, and sign off in §6 before F00 runs. If the Blueprint disagrees with a row, the Blueprint's answer goes in as a new row superseding this one.

| ID | Topic | Decision | Source | Affects | Needed by | Status |
|---|---|---|---|---|---|---|
| D1 | Runtime | Browser SPA + local Node.js engine in v1; the same SPA later runs inside an Electron shell whose main process starts the engine. Engine binds `127.0.0.1` only, token + origin checks. | ADR-001, ADR-003, Arch §7, FR-SYS-001..003 | SYS, DSK | Phase 0 | Accepted |
| D2 | Node dragging | Free dragging; positions persist. A separate "Auto-arrange" button applies a pure left-to-right `LayoutFn`. Layout is never forced. | ADR-010, FR-CAN-004, FR-CAN-008 | CAN | Phase 3 | Recommended |
| D3 | Loops | Cycles exist **only** as loop edges. Each loop edge has a max iteration count (1–50) and an exit condition on a field of structured output. On reaching max: continue with last output **or** fail, as configured. Plain edges closing a cycle are refused. | ADR-011, BR-05, FR-CON-003, FR-CON-007, FR-PAR-003..006 | CON, PAR | Phase 3 (validation), Phase 7 (execution) | Recommended |
| D4 | Pause semantics | Pause stops new dispatch; nodes already running are allowed to finish; run state `PAUSED`. Resume continues from where it stopped. A node in `WAITING` for approval holds no provider concurrency slot. | FR-CTL-001, FR-CTL-002, Arch §19.2 | CTL | Phase 6 | Recommended |
| D5 | Mid-run edits | Every run executes against an immutable snapshot frozen at dispatch. Edits made during a run are saved but apply only to later runs; the UI says so. | ADR-009, BR-04, BR-10, FR-EXE-002, FR-NODE-009 | EXE, NODE | Phase 5 | Accepted |
| D6 | Multimodal references | Files are stored once, content-addressed by hash, and passed between nodes as artifact references inside the envelope — never as bytes in a message. Default upload limit 100 MB, configurable. | FR-MM-001, FR-MM-002, FR-MM-004, Arch §15.1 | MM | Phase 8 | Recommended |
| D7 | Custom nodes | Both HTTP (envelope in, result out) and script (JSON over stdin/stdout) custom nodes ship in v1. Scripts run only in the sandbox with time, memory and folder limits, and only after the user approves their declared permissions. Closes OI-03. | FR-CUS-001..006, BR-11, FRS §11 OI-03 | CUS | Phase 11 | Recommended |
| D8 | Self-improvement | ACE self-improvement (spec §40) is out of scope for v1 (`Won't`). No code path, flag or stub for it. | Arch §2.2, FRS §1.2, PRD priorities | — | Phase 0 | Accepted |

---

## 2. Decisions carried from Arch §39 / FRS §11 — D9–D17

| ID | Topic | Decision | Source | Affects | Needed by | Status |
|---|---|---|---|---|---|---|
| D9 | Guardrail failure reason | Add `GUARDRAIL_VIOLATION` as a distinct failure reason, never merged with `CONTRACT_VIOLATION`, `RUN_FAILED` or `BLOCKED`. | ADR-012, OI-07, BR-12, FR-GRD-012 | GRD, contracts | Phase 1 | Recommended |
| D10 | Default guardrail strictness | New projects: **warn** on content issues; **block** secret leaks and tool abuse. | OI-08, FR-GRD-018 | GRD | Phase 6 | Recommended |
| D11 | Hosted auth | Self-hosted library (Better Auth / Auth.js), not a paid identity provider. | OI-09, Arch §11 | HOST | Phase 18 (post-v1) | Recommended |
| D12 | Router policies in v1 | Fixed + Fallback only. Capability, cost-aware and latency-aware policies stay behind a flag until v1.x. | ADR-014, OI-10, FR-RTR-001..005 | RTR | Phase 4 | Recommended |
| D13 | Local code sandbox | Child process with time, memory and folder limits; Docker used automatically when available. Every test must pass without Docker. | OI-11, FR-TOOL-004 | TOOL | Phase 11 | Recommended |
| D14 | Web search default | Self-hosted SearXNG (free, keyless). A user-keyed search API is an optional alternative. | OI-12, FR-TOOL-005 | TOOL | Phase 11 | Recommended |
| D15 | Start of hosted mode | Only after v1 launch feedback. No Phase 18+ work in any v1 session. | OI-13, Arch §2.2 | HOST, HMOD, TRN | Phase 17 | Recommended |
| D16 | MCP tools in v1 | Yes, at Should priority. | OI-14, FR-TOOL-007 | TOOL | Phase 11 | Recommended |
| D17 | Hosted retention by plan | 30 / 90 / 365 days. | OI-15, FR-HOST-013 | HOST | Phase 18 (post-v1) | Recommended |

---

## 3. Open issues — no answer yet

When Claude reaches one of these it must stop and post a `DECISION NEEDED` block. The answer becomes a new row in §4 and the issue's status here changes to `Resolved by Dnn`.

| ID | Issue | Spec's suggestion | Blocks | Needed by | Status |
|---|---|---|---|---|---|
| OI-01 | CLI provider quotas/terms, and whether CLI routes are in v1 | Optional in v1; API routes primary | FR-PRV-008 | Phase 4 | Open |
| OI-02 | Retrieval quality target (hit-rate@k) | Set after a pilot on a labelled set | FR-RAG-004, TC-RAG-010 | Phase 10 | Open |
| OI-03 | Script custom nodes in v1, or HTTP-only | Both, scripts sandboxed | FR-CUS-002, FR-CUS-005 | Phase 11 | Covered by D7 once confirmed |
| OI-04 | Third benchmark arm and win/partial/loss rule wording | Write before freezing any task | FR-BEN-007 | Phase 13 | Open |
| OI-05 | Code-signing certificates (Windows Authenticode, Apple Developer ID) | Buy before packaging — **paid; see note** | FR-DSK-001 | Phase 16 | Open |
| OI-06 | Transform node operation list | Template, JSON-field extract, join | FR-NODE-013 | Phase 3 | Open |
| OI-16 | Guardrail accuracy targets (≥95% caught, ≤5% false positives) validated on real corpora | Validate in Phase 14 | NFR-SAFE-02, TC-NFR-014 | Phase 14 | Open |

> **OI-05 note.** Both certificates cost money. A zero-cost alternative for v1 is to ship unsigned builds from GitHub Releases with install instructions that walk users past SmartScreen and Gatekeeper, and to buy certificates only if ACE gets real external users. That trade-off is a decision to make in Phase 16, not now.

---

## 4. Build decisions — D18 onwards

Appended during the build, one row per answered `DECISION NEEDED`. Newest at the bottom.

| ID | Topic | Decision | Source | Affects (FR IDs) | Phase | Date | Decided by |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

**Example of a well-formed row** (delete when the first real one is added):

```
| D18 | Transform node operations | Template + JSON-field extract + join only in v1; resolves OI-06 | OI-06, F08 plan | FR-NODE-013 | 3 | 2026-09-24 | Mouli + Arhant |
```

---

## 5. Superseded context — do not build to these

Decisions from the **earlier POC spec** that ACE spec v2 reverses. Listed so nobody — human or Claude — rebuilds them from old notes or older chats.

| Earlier POC decision | Replaced by | Why it matters |
|---|---|---|
| Computed-only canvas layout (`nodesDraggable={false}`) | D2 — free dragging + auto-arrange button (ADR-010) | FR-CAN-004 requires moving nodes by hand |
| Review→Fix modelled as a three-node DAG, no loops | D3 — loop edges with max iterations (ADR-011) | FR-PAR-003..007 and UC-06 need real iteration |
| Electron-first, two-process app from day one | D1 — web SPA + local engine first, Electron in Phase 16 (ADR-001) | Phases 1–15 run in the browser |

Everything else from the earlier POC that v2 keeps — engine owns truth, Zod envelopes, immutable run records, distinct failure states, git-backed replay, mock adapter, Monaco read-only during runs — is already covered by D5, D9, ADR-008/009 and the FRS.

---

## 6. Sign-off

Before **F00** runs, both developers read §1 and §2. Every `Recommended` row either gets confirmed here, or gets a replacement row in §4 with the different answer.

When a row is confirmed, change its status from `Recommended` to `Confirmed` — this is the one bulk status edit the rules allow, and it happens once.

| Rows | Confirmed by Mouli | Confirmed by Arhant | Date | Notes |
|---|---|---|---|---|
| D1–D8 | | | | Check against Build Blueprint §1.1 if available |
| D9–D17 | | | | |

---

## 7. ADR index

Full text in `docs/adr/ADR-0nn.md` (created by F00).

| ADR | Decision | Status |
|---|---|---|
| ADR-001 | Web UI + local engine first; Electron later | Accepted |
| ADR-002 | Custom orchestration engine, not LangGraph/LlamaIndex | Accepted |
| ADR-003 | Vite SPA for the app; Next.js only for the public site | Accepted |
| ADR-004 | TypeScript gateway (Hono), not FastAPI | Accepted |
| ADR-005 | SQLite locally, Postgres hosted, via Drizzle | Accepted |
| ADR-006 | In-process queue locally, BullMQ hosted; Kafka deferred | Accepted |
| ADR-007 | sqlite-vec / pgvector before Qdrant | Accepted |
| ADR-008 | Envelopes with bounded context | Locked |
| ADR-009 | Immutable run snapshots + append-only events | Locked |
| ADR-010 | Free node dragging + auto-layout button | Proposed → D2 |
| ADR-011 | Loops only via loop edges with max iterations | Proposed → D3 |
| ADR-012 | `GUARDRAIL_VIOLATION` as distinct failure reason | Proposed → D9 |
| ADR-013 | Guardrails as policies + optional Canvas node | Proposed |
| ADR-014 | Router v1 = Fixed + Fallback | Proposed → D12 |
| ADR-015 | Training optional, post-v1, Python service | Proposed |
| ADR-016 | Ports-and-adapters engine | Accepted |
