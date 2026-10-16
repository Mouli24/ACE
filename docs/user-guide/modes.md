# Modes: Ideate, Forge and Domain

A workflow has three modes, switched at the top of the header:

- **Ideate** (**Ctrl+Shift+1**): the Canvas, where you build the graph and watch it run.
- **Forge** (**Ctrl+Shift+2**): the code editor over the project's folder ([Forge](forge.md)).
- **Domain** (**Ctrl+Shift+3**): the run as a conversation between its agents.

On a Mac, use **⌘** for Ctrl.

## One workflow, one run

All three modes show the same workflow and the same **selected run**. Switching mode keeps both, and
the node you had selected, so you can watch a run on the Canvas, open Forge to see the files it
wrote, and read its conversation in Domain without losing your place. The run is part of the
address (`?run=` followed by its id), so a link or a reload opens the same run.

## The header in every mode

- **Run**, **Pause** (or **Resume**), **Stop** and **Restart** sit in the header in every mode, and
  act on the selected run. Stop asks first. **Restart** starts the run again and selects the new
  one in the mode you are in.
- An approval a run is waiting for can be answered in any mode: on the Canvas, in Forge, or in
  Domain.
- **Chat**, in Ideate and Forge, shows or hides the chat column. **Team**, in Domain, shows or
  hides the Team panel. Each remembers its own setting; **Ctrl+Alt+B** toggles the one for the mode
  you are in. See [Chat](chat.md).

## Following a node

- **From Domain to the Canvas:** **Show on canvas** on a message, or on an agent in the Team panel,
  opens Ideate with that node selected and centred, in the same run.
- **From the Canvas to Domain:** a card's **⋯ More → Open in Domain**, or right-click → **Open in
  Domain**.
- **In Forge:** a file an agent wrote names that agent in the path bar. Click its name to see it on
  the Canvas, or **Domain** beside it to open its conversation. While you follow a node, a bar
  above the editor says which files it wrote in this run, with **Show on canvas** and **Open in
  Domain**.

## Getting to a mode

Every place that opens a workflow offers all three modes: the project cards on the start page,
the project page, the first-run wizard, a run's page (**open the Canvas**, **Open in Forge**, **Open in
Domain**, each with that run selected), and the timeline.

See also: [Building a workflow](building-a-workflow.md), [Replay and compare](replay-and-compare.md).
