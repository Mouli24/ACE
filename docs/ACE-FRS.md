# ACE — Functional Requirements Specification (FRS)

**Product:** ACE — Multimodal AI Agent Orchestration Platform
**Version:** 1.1 (aligned with ARCHITECTURE.md v2)
**Owner:** Mouli Lohani
**Delivery model:** Web app (browser UI + local engine) first, desktop (Electron) later
**Status:** For review
**Companion docs:** ARCHITECTURE.md v2 · ACE Build Blueprint · DECISIONS.md

### Change log

| Version | Changes |
|---|---|
| 1.0 | Initial FRS: 22 modules, NFRs, business rules, use cases, test cases, traceability |
| 1.1 | Aligned with Architecture v2: added Prompt Management, Guardrails, Model Router, Tools (sandbox, web search, HTTP, MCP), Observability & Usage, Configuration & Data, CLI & SDK, Mobile, and post-v1 Hosted Platform, Hosted Models and Fine-Tuning modules; Guardrail node, WAITING/BLOCKED states, `GUARDRAIL_VIOLATION`, approvals; new NFRs, business rules, use cases, test cases; traceability now maps to architecture sections; phases 0–21 |

---

## 1. Introduction

### 1.1 Purpose
This document defines **what ACE must do**: every functional requirement, the quality requirements it must meet, the rules it must never break, and the test cases that prove each requirement works. It is the reference for design, development, testing and acceptance.

### 1.2 Scope
**In scope for v1 (Local mode):** visual Canvas, agent and model nodes, connections with automatic handoff, multi-provider and local model support, model routing, prompt management, workflow execution (sequential, parallel, loops), execution control, error handling and recovery, guardrails and approvals, multimodal data, tools (code sandbox, web search, HTTP, MCP), chat, context and RAG, agent memory, skills, custom nodes, git-backed workspace, observability and usage tracking, ACE Bench, CLI and SDK, responsive monitoring views, desktop packaging, onboarding.

**Specified here but delivered after v1 (priority L):** Hosted Platform (accounts, teams, rate limiting, metering, billing, multi-tenancy), Hosted Models (vLLM/TGI), Fine-Tuning, native mobile app.

**Out of scope:** ACE self-improvement (spec §40), real-time co-editing, node/skill marketplace, auto-generated agent teams, training foundation models.

### 1.3 Definitions

| Term | Meaning |
|---|---|
| Canvas | The visual workspace where workflows are built and run |
| Node | A unit on the Canvas (agent, model, input, output, merge, transform, retrieval, guardrail, custom) |
| Port | A typed input or output handle on a node |
| Edge / Connection | An arrow from an output port to an input port; defines data flow |
| Loop edge | A special edge that sends output back to an earlier node, with a maximum iteration count |
| Envelope | The validated package passed along an edge: reads + bounded context + output contract |
| Artifact | A stored file or media item, referenced by content hash |
| Provider | A source of models (cloud API, local server, CLI, custom endpoint) |
| Run | One execution of a workflow, based on an immutable snapshot |
| Node run | One execution of one node inside a run (per iteration and attempt) |
| Engine | The local Node.js backend that owns all state and executes workflows |
| Knowledge base (KB) | A set of documents indexed for retrieval |
| Skill | Reusable instructions and tools attachable to agents |
| Arm | One configuration being compared in ACE Bench |
| Guardrail | A policy check on data entering or leaving a model or tool |
| Guardrail policy | A versioned set of guardrail checks and actions (project default, agent override) |
| Approval | A user decision (approve/reject) requested by a guardrail; the node waits meanwhile |
| Routing policy | Rule for choosing which model an agent uses (fixed, fallback, capability, cost, latency) |
| Tool | A capability an agent can call (sandbox, search, HTTP, file, git, MCP) with declared permissions |
| MCP | Model Context Protocol; a standard way to connect external tool servers |
| Local mode / Hosted mode | ACE running on the user's machine / on ACE's cloud servers |
| Workspace (hosted) | A tenant: a user or team that owns projects, members, usage and billing |

### 1.4 Priority scale (MoSCoW)
**M** = Must (v1 blocked without it) · **S** = Should (v1 target) · **C** = Could (if time allows) · **L** = Later (specified now, delivered after v1 in the stated phase) · **W** = Won't (this version)

### 1.5 References
ACE product spec (47 sections) · **ARCHITECTURE.md v2** (referenced as "Arch §") · ACE build blueprint (API and data model) · ACE architecture prompt · DECISIONS.md

---

## 2. Overall Description

### 2.1 User types

| User | Description | Main goals |
|---|---|---|
| Builder | Developer or power user designing workflows | Build, connect, configure, run, debug |
| Operator | Runs existing workflows and reviews outputs | Run, inspect, retry, chat |
| Extender | Adds custom nodes, providers, skills | Integrate own agents and models |
| Evaluator | Runs ACE Bench experiments | Compare configurations fairly |
| Automator | Uses the CLI or SDK from scripts and CI | Run workflows without the UI |
| Workspace admin (hosted) | Manages members, keys, budgets and billing | Control access and spend |

v1 is single-user, local. All user types are the same person with different tasks. Workspace admin applies from Phase 18.

### 2.2 Operating environment
- Browser: latest two versions of Chrome, Edge, Firefox
- Engine: Node.js LTS on Windows 10+, macOS 13+, Ubuntu 22.04+
- Storage: local SQLite database and local file system
- Optional: Ollama / LM Studio for local models; Claude, Codex, Gemini CLIs
- Desktop (Phase 16): Electron on the same operating systems
- Optional local services: SearXNG (web search), Docker (code sandbox), Llama Guard via Ollama (moderation), local Langfuse (traces)
- Hosted (Phase 18+): Postgres + pgvector, Redis, S3-compatible storage, container platform/Kubernetes, optional GPU pool

### 2.3 Assumptions
- The user supplies their own provider credentials or local models.
- The machine has network access for cloud providers.
- Git is installed for workspace features.

### 2.4 Constraints
- The UI holds no source of truth; the engine does.
- Engine accepts connections only from the local machine.
- Handoffs use envelopes, never raw chat history.
- Provider quotas and rate limits are outside ACE's control.
- All product code is TypeScript; Python only for the optional fine-tuning service.
- Storage, queue, secrets, sandbox and auth sit behind interfaces so local and hosted modes share the same engine (Arch §7).

---

## 3. Functional Requirements

Each requirement has an ID, priority, delivery phase and acceptance criteria (AC).

### 3.1 System and Engine (SYS) — Phase 2

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-SYS-001 | Engine shall run locally and listen only on 127.0.0.1 | M | Connection attempts from another machine fail |
| FR-SYS-002 | Every REST request and WebSocket connection shall require a session token | M | Missing/wrong token → 401; WS closed |
| FR-SYS-003 | Engine shall reject requests from origins not on the allow-list | M | Request with foreign `Origin` → 403 |
| FR-SYS-004 | Engine shall expose a health check with version and database status | M | `GET /health` returns 200 with `version`, `db: ok` |
| FR-SYS-005 | User shall view and update settings (data folder, default provider, concurrency, theme) | S | Changes persist after engine restart |
| FR-SYS-006 | All errors shall use one format: kind, code, message, details, retryable | M | Every non-2xx response matches the error schema |
| FR-SYS-007 | Logs shall never contain API keys or tokens | M | Log scan after a full run finds no secrets |
| FR-SYS-008 | On shutdown the engine shall stop dispatching, cancel calls and save events | M | Active run is marked HALTED with reason `shutdown` |
| FR-SYS-009 | On restart after a crash, runs left in progress shall be marked HALTED | M | No run remains "running" after restart |
| FR-SYS-010 | Configuration is resolved in the order node → project → user → engine → defaults and validated at startup | M | Invalid config file → engine refuses to start with a clear message |
| FR-SYS-011 | Local logs rotate and are kept for 14 days by default | S | Older log files removed automatically |
| FR-SYS-012 | User can export a full backup of the data folder and restore it | S | Restored install shows the same projects, runs and settings |

### 3.2 Projects (PRJ) — Phase 2

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-PRJ-001 | User shall create a project with a name and optional folder path | M | Project appears in list; folder created if missing |
| FR-PRJ-002 | User shall list, open, rename and delete projects | M | Deleted project disappears from list; confirmation required |
| FR-PRJ-003 | Project folder must exist and be writable | M | Invalid path → validation error naming the path |
| FR-PRJ-004 | App shall reopen the last used project on launch | S | Relaunch opens the previous project |

### 3.3 Workflows (WF) — Phases 2–3

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-WF-001 | User shall create workflows inside a project | M | New workflow opens as a tab with an empty Canvas |
| FR-WF-002 | Multiple workflows shall be open as tabs | M | Switching tabs shows the correct graph |
| FR-WF-003 | User shall rename, duplicate and delete workflows | M | Duplicate has identical graph with new IDs |
| FR-WF-004 | All edits shall save automatically | M | Reload shows the latest state; no Save button needed |
| FR-WF-005 | Conflicting edits (stale version) shall be detected | M | Stale write → 409; UI refetches and reapplies |
| FR-WF-006 | User shall validate a workflow and see a list of issues | M | Each issue has severity, message and node/edge reference |
| FR-WF-007 | User shall export a workflow to JSON without secrets | S | Export file contains no credentials |
| FR-WF-008 | User shall import a workflow JSON with version checking | S | Unsupported version → clear error; valid file creates workflow |

### 3.4 Canvas (CAN) — Phase 3

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-CAN-001 | Canvas shall show a dark dotted-grid workspace | M | Visual check matches design system |
| FR-CAN-002 | User shall add nodes from the palette by click or drag | M | Node appears at the drop point and is saved |
| FR-CAN-003 | User shall select one node, several (Shift/Ctrl) or a box area | M | Selected nodes are highlighted |
| FR-CAN-004 | User shall move nodes by dragging; positions persist | M | Positions identical after reload |
| FR-CAN-005 | User shall delete selected nodes; their edges are removed | M | No dangling edges remain |
| FR-CAN-006 | User shall duplicate nodes with config copied and new IDs | M | Copy appears offset; editing it doesn't change the original |
| FR-CAN-007 | User shall pan, zoom (mouse and trackpad), fit to view and use a minimap | M | All four work on mouse and trackpad |
| FR-CAN-008 | User shall auto-arrange the graph | S | Nodes laid out left-to-right without overlap |
| FR-CAN-009 | User shall undo/redo graph edits (at least 50 steps) | S | Undo reverses add/move/delete/connect in order |
| FR-CAN-010 | Canvas shall show a loading state until the graph is fully loaded | M | No half-drawn nodes or edges during load |
| FR-CAN-011 | Right-click menus shall exist for nodes, edges and empty Canvas | S | Menu shows the relevant actions |
| FR-CAN-012 | Keyboard shortcuts: Delete, Ctrl+D, Ctrl+A, Ctrl+Z/Y, F (fit) | S | Each shortcut performs its action |
| FR-CAN-013 | User shall copy/paste nodes between workflows | C | Pasted nodes keep config, get new IDs |

