# Forge: the code editor

Inside a workflow, the switch at the top flips between **Ideate** (the canvas) and **Forge** (the
code editor on the project folder). **Ctrl+Shift+1** and **Ctrl+Shift+2** do the same
(**⌘⇧1** / **⌘⇧2** on a Mac). The chat stays on the right in both, and nothing is lost when you switch.

## The layout

- **Left:** the Explorer — the project's folder tree, its file count, and a filter at the bottom.
  Changed files carry git's letters (**M**odified, **A**dded, **U**ntracked) and their folders are
  tinted; an orange dot marks unsaved changes; an orange **±** marks a file an agent changed that
  waits for your review; ignored folders such as `node_modules` are dimmed. The switch at the top,
  **EXPLORER · SEARCH · CHANGES**, turns the column into [Search](#search) or
  [Changes](#changes-and-checkpoints). **Ctrl+B** shows or hides it.
- **Centre:** the editor, under its tabs and the file's path. A single click previews a file
  (italic tab); a double click, or an edit, keeps it.
- **Bottom:** the Terminal and Problems, as two tabs. **Ctrl+J** shows or hides the panel on the
  tab you used last (Problems the first time), and remembers it. **Ctrl+`** shows the Terminal, or
  hides it when it is showing. The footer's error and warning counts open Problems, and its
  **▶ running** count the Terminal. Warnings about saves and conflicts appear as notices.
- **Footer:** where the cursor is, then the open file's indentation, encoding, line endings and
  language.
- **Right:** the chat. **Ctrl+Alt+B**, or **Chat** in the header, shows or hides it.

## Files

- **New file / folder:** the buttons at the top of the Explorer, or right-click. Type the name and press Enter.
- **Rename:** select it and press **F2**.
- **Move:** drag it onto a folder, or onto a file to move it into that file's folder.
- **Delete:** select it and press **Delete**. In this version a delete cannot be undone.
- A rename, move or delete is refused while a file inside it is still saving; try again once the save finishes.
- **Go to a file:** **Ctrl+P**, then type a few letters of its name.

## Search

**Ctrl+Shift+F** (**⌘⇧F** on a Mac), or **SEARCH** at the top of the left column, opens Search with
the cursor in its box. Results come as you type.

- The three buttons in the box: **Aa** matches upper and lower case exactly, **ab** matches whole
  words only, **.\*** reads what you typed as a regular expression.
- **files to include** and **files to exclude** take patterns separated by commas, written as in a
  `.gitignore`: `src`, `*.ts`, `docs, *.md`.
- Results are grouped by file, with a count for each. Click a line to open the file there. The top
  says how many results in how many files; Search stops at 2,000 and says it shows the first 2,000.
- It searches what the Explorer shows, minus binary files and files over 2 MB: never
  `node_modules`, `.git` or anything your `.gitignore` leaves out.
- While Search is showing, its results follow changes to the files, at most every 2 seconds.
- A regular expression that does not work is explained under the box, and nothing is searched. So
  is one that repeats a group that itself repeats, such as `(a+)+`, which can take very long. A
  regular-expression search stops after 5 seconds and shows what it found by then ("Search stopped
  after 5 s; showing partial results").

## Saving, and files that change underneath you

**Ctrl+S** saves, **Ctrl+Alt+S** saves everything. A dot on a tab means unsaved changes.

If a file changes on disk — an agent wrote it, or another editor — while it is open:

- with no unsaved changes, Forge simply shows the new text;
- with unsaved changes, a bar appears: **Compare** (yours against the disk), **Take theirs**, or
  **Keep mine** (your next save wins). Forge never overwrites a change it has not shown you.

If a file is deleted on disk while it is open, a bar says so. With no unsaved changes it offers
**Save** (puts the file back) and **Close**. With unsaved changes it offers **Keep mine** (your next
save puts the file back) and **Discard and close**. Closing unsaved text always asks first.

Closing a tab with unsaved changes asks first, and so does closing or reloading the browser tab.

## Formatting

**Format** at the end of the file's path bar, **Shift+Alt+F** (**⇧⌥F**), or right-click →
**Format Document** formats the open file. It works for TypeScript, JavaScript, JSON, CSS, SCSS,
Less and HTML; for other files the button is greyed out.

With **Format on save** turned on, on the project page next to **Check command**, each save first
formats the file in the editor you are working in. **Ctrl+Alt+S** (save everything) formats only
that one and saves the others as they are. A file Forge cannot format is saved unchanged.

## Types across files

In TypeScript and JavaScript, the editor knows the project's other source files, not only the open
one: hovers, completions and the open file's errors take into account what your other files
export. Forge reads the project's `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs`
files (never from `node_modules` or anything `.gitignore` leaves out) when you open the project in
Forge, and follows them as they change. `baseUrl` and `paths` in the project's root
`tsconfig.json` are honoured. Problems still lists only the files you have open.

## The terminal

**Ctrl+`** opens the Terminal, the first tab of the bottom panel, and closes it again; so do the
footer's **▶ running** count and **Terminal** in an empty editor. On a Mac the hint reads **⌘`**,
which macOS keeps for switching windows; press **Ctrl+`** there, which works too. Type a command and press **Enter**: it runs in the project folder through your
system's shell (`cmd.exe` on Windows, `/bin/sh` elsewhere), and its output streams in, colours
and links included.

- **While it runs**, what you type goes to it: answer its prompt and press **Enter**. **Ctrl+C**
  copies when text is selected; otherwise it stops what runs, and everything it started.
- **Pasting several lines** runs the first. Each line after it goes to what is running, as its
  input; once nothing runs (after a `cd`, or a command that has already ended), the next line runs
  as a command. To run commands one after another, chain them on one line with `&&`.
- **`cd src`** moves the tab into a folder of the project, and the prompt says where you are.
  `cd ..` stops at the project folder; `cd` alone prints where you are. **`cls`** or **`clear`**
  clears the tab.
- **↑ / ↓** bring back earlier commands. **Ctrl+F** finds text in the tab.
- **Several tabs:** **+**, after the last tab, opens another; double-click a tab to rename it.
  Closing a tab whose command still runs asks before it stops it.
- **Scripts:** the **▶** buttons at the end of the tab row run the project's `package.json` scripts,
  each in its own tab, with the package manager the project uses (pnpm, yarn, bun or npm).
- **Processes**, beside the terminal, lists what runs, with **Stop**, and what ran, with how it
  ended. A command started from another browser tab shows there too; **Show** opens it in a tab.
- **Agents' commands** show in Processes as well, marked **agent**: every command a node runs with
  Shell commands, in the foreground or the background, with its output. They are read-only here —
  no Stop, no typing into them; stopping the run stops them. They do not count toward the 8 below.
  An agent's command is not confined to the project folder: it runs as you and can reach anything
  you can, which is why each one asks before it runs.
- Up to 8 commands run at once in a project. A tab keeps the last 1 MB of output.

Each project chooses how far it trusts its terminal, on the project page under **Terminal** (in
Ideate, the **…** menu next to the project name → **Project page**):

- **On — any command:** what you type, and the scripts.
- **Scripts only:** only the project's own `package.json` scripts.
- **Off:** nothing runs, and turning it off stops what runs.

With **Scripts only** or **Off**, the Terminal says so above its tabs, with a link to that setting.

Commands get your environment minus every variable whose **name** contains KEY, TOKEN, SECRET,
PASSWORD, PASSWD, CREDENTIAL, SESSION, AUTH or COOKIE, anywhere in the name and in any case (so
`ANTHROPIC_API_KEY` and `GITHUB_TOKEN` never reach them). Other names are passed through, even
when they hold a secret: `DB_PASS`, `GH_PAT` and `MYSQL_PWD` do reach your commands, as do `PATH`,
`HOME` and your ssh agent. Values are never inspected: a password inside a value, such as
`DATABASE_URL=postgres://user:pass@…`, reaches your commands too. Agents never use the terminal.

## Run checks

Name the project's **Check command** on the project page, under **Terminal**: `pnpm tsc --noEmit`,
say, or `pnpm lint`. Then **Run checks**, in the header of Problems, or **Ctrl+Shift+B**
(**⌘⇧B**), runs it in the project folder and lists what it found in Problems, under **Checks**.

- It runs like a terminal command, as **Checks** in the Terminal's Processes list. One run at a
  time per project; a new run replaces the last one's results, and **Clear** removes them.
- With the terminal on **Scripts only**, name one of the project's `package.json` scripts
  (`typecheck`, or `pnpm run typecheck`). With it **Off**, Run checks is off too. A command that is
  exactly a script's name always runs as that script.
- Problems reads what `tsc` and `eslint` (its usual "stylish" output) print, and the common
  `file:line:column: message` and `file:line: message` forms. Each row names the tool, opens its
  file at its line, and has **Fix with agent**. The footer's error and warning counts include
  them; an error an open file's live check also shows counts once.
- The **Checks** header says when it ran, how long it took and how it exited. A clean run says
  "No problems found by" and the command. A run that failed without a line Problems can read says
  "Checks failed (exit N); no problems recognised in the output", with **Show output** to see it in
  the Terminal.
- With no check command, the button reads **Set a check command** and takes you to the project
  page.

## Chat in the project

When the project has a folder, the chat works in it: the node you talk to can read and change the
project's files, from Ideate as from Forge. Without a folder, the chat answers as before and
changes nothing.

- **A coding-agent CLI node** (Claude Code, Codex, Gemini) works in the folder with its own tools.
  Its provider's **Permission** decides what it may do: **Read-only** or **Edit project files**
  ([CLI agents](providers.md#cli-agents)). A checkpoint can undo its changes to files, not what a
  command did. A turn gets at least 10 minutes, as in a run.
- **An API model** (an Agent or a Model node) can list, read, write and edit the project's files
  and look at `git status` and `git diff`: nothing that deletes, and never a command. It does so
  only when its model can call tools, at most the Agent's **Max tool calls** per turn (10 for a
  Model node). What a tool returns is checked before the model reads it, as in a run: hidden
  instructions are removed and personal data redacted under the node's guardrail policy.
- **What it did:** under the reply, "What it did: 2 edits, 1 read" opens to the files it read,
  wrote or edited and the commands it ran (a command's first line, cut before anything it writes
  to a file). ACE keeps the names, never what the files say.
- **Every turn in a folder is checkpointed**, and a reply that changed files carries a
  [Changes card](#changes-and-checkpoints).
- **One at a time:** in one project, these turns wait for each other. The waiting one shows
  "… is typing" and starts from the conversation as it is then, so it sees the reply it waited for.

**Asking another node.** Type `@` in the message box to pick a node of the workflow, for example
`@reviewer check what Coder did`. The line under the box says who the message goes **to**. That
node answers inside the same conversation, sees who said what, and its reply shows its name and
avatar. The conversation does not switch: your next message without an `@` goes back to the node
you were talking to.

- One message goes to one node. `@all` or two different nodes is explained under the box, and
  Send waits until you fix it; so is a handle no node has, when it is the message's first word.
  Anywhere else an unknown `@word` is plain text, and so is an `@` in code, in quotes, or in
  `@scope/package` and `@Decorator(…)`.
- Only an `@handle` counts; a node's plain name is just a word. The handles are the ones Domain
  uses: a node's own, or one made from its name, and `@brain` for the Brain.

## Ask agent and Fix with agent

- **Ask agent:** select code in the editor and press **Ctrl+L** (**⌘L**), or right-click →
  **Ask agent**. The chat opens with a reference such as `src/app.ts:L3-L7` in its message box,
  carrying the lines you selected; add your question and send. With nothing selected, the
  reference is the whole file.
- **Ask Agent About This File**, when you right-click a file in the Explorer, adds the file's name
  only; an agent working in the folder reads the file itself.
- **Fix with agent**, on every row in Problems (the open files' errors and Run checks' results
  alike), sends the node the chat is talking to "Fix this problem:", the message and the tool that
  reported it, with the file's lines around the problem (five either side). If the chat has no
  node of this workflow selected, the message and the reference wait in the message box until
  you pick one.

## Changes and checkpoints

Whenever an agent may change your files — a chat turn in a project with a folder, or a run — ACE
takes a private snapshot of the folder first, and another when the agent stops. What changed in
between is a **checkpoint**, waiting for your review. The snapshots live in ACE's own data folder,
never in your project's `.git`: your branches, staging area and stash are not touched.

- **One checkpoint per writing step.** In a run, each step of a node that can change files (one
  with Write files or Shell commands on, or a coding-agent CLI allowed to edit) is a checkpoint of
  its own, so you can keep one node's work and revert another's. Those steps take turns within a
  run, so each checkpoint holds only its own node's changes. A run whose nodes only read is one
  checkpoint, as before.
- **CHANGES**, at the top of the left column, lists the checkpoints, those still open first. Each
  says where it came from (**Chat with** the node, **Run** and the end of the run's id, or **Run**
  and the node whose step it was), when,
  its state (**Recording…** while the agent works, **To review**, **Kept**, **Reverted**, **Partly
  reverted**, or **Not revertible**), and each file it changed, with the lines added and removed.
  Click a file's orange **±** in the Explorer to open Changes on its checkpoint. A run's
  checkpoint links back to the run (**open the run at this node**), and the run's page lists its
  checkpoints under **Changes to the project**, each with **Review in Forge**.
- **In the chat**, a reply that changed files shows the same list as a card, with **Review**,
  **Keep all** and **Revert all**. Review opens Forge when you are in Ideate or Domain.
- **Review:** click a file's name. A read-only tab, "_file_ (agent change)", shows the file before
  the agent on the left and after it on the right, with **Keep** and **Revert** for that file. A
  binary file, or one over 2 MB, has no text to compare.
- **Keep** accepts a change. **Revert** puts the file back as it was before the agent: its old
  text, deleted again if the agent created it, recreated if the agent deleted it. **Keep all** and
  **Revert all** do every file still waiting. Revert all asks first, naming how many files it
  reverts and which ones it will delete.
- **A file changed since the agent's edit** is never overwritten: Revert says "_file_ changed after
  the agent's edit; review it before reverting" and leaves it. The other files are still reverted.
- **The agent hears about it.** After you revert files from a chat's checkpoint, that chat's next
  turn starts with a note naming them, so the agent does not build on a change you undid.
- **Files you changed in Forge while the agent worked** (saved, created, moved or deleted) are
  listed as **yours** and are not reverted here.
- **Files a snapshot left out** (see the limits below) are not reviewed. One left out on one side
  only — a file over 5 MB the agent shrank, say — is listed as **not captured** and can't be
  reverted. Revert deletes a file only when the snapshots prove the agent created it.
- A turn or run that changed nothing leaves no checkpoint.
- If a snapshot cannot be taken (git is missing, say), the agent still works, and the checkpoint
  says its changes can't be reverted, and why. If ACE stops while a checkpoint is recording, that
  one can't be reverted either: what changed meanwhile can't be told apart from your own work.

## Keys the browser keeps

The browser keeps **Ctrl+W**, **Ctrl+T**, **Ctrl+N**, **Ctrl+Tab** and **Ctrl+1…9** for itself, so
Forge uses **Alt+W** to close an editor tab, and **Ctrl+P** lists your open files first.

## Limits in this version

### Editor and terminal

- Text files up to 2 MB open for editing; binary files show a notice, images a preview.
- IntelliSense covers TypeScript, JavaScript, CSS, HTML and JSON; other languages get
  highlighting. Only TypeScript and JavaScript see across files
  ([Types across files](#types-across-files)).
- On a phone, Forge is browse-only.
- The terminal is line-based: full-screen programs (vim, top, some installers' menus) do not
  render. Prompts that read a line work.
- A tab keeps its `cd`, but nothing else carries from one command to the next (`set`, `export`, an
  activated virtualenv). Chain them on one line instead: `venv\Scripts\activate && python app.py`.
- Processes live in the engine's memory. When the engine shuts down normally, it stops every
  command first. If the engine exits abruptly instead (a crash, Task Manager, or `pnpm dev`
  restarting it after an edit), the tab says the engine restarted and the process may still be
  running: what the command started (a dev server, say) can live on and keep its port. If a port is
  still in use, stop it from the system's task manager.
- There is no end-of-input key (Ctrl+D): a program that reads until its input ends (`sort` or
  `cat` with no file) waits until you stop it with Ctrl+C.
- Background jobs are not tracked: something a command leaves running after it ends (`cmd &`,
  `start /b`) is not in Processes, and Stop cannot reach it. Run servers in a tab's foreground.
- On Windows, `cmd`'s own commands (`echo`, `dir`, `type`) may show accented and other non-ASCII
  characters as `�`. Programs such as node, python, git and npm display them correctly. A fix is
  planned.

### Checkpoints

- Checkpoints need git installed on your computer (on the `PATH`). Without it the agents still
  work, but every checkpoint says its changes can't be reverted.
- A snapshot leaves out files over 5 MB; everything a `.gitignore` in the project ignores, as the
  `.gitignore` files stood when the agent started; the folders Forge always dims (`node_modules`,
  `.ace`, `dist`, `build`, `.next`, `__pycache__` and `.venv`, at any depth); and links, which it
  never follows. The Changes view and card say so. What an agent does to those files is not
  reviewed and can't be reverted.
- A project of more than 200,000 files gets no checkpoints: each one says the project is too large.
- A git repository inside the project is snapshotted as plain files: its files are covered, its own
  `.git` is not.
- While a checkpoint records, a command you run in Forge's own terminal counts as yours: whatever
  changes while it runs, and for about two seconds after it ends, is listed as **yours** and never
  reverted. That holds for everything changed in that time, an agent's edits included, so a
  long-running command (a dev server, a watcher) makes the agents' changes meanwhile yours too.
  ACE sees these changes through Forge's file watcher, so they count as yours only while Forge is
  open on the project.
- An edit made outside Forge altogether (another editor, a terminal outside ACE) still counts as
  the agent's while a checkpoint records. It is listed in the checkpoint, and Revert can undo it.
- Saves in Forge and agents' file edits take turns on the same file: a save never lands between an
  agent's check that it has seen the file and its write.
- For about the first second of a checkpoint, while ACE takes the first snapshot, even a file you
  save in Forge can count as the agent's.
- A Domain run that stays open records a checkpoint for each writing turn of a node; a turn that
  only reads records none.
- Chat turns in a project wait for each other, but runs do not wait for chat turns: a run and a chat
  turn writing in the same project at once can mix their changes in each other's checkpoints.
- A renamed file shows as one file deleted and another added.
- Review shows the agent's change (the file before and after the agent), not the file as it is now.
- The two snapshots add about 2 seconds to each chat turn, each writing node step of a run, and
  each run that only reads, in a folder on Windows, even when nothing changes. Writing steps of one
  run wait for each other, so a run with several writing nodes in parallel takes longer than it
  did.
- Old checkpoints are never cleaned up: the store in ACE's data folder (`~/.ace/checkpoints`
  unless `ACE_DATA_DIR` says otherwise) only grows, and deleting a project does not remove its
  store.

### Chat

- A turn waiting for another one shows only "… is typing", not that it waits.
- The note that tells the agent which files you reverted waits in memory for the chat's next turn:
  if ACE restarts first, the agent is not told.
- On a phone, the chat shows no Changes card; review the changes in Forge.

### Search, checks, formatting and types

- The 5-second limit on a regular-expression search includes finding the files to search, so in a
  very large project it covers fewer of them.
- **files to include** and **files to exclude** follow `.gitignore` patterns, not VS Code's: `src`
  matches every folder named `src`, anywhere.
- Run checks reads only `tsc`, `eslint` in its "stylish" format, and the generic
  `file:line:column` and `file:line` forms. It reads only the last 1 MB of the command's output, and
  a path printed relative to a sub-folder (a tool run inside one package of a monorepo) does not
  open.
- Format on save formats only the file in the active editor; saving everything leaves the others as
  they are.
- Types across files stop at 1,500 files and 2 MB of source in all, shallowest folders first.
  `tsconfig.json` is read for `baseUrl` and `paths` only, and its `extends` is not followed. A
  JavaScript file sees only the project's JavaScript files.
