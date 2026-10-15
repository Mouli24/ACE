import type { ServerFrame } from '@ace/contracts';
import type { PersistedRunEvent } from '@ace/sdk';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { createNode } from '../nodes/factory';
import { useRunStore } from '../runs/run-store';
import { db, installMockServer, queryClient } from '../test/app';
import type { AgentLook } from '../theme/agents';
import {
  attribute,
  editedTexts,
  projectPath,
  touchedLines,
  useForgeAttribution,
  writtenPaths,
  type AttributionSources,
} from './attribution';

installMockServer();

const RUN = '01RUN0000000000000000000000';
const AT = '2026-10-10T10:00:00.000Z';

let seq = 0;
const nodeState = (nodeRunId: string, nodeId: string, status: string): ServerFrame =>
  ({
    seq: ++seq,
    type: 'node.state',
    payload: { runId: RUN, nodeRunId, nodeId, iteration: 1, attempt: 1, status },
  }) as ServerFrame;

const toolCall = (
  nodeRunId: string,
  toolName: string,
  args: unknown,
  status = 'ok',
  at = AT,
): ServerFrame =>
  ({
    seq: ++seq,
    type: 'tool.call',
    payload: {
      runId: RUN,
      nodeRunId,
      toolCall: {
        id: `call-${seq}`,
        nodeRunId,
        toolName,
        args,
        resultSummary: '',
        durationMs: 1,
        status,
        verdicts: [],
        at,
      },
    },
  }) as ServerFrame;

describe('D334 where a write landed: paths', () => {
  it('names the path from path, file_path, notebook_path or changes[].path', () => {
    expect(writtenPaths({ path: 'a.ts', content: '' })).toEqual(['a.ts']);
    expect(writtenPaths({ file_path: '/p/b.ts' })).toEqual(['/p/b.ts']);
    expect(writtenPaths({ notebook_path: 'n.ipynb' })).toEqual(['n.ipynb']);
    expect(writtenPaths({ changes: [{ path: 'c.ts', kind: 'update' }, { kind: 'add' }] })).toEqual([
      'c.ts',
    ]);
    expect(writtenPaths('nonsense')).toEqual([]);
  });

  it('turns backslashes into slashes and strips the project folder from an absolute path', () => {
    expect(projectPath('src\\app.ts', '/p')).toBe('src/app.ts');
    expect(projectPath('./src/app.ts', '/p')).toBe('src/app.ts');
    expect(projectPath('/home/me/shop/src/app.ts', '/home/me/shop')).toBe('src/app.ts');
    expect(projectPath('/home/me/shop/src/app.ts', '/home/me/shop/')).toBe('src/app.ts');
    expect(projectPath('C:\\Users\\me\\Shop\\src\\app.ts', 'c:\\users\\me\\shop')).toBe(
      'src/app.ts',
    );
    // outside the project, or no folder to measure against: not one of its files
    expect(projectPath('/elsewhere/app.ts', '/home/me/shop')).toBeUndefined();
    expect(projectPath('/home/me/shopping/app.ts', '/home/me/shop')).toBeUndefined();
    expect(projectPath('/home/me/shop/app.ts', undefined)).toBeUndefined();
  });
});

describe('D334 what a write covers: a whole file, or where its new text sits', () => {
  it('a write with content is the whole file; an edit is its new text', () => {
    expect(editedTexts({ path: 'a.ts', content: 'x' })).toBeUndefined();
    expect(editedTexts({ path: 'a.ts', oldString: 'a', newString: 'b' })).toEqual(['b']);
    expect(editedTexts({ file_path: 'a.ts', old_string: 'a', new_string: 'c' })).toEqual(['c']);
    expect(
      editedTexts({ file_path: 'a.ts', edits: [{ new_string: 'd' }, { new_string: 'e' }] }),
    ).toEqual(['d', 'e']);
    // Codex names only the paths it changed: nothing to find
    expect(editedTexts({ changes: [{ path: 'a.ts', kind: 'update' }] })).toEqual([]);
  });

  it('a whole-file write covers every line of the buffer as it is now', () => {
    expect(touchedLines('one\ntwo\nthree', undefined)).toEqual({ from: 1, to: 3 });
    expect(touchedLines('one\r\ntwo', undefined)).toEqual({ from: 1, to: 2 });
  });

  it('an edit covers the lines where its new text is found', () => {
    const buffer = 'import x;\n\nfunction a() {\n  return 1;\n}\n';
    expect(touchedLines(buffer, ['function a() {\n  return 1;\n}'])).toEqual({ from: 3, to: 5 });
    // a trailing newline ends the last line rather than starting another
    expect(touchedLines(buffer, ['  return 1;\n'])).toEqual({ from: 4, to: 4 });
    expect(touchedLines('a\r\nb\r\nc', ['b\nc'])).toEqual({ from: 2, to: 3 });
    // a MultiEdit spans every piece found
    expect(touchedLines(buffer, ['import x;', '}'])).toEqual({ from: 1, to: 5 });
  });

  it('shows nothing when the new text is not in the buffer any more', () => {
    expect(touchedLines('one\ntwo', ['three'])).toBeUndefined();
    expect(touchedLines('one\ntwo', [])).toBeUndefined();
  });
});

