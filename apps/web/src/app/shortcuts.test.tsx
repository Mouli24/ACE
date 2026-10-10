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
});
