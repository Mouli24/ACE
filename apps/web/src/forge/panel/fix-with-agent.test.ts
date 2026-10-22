import { waitFor } from '@testing-library/react';

import { api } from '../../app/api';
import { useLayoutStore } from '../../app/stores/layout';
import { usePanelsStore } from '../../app/stores/panels';
import { useComposerChips } from '../../chat/composer-chips';
import {
  db,
  installChatMockServer,
  queryClient,
  seedAgentNode,
  server,
} from '../../chat/test-support';
import { createForgeHandlers } from '../../mocks/handlers-forge';
import { asMonaco, createFakeMonaco } from '../../test/fake-monaco';
import { queryKeys } from '../../workflows/query-keys';
import { dirtyHandler } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { ensureModel, getModel, resetModels, setMonaco } from '../editor/models';
import { fixMessage, fixWithAgent, problemContext } from './fix-with-agent';

/*
 * D302 Fix with agent (design §6.5): a problem goes to the chat's current node with the file, the
 * line and five lines either side — or, with no node selected, waits in the composer.
 */

installChatMockServer();

const P = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
const problem = {
  path: 'src/app.ts',
  line: 10,
  message: "Cannot find name 'foo'.",
  source: 'ts',
};

/** Forge's workflow graph as the workflow layout loads it: in the query cache. */
async function loadGraph(workflowId: string): Promise<void> {
  await queryClient.fetchQuery({
    queryKey: queryKeys.workflow(workflowId),
    queryFn: () => api().getWorkflow(workflowId),
  });
}

beforeEach(() => {
  useComposerChips.getState().reset();
  resetModels();
  setMonaco(asMonaco(createFakeMonaco()));
  ensureModel(P, 'src/app.ts', LINES, 'typescript', () => undefined);
  useLayoutStore.setState({ chatOpen: false });
});

describe('D302 the problem as the agent reads it', () => {
  it('takes the line and five lines either side, clipped at the file’s ends', () => {
    expect(problemContext(LINES, 10)).toEqual({
      startLine: 5,
      endLine: 15,
      text: Array.from({ length: 11 }, (_, index) => `line ${index + 5}`).join('\n'),
    });
    expect(problemContext(LINES, 2)).toMatchObject({ startLine: 1, endLine: 7 });
    expect(problemContext(LINES, 19)).toMatchObject({ startLine: 14, endLine: 20 });
  });

  it('says what to fix, with the tool that found it', () => {
    expect(fixMessage(problem)).toBe("Fix this problem: Cannot find name 'foo'. (ts)");
    expect(fixMessage({ ...problem, source: undefined })).toBe(
      "Fix this problem: Cannot find name 'foo'.",
    );
  });
});

describe('D302 Fix with agent', () => {
  it('sends the chat’s current node the problem and the code around it at once', async () => {
    const { node, workflowId } = seedAgentNode();
    await loadGraph(workflowId);
    usePanelsStore.getState().chatWith(node.id);

    expect(await fixWithAgent({ projectId: P, workflowId, problem, queryClient })).toBe('sent');
    expect(useLayoutStore.getState().chatOpen).toBe(true);
    await waitFor(async () => {
      const [thread] = await api().listNodeChatThreads(node.id);
      const detail = await api().getChatThread(thread!.id);
      expect(detail.messages[0]?.content).toEqual([
        { type: 'text', text: "Fix this problem: Cannot find name 'foo'. (ts)" },
        {
          type: 'code',
          language: 'typescript',
          text: Array.from({ length: 11 }, (_, index) => `line ${index + 5}`).join('\n'),
          path: 'src/app.ts',
          startLine: 5,
          endLine: 15,
        },
      ]);
    });
    expect(useComposerChips.getState().chips).toEqual([]);
  });

  it('puts the message and the chip in the composer when no node is selected', async () => {
    const { node, workflowId } = seedAgentNode();
    await loadGraph(workflowId);
    usePanelsStore.getState().chatWith(undefined);

    expect(await fixWithAgent({ projectId: P, workflowId, problem, queryClient })).toBe(
      'prefilled',
    );
    expect(useComposerChips.getState().draft).toBe(
      "Fix this problem: Cannot find name 'foo'. (ts)",
    );
    expect(useComposerChips.getState().chips).toMatchObject([
      { path: 'src/app.ts', startLine: 5, endLine: 15 },
    ]);
    expect(useLayoutStore.getState().chatOpen).toBe(true);
    expect(await api().listNodeChatThreads(node.id)).toEqual([]);
  });

  it('never sends to a node of another workflow: the chat opens with the problem instead (F-I2)', async () => {
    // the person chatted with a node of another project's workflow, then closed the chat
    const { node: elsewhere } = seedAgentNode();
    usePanelsStore.getState().chatWith(elsewhere.id);
    const forge = db.createWorkflow(db.createProject({ name: 'B' }).id, 'Forge');
    seedAgentNode({ workflowId: forge.id, name: 'Coder' });
    await loadGraph(forge.id);

    expect(await fixWithAgent({ projectId: P, workflowId: forge.id, problem, queryClient })).toBe(
      'prefilled',
    );
    expect(useLayoutStore.getState().chatOpen).toBe(true);
    expect(useComposerChips.getState().draft).toBe(
      "Fix this problem: Cannot find name 'foo'. (ts)",
    );
    expect(useComposerChips.getState().chips).toMatchObject([
      { path: 'src/app.ts', startLine: 5, endLine: 15 },
    ]);
    expect(await api().listNodeChatThreads(elsewhere.id)).toEqual([]);
  });

  it('prefills rather than sends while Forge’s workflow graph is not loaded, or with no workflow', async () => {
    const { node, workflowId } = seedAgentNode();
    usePanelsStore.getState().chatWith(node.id);

    expect(await fixWithAgent({ projectId: P, workflowId, problem, queryClient })).toBe(
      'prefilled',
    );
    await loadGraph(workflowId);
    expect(await fixWithAgent({ projectId: P, problem, queryClient })).toBe('prefilled');
    expect(await api().listNodeChatThreads(node.id)).toEqual([]);
  });
});

