# Providers and models

A **provider** is a place models come from. Open **Providers** (`/providers`) to add, test and
remove them. The second tab is the **model catalogue**, filterable by provider, input type, output
type and availability.

## The free local route

You do not need to pay for anything to use ACE.

- **Mock** needs no key and no network. It returns made-up but predictable answers, so every
  template runs to completion on it. The first-run wizard adds it in one click.
- **Ollama** runs open models on your own machine. When Ollama answers on its default address
  (`http://127.0.0.1:11434`), ACE detects it and offers **Add Ollama**; nothing is added until you
  click. Local models have no price table, so their runs cost `$0`.
- **LM Studio** and other servers that speak the OpenAI API can be added as an
  **OpenAI-compatible** provider with their base URL.

## Cloud providers

Anthropic, Google and OpenAI need an API key. Type it once when you add the provider. The key is
kept in your operating system's keychain; ACE never shows it again, and the API only reports whether
a key is set. To change it, rotate the key from the provider's row.

## Status

Each provider shows one state: `UNKNOWN`, `CHECKING`, `CONNECTED`, `AUTH_FAILED`, `UNREACHABLE` or
`RATE_LIMITED`. **Test** checks it again. The top bar shows the same states while you work.

## Using a model

Select an Agent node on the Canvas and choose its provider and model in the config panel. A model
that cannot handle the node's data types is refused before the run starts, at pre-flight.

See also: [Troubleshooting](troubleshooting.md).
