import type { Artifact, WorkflowGraphResponse } from '@ace/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNode } from '../nodes/factory';
import { useWorkflowGraph } from '../workflows/hooks';
import { queryKeys } from '../workflows/query-keys';
import { resetGraphSyncRegistry } from '../workflows/sync-registry';
import { InputAttachments } from './InputAttachments';

const uploadArtifact = vi.fn();
const getArtifact = vi.fn();
const artifactContentUrl = vi.fn((id: string) => `http://mock.local/api/v1/artifacts/${id}/content?token=t`);
// A pending applyGraphOps keeps the optimistic cache in place for the assertion (the flush never
// completes to overwrite it), which is all this test needs of the engine.
const applyGraphOps = vi.fn(() => new Promise<never>(() => {}));
const getWorkflow = vi.fn();

vi.mock('../app/api', () => ({
  api: () => ({ uploadArtifact, getArtifact, artifactContentUrl, applyGraphOps, getWorkflow }),
}));

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  id: 'art-9',
  hash: 'a'.repeat(64),
  mime: 'image/png',
  name: 'sample.png',
  size: 2048,
  createdAt: new Date('2026-01-01').toISOString(),
  ...over,
});

const png = (name = 'sample.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

const WF = 'wf-1';
let queryClient: QueryClient;

function seed(artifactIds: string[] = []) {
  const node = createNode('input', WF, { x: 0, y: 0 });
  if (node.kind !== 'input') throw new Error('input');
  node.config.artifactIds = artifactIds;
  const graph: WorkflowGraphResponse = {
    workflow: {
      id: WF,
      projectId: 'p-1',
      name: 'F',
      version: 1,
      formatVersion: 1,
      createdAt: new Date('2026-01-01').toISOString(),
      updatedAt: new Date('2026-01-01').toISOString(),
    },
    nodes: [node],
    edges: [],
  };
  queryClient.setQueryData(queryKeys.workflow(WF), graph);
  return node;
}

/** Reads the input node from the cache and feeds its live config in, as the config panel does. */
function Harness({ nodeId }: { nodeId: string }) {
  const graph = useWorkflowGraph(WF);
  const node = graph.data?.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== 'input') return null;
  return <InputAttachments workflowId={WF} nodeId={nodeId} config={node.config} />;
}

function renderHarness(nodeId: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness nodeId={nodeId} />
    </QueryClientProvider>,
  );
}

const cachedIds = () =>
  queryClient
    .getQueryData<WorkflowGraphResponse>(queryKeys.workflow(WF))!
    .nodes.find((n) => n.kind === 'input')!.config.artifactIds;

beforeEach(() => {
  resetGraphSyncRegistry();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('InputAttachments (M4 §2 item 1, FR-MM-007)', () => {
  it('uploading attaches the artifact id to the node config and lists it', async () => {
    const node = seed();
    uploadArtifact.mockResolvedValue(artifact());
    getArtifact.mockResolvedValue(artifact());
    renderHarness(node.id);

    await userEvent.upload(screen.getByTestId('input-attachment-picker-input'), png());

    await waitFor(() => expect(cachedIds()).toEqual(['art-9']));
    expect(await screen.findByText('sample.png')).toBeInTheDocument();
  });

  it('TC-MM-007: attaching the same file twice keeps one entry (dedupe by id)', async () => {
    const node = seed();
    uploadArtifact.mockResolvedValue(artifact()); // mock engine dedupes bytes → same id
    getArtifact.mockResolvedValue(artifact());
    renderHarness(node.id);

    const input = screen.getByTestId('input-attachment-picker-input');
    await userEvent.upload(input, png());
    await waitFor(() => expect(cachedIds()).toEqual(['art-9']));
    await userEvent.upload(input, png());

    await waitFor(() => expect(uploadArtifact).toHaveBeenCalledTimes(2));
    expect(cachedIds()).toEqual(['art-9']);
    expect(screen.getAllByTestId(/^attachment-art-9$/)).toHaveLength(1);
  });

  it('removing an attachment drops it from the node config', async () => {
    const node = seed(['art-9']);
    getArtifact.mockResolvedValue(artifact());
    renderHarness(node.id);

    await screen.findByText('sample.png');
    await userEvent.click(screen.getByTestId('attachment-remove-art-9'));

    await waitFor(() => expect(cachedIds()).toEqual([]));
  });
});
