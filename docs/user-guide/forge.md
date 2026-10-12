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
- **Bottom:** Problems. **Ctrl+J** shows or hides the panel, and the error and warning counts in
  the footer open it. Your choice is remembered. Warnings about saves and conflicts appear as notices.
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

## Keys the browser keeps

The browser keeps **Ctrl+W**, **Ctrl+T**, **Ctrl+N**, **Ctrl+Tab** and **Ctrl+1…9** for itself, so
Forge uses **Alt+W** to close an editor tab, and **Ctrl+P** lists your open files first.

## Limits in this version

- Text files up to 2 MB open for editing; binary files show a notice, images a preview.
- IntelliSense covers TypeScript, JavaScript, CSS, HTML and JSON inside each file; other languages
  get highlighting.
- On a phone, Forge is browse-only.
