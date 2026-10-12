import type { AceSocket } from '@ace/sdk';
import { describe, expect, it, vi } from 'vitest';

import { retainProjectScope } from './project-scope';

function stubSocket() {
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  return { socket: { subscribe, unsubscribe } as unknown as AceSocket, subscribe, unsubscribe };
}

describe('D301 files and processes share one project subscription', () => {
  it('the first holder subscribes, and only the last to let go unsubscribes', () => {
    const { socket, subscribe, unsubscribe } = stubSocket();
    const files = retainProjectScope(socket, 'P');
    const terminal = retainProjectScope(socket, 'P');
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith({ scope: 'project', id: 'P' });

    files();
    expect(unsubscribe).not.toHaveBeenCalled();
    terminal();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith({ scope: 'project', id: 'P' });
  });

  it('a release called twice counts once', () => {
    const { socket, unsubscribe } = stubSocket();
    const first = retainProjectScope(socket, 'P');
    const second = retainProjectScope(socket, 'P');
    first();
    first();
    expect(unsubscribe).not.toHaveBeenCalled();
    second();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('counts each project and each socket apart', () => {
    const one = stubSocket();
    const two = stubSocket();
    retainProjectScope(one.socket, 'P');
    retainProjectScope(one.socket, 'Q');
    retainProjectScope(two.socket, 'P');
    expect(one.subscribe).toHaveBeenCalledTimes(2);
    expect(two.subscribe).toHaveBeenCalledTimes(1);
  });
});
