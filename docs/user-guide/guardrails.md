# Guardrails

Guardrails check what flows through a run. They are on by default: a new project warns on content
issues and blocks secret leaks and tool abuse.

## Where checks happen

- **Input:** what goes into a node.
- **Output:** a node's answer, before it flows downstream.
- **Cost:** spend, before and after each node; a block halts the run.
- **Loop:** each iteration of a loop edge; the same output three times stops it.
- **Tool:** every tool call, before it runs. A destructive call always asks.
- **Context:** retrieved and remembered text, which is always treated as untrusted.

Data guardrails (secrets, file access) are always on and cannot be turned off.

## Actions

Each check ends in one action: **pass**, **warn**, **redact**, **ask user** or **block**. "Ask
user" pauses the node and shows an approval card; approve to continue, or reject to fail the node
with `GUARDRAIL_VIOLATION`. The top bar counts the approvals waiting for you.

## Policies

Open **Guardrail policies** (the shield icon in the top bar, `/guardrails`) to create a policy,
choose the checks at each point and their actions, and try it in **Test this policy** before you
use it. A project has a default policy; an Agent node can use a different one from its config.

## Budgets

Set a daily budget under **Settings** and a per-run cap on the project. A run that would go over
halts with the reason `budget_exceeded`.

See also: [Building a workflow](building-a-workflow.md), [Tools](tools.md).