### 3.5 Nodes and Configuration (NODE) — Phase 3

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-NODE-001 | Node kinds: Agent, Model, Input, Output, Merge, Transform (M); Retrieval, Guardrail, Custom (S) | M | Each kind appears in the palette in its phase |
| FR-NODE-002 | Selecting a node opens its configuration panel | M | Panel shows that node's settings |
| FR-NODE-003 | Agent config: name, provider, model, routing policy, system instructions, input types, output types, tools, skills, context policy, memory, guardrail policy, execution settings | M | All fields editable and saved |
| FR-NODE-004 | Model picker shows only available models that support the node's data types | M | Unavailable or incompatible models are hidden or disabled with a reason |
| FR-NODE-005 | Node shows its model name and provider color on the Canvas | M | Changing model updates the chip immediately |
| FR-NODE-006 | Input/output data types create matching typed ports | M | Adding "image" output adds an image port |
| FR-NODE-007 | Execution settings: temperature, max tokens, timeout, retries | M | Values validated against allowed ranges |
| FR-NODE-008 | Invalid config is shown inline and blocks running | M | Run start fails pre-flight with the node named |
| FR-NODE-009 | Config edits during a run apply to the next run; UI says so | M | Active run uses its snapshot; notice displayed |
| FR-NODE-010 | Status is shown separately from provider color | M | Provider color unchanged across states |
| FR-NODE-011 | Input node collects text and/or files when a run starts | M | Run prompt appears if the input is empty |
| FR-NODE-012 | Output node marks a workflow end and shows the final result | M | Final output visible on the node and in the inspector |
| FR-NODE-013 | Transform node applies simple operations (template, extract JSON field, join text) | S | Output matches the configured operation |

### 3.6 Connections (CON) — Phases 3, 7

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-CON-001 | User connects nodes by dragging from an output port to an input port | M | Arrow appears and is saved |
| FR-CON-002 | Incompatible data types are rejected with a message | M | Text→image-only port refused with reason |
| FR-CON-003 | Cycles are rejected unless created as a loop edge | M | Plain edge that closes a cycle is refused |
| FR-CON-004 | User can disconnect an edge by delete key or menu | M | Edge removed and saved |
| FR-CON-005 | One output can feed many inputs; input ports accept one or many edges as configured | M | Fan-out works; single-input port refuses a second edge |
| FR-CON-006 | Edge shows its data type; hover shows the last transferred data summary | S | Tooltip shows type and short preview |
| FR-CON-007 | User can make a loop edge with max iterations (1–50) and an exit condition | S | Loop edge drawn differently; settings saved |

### 3.7 Providers (PRV) — Phase 4

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-PRV-001 | User can add providers: Anthropic, Google, OpenAI, OpenAI-compatible, Ollama, mock | M | Each type can be added and tested |
| FR-PRV-002 | API keys are stored in the OS keychain and never returned by the API | M | Provider responses show only "key set: yes/no" |
| FR-PRV-003 | User can test a provider; result is connected, auth failed, unreachable or rate limited | M | Wrong key → auth failed; engine offline endpoint → unreachable |
| FR-PRV-004 | Provider status is shown in the top bar and settings, refreshed regularly | M | Status updates without page reload |
| FR-PRV-005 | User can edit, rotate key and remove providers; removal of an in-use provider needs confirmation and marks nodes invalid | M | Affected nodes show "provider missing" |
| FR-PRV-006 | OpenAI-compatible provider takes base URL, optional key and model list | M | A local server's models become selectable |
| FR-PRV-007 | Ollama on the default local address is detected automatically | S | "Ollama detected" offered on first run |
| FR-PRV-008 | CLI providers (Claude Code, Codex, Gemini CLI) are detected with login status | C | Installed CLI listed; missing CLI shows install hint |
| FR-PRV-009 | Concurrency limit is configurable per provider | S | Never more simultaneous calls than the limit |
| FR-PRV-010 | Mock provider is available for development and tests | M | Returns deterministic outputs and simulated errors |

### 3.8 Model Catalog (MOD) — Phase 4

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-MOD-001 | Models are discovered automatically where the provider allows | M | Listing matches the provider's available models |
| FR-MOD-002 | A maintained model list is used where discovery isn't possible | M | Manifest models appear with source "manifest" |
| FR-MOD-003 | Each model records provider, name, availability, input/output types, context size, options | M | Detail view shows all fields |
| FR-MOD-004 | Catalog can be filtered by provider, data type and availability | M | Filters narrow results correctly |
| FR-MOD-005 | Nodes using unavailable models are flagged before running | M | Validation lists the node and the model |
| FR-MOD-006 | Catalog refreshes on demand and daily | S | Refresh button updates list; timestamp shown |

### 3.9 Execution (EXE) — Phase 5

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-EXE-001 | User can start a run of the whole workflow | M | Run ID created; nodes begin updating |
| FR-EXE-002 | Each run uses an unchangeable snapshot of the workflow | M | Editing during a run doesn't change that run |
| FR-EXE-003 | Pre-flight checks run before starting; failures stop the run as BLOCKED with a list | M | No provider call happens on a failed pre-flight |
| FR-EXE-004 | A node runs only when all its required inputs are available | M | Order follows the connections |
| FR-EXE-005 | Outputs pass to connected nodes automatically as envelopes | M | Downstream node receives upstream output without user action |
| FR-EXE-006 | Outputs are checked against the output contract; failures become CONTRACT_VIOLATION | M | Wrong JSON shape → CONTRACT_VIOLATION |
| FR-EXE-007 | Envelope context stays within the node's token budget | M | Envelope token count ≤ configured budget |
| FR-EXE-008 | Model output streams to the UI as it's generated | M | Text appears progressively |
| FR-EXE-009 | Node states shown: Idle, Ready, Running, Waiting, Completed, Failed, Stopped, Paused, Blocked | M | Each state has a distinct visual |
| FR-EXE-010 | Each node run records inputs, outputs, model, tokens, cost estimate, time, error, attempt | M | Inspector shows all fields |
| FR-EXE-011 | Run ends COMPLETE if all output nodes finished; otherwise HALTED | M | Terminal state is correct in both cases |
| FR-EXE-012 | Run history per workflow shows status, duration, tokens and cost | M | List ordered newest first |
| FR-EXE-013 | User can start a run from a chosen node, reusing earlier upstream outputs | S | Upstream nodes aren't re-called |
| FR-EXE-014 | Event log is ordered; a reconnecting UI receives missed events | M | Disconnect mid-run → no missing states after reconnect |
| FR-EXE-015 | Arrow animates when data moves across it | S | Animation plays on transfer |

### 3.10 Execution Control (CTL) — Phase 6

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-CTL-001 | Pause: no new nodes start; running nodes finish; run shows Paused | M | No new dispatch while paused |
| FR-CTL-002 | Resume continues from where the run paused | M | Remaining nodes execute |
| FR-CTL-003 | Stop cancels running calls; nodes become Stopped; run becomes HALTED | M | Provider streams closed within 2 s |
| FR-CTL-004 | Restart creates a new run with the same snapshot and inputs | M | New run ID; same inputs recorded |
| FR-CTL-005 | User can re-run a single node with the latest upstream outputs | M | Only that node executes |
| FR-CTL-006 | Control buttons enable/disable based on run state | M | E.g. Resume disabled unless paused |

### 3.11 Errors and Recovery (ERR) — Phase 6

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-ERR-001 | Errors are classified: user cancelled, agent, provider, auth, network, invalid config, workflow, guardrail | M | Each simulated error gets the right kind |
| FR-ERR-002 | Error view shows failed node, kind, message, provider, state and Retry | M | All items visible |
| FR-ERR-003 | User can retry a failed node with the same inputs; attempt number increases | M | New node run with attempt + 1 |
| FR-ERR-004 | User can retry a node and everything after it | S | Downstream nodes re-execute |
| FR-ERR-005 | Automatic retries follow a policy: network and rate-limit errors retry with backoff; auth and config errors don't | M | Retry counts match policy |
| FR-ERR-006 | Nodes that can't run because an upstream node failed become BLOCKED | M | BLOCKED shown, not Failed |
| FR-ERR-007 | User cancellation is shown differently from failures | M | Stopped nodes aren't counted as failures |
| FR-ERR-008 | User can fix a failed node's config and re-run without rebuilding the workflow | M | Re-run succeeds after fix |

### 3.12 Parallel Execution and Loops (PAR) — Phase 7

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-PAR-001 | Independent branches run at the same time | M | Two branches overlap in time |
| FR-PAR-002 | Merge node waits for all inputs or the first one, as configured; output ordered by input port | M | Both modes behave correctly |
| FR-PAR-003 | Loop edge repeats until the exit condition is met or the maximum is reached | S | Iteration count never exceeds the maximum |
| FR-PAR-004 | Exit condition can check a field in the reviewer's structured output | S | `verdict == "approved"` ends the loop |
| FR-PAR-005 | Each iteration is recorded; UI shows the count and each iteration's output | S | Iterations selectable in inspector |
| FR-PAR-006 | On reaching the maximum, the loop either continues with the last output or fails, as configured | S | Both options behave correctly |
| FR-PAR-007 | Review nodes can use a standard review contract: score, verdict, issues | S | Contract validated like other outputs |

### 3.13 Multimodal (MM) — Phase 8

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-MM-001 | User can upload files up to a configurable size (default 100 MB) | M | Larger file refused with a message |
| FR-MM-002 | Identical files are stored once | M | Second upload returns the same artifact |
| FR-MM-003 | Supported data: text, images, audio, video, code, structured data, files | M | Each type can be uploaded and passed |
| FR-MM-004 | Files move between nodes as references, not copies inside messages | M | Envelope contains references only |
| FR-MM-005 | If a model can't accept a data type, it's flagged before running | M | Image to text-only model → pre-flight issue |
| FR-MM-006 | Outputs display by type: formatted text, code, JSON tree, image, audio, video, download | M | Each renders correctly |
| FR-MM-007 | User can drop files onto an Input node | S | File attached to that node |
| FR-MM-008 | Audio can be converted to text for models that don't accept audio | C | Transcription step produces text |
| FR-MM-009 | Any artifact can be downloaded | M | Downloaded file matches the original hash |

### 3.14 Chat and Communication (CHAT) — Phase 9

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-CHAT-001 | Timeline shows user messages, agent messages, outputs, workflow events, errors and system events with distinct styles | M | Each type visually distinct |
| FR-CHAT-002 | Timeline can be filtered by run, node and type | S | Filters combine correctly |
| FR-CHAT-003 | User can send a message into the workflow's input | M | Message reaches the Input node |
| FR-CHAT-004 | User can chat directly with one agent, using its model, instructions and context | M | Reply reflects the agent's instructions |
| FR-CHAT-005 | Direct chats are separate threads and never change run records | M | Run record unchanged after chat |
| FR-CHAT-006 | Chat replies stream | M | Text appears progressively |
| FR-CHAT-007 | User can attach files in chat | S | Attachment reaches the model |
| FR-CHAT-008 | The agent's guardrail policy applies to direct chat | M | A blocked input in chat is refused with the guardrail reason |

### 3.15 Context and RAG (RAG) — Phase 10

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-RAG-001 | User can create a knowledge base with embedding model, chunk size and overlap | S | KB saved with settings |
| FR-RAG-002 | User can add PDF, DOCX, Markdown, text, code and HTML documents | S | Each type ingests successfully |
| FR-RAG-003 | Ingestion shows progress; failures show a reason | S | Corrupt file → failed with reason |
| FR-RAG-004 | Search combines meaning-based and keyword results | S | Exact-term and paraphrased queries both find the right chunk |
| FR-RAG-005 | User can attach knowledge bases to an agent; retrieval uses the incoming input as the query | S | Retrieved chunks appear in the envelope |
| FR-RAG-006 | Retrieval node returns chunks as structured output | S | Output contains text, score, source |
| FR-RAG-007 | Retrieved chunk IDs are recorded in the envelope | S | Inspector lists sources |
| FR-RAG-008 | User can test a search from the KB screen | S | Results with scores shown |
| FR-RAG-009 | Removing a document removes its chunks; KB can be re-indexed | S | Removed text no longer retrieved |
| FR-RAG-010 | Large upstream outputs are summarized to fit the budget, and summaries are cached | S | Same input doesn't trigger a second summary call |