describe('[audit F-1] Fix with agent saves the file first: the agent fixes what the disk holds', () => {
  /** A Forge project with `src/app.ts` on disk, open in the editor and typed into, unsaved. */
  async function openDirty(): Promise<{ projectId: string; workflowId: string; nodeId: string }> {
    server.use(...createForgeHandlers(db));
    const { node, workflowId } = seedAgentNode();
    await loadGraph(workflowId);
    usePanelsStore.getState().chatWith(node.id);
    const projectId = db.getWorkflow(workflowId)!.projectId;
    db.seedFiles(projectId, { 'src/app.ts': LINES });
    const disk = await api().readFile(projectId, 'src/app.ts');
    useEditorStore.getState().open(projectId, 'src/app.ts');
    useEditorStore
      .getState()
      .loaded(projectId, 'src/app.ts', disk.kind === 'text' ? disk.version : '', false);
    ensureModel(
      projectId,
      'src/app.ts',
      LINES,
      'typescript',
      dirtyHandler(projectId, 'src/app.ts'),
    );
    getModel(projectId, 'src/app.ts')!.setValue(LINES.replace('line 10', 'line ten'));
    expect(useEditorStore.getState().projects[projectId]?.files['src/app.ts']?.dirty).toBe(true);
    return { projectId, workflowId, nodeId: node.id };
  }

  it('saves the unsaved buffer, then sends: the disk and the message hold the same text', async () => {
    const { projectId, workflowId, nodeId } = await openDirty();

    expect(await fixWithAgent({ projectId, workflowId, problem, queryClient })).toBe('sent');
    const disk = await api().readFile(projectId, 'src/app.ts');
    expect(disk).toMatchObject({ kind: 'text', content: LINES.replace('line 10', 'line ten') });
    expect(useEditorStore.getState().projects[projectId]?.files['src/app.ts']?.dirty).toBe(false);
    await waitFor(async () => {
      const [thread] = await api().listNodeChatThreads(nodeId);
      const detail = await api().getChatThread(thread!.id);
      expect(detail.messages[0]?.content[1]).toMatchObject({ type: 'code', path: 'src/app.ts' });
      expect(JSON.stringify(detail.messages[0]?.content)).toContain('line ten');
    });
  });

  it('a save that meets a conflict sends nothing: the request waits in the composer, saying the file is unsaved', async () => {
    const { projectId, workflowId, nodeId } = await openDirty();
    // the disk moved on since the buffer was loaded, so the save answers 409
    db.seedFiles(projectId, { 'src/app.ts': `${LINES}\nline 21` });

    expect(await fixWithAgent({ projectId, workflowId, problem, queryClient })).toBe('prefilled');
    expect(useComposerChips.getState().draft).toBe(
      "Fix this problem: Cannot find name 'foo'. (ts)\n" +
        'Note: src/app.ts has unsaved changes in the editor that are not on disk.',
    );
    expect(useComposerChips.getState().chips).toMatchObject([{ path: 'src/app.ts' }]);
    expect(useEditorStore.getState().projects[projectId]?.files['src/app.ts']?.conflict).toBe(
      'changed',
    );
    expect(await api().listNodeChatThreads(nodeId)).toEqual([]);
  });
});
