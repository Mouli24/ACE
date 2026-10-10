# Forge: the code editor

Inside a workflow, the switch at the top flips between **Ideate** (the canvas) and **Forge** (the
code editor on the project folder). **Ctrl+Shift+1** and **Ctrl+Shift+2** do the same
(**⌘⇧1** / **⌘⇧2** on a Mac). The chat stays on the right in both, and nothing is lost when you switch.

## The layout

- **Left:** the Explorer — _Open editors_ (what you are editing) above the project's folder tree.
  Changed files carry git's letters (**M**odified, **A**dded, **U**ntracked); ignored folders such as
  `node_modules` are dimmed. **Ctrl+B** shows or hides it.
- **Centre:** the editor. A single click previews a file (italic tab); a double click, or an edit, keeps it.
- **Bottom:** Problems and Output. **Ctrl+J** shows or hides the panel. Your choice is remembered.
- **Right:** the chat. **Ctrl+Alt+B** shows or hides it.

Every panel can be resized by dragging its edge.

## Files

- **New file / folder:** the buttons at the top of the Explorer, or right-click. Type the name and press Enter.
- **Rename:** select it and press **F2**.
- **Move:** drag it onto a folder, or onto a file to move it into that file's folder.
- **Delete:** select it and press **Delete**. In this version a delete cannot be undone.
- A rename, move or delete waits while a file inside it is still saving.
- **Go to a file:** **Ctrl+P**, then type a few letters of its name.

## Saving, and files that change underneath you

**Ctrl+S** saves, **Ctrl+Alt+S** saves everything. A dot on a tab means unsaved changes.

If a file changes on disk — an agent wrote it, or another editor — while it is open:

- with no unsaved changes, Forge simply shows the new text;
- with unsaved changes, a bar appears: **Compare** (yours against the disk), **Take theirs**, or
  **Keep mine** (your next save wins). Forge never overwrites a change it has not shown you.

If a file you are editing is deleted on disk, its bar offers **Save** (recreates it) and **Close**,
and closing unsaved text always asks first.

Closing a tab with unsaved changes asks first, and so does closing or reloading the browser tab.

## Keys the browser keeps

The browser keeps **Ctrl+W**, **Ctrl+T**, **Ctrl+N**, **Ctrl+Tab** and **Ctrl+1…9** for itself, so
Forge uses **Alt+W** to close an editor tab, and **Ctrl+P** lists your open files first.

## Limits in this version

- Text files up to 2 MB open for editing; binary files show a notice, images a preview.
- IntelliSense covers TypeScript, JavaScript, CSS, HTML and JSON inside each file; other languages
  get highlighting.
- On a phone, Forge is browse-only.