### 3.16 Agent Memory (MEM) — Phase 10

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-MEM-001 | Memory can be enabled per agent | S | Toggle saved |
| FR-MEM-002 | Agent can save or delete memory entries through its output | S | Entries appear in memory view |
| FR-MEM-003 | Saved memory is included in the agent's next run | S | Next envelope contains the entries |
| FR-MEM-004 | User can view, delete one or clear all memory entries | S | Deleted entries never reappear |

### 3.17 Skills (SKL) — Phase 11

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-SKL-001 | User can create and edit skills: name, description, instructions, tools | S | Skill saved |
| FR-SKL-002 | User can attach and detach skills on an agent | S | Attached skills listed on the node |
| FR-SKL-003 | Skill instructions are added to the agent prompt in a fixed order | S | Same config always yields the same prompt |
| FR-SKL-004 | Skills are versioned and runs record the version used | C | Node run shows skill version |

### 3.18 Custom Nodes (CUS) — Phase 11

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-CUS-001 | User can register a custom node that calls an HTTP endpoint, via a manifest | S | Node appears in palette |
| FR-CUS-002 | User can register a custom node that runs a local script | S | Script node appears in palette |
| FR-CUS-003 | Manifests are validated; errors name the field | S | Missing `outputs` → clear error |
| FR-CUS-004 | Custom nodes behave like built-in nodes: connect, configure, run, retry, inspect | S | Works inside a mixed workflow |
| FR-CUS-005 | Script nodes run isolated with time, memory and folder limits | M* | Script exceeding limit is stopped (*M once script nodes are enabled) |
| FR-CUS-006 | Declared permissions are shown and must be approved before first use | M* | Unapproved node can't run |
| FR-CUS-007 | User can test a custom node with sample input | S | Test output displayed |

### 3.19 Workspace and Code (GIT) — Phase 12

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-GIT-001 | Each project folder is a git repository | S | `.git` present after project creation |
| FR-GIT-002 | A commit is made after each node that changes files | S | Commit message includes run, node, iteration |
| FR-GIT-003 | User can browse project files | S | File tree matches disk |
| FR-GIT-004 | User can view and edit files in the code panel; editing is blocked during runs | S | Editor read-only while a run is active |
| FR-GIT-005 | User can view differences between commits | S | Diff view shows changes |
| FR-GIT-006 | User can open a file or folder in VS Code | C | VS Code opens the path |
| FR-GIT-007 | User can replay a past run | S | Replay uses the recorded commit and envelopes |
| FR-GIT-008 | File access is limited to the project folder | M | `../` paths refused |

### 3.20 ACE Bench (BEN) — Phase 13

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-BEN-001 | User can create draft benchmark tasks: prompt, inputs, rubric | S | Draft saved and editable |
| FR-BEN-002 | User can freeze a task; frozen tasks can't be changed | S | Edit attempt refused; hash stored |
| FR-BEN-003 | User can create experiments with tasks, arms and a repetition count | S | Experiment lists all planned runs |
| FR-BEN-004 | Each bench run records output, tokens, cost, time, models, workflow and prompt snapshots, build version | S | All fields present |
| FR-BEN-005 | User can export anonymized outputs for blind judging | S | Export contains no arm names |
| FR-BEN-006 | User can import judge scores | S | Scores linked to the correct runs |
| FR-BEN-007 | Report applies the win/partial/loss rules recorded before the experiment | S | Rules can't be edited after start |
| FR-BEN-008 | Bench runs are kept separate from normal runs | S | Normal run history excludes bench runs |

### 3.21 Desktop (DSK) — Phase 16

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-DSK-001 | Installers exist for Windows, macOS and Linux | S | Install and launch succeed on each |
| FR-DSK-002 | Desktop app starts the engine itself and connects securely | M | No manual engine start needed |
| FR-DSK-003 | Secrets move to the operating system's secure storage | M | Existing keys work after migration |
| FR-DSK-004 | Native file dialogs and dragging files from the desktop work | S | Files attach correctly |
| FR-DSK-005 | App updates itself | S | New version installs on restart |
| FR-DSK-006 | Desktop has every web feature | M | Full end-to-end suite passes in desktop |

### 3.22 Onboarding and Templates (ONB) — Phase 17

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-ONB-001 | First launch guides the user: add provider → choose template → first run | S | New user completes a run without docs |
| FR-ONB-002 | Templates: linear chain, Review→Fix, parallel research + merge, RAG Q&A | S | Each template runs with the mock provider |
| FR-ONB-003 | Help links open relevant documentation | C | Links resolve |

### 3.23 Prompt Management (PRM) — Phases 5, 11 · Arch §12.5

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-PRM-001 | Prompts are assembled in a fixed order: system base → agent instructions → skills → guardrail instructions → context → reads → output contract | M | Same config always yields the same prompt |
| FR-PRM-002 | Context sections are clearly delimited and untrusted content is labelled | M | Retrieved and tool content appears inside marked untrusted blocks |
| FR-PRM-003 | Prompts support placeholders (`{{input.text}}`, `{{memory.key}}`, `{{run.iteration}}`) | S | Placeholders resolved; unknown placeholder flagged in validation |
| FR-PRM-004 | Agent prompts are versioned; each node run records the prompt version | M | Inspector shows the version used |
| FR-PRM-005 | User can view the fully assembled prompt of any node run | M | "View prompt" shows exactly what was sent (secrets redacted) |
| FR-PRM-006 | User can save prompts to a project prompt library and insert them into agents | S | Saved prompt reusable across workflows |
| FR-PRM-007 | User can compare two prompt versions | C | Side-by-side diff shown |

### 3.24 Guardrails (GRD) — Phases 6, 10, 11, 15 · Arch §13

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-GRD-001 | Guardrail policies can be created, edited, versioned and tested | M | Policy saved with version; test endpoint returns verdicts |
| FR-GRD-002 | A project has a default policy; an agent can override it | M | Agent override takes effect over project default |
| FR-GRD-003 | **Input guardrails:** size/type limits, PII detection, prompt-injection patterns, blocked topics | M | Each check triggers on its test input |
| FR-GRD-004 | **Context guardrails:** retrieved chunks, upstream outputs and tool results are tagged untrusted and hidden instructions are stripped | M | Injected instruction in a document doesn't change agent behaviour in the test corpus |
| FR-GRD-005 | **Tool guardrails:** tool must be allowed for the agent, arguments valid, paths inside the project, domains on the allow-list | M | Disallowed tool/path/domain blocked |
| FR-GRD-006 | Destructive tool actions require user approval | M | Delete/overwrite action pauses the node for approval |
| FR-GRD-007 | **Output guardrails:** contract check, content moderation, secret-leak detection, PII detection, required citations | M | Leaked key in output is blocked or redacted |
| FR-GRD-008 | **Cost guardrails:** max tokens per node, max cost per run, daily budget | M | Exceeding run budget stops the run as HALTED with reason `budget_exceeded` |
| FR-GRD-009 | **Loop guardrails:** max iterations, max tool calls per node, repeated-output detection | M | Identical output 3 times in a row stops the loop |
| FR-GRD-010 | **Data guardrails:** secrets never stored or logged; file access confined | M | Always on; cannot be disabled |
| FR-GRD-011 | Each check has an action: pass, warn, redact, ask user, block | M | All five actions behave as configured |
| FR-GRD-012 | A block fails the node with `GUARDRAIL_VIOLATION` (D9) | M | State and reason shown; distinct from CONTRACT_VIOLATION |
| FR-GRD-013 | "Ask user" puts the node in Waiting and shows an approval card; approve continues, reject fails the node | M | Both paths behave correctly; decision logged with time |
| FR-GRD-014 | Redaction records what type was removed, never the value | M | Inspector shows "email redacted", not the email |
| FR-GRD-015 | Every verdict is stored on the node run and visible in the inspector | M | Verdict list with check, action and reason |
| FR-GRD-016 | Guardrail node can be placed on the Canvas; it outputs sanitized data and a verdict, and edges can branch on the verdict | S | Pass branch and block branch both work |
| FR-GRD-017 | Local moderation uses a local classifier model (e.g. Llama Guard via Ollama) when available, otherwise rule packs | S | Moderation works offline with Ollama running |
| FR-GRD-018 | Default policy: warn on content issues; block secret leaks and tool abuse (D10) | S | New project uses this default |

### 3.25 Model Router (RTR) — Phase 4 · Arch §14.3

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-RTR-001 | Each agent has a routing policy; default is Fixed | M | New agents show "Fixed" |
| FR-RTR-002 | **Fallback chain:** on provider or network failure, try the next model in the list | M | Primary down → second model answers |
| FR-RTR-003 | **Capability:** choose the first available model that supports the node's data types | C | Image input routes to a vision model |
| FR-RTR-004 | **Cost-aware:** choose the cheapest capable model | C | Cheapest eligible model selected |
| FR-RTR-005 | **Latency-aware:** choose the fastest capable model from recent measurements | C | Fastest eligible model selected |
| FR-RTR-006 | The model actually used is recorded and shown on the node and in the inspector | M | Fallback use clearly visible |
| FR-RTR-007 | Bench runs always use Fixed routing | M | Bench refuses non-fixed policies |

### 3.26 Tools (TOOL) — Phases 8, 11, 12 · Arch §16

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-TOOL-001 | Tools are registered with name, description, input/output schemas, permissions (network, file paths, destructive) and timeout | M | Registry lists all tools with permissions |
| FR-TOOL-002 | User can enable specific tools per agent | M | Agent can only call enabled tools |
| FR-TOOL-003 | Agents can call tools in a loop until they produce a final answer or hit the tool-call limit | M | Multi-step tool use completes; limit enforced |
| FR-TOOL-004 | **Code sandbox:** run generated code in a child process with time, memory and folder limits; use Docker when available | S | Infinite loop killed at timeout; no access outside sandbox folder |
| FR-TOOL-005 | **Web search and fetch:** search via SearXNG (default) or a user-keyed search API; fetch page text | S | Query returns results with URLs |
| FR-TOOL-006 | **HTTP request:** call external APIs only on allow-listed domains | S | Non-listed domain refused |
| FR-TOOL-007 | **MCP:** user can connect MCP servers and expose their tools to agents | S | MCP tool appears in registry and is callable |
| FR-TOOL-008 | **File and Git tools:** read/write project files and commit, confined to the project | S | Writes outside project refused |
| FR-TOOL-009 | Every tool call is logged with arguments (secrets redacted), result summary, duration and verdicts | M | Tool call list visible in inspector |
| FR-TOOL-010 | Tool results are passed back to the model as untrusted content | M | Result appears inside untrusted block |

### 3.27 Observability and Usage (OBS) — Phases 5, 15 · Arch §26, §27

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-OBS-001 | Each run has a trace view: timeline of node runs, tool calls, guardrail verdicts and events | M | Trace matches event log order |
| FR-OBS-002 | Tokens and estimated cost are recorded per node run and totalled per run, workflow and day | M | Totals equal the sum of node runs |
| FR-OBS-003 | Cost estimates use a versioned price table | S | Changing price table doesn't change past estimates |
| FR-OBS-004 | Usage screen shows spend and tokens by provider, model and day | S | Charts match stored data |
| FR-OBS-005 | Optional export of LLM traces to Langfuse (local or cloud) | S | Traces visible in Langfuse when enabled |
| FR-OBS-006 | Optional error reporting (Sentry), off by default | S | No reports sent unless enabled |
| FR-OBS-007 | Basic health metrics visible in settings: runs, failures by kind, provider latency | S | Numbers update after runs |

