# Providers and models

A **provider** is a place models come from. Open **Providers** (`/providers`) to add, test and
remove them. The second tab is the **model catalogue**, filterable by provider, input type, output
type and availability.

## How providers are grouped

The Providers page and every provider picker list providers in the same sections:

- **Cloud APIs:** Anthropic, Google and OpenAI.
- **Local & open models:** Ollama, LM Studio and other servers on your own machine or network.
- **CLI agents:** Claude Code, Codex and Gemini, run through their own command-line tools.
- **Custom endpoints:** any other server that speaks the OpenAI API.
- **Test providers:** the built-in Mock.

## The free local route

You do not need to pay for anything to use ACE.

- **Mock** needs no key and no network. It returns made-up but predictable answers, so every
  template runs to completion on it. The first-run wizard adds it in one click.
- **Ollama** runs open models on your own machine. When Ollama answers on its default address
  (`http://127.0.0.1:11434`), ACE detects it and offers **Add Ollama**; nothing is added until you
  click.
- **LM Studio** and other servers that speak the OpenAI API can be added with their base URL; one
  on your machine or local network lands under **Local & open models**.

Under **Local & open models**, each runtime lists the models it has on this machine, with their
size and whether they can call tools and answer in JSON, for example `4.7 GB · tools · JSON`. They
read **Free · runs on your machine**, and their runs cost `$0`. A runtime with no model yet shows
the command to get one, such as `ollama pull llama3.2`; run it in a terminal, then refresh the
provider's models.

## Cloud providers

Anthropic, Google and OpenAI need an API key. Type it once when you add the provider. The key is
kept in your operating system's keychain; ACE never shows it again, and the API only reports whether
a key is set. To change it, rotate the key from the provider's row.

A remote model ACE has no price for shows its cost as **unknown** (`?` in an estimate), never `$0`,
so a run on it is not mistaken for a free one.

## CLI agents

A CLI agent's **Permission** says what it may do in your project: **Read-only** or **Edit project
files**. There is no setting that lets it skip ACE's approvals, budgets and guardrails; a provider
that had one before is moved to **Edit project files**, and ACE says so once.

## Status

Each provider shows one state: `UNKNOWN`, `CHECKING`, `CONNECTED`, `AUTH_FAILED`, `UNREACHABLE` or
`RATE_LIMITED`. **Test** checks it again. The top bar shows the same states while you work.

## Using a model

ACE asks for a provider and a model whenever you add an Agent or a Model node
([Adding a node](building-a-workflow.md#adding-a-node-provider-first)). To change them later, open
the node's settings. A model that cannot handle the node's data types is refused before the run
starts, at pre-flight.

See also: [Troubleshooting](troubleshooting.md).
