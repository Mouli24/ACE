# Troubleshooting

## "Open ACE from the engine link"

The web app has no session token. Start the engine with `pnpm dev` and open the URL it prints,
which ends in `?token=…`.

## A provider shows `AUTH_FAILED`

The key was refused. Rotate it on the [Providers](providers.md) screen and press **Test**.

## A provider shows `UNREACHABLE`

The engine could not reach it. For Ollama or LM Studio, check that the server is running and that
the base URL is right. For a cloud provider, check your network.

## A provider shows `RATE_LIMITED`

The provider asked ACE to slow down. Runs retry with backoff; lowering the provider's concurrency
also helps.

## The run is `BLOCKED`

Pre-flight found a problem before any model was called, such as a missing model, a data type the
model cannot handle, or a broken connection. The issues are listed over the Canvas; click one that
names a node to select it.

## The run is `HALTED`

It was stopped, went over its budget (`budget_exceeded`), or a node failed and could not recover.
Open that node's Inspector to read the error, fix its settings, and retry the node.

## A node is waiting and nothing happens

A guardrail asked for your approval. Look for the approval card on the run, or the count in the top
bar.

## I want to be sure nothing costs money

Use the Mock provider or Ollama. Neither sends anything off your machine, and their runs cost `$0`.

See also: [Getting started](getting-started.md).