### 3.28 CLI and SDK (CLI) — Phase 17 · Arch §10.4, §10.5

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-CLI-001 | `ace connect` connects to a local engine (or hosted account later) | S | Connection status shown |
| FR-CLI-002 | `ace run <workflow> --input <file>` runs a workflow and streams progress | S | Exit code 0 on COMPLETE, non-zero on HALTED/BLOCKED |
| FR-CLI-003 | `ace runs list/show` shows history and details | S | Output matches UI |
| FR-CLI-004 | `ace export/import` handles workflow files | S | Round-trip preserves the workflow |
| FR-CLI-005 | `ace bench run <experiment>` runs benchmarks from CI | C | Report produced |
| FR-CLI-006 | A TypeScript SDK is generated from the shared contracts with typed methods and an event stream helper | S | SDK compiles; example script runs a workflow |
| FR-CLI-007 | An OpenAPI document is generated from the contracts | S | Document validates and matches endpoints |

### 3.29 Mobile and Responsive Views (MOB) — Phases 17, 21 · Arch §10.3

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-MOB-001 | Runs, run detail, outputs and chat are usable on phone-sized screens | S | Usable at 380 px width |
| FR-MOB-002 | Guardrail approvals can be answered from a phone | S | Approve/reject works on mobile layout |
| FR-MOB-003 | Workflow building is not required on mobile; the Canvas shows read-only | S | Read-only Canvas renders |
| FR-MOB-004 | Native mobile app for monitoring and approvals | L (Ph 21) | App shows runs and approvals |

### 3.30 Hosted Platform (HOST) — Phase 18 · Arch §11, §23

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-HOST-001 | Users can sign up, log in (email and OAuth), log out and reset password | L | All flows work |
| FR-HOST-002 | Optional multi-factor authentication | L | MFA challenge enforced when enabled |
| FR-HOST-003 | Workspaces with roles owner, editor, viewer | L | Viewer can't edit; editor can't manage members |
| FR-HOST-004 | Owners invite and remove members | L | Invite email received; removed member loses access |
| FR-HOST-005 | Users create scoped API keys for CLI/SDK and can revoke them | L | Revoked key → 401 |
| FR-HOST-006 | Rate limits per user, API key and workspace | L | Exceeding limit → 429 with retry time |
| FR-HOST-007 | Usage is metered per workspace and mapped to plans | L | Usage page matches metered totals |
| FR-HOST-008 | Billing through Stripe: plans, upgrades, invoices | L | Test-mode purchase succeeds |
| FR-HOST-009 | Workspace budgets and plan limits stop runs when exceeded | L | Run HALTED with `plan_limit` reason |
| FR-HOST-010 | Tenant data is isolated (row-level security, prefixed storage) | L | Cross-workspace access attempts fail |
| FR-HOST-011 | Run creation supports an idempotency key | L | Duplicate request returns the same run |
| FR-HOST-012 | Audit log of logins, key changes, policy changes and deletions | L | Entries visible to owners |
| FR-HOST-013 | Data retention follows the plan (e.g. 30/90/365 days) | L | Older runs removed on schedule |
| FR-HOST-014 | Users can move local workflows, KBs and skills to hosted (secrets excluded) | L | Import succeeds; keys must be re-entered |
| FR-HOST-015 | Public website: home, features, pricing, docs | L | Pages live and linked from login |

### 3.31 Hosted Models (HMOD) — Phase 19 · Arch §14

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-HMOD-001 | ACE can serve selected open models on its own GPU pool (vLLM or TGI) | L | Models appear in catalog as "ACE hosted" |
| FR-HMOD-002 | Hosted models autoscale with demand | L | Scale-up under load test |
| FR-HMOD-003 | Hosted model usage is metered like other providers | L | Tokens and cost recorded |

### 3.32 Fine-Tuning (TRN) — Phase 20 · Arch §17

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| FR-TRN-001 | Training data is built only from graded runs the user consented to share | L | No record without consent enters a dataset |
| FR-TRN-002 | PII is removed before data enters a dataset | L | PII scan of dataset finds nothing |
| FR-TRN-003 | Frozen benchmark tasks are never used for training | L | Dataset build fails if a frozen task hash appears |
| FR-TRN-004 | LoRA/QLoRA jobs can be started for small open models in defined roles (reviewer, router, guardrail classifier) | L | Job completes and produces an adapter |
| FR-TRN-005 | Every trained model is evaluated on ACE Bench (non-frozen split) against its baseline | L | Report shows comparison |
| FR-TRN-006 | A model registry stores version, base model, dataset hash, metrics and approval status | L | Only approved models deployable |
| FR-TRN-007 | Approved models deploy to hosted serving or export for Ollama | L | Model selectable in catalog |

---

## 4. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-PERF-01 | Performance | Canvas stays smooth (≈60 fps) with 200 nodes and 400 edges |
| NFR-PERF-02 | Performance | UI responds to any click within 100 ms |
| NFR-PERF-03 | Performance | Engine adds under 50 ms per node dispatch (excluding the model call) |
| NFR-PERF-04 | Performance | Streamed text reaches the screen within 200 ms of arriving at the engine |
| NFR-PERF-05 | Performance | Engine starts in under 3 s; a 200-node workflow loads in under 1 s |
| NFR-PERF-06 | Performance | Default 20 simultaneous node runs, configurable |
| NFR-REL-01 | Reliability | No events lost across UI reconnects |
| NFR-REL-02 | Reliability | Database writes are atomic; crash never leaves a half-saved graph |
| NFR-REL-03 | Reliability | Database is backed up before every migration |
| NFR-SEC-01 | Security | Local-only binding, token auth, origin allow-list |
| NFR-SEC-02 | Security | Secrets only in OS secure storage; never in DB, logs or exports |
| NFR-SEC-03 | Security | File access confined to the project folder |
| NFR-SEC-04 | Security | Model outputs and retrieved documents are treated as untrusted; tools run only with declared permission; destructive tools ask for confirmation |
| NFR-SEC-05 | Security | Upload size limits and file type checks |
| NFR-SEC-06 | Security | No known high/critical dependency vulnerabilities at release |
| NFR-USE-01 | Usability | Every major action is possible from the Canvas |
| NFR-USE-02 | Usability | Keyboard accessible; text contrast meets WCAG AA |
| NFR-USE-03 | Usability | Error messages say what happened and what to do next |
| NFR-COMP-01 | Compatibility | Latest two versions of Chrome, Edge, Firefox |
| NFR-COMP-02 | Compatibility | Windows 10+, macOS 13+, Ubuntu 22.04+ |
| NFR-MAIN-01 | Maintainability | TypeScript strict mode; shared schemas are the single source of truth |
| NFR-MAIN-02 | Maintainability | Test coverage ≥ 80% engine, ≥ 60% frontend |
| NFR-OBS-01 | Observability | Every run has a viewable trace of events |
| NFR-PRIV-01 | Privacy | Data stays on the machine except calls to chosen providers; telemetry is opt-in |
| NFR-SAFE-01 | Safety | Guardrail checks add under 300 ms per node when using rule packs (classifier models excluded) |
| NFR-SAFE-02 | Safety | Guardrail test corpus: ≥95% of known injection and leak cases caught; false-positive rate on clean corpus ≤5% |
| NFR-PORT-01 | Portability | The same engine package runs in local and hosted modes by swapping adapters only |
| NFR-VER-01 | Versioning | API changes within `/api/v1` are additive only; workflow files carry a format version and old versions import |
| NFR-OBS-02 | Observability | Every node run, tool call and guardrail verdict is traceable from the run trace |
| NFR-HOST-01 | Availability (hosted) | 99.5% monthly API availability |
| NFR-HOST-02 | Latency (hosted) | p95 run-start < 1 s; p95 stream latency < 300 ms |
| NFR-HOST-03 | Recovery (hosted) | RPO ≤ 15 min, RTO ≤ 4 h; daily backups with point-in-time recovery |
| NFR-HOST-04 | Isolation (hosted) | No data access across workspaces, verified by automated tests |
| NFR-HOST-05 | Scalability (hosted) | Workers scale horizontally on queue depth |

---

## 5. Business Rules

| ID | Rule |
|---|---|
| BR-01 | The UI never holds the source of truth; the engine does |
| BR-02 | Nodes exchange envelopes only; raw conversation history is never passed |
| BR-03 | CONTRACT_VIOLATION, RUN_FAILED and BLOCKED are different failures; COMPLETE and HALTED are different endings |
| BR-04 | A run's snapshot never changes after the run starts |
| BR-05 | Cycles exist only as loop edges with a maximum iteration count |
| BR-06 | Frozen benchmark tasks and pre-registered rules can't be edited |
| BR-07 | Secrets never appear in the database, logs or exports |
| BR-08 | The engine never calls a provider that failed its pre-flight check |
| BR-09 | Project files can't be edited by the user while a run is active |
| BR-10 | Config edits during a run apply only to later runs |
| BR-11 | Custom scripts never run without the user approving their permissions |
| BR-12 | Guardrail blocks are reported as `GUARDRAIL_VIOLATION`, never merged with other failure reasons (D9) |
| BR-13 | Retrieved documents, tool results and upstream outputs are always treated as untrusted |
| BR-14 | Destructive tool actions never run without user approval |
| BR-15 | Data guardrails (secrets, file confinement) can't be disabled |
| BR-16 | The model actually used is always recorded; benchmark runs use fixed routing |
| BR-17 | Frozen benchmark tasks never enter training data |
| BR-18 | Hosted tenants never see each other's data |

---

## 6. External Interfaces

- **User interface:** web app (later desktop) with top bar, node palette, Canvas, configuration panel and bottom panel (timeline, events, errors, code).
- **Engine API:** REST at `/api/v1` and WebSocket at `/ws`; full endpoint list in the build blueprint §6.
- **Provider interfaces:** Anthropic, Google and OpenAI APIs; OpenAI-compatible endpoints (Ollama, LM Studio, custom); CLIs through process execution.
- **Custom node interfaces:** HTTP (envelope in, result out) and script (JSON over standard input/output).
- **Storage:** SQLite database, artifact folder, git repositories, OS keychain (local); Postgres, Redis, S3-compatible storage, secret manager (hosted).
- **CLI and SDK:** `ace` command; TypeScript SDK and OpenAPI document generated from contracts.
- **Tool interfaces:** code sandbox (process/Docker), SearXNG or search API, HTTP with domain allow-list, MCP servers.
- **Guardrail services:** local classifier via Ollama; Presidio and hosted classifiers in hosted mode.
- **Observability:** Langfuse, Sentry, OpenTelemetry, Prometheus (hosted).
- **Hosted services:** OAuth providers, Stripe billing, email delivery.

---

## 7. Use Cases

