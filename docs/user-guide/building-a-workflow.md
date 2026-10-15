# Building a workflow

A **project** holds workflows. A **workflow** is a graph of nodes on the Canvas, shown as a tab in
the top bar.

## The Canvas

- **Left:** the palette. Drag a node kind onto the Canvas, or click it to add one.
- **Centre:** the workflow. **+ Add node**, at its edge, adds an Agent after the last one.
- **Right:** **Inspector**, for what the selected node's last run did.
- **Bottom:** **Problems & events**, in the footer, opens Validation, Events, Errors and Timeline.

Every edit is saved as you make it. If another tab changed the same workflow first, ACE loads the
latest version and applies your edit again.

## Adding a node: provider first

An Agent or a Model node needs a provider and a model before it can run, so ACE asks for them
first. **Add node**, dropping one from the palette, and **Duplicate** all open **Choose a provider
and model**. Pick a provider, then a model, and press **Add node** (or **Duplicate**). **Cancel**
adds nothing.

- A node pasted or imported from somewhere else keeps its provider. If that provider does not
  exist here, the card turns red and shows **Choose a provider**; click it to pick one.
- Pre-flight refuses to start a run while a node has no provider, with the issue
  `missing_provider`: "_name_ has no provider chosen yet — choose a provider and a model".
- A template asks once, and every node in it uses that provider.

## Nodes and connections

Each node has typed ports: `text`, `image`, `audio`, `video`, `code`, `json` or `file`. A port's
dot is coloured by its type and shows when you hover a card, on the selected card, and on every
port that fits while you draw a line.

- **Drag** from an output port to an input port. While you drag, the ports that fit stay bright
  and the ones that do not dim; hover a dim port to see why (another type, an input already taken,
  or a plain cycle).
- **Drop the line on a card** rather than a port, and ACE connects it to the first input that fits.
  When several fit, **Connect to which input?** lets you choose.
- **⋯ More → Connect to…** does the same without dragging, for a trackpad or a touch screen: pick
  the node the output goes to, then the input if there is a choice.
- **With the keyboard:** Tab to an output port and press **Enter**, then Tab to an input port and
  press **Enter** again.

A connection that cannot work is refused with a reason. To repeat a step on purpose, draw a
**loop edge** and give it a maximum number of iterations and an exit condition.

Every card has two buttons at its top right. **⚙ Settings** opens the node's settings; so does a
plain click on the card (dragging a card only moves it). **⋯ More** holds **Open in Domain**,
**Connect to…**, **Duplicate**, **Run from here** and **Delete**.

An Agent node's settings cover its name, instructions, provider and model, input and output types,
tools, knowledge bases, memory, guardrail policy and its own cost cap. A JSON schema in the output
contract means the output will be JSON and checked against it.

## What a node reads

The **Reads** section, at the end of a node's settings, shows what it will be handed before any
run: which nodes and ports feed it, how its context budget is split, and the output contract it is
held to. A node with nothing upstream says it starts the run. Nodes never pass a whole chat history
to each other; each gets an **envelope** with just these reads and a bounded context.

## Cost before you run

ACE estimates what a run could cost before it starts.

- Each Agent and Model card shows its own estimate, such as `≈ $0.002–0.01`. A local model shows
  `free`; a model with no price shows `?`, and hovering says why (no model chosen, a model not in the
  catalogue, or no price for this model).
- The **Run** button shows the workflow's estimate, and hovering it adds what your budget leaves. If
  the run could cost more than is left, ACE asks before it starts.
- **Max cost per run of this node (USD)**, in a node's settings, caps that node alone. Over it,
  the node fails with a budget reason. Leave it blank for no cap.

## Running

Press **Run** in the header. It is there in Ideate, Forge and Domain, with **Pause** (or
**Resume**), **Stop** and **Restart** beside it ([Modes](modes.md)). If an Input node has nothing to
send yet, ACE asks for the text first. Before any model is called, **pre-flight** checks the graph;
a problem stops the run as `BLOCKED` and lists the issues.

While the run is going, each card shows its state as a word, a glyph and a colour of its own, so
`FAILED`, `BLOCKED`, `PAUSED`, `WAITING` and the rest never look alike. Cards stream their text,
and edges light up as data moves. A run ends `COMPLETE` when every Output node has finished, or
`HALTED` when it is stopped, goes over its budget or fails.

Select a node and open **Inspector** to see what its last run did. **Inputs** shows each envelope
it was given: from which node, how much of its budget the reads and context used, how trusted they
were, the contract, and the reads themselves. Below are its verdicts, output, the model asked and
the model that actually answered, tokens, cost and any error. **View prompt** shows the exact text
sent. A failed node can be retried without rebuilding the graph. Every run is kept under the
**Runs** tab; to play one back or put two side by side, see [Replay and compare](replay-and-compare.md).

If a run would change your project's files but ACE cannot record those changes for undo, it stops
before the first write with **Can't record changes for undo**. **Run without undo** goes ahead this
once; **Cancel** leaves things as they are.

See also: [Chat](chat.md), [Guardrails](guardrails.md), [Tools](tools.md).
