import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { matches, SHORTCUTS, shortcutLabel, useShortcuts, type Shortcut } from './shortcuts';

const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('D299 Forge’s keyboard shortcuts', () => {
  it('treats Ctrl and ⌘ alike and refuses extra modifiers', () => {
    const ctrlS = new KeyboardEvent('keydown', { code: 'KeyS', ctrlKey: true });
    const metaS = new KeyboardEvent('keydown', { code: 'KeyS', metaKey: true });
    const ctrlAltS = new KeyboardEvent('keydown', { code: 'KeyS', ctrlKey: true, altKey: true });
    expect(matches(ctrlS, SHORTCUTS.save)).toBe(true);
    expect(matches(metaS, SHORTCUTS.save)).toBe(true);
    expect(matches(ctrlAltS, SHORTCUTS.save)).toBe(false);
    expect(matches(ctrlAltS, SHORTCUTS.saveAll)).toBe(true);
  });

  it('matches the mode keys by code, so Shift+1 works on any layout', () => {
    expect(
      matches(
        new KeyboardEvent('keydown', { code: 'Digit2', key: '@', ctrlKey: true, shiftKey: true }),
        SHORTCUTS.forge,
      ),
    ).toBe(true);
  });

  it('follows the typed letter, so Dvorak’s Ctrl+O is never save', () => {
    const dvorakO = new KeyboardEvent('keydown', { code: 'KeyS', key: 'o', ctrlKey: true });
    const dvorakS = new KeyboardEvent('keydown', { code: 'KeyO', key: 's', ctrlKey: true });
    expect(matches(dvorakO, SHORTCUTS.save)).toBe(false);
    expect(matches(dvorakS, SHORTCUTS.save)).toBe(true);
  });

  it('falls back to the key’s place when the layout types no Latin letter', () => {
    const cyrillic = new KeyboardEvent('keydown', { code: 'KeyS', key: 'ы', ctrlKey: true });
    expect(matches(cyrillic, SHORTCUTS.save)).toBe(true);
  });

  it('never treats AltGr as a shortcut', () => {
    const altGr = new KeyboardEvent('keydown', {
      code: 'KeyB',
      key: 'b',
      ctrlKey: true,
      altKey: true,
    });
    altGr.getModifierState = (key: string) => key === 'AltGraph';
    expect(matches(altGr, SHORTCUTS.toggleChat)).toBe(false);
  });

  it('never binds a key the browser keeps for itself', () => {
    const reserved = [
      'KeyW',
      'KeyT',
      'KeyN',
      'Tab',
      ...Array.from({ length: 9 }, (_, i) => `Digit${i + 1}`),
    ];
    for (const shortcut of Object.values<Shortcut>(SHORTCUTS)) {
      const plainMod = shortcut.mod === true && shortcut.shift !== true && shortcut.alt !== true;
      expect(plainMod && reserved.includes(shortcut.code), shortcutLabel(shortcut)).toBe(false);
    }
  });

  it('runs in the capture phase, before an editor sees the key, and stops the browser default', () => {
    const save = vi.fn();
    function Probe() {
      useShortcuts([[SHORTCUTS.save, save]]);
      return <textarea aria-label="editor" />;
    }
    const { getByLabelText } = render(<Probe />);
    const editorSaw = vi.fn();
    getByLabelText('editor').addEventListener('keydown', editorSaw);
    const event = press({ code: 'KeyS', ctrlKey: true }, getByLabelText('editor'));
    expect(save).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(editorSaw).not.toHaveBeenCalled();
  });

  it('D301 Ctrl+` and ⌘+` toggle the terminal, labelled with the backquote itself', () => {
    const backquote = (init: KeyboardEventInit) =>
      new KeyboardEvent('keydown', { code: 'Backquote', key: '`', ...init });
    expect(matches(backquote({ ctrlKey: true }), SHORTCUTS.toggleTerminal)).toBe(true);
    expect(matches(backquote({ metaKey: true }), SHORTCUTS.toggleTerminal)).toBe(true);
    expect(matches(backquote({}), SHORTCUTS.toggleTerminal)).toBe(false);
    expect(shortcutLabel(SHORTCUTS.toggleTerminal)).toBe('Ctrl+`');
  });
});

describe('D299 Phase 4 Search, Run checks and Format keys', () => {
  it('binds Ctrl/⌘+Shift+F to Search and Ctrl/⌘+Shift+B to Run checks, apart from Ctrl+B and Ctrl+Alt+B', () => {
    const key = (code: string, init: KeyboardEventInit) =>
      new KeyboardEvent('keydown', { code, key: code.slice(3).toLowerCase(), ...init });
    expect(matches(key('KeyF', { ctrlKey: true, shiftKey: true }), SHORTCUTS.searchFiles)).toBe(
      true,
    );
    expect(matches(key('KeyF', { ctrlKey: true }), SHORTCUTS.searchFiles)).toBe(false);
    const ctrlShiftB = key('KeyB', { ctrlKey: true, shiftKey: true });
    expect(matches(ctrlShiftB, SHORTCUTS.runChecks)).toBe(true);
    expect(matches(ctrlShiftB, SHORTCUTS.toggleSidebar)).toBe(false);
    expect(matches(ctrlShiftB, SHORTCUTS.toggleChat)).toBe(false);
    expect(shortcutLabel(SHORTCUTS.runChecks)).toBe('Ctrl+Shift+B');
  });

  it('leaves Shift+Alt+F to Monaco’s Format Document: no shortcut takes it', () => {
    const shiftAltF = new KeyboardEvent('keydown', {
      code: 'KeyF',
      key: 'F',
      shiftKey: true,
      altKey: true,
    });
    for (const shortcut of Object.values(SHORTCUTS)) {
      expect(matches(shiftAltF, shortcut)).toBe(false);
    }
    const run = vi.fn();
    render(<Bound bindings={Object.values(SHORTCUTS).map((shortcut) => [shortcut, run])} />);
    const event = press({ code: 'KeyF', key: 'F', shiftKey: true, altKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

function Bound({ bindings }: { bindings: ReadonlyArray<readonly [Shortcut, () => void]> }) {
  useShortcuts(bindings);
  return null;
}
