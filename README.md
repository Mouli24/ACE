# ACE

ACE is a multimodal AI agent orchestration platform: you build workflows by placing agent nodes on a
Canvas and drawing typed connections between them, and a run executes across cloud, local and
custom models with guardrails, budgets and approvals on by default.

This repository is **Round 1**: the engine skeleton and the web shell with the Canvas. **No model is
called yet** — providers, the model catalog and the run engine arrive in Round 2. What works today:
projects, workflows (tabs, rename, duplicate, delete, export/import), the dark dotted Canvas with six
node kinds, typed ports, typed connections that refuse incompatible types and plain cycles, the
config panel, autosave with conflict handling, and a validation tab.

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

Then: **New project** → **New workflow** → drag _Input_, _Agent_ and _Output_ from the palette →
connect _Input → Agent → Output_ by dragging from an output port to an input port → click the agent
to fill in name, instructions and data types. Every edit is saved as you go; reload and the graph
is exactly where you left it.

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

The web app can run against an in-memory mock engine (MSW) that implements the Round 1 API:

```sh
VITE_ACE_MOCK=1 pnpm dev:web
```

Mock state lives in `localStorage`, so two tabs act as two clients of the same engine. Add
`?fixture=200` to the URL to open a generated 200-node / 400-edge workflow.

## Layout

```
apps/server        local engine entry point (ace-engine)
apps/web           React/Vite SPA — Canvas, config panel, projects, workflows
packages/contracts the shared contract: every Zod schema, enum and API/WS type
packages/engine    orchestration core
packages/sdk       @ace/sdk — typed REST client and resuming WebSocket client
packages/ui        design tokens (dark dotted Canvas, provider accents, status rings) and components
docs/              PRD, FRS, architecture, decision log, defect log, team prompts
```

See `CLAUDE.md` for the team process, `docs/ACE-FRS.md` for requirements and `docs/DECISIONS.md`
for every decision made along the way.
