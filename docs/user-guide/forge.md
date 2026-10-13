# Forge: the code editor

Inside a workflow, the switch at the top flips between **Ideate** (the canvas) and **Forge** (the
code editor on the project folder). **Ctrl+Shift+1** and **Ctrl+Shift+2** do the same
(**⌘⇧1** / **⌘⇧2** on a Mac). The chat stays on the right in both, and nothing is lost when you switch.

## The layout

- **Left:** the Explorer — the project's folder tree, its file count, and a filter at the bottom.
  Changed files carry git's letters (**M**odified, **A**dded, **U**ntracked) and their folders are
  tinted; an orange dot marks unsaved changes; ignored folders such as `node_modules` are dimmed.
  **Ctrl+B** shows or hides it.
- **Centre:** the editor, under its tabs and the file's path. A single click previews a file
  (italic tab); a double click, or an edit, keeps it.
- **Bottom:** the Terminal and Problems, as two tabs. **Ctrl+J** shows or hides the panel on the
  tab you used last (Problems the first time), and remembers it. **Ctrl+`** shows the Terminal, or
  hides it when it is showing. The footer's error and warning counts open Problems, and its
  **▶ running** count the Terminal. Warnings about saves and conflicts appear as notices.
- **Footer:** where the cursor is, then the open file's indentation, encoding, line endings and
  language.
- **Right:** the chat. **Ctrl+Alt+B**, or **Split** in the header, shows or hides it.

## Files

- **New file / folder:** the buttons at the top of the Explorer, or right-click. Type the name and press Enter.
- **Rename:** select it and press **F2**.
- **Move:** drag it onto a folder, or onto a file to move it into that file's folder.
- **Delete:** select it and press **Delete**. In this version a delete cannot be undone.
- A rename, move or delete is refused while a file inside it is still saving; try again once the save finishes.
- **Go to a file:** **Ctrl+P**, then type a few letters of its name.

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

## The terminal

**Ctrl+`** opens the Terminal, the first tab of the bottom panel, and closes it again; so do the
footer's **▶ running** count and **Terminal** in an empty editor. On a Mac the hint reads **⌘`**,
which macOS keeps for switching windows; press **Ctrl+`** there, which works too. Type a command and press **Enter**: it runs in the project folder through your
system's shell (`cmd.exe` on Windows, `/bin/sh` elsewhere), and its output streams in, colours
and links included.

- **While it runs**, what you type goes to it: answer its prompt and press **Enter**. **Ctrl+C**
  stops it, and everything it started.
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
- Up to 8 commands run at once in a project. A tab keeps the last 1 MB of output.

Each project chooses how far it trusts its terminal, on the project page under **Terminal** (in
Ideate, the **…** menu next to the project name → **Project page**):

- **On — any command:** what you type, and the scripts.
- **Scripts only:** only the project's own `package.json` scripts.
- **Off:** nothing runs, and turning it off stops what runs.

With **Scripts only** or **Off**, the Terminal says so above its tabs, with a link to that setting.

Commands get your environment minus anything whose **name** looks like a secret: API keys,
tokens and passwords never reach them, while `PATH`, `HOME` and your ssh agent do. Only names are
checked, never values: a password inside a value, such as `DATABASE_URL=postgres://user:pass@…`,
does reach your commands. Agents never use the terminal.

## Keys the browser keeps

The browser keeps **Ctrl+W**, **Ctrl+T**, **Ctrl+N**, **Ctrl+Tab** and **Ctrl+1…9** for itself, so
Forge uses **Alt+W** to close an editor tab, and **Ctrl+P** lists your open files first.

## Limits in this version

- Text files up to 2 MB open for editing; binary files show a notice, images a preview.
- IntelliSense covers TypeScript, JavaScript, CSS, HTML and JSON inside each file; other languages
  get highlighting.
- On a phone, Forge is browse-only.
- The terminal is line-based: full-screen programs (vim, top, some installers' menus) do not
  render. Prompts that read a line work.
- A tab keeps its `cd`, but nothing else carries from one command to the next (`set`, `export`, an
  activated virtualenv). Chain them on one line instead: `venv\Scripts\activate && python app.py`.
- Processes live in the engine's memory: restarting the engine ends every command.
- There is no end-of-input key (Ctrl+D): a program that reads until its input ends (`sort` or
  `cat` with no file) waits until you stop it with Ctrl+C.
- Background jobs are not tracked: something a command leaves running after it ends (`cmd &`,
  `start /b`) is not in Processes, and Stop cannot reach it. Run servers in a tab's foreground.
- On Windows, `cmd`'s own commands (`echo`, `dir`, `type`) may show accented and other non-ASCII
  characters as `�`. Programs such as node, python, git and npm display them correctly. A fix is
  planned.