| ID | Name | Actor | Precondition | Main flow | Alternate flows |
|---|---|---|---|---|---|
| UC-01 | Set up a provider | Builder | Engine running | Open settings → add provider → enter key → test → models listed | Wrong key → auth failed shown |
| UC-02 | Build a workflow | Builder | Project open | New workflow → add Input, 2 Agents, Output → connect → configure models | Incompatible connection refused |
| UC-03 | Run a workflow | Operator | Valid workflow | Start → provide input → watch states and streaming → view final output | Pre-flight fails → BLOCKED with issues |
| UC-04 | Recover from failure | Operator | Node failed | Open error → fix config or wait → Retry → run continues | Auth error → update key first |
| UC-05 | Control a run | Operator | Run active | Pause → resume, or Stop → run HALTED | Restart creates a new run |
| UC-06 | Review→Fix loop | Builder | Two agents | Writer → Reviewer → loop edge back to Writer with max 3 and exit on approval | Max reached → configured behavior |
| UC-07 | Parallel research | Builder | 3+ agents | Input fans out to 2 researchers → Merge → Writer | "any" mode proceeds on first result |
| UC-08 | Multimodal flow | Builder | Vision model available | Upload image → vision agent describes → text agent writes | Text-only model flagged before run |
| UC-09 | Chat with an agent | Operator | Node exists | Select node → Chat tab → send message → streamed reply | Provider offline → error in chat |
| UC-10 | Use a knowledge base | Builder | Embedding model available | Create KB → add documents → attach to agent → run → sources shown | Ingest failure shown per document |
| UC-11 | Add a custom node | Extender | Endpoint or script ready | Register manifest → approve permissions → test → use in workflow | Invalid manifest → field error |
| UC-12 | Replay a run | Builder | Past run exists | Run history → select → Replay | Missing commit → error with reason |
| UC-13 | Run a benchmark | Evaluator | Frozen tasks | Create experiment → start → blind export → import scores → report | Run failure recorded, not hidden |
| UC-14 | Install desktop app | Any | Installer downloaded | Install → launch → existing data available | Update available → install on restart |
| UC-15 | Approve a risky action | Operator | Agent with file tools | Agent requests delete → node Waiting → approval card → Approve → continues | Reject → node GUARDRAIL_VIOLATION |
| UC-16 | Set a guardrail policy | Builder | Project open | Guardrails → new policy → choose checks and actions → test → set as project default | Test shows false positive → adjust threshold |
| UC-17 | Use tools | Builder | Tools enabled | Enable web search + sandbox on agent → run → inspector shows tool calls | Domain not allowed → blocked |
| UC-18 | Set a fallback model | Builder | Two providers | Routing policy Fallback: A → B → run with A down | Both down → node fails with provider error |
| UC-19 | Run from CLI | Automator | Engine running | `ace run flow.json --input brief.md` → streamed progress → exit code | HALTED → non-zero exit code |
| UC-20 | Join a hosted workspace (post-v1) | Workspace admin | Hosted account | Invite member → member signs up → edits workflows | Viewer tries to edit → refused |

---

## 8. Testing (Phase 14 — Testing & QA)

