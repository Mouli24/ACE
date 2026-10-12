import { describe, expect, it, vi } from 'vitest';

import { killTree } from './runner.js';

const spawned = vi.hoisted(
  () => [] as Array<{ command: string; args: readonly string[]; options: unknown }>,
);

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[], options: unknown) => {
    spawned.push({ command, args, options });
    return { on: () => undefined };
  },
}));

describe('D301 killTree on Windows', () => {
  it('runs taskkill on the whole tree with no console window flashing up', () => {
    killTree(4321, 'win32');
    expect(spawned).toEqual([
      {
        command: 'taskkill',
        args: ['/pid', '4321', '/T', '/F'],
        options: { stdio: 'ignore', windowsHide: true },
      },
    ]);
  });
});
