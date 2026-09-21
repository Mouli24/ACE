# Product Requirements Document (PRD)

## Product Goal
Create a visual, multimodal AI orchestration workspace where users build workflows by connecting agents on a Canvas, run them across any mix of cloud, local and custom models, and get safe, inspectable, reproducible results — first as a local web/desktop app, later as a hosted service.

## Feature Priorities
| Feature | Priority |
|---|---|
| Project and workflow management | Must |
| Visual Canvas (add, move, select, delete, duplicate, pan, zoom) | Must |
| Agent node configuration | Must |
| Typed connections with automatic handoff | Must |
| Provider management (cloud, local, custom endpoints) | Must |
| Dynamic model catalog | Must |
| Model router (fixed + fallback) | Must |
| Workflow execution with live streaming | Must |
| Envelope contracts and output validation | Must |
| Run controls (pause, resume, stop, restart, re-run node) | Must |
| Error handling and retry | Must |
| Guardrails (input, context, tool, output, cost, loop, data) | Must |
| Human approval for risky actions | Must |
| Parallel branches and merge node | Must |
| Multimodal files and outputs | Must |
| Agent chat and workflow timeline | Must |
| Prompt management and prompt inspection | Must |
| Run history and trace view | Must |
| Token and cost tracking | Must |
| Local security (token, origin check, secret storage) | Must |
| Workflow loops (loop edges) | Should |
| Knowledge bases and RAG | Should |
| Retrieval node | Should |
| Agent memory | Should |
| Skills | Should |
| Custom nodes (HTTP and script) | Should |
| Tools (code sandbox, web search, HTTP, MCP) | Should |
| Guardrail node on Canvas | Should |
| Git workspace, code panel and replay | Should |
| ACE Bench | Should |
| Desktop app with auto-update | Should |
| Onboarding and templates | Should |
| CLI and TypeScript SDK | Should |
| Mobile-friendly monitoring and approvals | Should |
| Undo/redo and auto-layout | Should |
| Workflow import/export | Should |
| Langfuse trace export | Should |
| Capability, cost and latency routing | Could |
| CLI model providers (Claude Code, Codex, Gemini CLI) | Could |
| Copy/paste nodes between workflows | Could |
| Hosted platform (accounts, teams, billing, rate limits) | Later |
| ACE-hosted open models (vLLM/TGI) | Later |
| Fine-tuning (LoRA/QLoRA + model registry) | Later |
| Native mobile app | Later |
| ACE self-improvement | Won't (this version) |

## User Stories

### US-001
As a builder, I want to create a project and workflows so that I can organize my AI systems.

**Acceptance criteria**
- Project is created with a name and folder; Git is initialized.
- Multiple workflows open as tabs.
- Every edit saves automatically.

### US-002
As a builder, I want to add agent nodes to the Canvas so that I can design my AI system visually.

**Acceptance criteria**
- Nodes can be added by click or drag from the palette.
- Nodes can be moved, selected (single, multi, box), duplicated and deleted.
- Positions persist after reload.

### US-003
As a builder, I want to navigate the Canvas smoothly so that large workflows stay manageable.

**Acceptance criteria**
- Pan, zoom, fit-to-view and minimap work with mouse and trackpad.
- Canvas stays smooth with 200 nodes.
- Canvas never appears half-loaded.

### US-004
As a builder, I want to configure an agent from its node so that I control what it does.

**Acceptance criteria**
- Name, model, routing policy, instructions, input/output types, tools, skills, context, memory, guardrail policy and execution settings are editable.
- Invalid settings are shown inline and block running.
- The selected model is visible on the node.

### US-005
As a builder, I want to connect nodes with arrows so that outputs flow automatically to the next agent.

**Acceptance criteria**
- Dragging from an output to an input creates a connection.
- Incompatible data types and unintended cycles are refused with a reason.
- No manual copy-paste is needed between agents.

### US-006
As a builder, I want to add cloud, local and custom model providers so that I'm not locked to one vendor.

**Acceptance criteria**
- Anthropic, Google, OpenAI, Ollama, LM Studio and OpenAI-compatible endpoints can be added.
- Test connection reports connected, auth failed, unreachable or rate limited.
- API keys are stored in secure storage and never shown back.

### US-007
As a builder, I want the model list to update automatically so that I only choose models that exist and fit.

**Acceptance criteria**
- Models are discovered where supported, otherwise loaded from a manifest.
- Each model shows capabilities, data types and availability.
- Unavailable or incompatible models are flagged before a run.

### US-008
As a builder, I want a fallback model so that a provider outage doesn't stop my workflow.

**Acceptance criteria**
- Default routing is Fixed.
- Fallback tries the next model on provider or network failure.
- The model actually used is shown on the node.