### 8.1 Why testing is its own phase
Tests are still written inside every phase (each phase's "done when" includes its tests). The dedicated **Testing & QA phase** adds the system-wide work that can't happen feature by feature: full end-to-end suites, regression, performance, cross-browser, recovery, user acceptance, and the final test report.

### 8.2 Test levels

| Level | What it covers | Tool | When |
|---|---|---|---|
| Unit | Schemas, validation, scheduler logic, envelope building, chunking, retry policy | Vitest | Every commit |
| Integration | Engine API with a temporary database and mock provider | Vitest + supertest-style client | Every commit |
| Component | React components (nodes, panels, inspector) | Vitest + Testing Library | Every commit |
| End-to-end | Full user journeys in the browser | Playwright | Every pull request |
| Provider contract | Real calls to each provider | Vitest (tagged) | Nightly |
| Performance | Large graphs, streaming, parallel load | Playwright traces + custom scripts | Phase 14, before release |
| Security | Auth, origin, path traversal, secrets, sandbox | Automated tests + manual review | Phases 14–15 |
| Recovery | Crash, disconnect, provider outage | Scripted fault injection | Phase 14 |
| Compatibility | Browsers and operating systems | Playwright matrix | Phase 14, again in Phase 16 |
| Guardrail suite | Injection, PII, secret-leak, tool-abuse and clean corpora | Vitest | Every commit (rules), nightly (classifiers) |
| CLI/SDK | Commands and SDK examples against a test engine | Vitest | Every pull request |
| Tenant isolation (hosted) | Cross-workspace access attempts | Integration tests | Phase 18 |
| User acceptance | Real tasks by real users | Checklist sessions | End of Phase 14 |

### 8.3 Test environment and data
- Temporary SQLite database per test run; mock provider with scripted responses, delays and errors.
- Fixture workflows: linear (3 nodes), parallel (fan-out/merge), loop (Review→Fix), multimodal (image), RAG (5 documents), custom HTTP node (local test server).
- Guardrail corpora: known injection prompts, documents with hidden instructions, texts with PII and fake API keys, and a clean control set.
- Tool fixtures: local HTTP test server, local SearXNG or mocked search, a local MCP test server.
- Fixture files: sample PDF, DOCX, Markdown, PNG, MP3, MP4, a corrupt PDF, a file over the size limit.

### 8.4 Entry and exit criteria
- **Entry:** feature complete for the phase; builds pass; test data ready.
- **Exit:** 100% of Must test cases pass; ≥ 95% of Should test cases pass; no open critical or high defects; coverage targets met; performance targets met.

### 8.5 Defect severity

| Severity | Meaning | Example |
|---|---|---|
| Critical | Data loss, security hole, app unusable | Secret written to logs |
| High | Main feature broken, no workaround | Runs never complete |
| Medium | Feature broken with workaround | Undo misses one action type |
| Low | Cosmetic | Misaligned icon |

### 8.6 Test cases

Type: **P** = positive, **N** = negative, **E** = edge case.

#### System (SYS)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-SYS-001 | FR-SYS-001 | N | Remote access blocked | Call engine from another machine on the LAN | Connection refused |
| TC-SYS-002 | FR-SYS-002 | N | Missing token | Call `GET /projects` without token | 401 error in standard format |
| TC-SYS-003 | FR-SYS-002 | N | WebSocket bad token | Connect `/ws?token=wrong` | Connection closed |
| TC-SYS-004 | FR-SYS-003 | N | Foreign origin | Send request with `Origin: https://evil.example` | 403 |
| TC-SYS-005 | FR-SYS-004 | P | Health check | `GET /health` | 200, version, db ok |
| TC-SYS-006 | FR-SYS-005 | P | Settings persist | Change concurrency to 5 → restart engine | Value is 5 |
| TC-SYS-007 | FR-SYS-006 | P | Error format | Trigger 400, 401, 404, 409 | All match error schema |
| TC-SYS-008 | FR-SYS-007 | N | No secrets in logs | Add provider with key → full run → search logs | Key not found |
| TC-SYS-009 | FR-SYS-008 | P | Graceful shutdown | Start long run → stop engine | Run HALTED, reason shutdown |
| TC-SYS-010 | FR-SYS-009 | E | Crash recovery | Kill engine mid-run → restart | Run shows HALTED, not running |

#### Projects and Workflows (PRJ, WF)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-PRJ-001 | FR-PRJ-001 | P | Create project | Create "Demo" with new folder path | Project listed; folder exists; git initialized |
| TC-PRJ-002 | FR-PRJ-003 | N | Unwritable folder | Create with read-only path | Validation error naming the path |
| TC-PRJ-003 | FR-PRJ-002 | P | Delete project | Delete → confirm | Removed from list |
| TC-PRJ-004 | FR-PRJ-004 | P | Reopen last project | Open project B → relaunch | Project B opens |
| TC-WF-001 | FR-WF-001 | P | Create workflow | New workflow "Flow 1" | New tab with empty Canvas |
| TC-WF-002 | FR-WF-002 | P | Switch tabs | Open two workflows, switch | Each shows its own graph |
| TC-WF-003 | FR-WF-003 | P | Duplicate workflow | Duplicate a 3-node workflow | Same structure, different IDs |
| TC-WF-004 | FR-WF-004 | P | Autosave | Add node → reload page | Node still present |
| TC-WF-005 | FR-WF-005 | N | Stale edit | Edit in two tabs; save older version | 409; tab refreshes to latest |
| TC-WF-006 | FR-WF-006 | P | Validation list | Leave required input unconnected → Validate | Issue lists node and severity |
| TC-WF-007 | FR-WF-007 | N | Export has no secrets | Export workflow using a keyed provider | No key in file |
| TC-WF-008 | FR-WF-008 | N | Bad import version | Import file with unknown version | Clear error; nothing created |

#### Canvas and Nodes (CAN, NODE)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-CAN-001 | FR-CAN-002 | P | Drag node from palette | Drag Agent onto Canvas | Node at drop point |
| TC-CAN-002 | FR-CAN-003 | P | Box select | Drag selection box over 3 nodes | 3 selected |
| TC-CAN-003 | FR-CAN-004 | P | Positions persist | Move node → reload | Same position |
| TC-CAN-004 | FR-CAN-005 | P | Delete removes edges | Delete a connected node | Its edges gone |
| TC-CAN-005 | FR-CAN-006 | P | Duplicate independence | Duplicate → rename copy | Original unchanged |
| TC-CAN-006 | FR-CAN-007 | P | Navigation | Pan, zoom with trackpad, press F | View fits all nodes |
| TC-CAN-007 | FR-CAN-008 | P | Auto-layout | Scatter 6 nodes → Auto-arrange | No overlaps, left-to-right order |
| TC-CAN-008 | FR-CAN-009 | P | Undo/redo | Add, move, connect → undo ×3 → redo ×3 | States reverse and restore in order |
| TC-CAN-009 | FR-CAN-010 | E | Load state | Open 200-node workflow on throttled network | Loading state, then full graph at once |
| TC-CAN-010 | FR-CAN-012 | P | Shortcuts | Use Delete, Ctrl+D, Ctrl+A, F | Each works |
| TC-NODE-001 | FR-NODE-002 | P | Open config | Click agent node | Config panel shows its fields |
| TC-NODE-002 | FR-NODE-003 | P | Save config | Edit all fields → reload | All values kept |
| TC-NODE-003 | FR-NODE-004 | N | Incompatible model hidden | Set input type image → open picker | Text-only models disabled with reason |
| TC-NODE-004 | FR-NODE-005 | P | Model chip updates | Change model | Chip shows new model at once |
| TC-NODE-005 | FR-NODE-006 | P | Ports from types | Add output type image | Image port appears |
| TC-NODE-006 | FR-NODE-007 | N | Out-of-range setting | Temperature 5 | Inline error; not saved |
| TC-NODE-007 | FR-NODE-008 | N | Invalid config blocks run | Clear model → Start | Pre-flight error names node |
| TC-NODE-008 | FR-NODE-009 | P | Edit during run | Change prompt mid-run | Run unchanged; notice shown; next run uses new prompt |
| TC-NODE-009 | FR-NODE-010 | P | Status vs provider color | Run node through states | Provider color constant; status ring changes |
| TC-NODE-010 | FR-NODE-011 | P | Input prompt | Start with empty Input node | Input dialog appears |

#### Connections (CON)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-CON-001 | FR-CON-001 | P | Connect nodes | Drag output to input | Edge saved |
| TC-CON-002 | FR-CON-002 | N | Type mismatch | Connect text output to image-only input | Refused with reason |
| TC-CON-003 | FR-CON-003 | N | Plain cycle | A→B then B→A as normal edge | Refused |
| TC-CON-004 | FR-CON-004 | P | Disconnect | Select edge → Delete | Edge removed |
| TC-CON-005 | FR-CON-005 | P | Fan-out | Connect one output to 3 inputs | All 3 saved |
| TC-CON-006 | FR-CON-005 | N | Single-input port | Connect second edge to single input | Refused |
| TC-CON-007 | FR-CON-007 | E | Loop limits | Set max iterations 0 and 51 | Both refused |

#### Providers and Models (PRV, MOD)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-PRV-001 | FR-PRV-001 | P | Add each provider | Add Anthropic, Google, OpenAI, Ollama, mock | All listed |
| TC-PRV-002 | FR-PRV-002 | N | Key never returned | Add provider → `GET /providers` | Only "key set: yes" |
| TC-PRV-003 | FR-PRV-003 | N | Wrong key | Add with invalid key → Test | Auth failed |
| TC-PRV-004 | FR-PRV-003 | N | Unreachable | OpenAI-compatible with dead URL → Test | Unreachable |
| TC-PRV-005 | FR-PRV-004 | P | Live status | Stop Ollama while app open | Status changes without reload |
| TC-PRV-006 | FR-PRV-005 | P | Remove in-use provider | Remove → confirm | Affected nodes show "provider missing" |
| TC-PRV-007 | FR-PRV-006 | P | Custom endpoint models | Add LM Studio URL | Its models selectable |
| TC-PRV-008 | FR-PRV-007 | P | Ollama detection | First launch with Ollama running | Detection offered |
| TC-PRV-009 | FR-PRV-009 | P | Concurrency limit | Limit 2; run 5 parallel nodes | Never more than 2 active calls |
| TC-PRV-010 | FR-PRV-010 | P | Mock provider | Run workflow on mock | Deterministic outputs |
| TC-MOD-001 | FR-MOD-001 | P | Discovery | Add provider supporting listing | Models listed as discovered |
| TC-MOD-002 | FR-MOD-002 | P | Manifest fallback | Add provider without listing | Manifest models listed |
| TC-MOD-003 | FR-MOD-004 | P | Filters | Filter image input + available | Only matching models |
| TC-MOD-004 | FR-MOD-005 | N | Unavailable model | Mark model unavailable → Validate | Node flagged |

#### Execution (EXE)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-EXE-001 | FR-EXE-001, 005 | P | Linear run | Input → A → B → Output; Start | Each output flows on; run COMPLETE |
| TC-EXE-002 | FR-EXE-002 | P | Snapshot | Start run → delete node B mid-run | Run still executes B |
| TC-EXE-003 | FR-EXE-003 | N | Pre-flight failure | Provider offline → Start | Run BLOCKED; zero provider calls |
| TC-EXE-004 | FR-EXE-004 | P | Dependency order | A and B both feed C | C starts only after A and B finish |
| TC-EXE-005 | FR-EXE-006 | N | Contract violation | Mock returns wrong JSON shape | Node CONTRACT_VIOLATION |
| TC-EXE-006 | FR-EXE-007 | E | Budget limit | Upstream output 50k tokens, budget 4k | Envelope ≤ 4k tokens |
| TC-EXE-007 | FR-EXE-008 | P | Streaming | Mock streams 100 tokens slowly | Text appears progressively |
| TC-EXE-008 | FR-EXE-009 | P | All states visible | Script mock to hit every state | Each state displayed distinctly |
| TC-EXE-009 | FR-EXE-010 | P | Node run record | Complete run → open inspector | Inputs, outputs, model, tokens, cost, time shown |
| TC-EXE-010 | FR-EXE-011 | P | HALTED ending | One output node fails | Run HALTED |
| TC-EXE-011 | FR-EXE-012 | P | Run history | Run 3 times | 3 entries, newest first |
| TC-EXE-012 | FR-EXE-013 | P | Start from node | Start from B | A not called again |
| TC-EXE-013 | FR-EXE-014 | E | Reconnect | Drop WebSocket mid-run → reconnect | All state changes present, in order |
| TC-EXE-014 | FR-EXE-015 | P | Transfer animation | Run linear workflow | Arrow animates on each handoff |

#### Control and Errors (CTL, ERR)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-CTL-001 | FR-CTL-001 | P | Pause | Pause while A runs | A finishes; B doesn't start |
| TC-CTL-002 | FR-CTL-002 | P | Resume | Resume | B starts; run completes |
| TC-CTL-003 | FR-CTL-003 | P | Stop | Stop during streaming | Stream ends within 2 s; run HALTED |
| TC-CTL-004 | FR-CTL-004 | P | Restart | Restart finished run | New run ID, same inputs |
| TC-CTL-005 | FR-CTL-005 | P | Re-run one node | Re-run B | Only B executes |
| TC-CTL-006 | FR-CTL-006 | N | Button states | Check buttons in each run state | Only valid actions enabled |
| TC-ERR-001 | FR-ERR-001 | P | Error classification | Simulate each of the 7 error kinds | Each classified correctly |
| TC-ERR-002 | FR-ERR-002 | P | Error display | Trigger provider error | Card shows node, kind, message, provider, Retry |
| TC-ERR-003 | FR-ERR-003 | P | Manual retry | Retry failed node | Attempt 2 recorded; same inputs |
| TC-ERR-004 | FR-ERR-004 | P | Cascade retry | Retry with downstream | Downstream nodes re-run |
| TC-ERR-005 | FR-ERR-005 | P | Auto retry on rate limit | Mock returns 429 twice then success | Node completes on attempt 3 |
| TC-ERR-006 | FR-ERR-005 | N | No retry on auth | Mock returns 401 | Fails once; no retries |
| TC-ERR-007 | FR-ERR-006 | P | Downstream blocked | A fails | B and C show BLOCKED |
| TC-ERR-008 | FR-ERR-007 | P | Cancel ≠ failure | Stop run | Nodes Stopped, not counted as failed |
| TC-ERR-009 | FR-ERR-008 | P | Fix and re-run | Fix bad model → re-run node | Succeeds; workflow unchanged otherwise |

#### Parallel and Loops (PAR)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-PAR-001 | FR-PAR-001 | P | Parallel branches | Two 2-second branches | Total ≈ 2 s, not 4 s |
| TC-PAR-002 | FR-PAR-002 | P | Merge "all" | Merge waits on 2 branches | Starts after both; ordered by port |
| TC-PAR-003 | FR-PAR-002 | P | Merge "any" | Merge in any mode | Starts after first branch |
| TC-PAR-004 | FR-PAR-003, 004 | P | Loop exits on approval | Reviewer approves on iteration 2 | Loop stops at 2 |
| TC-PAR-005 | FR-PAR-003 | E | Loop hits maximum | Reviewer never approves, max 3 | Exactly 3 iterations |
| TC-PAR-006 | FR-PAR-005 | P | Iteration history | Open loop node inspector | Each iteration's output selectable |
| TC-PAR-007 | FR-PAR-006 | P | Max behavior | Set "fail on max" | Node fails with clear reason |
| TC-PAR-008 | FR-PAR-007 | N | Bad review output | Reviewer returns no verdict | CONTRACT_VIOLATION |

#### Multimodal (MM)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-MM-001 | FR-MM-001 | N | Oversized upload | Upload 150 MB file | Refused with message |
| TC-MM-002 | FR-MM-002 | P | Deduplication | Upload same image twice | Same artifact ID |
| TC-MM-003 | FR-MM-003 | P | Each type | Upload text, PNG, MP3, MP4, code, JSON, ZIP | All accepted and stored |
| TC-MM-004 | FR-MM-004 | P | References only | Pass image between nodes → inspect envelope | Contains reference, no raw bytes |
| TC-MM-005 | FR-MM-005 | N | Wrong model type | Image into text-only model → Start | Pre-flight issue |
| TC-MM-006 | FR-MM-006 | P | Rendering | Outputs of each type | Each displays correctly |
| TC-MM-007 | FR-MM-007 | P | Drop onto node | Drag PNG onto Input node | Attached |
| TC-MM-008 | FR-MM-009 | P | Download integrity | Download artifact → hash | Hash matches |
| TC-MM-009 | FR-MM-003 | P | Vision flow | Image → vision agent → text agent | Description passed and used |

#### Chat (CHAT)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-CHAT-001 | FR-CHAT-001 | P | Message styles | Run with an error | Six message types visually distinct |
| TC-CHAT-002 | FR-CHAT-002 | P | Filters | Filter by node + errors | Only matching messages |
| TC-CHAT-003 | FR-CHAT-003 | P | Message to workflow | Send message | Reaches Input node |
| TC-CHAT-004 | FR-CHAT-004 | P | Direct chat uses config | Agent told "answer in French" → chat | Reply in French |
| TC-CHAT-005 | FR-CHAT-005 | P | Run records untouched | Chat after run → compare run record | Unchanged |
| TC-CHAT-006 | FR-CHAT-006 | P | Streaming chat | Send message | Reply streams |
| TC-CHAT-007 | FR-CHAT-007 | P | Chat attachment | Attach image to vision agent chat | Reply references image |

#### RAG and Memory (RAG, MEM)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-RAG-001 | FR-RAG-001 | P | Create KB | Create with settings | Saved |
| TC-RAG-002 | FR-RAG-002 | P | Ingest types | Add PDF, DOCX, MD, TXT, code, HTML | All reach "ready" |
| TC-RAG-003 | FR-RAG-003 | N | Corrupt file | Add corrupt PDF | Failed with reason; others unaffected |
| TC-RAG-004 | FR-RAG-004 | P | Keyword match | Query an exact rare term | Correct chunk in top 3 |
| TC-RAG-005 | FR-RAG-004 | P | Meaning match | Query a paraphrase | Correct chunk in top 3 |
| TC-RAG-006 | FR-RAG-005, 007 | P | Attached KB | Attach KB → run agent | Sources listed in envelope |
| TC-RAG-007 | FR-RAG-006 | P | Retrieval node | Query → Retrieval → Agent | Chunks passed with scores |
| TC-RAG-008 | FR-RAG-009 | P | Remove document | Delete doc → query its content | Not returned |
| TC-RAG-009 | FR-RAG-010 | P | Summary cache | Run twice with same large input | One summary call only |
| TC-RAG-010 | FR-RAG-004 | P | Quality check | Run labelled question set | Hit rate meets agreed target |
| TC-MEM-001 | FR-MEM-002, 003 | P | Memory carry-over | Agent saves a fact → next run | Fact in next envelope |
| TC-MEM-002 | FR-MEM-004 | P | Clear memory | Clear → next run | No memory injected |

#### Skills and Custom Nodes (SKL, CUS)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-SKL-001 | FR-SKL-001, 002 | P | Attach skill | Create skill → attach | Listed on node |
| TC-SKL-002 | FR-SKL-003 | P | Deterministic prompt | Build prompt twice | Identical |
| TC-SKL-003 | FR-SKL-002 | P | Detach skill | Detach → run | Skill text absent |
| TC-CUS-001 | FR-CUS-001 | P | HTTP custom node | Register test server manifest | In palette |
| TC-CUS-002 | FR-CUS-003 | N | Invalid manifest | Omit outputs | Error names field |
| TC-CUS-003 | FR-CUS-004 | P | Mixed workflow | Agent → Custom → Agent | Run COMPLETE |
| TC-CUS-004 | FR-CUS-005 | N | Script timeout | Script sleeps past limit | Stopped; node Failed with timeout |
| TC-CUS-005 | FR-CUS-005 | N | Folder escape | Script reads outside allowed folder | Access denied |
| TC-CUS-006 | FR-CUS-006 | N | Unapproved permissions | Run before approving | Blocked with prompt |
| TC-CUS-007 | FR-CUS-007 | P | Test with sample | Test button | Output shown |

#### Workspace and Code (GIT)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-GIT-001 | FR-GIT-002 | P | Auto commit | Node writes a file | Commit with run/node/iteration |
| TC-GIT-002 | FR-GIT-004 | N | Edit during run | Try editing while run active | Editor read-only; write API refused |
| TC-GIT-003 | FR-GIT-005 | P | Diff | Compare two commits | Changes shown |
| TC-GIT-004 | FR-GIT-007 | P | Replay | Replay past run | Same inputs and file state |
| TC-GIT-005 | FR-GIT-008 | N | Path traversal | Request `../../secret` | Refused |

#### ACE Bench (BEN)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-BEN-001 | FR-BEN-002 | N | Frozen task edit | Freeze → edit | Refused |
| TC-BEN-002 | FR-BEN-003 | P | Experiment plan | 2 tasks × 3 arms × 3 reps | 18 runs planned |
| TC-BEN-003 | FR-BEN-004 | P | Metrics captured | Complete experiment | All fields on every run |
| TC-BEN-004 | FR-BEN-005 | P | Blind export | Export | No arm names or IDs linking to arms |
| TC-BEN-005 | FR-BEN-006 | P | Score import | Import scores | Linked to correct runs |
| TC-BEN-006 | FR-BEN-007 | N | Rules locked | Edit rules after start | Refused |
| TC-BEN-007 | FR-BEN-008 | P | Separation | Open normal run history | No bench runs |

#### Desktop and Onboarding (DSK, ONB)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-DSK-001 | FR-DSK-001 | P | Install on each OS | Install on Windows, macOS, Linux | Launches |
| TC-DSK-002 | FR-DSK-002 | P | Engine auto-start | Launch app | Canvas ready, no manual step |
| TC-DSK-003 | FR-DSK-003 | P | Secret migration | Web keys → first desktop launch | Providers still connected |
| TC-DSK-004 | FR-DSK-005 | P | Auto-update | Publish newer version | Installed on restart |
| TC-DSK-005 | FR-DSK-006 | P | Feature parity | Run full end-to-end suite in desktop | All pass |
| TC-ONB-001 | FR-ONB-001 | P | First-run flow | Fresh install | User finishes a run through the wizard |
| TC-ONB-002 | FR-ONB-002 | P | Templates | Run each template on mock | All COMPLETE |

#### Prompt Management (PRM)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-PRM-001 | FR-PRM-001 | P | Deterministic assembly | Build same node prompt twice | Identical text and section order |
| TC-PRM-002 | FR-PRM-002 | P | Untrusted labelling | Run with retrieved chunk | Chunk inside untrusted block |
| TC-PRM-003 | FR-PRM-003 | N | Unknown placeholder | Use `{{foo.bar}}` → Validate | Validation issue |
| TC-PRM-004 | FR-PRM-004 | P | Version recorded | Edit prompt → run | Node run shows new version |
| TC-PRM-005 | FR-PRM-005 | P | View sent prompt | Open "View prompt" | Exact prompt, secrets redacted |
| TC-PRM-006 | FR-PRM-006 | P | Prompt library | Save prompt → insert in another workflow | Inserted text matches |

#### Guardrails (GRD)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-GRD-001 | FR-GRD-001 | P | Policy lifecycle | Create → edit → test policy | New version; test verdicts returned |
| TC-GRD-002 | FR-GRD-002 | P | Agent override | Project warns on PII, agent blocks | Agent blocks |
| TC-GRD-003 | FR-GRD-003 | N | Injection input | Input "ignore previous instructions…" | Warned or blocked per policy |
| TC-GRD-004 | FR-GRD-003 | N | PII input | Input with phone and email | Detected; action applied |
| TC-GRD-005 | FR-GRD-004 | N | Poisoned document | KB doc contains hidden instruction to reveal system prompt | Agent doesn't comply; content tagged untrusted |
| TC-GRD-006 | FR-GRD-005 | N | Path escape | Tool call writes `../../x` | Blocked |
| TC-GRD-007 | FR-GRD-005 | N | Domain not allowed | HTTP tool to non-listed domain | Blocked |
| TC-GRD-008 | FR-GRD-006, 013 | P | Approval approve | Agent requests delete → approve | Node Waiting then continues; decision logged |
| TC-GRD-009 | FR-GRD-013 | N | Approval reject | Same → reject | Node GUARDRAIL_VIOLATION |
| TC-GRD-010 | FR-GRD-007 | N | Secret leak | Mock output contains fake API key | Blocked or redacted |
| TC-GRD-011 | FR-GRD-007 | N | Missing citations | Policy requires citations; output has none | Check fails with reason |
| TC-GRD-012 | FR-GRD-008 | E | Budget exceeded | Run cap $0.01; expensive node | Run HALTED, reason budget_exceeded |
| TC-GRD-013 | FR-GRD-009 | E | Repeated output | Loop agent returns same output 3× | Loop stopped |
| TC-GRD-014 | FR-GRD-009 | E | Tool-call limit | Limit 5; model keeps calling tools | Stops at 5 |
| TC-GRD-015 | FR-GRD-010 | N | Cannot disable data guardrails | Try to turn off secret redaction | Option unavailable / refused |
| TC-GRD-016 | FR-GRD-011 | P | All actions | Configure pass/warn/redact/ask/block on test inputs | Each behaves as configured |
| TC-GRD-017 | FR-GRD-012 | P | Distinct failure | Trigger block | Reason GUARDRAIL_VIOLATION, not CONTRACT_VIOLATION |
| TC-GRD-018 | FR-GRD-014 | P | Redaction record | Redact email | Inspector shows type only |
| TC-GRD-019 | FR-GRD-015 | P | Verdicts visible | Run with warnings | Verdict list in inspector |
| TC-GRD-020 | FR-GRD-016 | P | Guardrail node branching | Guardrail node with pass/block edges | Correct branch taken for each input |
| TC-GRD-021 | FR-GRD-017 | P | Offline moderation | Ollama with classifier running, network off | Moderation verdicts produced |
| TC-GRD-022 | FR-CHAT-008 | N | Chat guardrail | Blocked input in direct chat | Refused with reason |

#### Model Router (RTR)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-RTR-001 | FR-RTR-001 | P | Default policy | Add agent | Policy Fixed |
| TC-RTR-002 | FR-RTR-002 | P | Fallback | Primary mock returns 503 | Secondary answers |
| TC-RTR-003 | FR-RTR-002 | N | All down | All models fail | Node fails, provider error |
| TC-RTR-004 | FR-RTR-006 | P | Used model shown | After fallback | Node and inspector show secondary |
| TC-RTR-005 | FR-RTR-007 | N | Bench routing | Bench arm with Fallback policy | Refused |
| TC-RTR-006 | FR-RTR-003–005 | P | Smart policies | Capability/cost/latency with fixtures | Expected model chosen each time |

#### Tools (TOOL)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-TOOL-001 | FR-TOOL-001 | P | Registry | Open tools list | All tools with permissions |
| TC-TOOL-002 | FR-TOOL-002 | N | Disabled tool | Model calls a tool not enabled | Refused |
| TC-TOOL-003 | FR-TOOL-003 | P | Multi-step tools | Search → fetch → answer | Final answer after 2 calls |
| TC-TOOL-004 | FR-TOOL-004 | N | Sandbox timeout | Code with infinite loop | Killed at timeout |
| TC-TOOL-005 | FR-TOOL-004 | N | Sandbox escape | Code reads `/etc` or home folder | Denied |
| TC-TOOL-006 | FR-TOOL-005 | P | Web search | Search query | Results with URLs |
| TC-TOOL-007 | FR-TOOL-006 | P | Allowed HTTP | Call allow-listed test server | Response returned |
| TC-TOOL-008 | FR-TOOL-007 | P | MCP server | Connect local MCP test server | Its tools callable |
| TC-TOOL-009 | FR-TOOL-008 | N | File tool outside project | Write to parent folder | Refused |
| TC-TOOL-010 | FR-TOOL-009 | P | Tool call log | Run with tools | Calls listed, secrets redacted |
| TC-TOOL-011 | FR-TOOL-010 | P | Untrusted result | Inspect prompt after tool call | Result inside untrusted block |

#### Observability and Usage (OBS)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-OBS-001 | FR-OBS-001 | P | Trace view | Run with tools and guardrails | Trace shows all in order |
| TC-OBS-002 | FR-OBS-002 | P | Cost totals | Run 3 nodes | Run total = sum of nodes |
| TC-OBS-003 | FR-OBS-003 | P | Price table versioning | Change price table → view old run | Old estimate unchanged |
| TC-OBS-004 | FR-OBS-004 | P | Usage screen | Several runs across providers | Breakdown matches data |
| TC-OBS-005 | FR-OBS-005 | P | Langfuse export | Enable, run | Trace appears in Langfuse |
| TC-OBS-006 | FR-OBS-006 | N | Sentry off by default | Trigger error with default settings | No outbound report |

#### Configuration and Data (SYS additions)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-SYS-011 | FR-SYS-010 | N | Bad config file | Start engine with invalid config | Refuses to start; clear message |
| TC-SYS-012 | FR-SYS-010 | P | Precedence | Timeout set at project and node | Node value used |
| TC-SYS-013 | FR-SYS-011 | P | Log rotation | Simulate 15 days of logs | Oldest removed |
| TC-SYS-014 | FR-SYS-012 | P | Backup and restore | Export → fresh install → restore | Same projects, runs, settings |

#### CLI, SDK and Mobile (CLI, MOB)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-CLI-001 | FR-CLI-002 | P | CLI run success | `ace run` on valid workflow | Streams; exit code 0 |
| TC-CLI-002 | FR-CLI-002 | N | CLI run halted | Workflow that fails | Non-zero exit code |
| TC-CLI-003 | FR-CLI-004 | P | Export/import round trip | Export → import | Identical graph |
| TC-CLI-004 | FR-CLI-006 | P | SDK example | Run SDK example script | Workflow completes |
| TC-CLI-005 | FR-CLI-007 | P | OpenAPI | Validate generated document | Valid; matches routes |
| TC-MOB-001 | FR-MOB-001 | P | Phone layout | Open run detail at 380 px | Usable, no horizontal scroll |
| TC-MOB-002 | FR-MOB-002 | P | Mobile approval | Approve on phone layout | Node continues |

#### Hosted, Hosted Models, Fine-Tuning (post-v1)

| TC ID | FR | Type | Title | Steps | Expected result |
|---|---|---|---|---|---|
| TC-HOST-001 | FR-HOST-001 | P | Sign up and log in | Email and OAuth sign-up | Account created; logged in |
| TC-HOST-002 | FR-HOST-003 | N | Viewer edit | Viewer edits a workflow | 403 |
| TC-HOST-003 | FR-HOST-005 | N | Revoked API key | Revoke → call API | 401 |
| TC-HOST-004 | FR-HOST-006 | N | Rate limit | Exceed request limit | 429 with retry time |
| TC-HOST-005 | FR-HOST-007, 008 | P | Metering and billing | Runs → usage → test purchase | Usage correct; plan upgraded |
| TC-HOST-006 | FR-HOST-009 | E | Plan limit | Exceed plan | Run HALTED, plan_limit |
| TC-HOST-007 | FR-HOST-010 | N | Cross-tenant access | Workspace A requests B's run ID | 404/403 |
| TC-HOST-008 | FR-HOST-011 | P | Idempotency | Same key twice | One run created |
| TC-HOST-009 | FR-HOST-012 | P | Audit log | Rotate key, change policy | Both entries present |
| TC-HOST-010 | FR-HOST-014 | P | Local → hosted move | Export local → import hosted | Items present; keys required |
| TC-HMOD-001 | FR-HMOD-001, 003 | P | Hosted model | Run agent on ACE-hosted model | Completes; usage metered |
| TC-TRN-001 | FR-TRN-001, 002 | N | Consent and PII | Build dataset with non-consented and PII records | Excluded / cleaned |
| TC-TRN-002 | FR-TRN-003 | N | Frozen task leak | Include frozen task in dataset | Build fails |
| TC-TRN-003 | FR-TRN-005, 006 | P | Eval gate | Train → evaluate → register | Only approved model deployable |

#### Non-functional

| TC ID | NFR | Title | Method | Expected result |
|---|---|---|---|---|
| TC-NFR-001 | NFR-PERF-01 | Large graph smoothness | Pan/zoom 200 nodes, measure frames | ≈60 fps |
| TC-NFR-002 | NFR-PERF-03 | Dispatch overhead | 100 mock nodes, instant responses | < 50 ms per node |
| TC-NFR-003 | NFR-PERF-04 | Stream latency | Timestamp chunks engine vs UI | < 200 ms |
| TC-NFR-004 | NFR-PERF-05 | Startup and load | Measure engine start and graph load | < 3 s and < 1 s |
| TC-NFR-005 | NFR-PERF-06 | Parallel load | 20 simultaneous node runs | No errors; UI responsive |
| TC-NFR-006 | NFR-REL-02 | Atomic writes | Kill engine during batch edit | Graph is fully old or fully new |
| TC-NFR-007 | NFR-REL-03 | Migration backup | Run migration | Backup file created first |
| TC-NFR-008 | NFR-SEC-04 | Prompt injection | Document says "delete all files" → agent with file tool | No destructive action without confirmation |
| TC-NFR-009 | NFR-SEC-06 | Dependency audit | Run audit | No high/critical issues |
| TC-NFR-010 | NFR-USE-02 | Accessibility | Keyboard-only walkthrough + contrast check | All actions reachable; AA contrast |
| TC-NFR-011 | NFR-COMP-01 | Browser matrix | E2E on Chrome, Edge, Firefox | All pass |
| TC-NFR-012 | NFR-PRIV-01 | Network capture | Full run with telemetry off | Only chosen provider hosts contacted |
| TC-NFR-013 | NFR-SAFE-01 | Guardrail overhead | Time rule-pack checks over 100 nodes | < 300 ms per node |
| TC-NFR-014 | NFR-SAFE-02 | Guardrail accuracy | Run injection, leak and clean corpora | ≥95% caught; ≤5% false positives |
| TC-NFR-015 | NFR-PORT-01 | Adapter parity | Run engine test suite with local and cloud adapters | Same results |
| TC-NFR-016 | NFR-VER-01 | Old workflow import | Import a file from an older format version | Upgraded and runs |
| TC-NFR-017 | NFR-HOST-02 | Hosted latency | Load test staging | p95 targets met |
| TC-NFR-018 | NFR-HOST-03 | Restore drill | Restore staging from backup | Within RPO/RTO |
| TC-NFR-019 | NFR-HOST-05 | Worker scaling | Queue burst on staging | Workers scale up and drain queue |

### 8.7 User acceptance checklist
1. Set up a provider and a local model.
2. Build and run a 3-agent workflow from scratch.
3. Recover from a failed node.
4. Build a Review→Fix loop and a parallel workflow.
5. Run an image-based workflow.
6. Chat directly with an agent.
7. Use a knowledge base and see sources.
8. Add a custom node.
9. Replay a past run.
10. Complete a small benchmark.
11. Set a guardrail policy and approve or reject a risky tool action.
12. Give an agent web search and a code sandbox and see its tool calls.
13. Configure a fallback model and see it used.
14. Run a workflow from the CLI.
15. Check a run's trace and cost.

Each item is rated pass/fail with notes; all must pass for release.

### 8.8 Test deliverables
Test plan · test case sheet (this section) · automated suites in CI · defect log · performance report · security review report · UAT sign-off · final test summary report.

---

## 9. Traceability Matrix

| Module | Requirements | Spec § | Arch § | Phase | Test cases |
|---|---|---|---|---|---|
| SYS | FR-SYS-001–012 | §33, §34 | §11, §22, §29 | 2 | TC-SYS-001–014 |
| PRJ | FR-PRJ-001–004 | §36 | §12.2 | 2 | TC-PRJ-001–004 |
| WF | FR-WF-001–008 | §36, §42 | §12.2, §32 | 2–3 | TC-WF-001–008 |
| CAN | FR-CAN-001–013 | §2, §31, §32, §42, §43, §45 | §10.1 | 3 | TC-CAN-001–010 |
| NODE | FR-NODE-001–013 | §4, §10, §17, §18, §38 | §10.1, §12.7 | 3 | TC-NODE-001–010 |
| CON | FR-CON-001–007 | §5, §19, §23 | §12.3 | 3, 7 | TC-CON-001–007 |
| PRV | FR-PRV-001–010 | §9, §13, §14, §15, §34 | §14.1, §14.2 | 4 | TC-PRV-001–010 |
| MOD | FR-MOD-001–006 | §10, §11, §16 | §14.4 | 4 | TC-MOD-001–004 |
| RTR | FR-RTR-001–007 | §11 | §14.3 | 4 | TC-RTR-001–006 |
| EXE | FR-EXE-001–015 | §6, §7, §19, §20, §21, §31 | §12.3, §12.4, §19, §21.1 | 5 | TC-EXE-001–014 |
| PRM | FR-PRM-001–007 | §4, §17 | §12.5 | 5, 11 | TC-PRM-001–006 |
| CTL | FR-CTL-001–006 | §20, §28 | §19.2 | 6 | TC-CTL-001–006 |
| ERR | FR-ERR-001–008 | §29, §30 | §28 | 6 | TC-ERR-001–009 |
| GRD | FR-GRD-001–018 | §29, §46 (safety) | §13, §21.2, §22 | 6, 10, 11, 15 | TC-GRD-001–022 |
| PAR | FR-PAR-001–007 | §22, §23, §24, §25 | §12.3 | 7 | TC-PAR-001–008 |
| MM | FR-MM-001–009 | §3, §18, §37 | §15, §16 | 8 | TC-MM-001–009 |
| CHAT | FR-CHAT-001–008 | §7, §26, §27 | §12.2, §20.3 | 9 | TC-CHAT-001–007, TC-GRD-022 |
| RAG | FR-RAG-001–010 | §4, §17 | §12.6, §21.3 | 10 | TC-RAG-001–010 |
| MEM | FR-MEM-001–004 | §4, §17 | §12.8 | 10 | TC-MEM-001–002 |
| SKL | FR-SKL-001–004 | §35 | §12.2 | 11 | TC-SKL-001–003 |
| CUS | FR-CUS-001–007 | §12, §38 | §16 | 11 | TC-CUS-001–007 |
| TOOL | FR-TOOL-001–010 | §4, §35, §38 | §12.7, §16 | 8, 11, 12 | TC-TOOL-001–011 |
| GIT | FR-GIT-001–008 | §33, §36, §42 | §15, §16 | 12 | TC-GIT-001–005 |
| BEN | FR-BEN-001–008 | §39 | §12.2, §17 | 13 | TC-BEN-001–007 |
| OBS | FR-OBS-001–007 | §39 (metrics) | §26, §27 | 5, 15 | TC-OBS-001–006 |
| DSK | FR-DSK-001–006 | §33 | §10.2, §18.1 | 16 | TC-DSK-001–005 |
| ONB | FR-ONB-001–003 | §44 | §33 | 17 | TC-ONB-001–002 |
| CLI | FR-CLI-001–007 | §38 (extensible) | §10.4, §10.5, §20 | 17 | TC-CLI-001–005 |
| MOB | FR-MOB-001–004 | §26, §28 | §10.3 | 17, 21 | TC-MOB-001–002 |
| HOST | FR-HOST-001–015 | — (post-v1) | §11, §23, §25 | 18 | TC-HOST-001–010 |
| HMOD | FR-HMOD-001–003 | §13 | §14 | 19 | TC-HMOD-001 |
| TRN | FR-TRN-001–007 | §39 | §17 | 20 | TC-TRN-001–003 |
| NFR | NFR-* | §31, §43, §46 | §4, §24–§26 | 14–15, 18 | TC-NFR-001–019 |

Not covered by design (exclusion): §40 ACE self-improvement.

### Architecture coverage (8-layer reference)

| Layer | FRS modules |
|---|---|
| 1. Client (web, mobile, CLI, SDK) | CAN, NODE, CHAT, DSK, ONB, CLI, MOB |
| 2. API Gateway (auth, rate limiting, metering) | SYS, HOST, OBS |
| 3. Orchestration (prompts, RAG, agents, tools, memory, guardrails) | WF, CON, EXE, CTL, ERR, PAR, PRM, RAG, MEM, SKL, CUS, GRD, BEN |
| 4. Model serving (providers, router) | PRV, MOD, RTR, HMOD |
| 5. Data (DB, vectors, cache, objects) | PRJ, MM, RAG, GIT, SYS |
| 6. Tools (sandbox, search, parsers, APIs) | TOOL, MM, RAG, CUS |
| 7. Training | TRN |
| 8. Infra + Ops | OBS, DSK, HOST, NFR |

---

## 10. Phase List

| Phase | Name | Main FRS modules |
|---|---|---|
| 0 | Foundations | — (decisions, repo) |
| 1 | Contracts + DB | Schemas for all modules |
| 2 | Engine skeleton | SYS, PRJ, WF |
| 3 | Canvas | CAN, NODE, CON |
| 4 | Providers + router | PRV, MOD, RTR |
| 5 | Execution engine | EXE, PRM, OBS (basic) |
| 6 | Control + errors + guardrails | CTL, ERR, GRD (input, output, cost, loop, approvals) |
| 7 | Parallel + loops | PAR |
| 8 | Multimodal | MM, TOOL (media) |
| 9 | Chat + communication | CHAT |
| 10 | Context & RAG | RAG, MEM, GRD (context) |
| 11 | Skills, custom nodes, tools | SKL, CUS, TOOL, GRD (tool, Guardrail node), PRM (library) |
| 12 | Workspace + code | GIT, TOOL (file, git) |
| 13 | ACE Bench | BEN |
| 14 | Testing & QA | All test cases |
| 15 | Hardening | GRD (classifier), OBS, NFR |
| 16 | Desktop | DSK |
| 17 | Launch | ONB, CLI, MOB (responsive) |
| 18 | Hosted platform (post-v1) | HOST |
| 19 | Hosted models (post-v1, optional) | HMOD |
| 20 | Fine-tuning (post-v1, optional) | TRN |
| 21 | Mobile app (post-v1, optional) | MOB-004 |

---

## 11. Open Issues

| ID | Issue | Recommended | Needed by |
|---|---|---|---|
| OI-01 | CLI provider quotas and whether CLI routes are in v1 | Optional in v1 | Phase 4 |
| OI-02 | Exact retrieval quality target (hit rate@k) | Set after pilot | Phase 10 |
| OI-03 | Script custom nodes in v1 or HTTP-only | Both, scripts sandboxed | Phase 11 |
| OI-04 | Third benchmark arm and win/partial/loss rules | Write before freezing tasks | Phase 13 |
| OI-05 | Code signing certificates for Windows and macOS | Buy before packaging | Phase 16 |
| OI-06 | Transform node operation list | Template, JSON extract, join | Phase 3 |
| OI-07 (D9) | Add `GUARDRAIL_VIOLATION` failure reason | Yes | Phase 1 |
| OI-08 (D10) | Default guardrail strictness | Warn on content; block secrets and tool abuse | Phase 6 |
| OI-09 (D11) | Hosted authentication provider | Self-hosted library | Phase 18 |
| OI-10 (D12) | Router policies in v1 | Fixed + Fallback | Phase 4 |
| OI-11 (D13) | Local code sandbox | Child process; Docker when available | Phase 11 |
| OI-12 (D14) | Default web search | SearXNG | Phase 11 |
| OI-13 (D15) | When hosted mode starts | After v1 launch feedback | Phase 17 |
| OI-14 (D16) | MCP tools in v1 | Yes (Should) | Phase 11 |
| OI-15 (D17) | Hosted retention by plan | 30 / 90 / 365 days | Phase 18 |
| OI-16 | Guardrail accuracy targets (NFR-SAFE-02) confirmed on real corpora | Validate in Phase 14 | Phase 14 |
