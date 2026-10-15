# Chat

The **Chat** column talks to one node of the workflow. Select an Agent node on the Canvas, or pick
one at the top of the column, and type in **Message this agent**. **Chat** in the header (or
**Ctrl+Alt+B**) shows and hides the column, in Ideate and Forge.

The column has two tabs. **Node chat** is your direct conversation with the node. **Run** shows the
selected run's team conversation, read-only.

## Message actions

Hover a message to see its actions. Each one appears only where it applies.

- **Copy** copies the message's text.
- **Retry**, on a reply or on a message that failed, asks again.
- **Edit & resend**, on your own message, opens it in a box. **Enter** or **Send edited message**
  sends it, **Shift+Enter** breaks a line, **Escape** or **Cancel** leaves it as it was. If the
  turns it replaces changed files, **Also revert the file changes of the turns this replaces**
  undoes those too.
- **Delete** hides a message from the chat and from every later prompt. ACE still keeps it in the
  run's event log.

Retry and Edit & resend add a new turn. The turns they replaced fold into one **Earlier version**
row; open it to see them, dimmed. They are never sent to the model again, and only **Copy** and
**Delete** work on them.

## While a reply comes in

- **Stop**, in place of Send, ends the reply that is streaming.
- If the node says nothing for longer than its time limit, a **No answer** card appears. Its
  **Retry** reads the conversation again and asks again if the answer is not there.
- Under each reply, its tokens and cost. A model with no price says **cost unknown**.

## Approvals in chat

When the node wants to use a tool that needs your say, the chat shows "_node_ wants to run a tool
· approval needed", with what it is about to do, and the turn waits. **Approve** lets it run;
**Reject** refuses it. The rules are the same as in a run ([Guardrails](guardrails.md)).

## Undo for file changes

In a project with a folder, a chat turn may change your files, and ACE records those changes so you
can revert them ([Forge](forge.md#changes-and-checkpoints)). If it cannot record them, the turn
stops before its first write with **Can't record changes for undo** and the reason. **Run without
undo** goes ahead for this turn only; **Cancel** stops it.

## In Domain

Domain shows the run's conversation, not a chat of its own. There you can **Copy** a message,
**Retry** a node, and resend a post that failed.

See also: [Modes](modes.md), [Building a workflow](building-a-workflow.md).
