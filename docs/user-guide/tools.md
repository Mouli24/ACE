# Tools

Agents can call tools while they run. Open **Tools** (`/library/tools`) to see the registry.

## Built-in tools

ACE ships with `echo`, `code_sandbox`, `sandbox_delete`, `http_request`, `web_search` and
`web_fetch`. Code runs in a sandbox, never inside the engine itself. Web search uses the SearXNG
address set in Settings.

## Giving an agent tools

In the Agent's config, tick the tools under **Enabled tools** and set **Max tool calls**. Tools
that reach the network can be limited to **Allowed domains**.

Every call passes the tool guardrails first. A destructive call always asks you for approval, and
the approval card shows what it is about to do. Tool results come back to the agent labelled
untrusted. The Inspector's **Tool calls** tab lists each call with its arguments, result and
verdict.

## MCP servers

Under **MCP servers**, add a server by name, with the `stdio` transport (a command and its
arguments) or `http` (a URL). Its tools join the registry, prefixed with the server's name.

See also: [Guardrails](guardrails.md).
