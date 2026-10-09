import type { MenuItemConstructorOptions } from 'electron';

/**
 * The application menu (D294): View only. There is deliberately **no Edit menu** — its accelerators
 * (Ctrl+A, C, V, Z, Y …) would be the window's, and those keys belong to the Canvas. Text fields
 * still copy and paste with Ctrl+C/V on Windows: Chromium handles them in an editable field itself.
 */
export function appMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
}

/** The slice of Electron's `context-menu` params the menu is built from. */
export interface ContextMenuParams {
  isEditable: boolean;
  selectionText: string;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

/**
 * The right-click menu for what the page leaves to the browser (D294). An editable field gets
 * Cut/Copy/Paste/Select All, selected text gets Copy, anything else nothing. The Canvas opens its own
 * menu and cancels the event, so Electron never asks for one there.
 */
export function contextMenuTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    return [
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ];
  }
  if (params.selectionText.trim() !== '') {
    return [{ role: 'copy', enabled: params.editFlags.canCopy }];
  }
  return [];
}