### US-009
As an operator, I want to run a workflow and watch it live so that I understand what's happening.

**Acceptance criteria**
- Pre-flight checks run before any model call.
- Node states and streamed text update in real time.
- Arrows animate when data moves.

### US-010
As an operator, I want every handoff validated so that bad outputs don't silently spread.

**Acceptance criteria**
- Outputs are checked against the downstream contract.
- Invalid outputs fail as `CONTRACT_VIOLATION`.
- Context passed between nodes stays within the token budget.

### US-011
As an operator, I want to pause, resume, stop and restart runs so that I stay in control.

**Acceptance criteria**
- Pause stops new nodes from starting.
- Stop cancels in-flight calls within 2 seconds and ends the run as `HALTED`.
- Restart creates a new run with the same inputs.

### US-012
As an operator, I want clear errors and one-click retry so that I don't rebuild workflows after failures.

**Acceptance criteria**
- Errors show node, type, message, provider and a Retry button.
- Network and rate-limit errors retry automatically with backoff; auth errors don't.
- Downstream nodes of a failed node show `BLOCKED`.

### US-013
As an operator, I want to re-run a single node so that I can fix one step without repeating the whole run.

**Acceptance criteria**
- Only the selected node executes, using the latest upstream outputs.
- The new attempt is recorded separately.

### US-014
As a builder, I want parallel branches and a merge node so that agents can work at the same time.

**Acceptance criteria**
- Independent branches run concurrently within provider limits.
- Merge waits for all inputs or the first, as configured.

### US-015
As a builder, I want review-and-fix loops so that agents can improve their work iteratively.

**Acceptance criteria**
- Loop edges require a maximum iteration count and an exit condition.
- Each iteration is recorded and viewable.
- The loop never exceeds its maximum.

### US-016
As a builder, I want agents to work with images, audio, video, code and files so that workflows aren't text-only.

**Acceptance criteria**
- Files are validated for type and size on upload.
- Files move between nodes as references.
- Outputs render by type and can be downloaded.

### US-017
As an operator, I want safety checks on inputs and outputs so that harmful or leaked content doesn't pass through.

**Acceptance criteria**
- Prompt injection, PII, blocked topics and secret leaks are detected.
- Each check can pass, warn, redact, ask the user or block.
- Blocks fail the node as `GUARDRAIL_VIOLATION`.

### US-018
As an operator, I want to approve risky actions so that agents never delete or overwrite things without me.

**Acceptance criteria**
- Destructive tool calls put the node in `WAITING`.
- An approval card appears on desktop and mobile.
- Approve continues; reject fails the node; the decision is logged.

### US-019
As an operator, I want spending limits so that loops and large runs don't surprise me with costs.

**Acceptance criteria**
- Per-node token limits, per-run cost caps and daily budgets can be set.
- Exceeding a cap stops the run with a clear reason.

### US-020
As a builder, I want to place a guardrail as a node so that safety is visible in my workflow.

**Acceptance criteria**
- Guardrail node outputs sanitized data and a verdict.
- Connections can branch on pass or block.

### US-021
As an operator, I want a timeline of messages and events so that I can follow agent communication.

**Acceptance criteria**
- User messages, agent messages, outputs, events, errors and system events look different.
- Timeline can be filtered by run, node and type.

### US-022
As an operator, I want to chat directly with one agent so that I can question or test it.

**Acceptance criteria**
- Chat uses the agent's model, instructions, context and guardrails.
- Replies stream.
- Chat never changes past run records.

### US-023
As a builder, I want to see and version the exact prompt each agent receives so that behaviour is explainable.

**Acceptance criteria**
- Prompts are assembled in a fixed, documented order.
- Untrusted content is clearly labelled.
- Each node run shows the prompt version and the full prompt sent (secrets redacted).

### US-024
As a builder, I want to give agents my documents so that they answer from the right information.

**Acceptance criteria**
- PDF, DOCX, Markdown, text, code and HTML can be added to a knowledge base.
- Ingestion progress and failures are shown.
- Retrieved sources are listed for every node run.

### US-025
As a builder, I want a Retrieval node so that document search is visible on the Canvas.

**Acceptance criteria**
- The node returns chunks with text, score and source.
- Its output connects to any agent.

### US-026
As a builder, I want agents to remember useful facts across runs so that they improve over time.

**Acceptance criteria**
- Memory can be enabled per agent.
- Saved entries appear in the next run's context.
- Entries can be viewed, deleted or cleared.

### US-027
As an extender, I want reusable skills so that I don't rewrite the same instructions for every agent.

**Acceptance criteria**
- Skills have name, description, instructions and tools.
- Skills can be attached to and detached from agents.