describe('D334 who wrote which file, from the run’s tool calls', () => {
  const writer: AgentLook = {
    nodeId: 'n1',
    name: 'Writer',
    letter: 'W',
    color: '#ef6b3f',
    index: 0,
  };
  const editor: AgentLook = {
    nodeId: 'n2',
    name: 'Editor',
    letter: 'E',
    color: '#7a62d6',
    index: 1,
  };
  const states = new Map<string, string>([
    ['n1', 'RUNNING'],
    ['n2', 'COMPLETED'],
  ]);
  const sources: AttributionSources = {
    nodeIdOf: (nodeRunId) => ({ r1: 'n1', r2: 'n2', r3: 'n3' })[nodeRunId],
    nodeState: (nodeId) => (states.get(nodeId) ?? 'IDLE') as never,
    agents: new Map([
      ['n1', writer],
      ['n2', editor],
    ]),
    folderPath: '/home/me/shop',
  };
  const events = (...frames: ServerFrame[]) => frames as PersistedRunEvent[];

  it('keeps the latest successful write per file, and a live badge only for a RUNNING node', () => {
    const result = attribute(
      events(
        toolCall('r2', 'cli_write', { file_path: '/home/me/shop/a.ts', content: 'x' }),
        toolCall('r1', 'edit_file', { path: 'a.ts', oldString: 'x', newString: 'y' }, 'ok', 'T2'),
        toolCall('r2', 'cli_edit', { file_path: 'b.ts', old_string: 'p', new_string: 'q' }),
      ),
      sources,
    );
    // PG-3.4: each touch also names the node run that wrote it, for the model it ran on
    expect(result.last.get('a.ts')).toEqual({
      agent: writer,
      nodeRunId: 'r1',
      at: 'T2',
      edit: ['y'],
    });
    expect(result.last.get('b.ts')).toEqual({
      agent: editor,
      nodeRunId: 'r2',
      at: AT,
      edit: ['q'],
    });
    expect([...result.live]).toEqual([['a.ts', writer]]);
  });

  it('ignores reads, failed or refused writes, files outside the project and non-agent nodes', () => {
    const result = attribute(
      events(
        toolCall('r1', 'read_file', { path: 'a.ts' }),
        toolCall('r1', 'write_file', { path: 'b.ts', content: '' }, 'error'),
        toolCall('r1', 'cli_write', { file_path: '/elsewhere/c.ts', content: '' }),
        toolCall('r3', 'write_file', { path: 'd.ts', content: '' }),
      ),
      sources,
    );
    expect(result.last.size).toBe(0);
    expect(result.live.size).toBe(0);
  });
});

describe('D334 useForgeAttribution follows the run store', () => {
  let projectId: string;
  let workflowId: string;
  let agentId: string;
  beforeEach(() => {
    useRunStore.getState().reset();
    const project = db.createProject({ name: 'Shop', folderPath: '/home/me/shop' });
    projectId = project.id;
    workflowId = db.createWorkflow(project.id, 'Main').id;
    const agent = { ...createNode('agent', workflowId, { x: 0, y: 0 }), name: 'Writer' };
    agentId = agent.id;
    db.commitGraph(workflowId, [agent], []);
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('badges a file while its writer runs, and keeps the edit after it finishes', async () => {
    const { result } = renderHook(() => useForgeAttribution(projectId, workflowId), { wrapper });
    act(() => {
      useRunStore.getState().begin(workflowId, RUN, 'RUNNING');
      useRunStore.getState().apply(nodeState('r1', agentId, 'RUNNING'));
      useRunStore
        .getState()
        .apply(toolCall('r1', 'cli_write', { file_path: '/home/me/shop/src\\a.ts', content: 'x' }));
    });
    await waitFor(() => expect(result.current.live.get('src/a.ts')?.name).toBe('Writer'));
    expect(result.current.live.get('src/a.ts')).toMatchObject({ letter: 'W', color: '#ef6b3f' });
    expect(result.current.last.get('src/a.ts')).toMatchObject({ at: AT, edit: undefined });

    act(() => useRunStore.getState().apply(nodeState('r1', agentId, 'COMPLETED')));
    await waitFor(() => expect(result.current.live.size).toBe(0));
    expect(result.current.last.get('src/a.ts')?.agent.name).toBe('Writer');
  });

  it('shows nothing for another workflow’s run', async () => {
    const { result } = renderHook(() => useForgeAttribution(projectId, workflowId), { wrapper });
    act(() => {
      useRunStore.getState().begin('01OTHER0000000000000000000', RUN, 'RUNNING');
      useRunStore.getState().apply(nodeState('r1', agentId, 'RUNNING'));
      useRunStore.getState().apply(toolCall('r1', 'write_file', { path: 'a.ts', content: 'x' }));
    });
    // give the graph and project queries time to land, then check again
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(result.current.live.size).toBe(0);
    expect(result.current.last.size).toBe(0);
  });
});
