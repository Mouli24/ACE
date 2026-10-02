# ACE

ACE is a multimodal AI agent orchestration platform: you build workflows by placing agent nodes on a
Canvas and drawing typed connections between them, and a run executes across cloud, local and
custom models with guardrails, budgets and approvals on by default.

**Nothing paid is required.** The built-in Mock provider answers every request on your machine, with
no API key and no network, and every starting template runs to completion on it. Ollama is the free
local route to real models; cloud providers (Anthropic, Google, OpenAI) are optional.

## From clone to first run

Requirements: Node.js 20 LTS or newer and pnpm 9 (`corepack enable` gives you the pinned version).

```sh
git clone <this repository> ace
cd ace
pnpm install
pnpm dev
```

`pnpm dev` starts the engine (`http://127.0.0.1:4747`) and the web app (`http://localhost:5173`)
together. The engine prints a line like

```
ACE engine ready · http://127.0.0.1:4747 · open http://localhost:5173/?token=<token>
```

Open **that URL** — the token is the session key; the web app stores it and strips it from the
address bar. Opening `http://localhost:5173` without a token shows a page telling you to use the
printed link.

A fresh install opens the **first-run wizard** (`/onboarding`):

1. **Add a provider** — click **Use the built-in Mock provider (no key, works offline)**. If Ollama
   is running locally, **Add Ollama** is offered too.
2. **Pick a template** — Linear chain, Review and fix, Parallel research or RAG Q&A.
3. **Create and run** — name the project, type the first question and press **Create project and
   run**. Nothing is created before you do. The Canvas opens and the run streams until the top bar
   reads **run complete**.

**Skip setup** goes straight to the project list. From there: **New project** → **New workflow** →
drag _Input_, _Agent_ and _Output_ from the palette → connect them by dragging from an output port
to an input port → pick the Mock provider and a model on the agent → press **Start**. Every edit is
saved as you go; reload and the graph is exactly where you left it.

The user guide is built in: the **?** icon in the top bar opens `/help/getting-started`, and the
pages live in [`docs/user-guide/`](docs/user-guide/). They are bundled into the app and work
offline.

## Scripts

| Script                             | What it does                                                           |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`                         | Engine + web together (login URL printed)                              |
| `pnpm dev:engine` / `pnpm dev:web` | One side only                                                          |
| `pnpm build`                       | Builds every package and app                                           |
| `pnpm typecheck` / `pnpm lint`     | Whole workspace                                                        |
| `pnpm test`                        | Unit, integration and component tests, mock provider only, no env vars |
| `pnpm test:e2e`                    | Playwright for the web app against in-browser mocks (no engine needed) |
| `pnpm test:acceptance`             | Cross-tests against the real engine (temp database)                    |

### Web app without the engine

The web app can run against an in-memory mock engine (MSW) that implements the engine's API:

```sh
VITE_ACE_MOCK=1 pnpm dev:web
```

Mock state lives in `localStorage`, so two tabs act as two clients of the same engine. Add
`?fixture=200` to the URL to open a generated 200-node / 400-edge workflow.

## Layout

```
apps/server        local engine entry point (ace-engine)
apps/web           React/Vite SPA — Canvas, runs, chat, knowledge, onboarding, settings
packages/contracts the shared contract: every Zod schema, enum and API/WS type
packages/engine    orchestration core
packages/sdk       @ace/sdk — typed REST client and resuming WebSocket client
packages/ui        design tokens (dark dotted Canvas, provider accents, status rings) and components
docs/              PRD, FRS, architecture, decision log, defect log, team prompts
docs/user-guide/   the user guide the app renders at /help/:page
```

See `CLAUDE.md` for the team process, `docs/ACE-FRS.md` for requirements and `docs/DECISIONS.md`
for every decision made along the way.

## Providers, models and runs (web)

The mock engine is enough to drive everything below with no keys and no network: `VITE_ACE_MOCK=1
pnpm dev:web`, or `pnpm dev` for the real engine.

- **`/providers`** — add a provider per type (the `mock` one needs nothing), Test it, rotate or
  remove its key, set its concurrency. A key is written, never read back: the API returns
  `keySet: true/false` and nothing else. The second tab is the model catalogue, filterable by
  provider, input type, output type and availability, with a per-provider refresh.
- **The Canvas** — pick a provider and model on an agent, then press **Start** in the top bar. An
  Input node with nothing to send is asked for text first. While the run is in flight each card
  shows its state ring, the text streaming in, and the model that answered; the edge an envelope
  travelled lights up; the Output node shows the final result; the top bar carries the run's status
  and its tokens and cost.
- **Inspector** (right pane, next to Configure) — for the selected node: the envelope it was given
  with its budget and trust label, its output, the model used, tokens, cost, duration, any error,
  and the prompt version with a **View prompt** drawer showing the exact text that was sent.
- **Runs** — a Runs tab per workflow, `/projects/:projectId/runs` for the project, and
  `/runs/:runId` for one run with its snapshot read-only.

- **Controls and guardrails** — Pause, Resume, Stop and Restart sit beside Start; a failed node is
  retried from its error card; guardrail policies live at `/guardrails`, and an "ask user" verdict
  shows an approval card on the run.

### Driving a scenario by hand

In mock mode the browser console can script a run, which is what the e2e suite does:

```js
window.__aceMock.setScenario("slow-stream"); // or fallback-used, contract-violation,
// preflight-blocked, all-nine-states, socket-drop
window.__aceMock.seedRunnable(); // Input → Agent → Output on the mock provider
window.__aceMock.dropSocket(); // cut the connection mid-run and watch it resume
window.__aceMock.setProviderStatus(id, "AUTH_FAILED", "key rejected");
```
