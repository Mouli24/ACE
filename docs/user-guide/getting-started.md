# Getting started

ACE runs on your own machine. The engine listens on `127.0.0.1:4747` and the web app on
`localhost:5173`. Nothing paid is needed to try it: the built-in **Mock** provider answers every
request offline, with no API key.

## Open ACE

1. In the repository, run `pnpm install` once, then `pnpm dev`.
2. The engine prints a line ending in `open http://localhost:5173/?token=…`. Open **that** link. The
   token is your session key; opening the app without it shows a page asking for the link.

## The first-run wizard

A brand-new install opens the wizard at `/onboarding`. It has three steps.

1. **Add a provider.** Choose **Use the built-in Mock provider** for a free, offline start. If a
   local Ollama is running, **Add Ollama** appears as well. For a cloud model, add a keyed provider
   on the [Providers](providers.md) screen and come back.
2. **Pick a template.** Linear chain, Review and fix, Parallel research or RAG Q&A. Each card shows
   the shape of its graph. Click a card, or use the arrow keys, to choose one.
   Every node of the template uses the provider you chose in step 1, so on the Mock provider the
   first run needs no key. To change a node's provider or model later, open its settings.
3. **Create the project.** Name the project and type the first question. Nothing is created until
   you press **Create project and run**. ACE then opens the Canvas and starts the run; the top bar
   shows the run's status until it reads **run complete**.

**Skip setup** closes the wizard and opens the project list. If you leave the wizard half way,
opening `/onboarding` again in the same browser tab picks up where you stopped.

## Where to go next

- [Building a workflow](building-a-workflow.md): nodes, connections, cost and runs.
- [Modes](modes.md): Ideate, Forge and Domain over one workflow and one run.
- [Chat](chat.md): talking to a node, and what you can do with each message.
- [Providers and models](providers.md): cloud, local and the Mock provider.
- [Replay and compare](replay-and-compare.md): playing a run back, comparing two, exporting one.
- [Bench](bench.md): does a workflow beat one model alone?
- [Guardrails](guardrails.md): what is checked, and approvals.
- [Knowledge bases](knowledge-bases.md): answering from your own documents.
- [Tools](tools.md): built-in tools and MCP servers.
- [Troubleshooting](troubleshooting.md): when something does not work.
