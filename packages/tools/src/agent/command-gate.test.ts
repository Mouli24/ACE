import { commandGate } from '@ace/engine';
import { describe, expect, it } from 'vitest';

import { classifyCommand } from './classify.js';

/**
 * D376: the engine's command gate over the real `classifyCommand` — the pairing the server wires.
 * The engine cannot import this package (CLAUDE.md §3.4 rule 3), so its own tests use the answers
 * recorded here; these are the brief's five cases against the real classifier.
 */
describe('D376 commandGate over classifyCommand', () => {
  it('allows a command the allowlist covers', () => {
    expect(commandGate('pnpm test', ['pnpm test'], classifyCommand)).toEqual({
      kind: 'allow',
    });
  });

  it('asks for a compound line covered only in part, offering no prefix', () => {
    expect(commandGate('pnpm install && pnpm test', ['pnpm install'], classifyCommand)).toEqual({
      kind: 'ask',
      denylisted: false,
    });
  });

  it('asks for a denylisted command whose prefix is allowed, offering no prefix', () => {
    expect(commandGate('git push --force', ['git push'], classifyCommand)).toEqual({
      kind: 'ask',
      denylisted: true,
    });
  });

  it('asks for an unlisted command and offers its prefix', () => {
    expect(commandGate('npm run build', [], classifyCommand)).toEqual({
      kind: 'ask',
      allowPrefix: 'npm run build',
      denylisted: false,
    });
  });

  it('asks for a substitution, offering no prefix', () => {
    expect(commandGate('echo $(whoami)', [], classifyCommand)).toEqual({
      kind: 'ask',
      denylisted: false,
    });
  });

  it.each([
    ['./npm test', ['npm test']],
    ['NODE_OPTIONS=--require=./pwn.js npm test', ['npm test']],
    ['npm test > ~/.bashrc', ['npm test']],
    ['sudo pnpm install', []],
    ['node pwn.js', []],
  ])('%s under %j asks with no Always allow (D376 review)', (command, allowlist) => {
    expect(commandGate(command, allowlist, classifyCommand)).toEqual({
      kind: 'ask',
      denylisted: false,
    });
  });

  it('pnpm install is still offered for Always allow', () => {
    expect(commandGate('pnpm install', [], classifyCommand)).toEqual({
      kind: 'ask',
      allowPrefix: 'pnpm install',
      denylisted: false,
    });
  });

  it("matches the classifications the engine's tests record", () => {
    expect(classifyCommand('pnpm test', ['pnpm test'])).toMatchObject({
      autoAllowed: true,
      denied: [],
    });
    expect(classifyCommand('pnpm install && pnpm test', ['pnpm install'])).toMatchObject({
      autoAllowed: false,
      denied: [],
    });
    expect(
      classifyCommand('pnpm install && pnpm test', ['pnpm install']).alwaysAllowPrefix,
    ).toBeUndefined();
    expect(classifyCommand('git push --force', ['git push'])).toMatchObject({
      autoAllowed: false,
      denied: ['git-force-push'],
    });
    expect(classifyCommand('npm run build', [])).toMatchObject({
      autoAllowed: false,
      alwaysAllowPrefix: 'npm run build',
      denied: [],
    });
    expect(classifyCommand('echo $(whoami)', [])).toMatchObject({
      autoAllowed: false,
      denied: [],
    });
    expect(classifyCommand('echo $(whoami)', []).alwaysAllowPrefix).toBeUndefined();
  });
});