### US-028
As an extender, I want to add my own agents as custom nodes so that they work alongside built-in agents.

**Acceptance criteria**
- HTTP and script custom nodes can be registered through a manifest.
- Permissions must be approved before first use.
- Script nodes run with time, memory and folder limits.

### US-029
As a builder, I want agents to use tools so that they can search, run code and call APIs.

**Acceptance criteria**
- Tools are enabled per agent with declared permissions.
- Code runs in a sandbox; HTTP calls respect a domain allow-list.
- MCP servers can be connected and their tools used.
- Every tool call is logged and its result treated as untrusted.

### US-030
As a builder, I want files my workflow creates to be versioned so that I can compare and replay.

**Acceptance criteria**
- A Git commit is made after each node that changes files.
- Diffs between versions are viewable.
- Files can't be edited while a run is active.

### US-031
As a builder, I want to replay a past run so that I can reproduce results.

**Acceptance criteria**
- Replay uses the recorded snapshot, envelopes and commit.
- Missing data produces a clear error.

### US-032
As an operator, I want a trace and cost view for every run so that I can debug and control spend.

**Acceptance criteria**
- Trace shows node runs, tool calls and guardrail verdicts in order.
- Tokens and cost are shown per node, run, workflow and day.

### US-033
As an evaluator, I want governed benchmarks so that I can prove whether orchestration beats simpler setups.

**Acceptance criteria**
- Tasks can be frozen and then never edited.
- Experiments define arms and repetitions; routing is fixed.
- Outputs can be exported blind; scores imported; the report applies rules written before the run.

### US-034
As a new user, I want guided setup and templates so that I get a working run quickly.

**Acceptance criteria**
- First launch walks through adding a provider and choosing a template.
- Templates include linear chain, Review→Fix, parallel research and RAG Q&A.

### US-035
As a user, I want a desktop app so that ACE runs like a normal installed program.

**Acceptance criteria**
- Installers work on Windows, macOS and Linux.
- The engine starts automatically; existing data and keys carry over.
- The app updates itself.

### US-036
As an automator, I want a CLI and SDK so that I can run workflows from scripts and CI.

**Acceptance criteria**
- `ace run` streams progress and returns exit code 0 on success, non-zero otherwise.
- The TypeScript SDK is generated from the same contracts as the API.

### US-037
As an operator, I want to check runs and approve actions from my phone so that I'm not tied to my desk.

**Acceptance criteria**
- Run views, outputs, chat and approvals work at phone width.
- The Canvas is read-only on mobile.

### US-038
As a user, I want my data to stay private and safe so that I can trust ACE with my work.

**Acceptance criteria**
- The local engine accepts only local, authenticated requests from the ACE UI.
- Secrets never appear in the database, logs or exports.
- Only chosen providers are contacted; telemetry is opt-in.

### US-039 (Later)
As a workspace admin, I want accounts, teams, roles and billing so that my team can use ACE in the cloud.

**Acceptance criteria**
- Sign-up, login, roles (owner, editor, viewer) and API keys work.
- Usage is metered and billed; plan limits stop runs with a reason.
- Workspaces never see each other's data.

### US-040 (Later)
As a builder, I want to fine-tune small models from my graded results so that specialised roles get better.

**Acceptance criteria**
- Only consented, PII-free data is used; frozen benchmark tasks are excluded.
- Trained models must beat their baseline on ACE Bench before deployment.

## Product States

**Run states**
`PREFLIGHT → RUNNING ⇄ PAUSED → COMPLETE`

Failure / ending states: `BLOCKED` (pre-flight failed), `HALTED` (stopped, budget exceeded or unrecoverable failure).

**Node states**
`IDLE → READY → RUNNING → (WAITING) → COMPLETED`

Other states: `PAUSED`, `STOPPED`, `BLOCKED`, `FAILED`.

**Failure reasons** (never merged)
`RUN_FAILED` · `CONTRACT_VIOLATION` · `GUARDRAIL_VIOLATION` · `BLOCKED`

**Provider states**
`UNKNOWN → CHECKING → CONNECTED`

Failure states: `AUTH_FAILED`, `UNREACHABLE`, `RATE_LIMITED`.

## Product Principles
- Canvas first: every major action happens on the Canvas.
- The engine owns the truth; the UI only shows it.
- Envelopes, not history: agents receive only bounded, validated context.
- Provider agnostic: cloud, local and custom models side by side.
- Multimodal first: text is one data type among many.
- User controlled: no hidden agents, models or connections.
- Safe by default: guardrails, budgets and approvals are on unless relaxed.
- Untrusted by default: retrieved content and tool results never act as instructions.
- Every run is traceable and reproducible.
- Measure before claiming: benchmarks are frozen, blind and pre-registered.
