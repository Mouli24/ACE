import { afterEach, describe, expect, it } from 'vitest';

import { isCloseTabKey } from './close-tab-key';

/** What `isCloseTabKey` answers for a keydown dispatched at `target`, as the window sees it. */
function closes(target: Element, init: KeyboardEventInit): boolean {
  let answer: boolean | undefined;
  const listen = (event: KeyboardEvent): void => {
    answer = isCloseTabKey(event);
  };
  window.addEventListener('keydown', listen, true);
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  window.removeEventListener('keydown', listen, true);
  return answer ?? false;
}

const ALT_W = { key: 'w', code: 'KeyW', altKey: true };

/** Monaco's editor with its own text area and, inside it, the find widget's field. */
function monaco(): { area: HTMLTextAreaElement; find: HTMLTextAreaElement } {
  const editor = document.createElement('div');
  editor.className = 'monaco-editor';
  const area = document.createElement('textarea');
  area.className = 'inputarea';
  const widget = document.createElement('div');
  widget.className = 'find-widget';
  const find = document.createElement('textarea');
  widget.append(find);
  editor.append(area, widget);
  document.body.append(editor);
  return { area, find };
}

afterEach(() => document.body.replaceChildren());

describe('[audit F-10] Alt+W closes the tab only when the focus does not mean something else', () => {
  it('closes from the page and from Monaco’s own text area', () => {
    expect(closes(document.body, ALT_W)).toBe(true);
    expect(closes(monaco().area, ALT_W)).toBe(true);
  });

  it('leaves Alt+W to Monaco’s find widget (whole word) and to a text field outside the editor', () => {
    expect(closes(monaco().find, ALT_W)).toBe(false);
    const field = document.createElement('input');
    document.body.append(field);
    expect(closes(field, ALT_W)).toBe(false);
  });

  it('follows the letter typed, not the key’s place: Option+W on a Mac types ∑, and closes nothing', () => {
    expect(closes(document.body, { ...ALT_W, key: '∑' })).toBe(false);
    expect(closes(document.body, { ...ALT_W, key: 'ц' })).toBe(false);
    // a key that types nothing (a dead key) still counts by its place
    expect(closes(document.body, { ...ALT_W, key: 'Dead' })).toBe(true);
  });

  it('needs Alt alone', () => {
    expect(closes(document.body, { ...ALT_W, shiftKey: true })).toBe(false);
    expect(closes(document.body, { ...ALT_W, ctrlKey: true })).toBe(false);
    expect(closes(document.body, { key: 'w', code: 'KeyW' })).toBe(false);
  });
});
