import { waitFor } from '@testing-library/react';

import { api } from '../../app/api';
import { useLayoutStore } from '../../app/stores/layout';
import { usePanelsStore } from '../../app/stores/panels';
import { useComposerChips } from '../../chat/composer-chips';
import { installChatMockServer, queryClient, seedAgentNode } from '../../chat/test-support';
import { asMonaco, createFakeMonaco } from '../../test/fake-monaco';
import { ensureModel, resetModels, setMonaco } from '../editor/models';
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
    const { node } = seedAgentNode();
    usePanelsStore.getState().chatWith(node.id);

    expect(await fixWithAgent({ projectId: P, problem, queryClient })).toBe('sent');
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
    const { node } = seedAgentNode();
    usePanelsStore.getState().chatWith(undefined);

    expect(await fixWithAgent({ projectId: P, problem, queryClient })).toBe('prefilled');
    expect(useComposerChips.getState().draft).toBe(
      "Fix this problem: Cannot find name 'foo'. (ts)",
    );
    expect(useComposerChips.getState().chips).toMatchObject([
      { path: 'src/app.ts', startLine: 5, endLine: 15 },
    ]);
    expect(useLayoutStore.getState().chatOpen).toBe(true);
    expect(await api().listNodeChatThreads(node.id)).toEqual([]);
  });
});
