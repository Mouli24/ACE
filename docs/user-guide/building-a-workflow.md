# Building a workflow

A **project** holds workflows. A **workflow** is a graph of nodes on the Canvas, shown as a tab in
the top bar.

## The Canvas

- **Left:** the palette. Drag a node kind onto the Canvas, or click it to add one.
- **Centre:** the workflow.
- **Right:** **Configure** for the selected node, and **Inspector** for what its last run did.
- **Bottom:** Validation, Events, Errors and Timeline.

Every edit is saved as you make it. If another tab changed the same workflow first, ACE loads the
latest version and applies your edit again.

## Nodes and connections

Each node has typed ports: `text`, `image`, `audio`, `video`, `code`, `json` or `file`. Drag from an
output port to an input port to connect two nodes. A connection between types that do not match, or
one that makes a plain cycle, is refused with a reason. To repeat a step on purpose, draw a **loop
edge** and give it a maximum number of iterations and an exit condition.

An Agent node's config covers its name, instructions, provider and model, input and output types,
tools, knowledge bases, memory and guardrail policy.

## Running

Press **Start** in the top bar. If an Input node has nothing to send yet, ACE asks for the text
first. Before any model is called, **pre-flight** checks the graph; a problem stops the run as
`BLOCKED` and lists the issues.

While the run is going, each node shows its state and streams its text, and the edges light up as
data moves. **Pause**, **Resume**, **Stop** and **Restart** sit next to Start. A run ends `COMPLETE`
when every Output node has finished, or `HALTED` when it is stopped, goes over its budget or fails.

Select a node and open **Inspector** to see the envelope it was given, its output, model, tokens,
cost and any error, and **View prompt** for the exact text that was sent. A failed node can be
retried without rebuilding the graph. Every run is kept under the **Runs** tab.

See also: [Guardrails](guardrails.md), [Tools](tools.md).
