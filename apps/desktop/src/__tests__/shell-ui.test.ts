import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { appMenuTemplate, contextMenuTemplate } from '../menus.js';
import { permissionAllowed } from '../permissions.js';
import { pickFreePort } from '../ports.js';
import { startingPageHtml, startingPageUrl } from '../starting-page.js';

const APP = 'http://localhost:5173';
const ALL_FLAGS = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

describe('FR-DSK-002 permissions: the clipboard, for the app, and nothing else (D294)', () => {
  it('grants clipboard read and write to the app origin', () => {
    expect(permissionAllowed('clipboard-read', `${APP}/projects/p1`, APP)).toBe(true);
    expect(permissionAllowed('clipboard-sanitized-write', APP, APP)).toBe(true);
  });

  it('denies every other permission', () => {
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'hid',
      'serial',
      'openExternal',
    ]) {
      expect(permissionAllowed(permission, APP, APP)).toBe(false);
    }
  });

  it('denies the clipboard to any other origin, or before the app origin is known', () => {
    expect(permissionAllowed('clipboard-read', 'https://evil.example/', APP)).toBe(false);
    expect(permissionAllowed('clipboard-read', 'not a url', APP)).toBe(false);
    expect(permissionAllowed('clipboard-read', APP, undefined)).toBe(false);
  });
});

describe('FR-DSK-002 the application menu leaves the Canvas its keys (D294)', () => {
  const roles = (items: ReturnType<typeof appMenuTemplate>): string[] =>
    items.flatMap((item) => [
      ...(item.role === undefined ? [] : [item.role]),
      ...(Array.isArray(item.submenu) ? roles(item.submenu) : []),
    ]);

  it('is View only: reload, force reload, devtools, zoom, full screen', () => {
    const menu = appMenuTemplate();
    expect(menu.map((item) => item.label)).toEqual(['View']);
    expect(roles(menu)).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen',
    ]);
  });

  it('has no edit role and no accelerator on a Canvas key', () => {
    const all = roles(appMenuTemplate());
    for (const edit of [
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'selectAll',
      'delete',
      'editMenu',
    ]) {
      expect(all).not.toContain(edit);
    }
    const accelerators = JSON.stringify(appMenuTemplate()).match(/"accelerator"/g);
    expect(accelerators).toBeNull();
  });
});

describe('FR-DSK-002 the right-click menu (D294)', () => {
  it('an editable field gets cut, copy, paste and select all, enabled as the page says', () => {
    const menu = contextMenuTemplate({
      isEditable: true,
      selectionText: '',
      editFlags: { ...ALL_FLAGS, canCut: false, canCopy: false },
    });
    expect(menu.map((item) => item.role ?? item.type)).toEqual([
      'cut',
      'copy',
      'paste',
      'separator',
      'selectAll',
    ]);
    expect(menu.map((item) => item.enabled)).toEqual([false, false, true, undefined, true]);
  });

  it('selected text gets copy; nothing selected and not editable gets nothing', () => {
    expect(
      contextMenuTemplate({ isEditable: false, selectionText: 'hello', editFlags: ALL_FLAGS }),
    ).toEqual([{ role: 'copy', enabled: true }]);
    expect(
      contextMenuTemplate({ isEditable: false, selectionText: '  ', editFlags: ALL_FLAGS }),
    ).toEqual([]);
  });
});

describe('the starting page', () => {
  it('escapes what it shows and is a self-contained data: URL', () => {
    const html = startingPageHtml('Waiting <for> "the" engine & Vite', "it's fine");
    expect(html).toContain('Waiting &lt;for&gt; &quot;the&quot; engine &amp; Vite');
    expect(html).toContain('it&#39;s fine');
    expect(html).not.toMatch(/<script|src=|href=/);

    const url = startingPageUrl('Starting ACE…');
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toContain('<h1>Starting ACE…</h1>');
    expect(startingPageHtml('x')).not.toContain('<p>');
  });
});

describe('FR-DSK-002 pickFreePort', () => {
  it('answers a loopback port nothing is listening on', async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    // Prove it is free: we can bind it ourselves.
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve()));
    });
  });

  it('rejects when the host cannot be bound', async () => {
    await expect(pickFreePort('256.0.0.1')).rejects.toThrow();
  });
});
