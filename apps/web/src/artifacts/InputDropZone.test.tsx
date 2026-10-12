import type { Artifact, WorkflowGraphResponse } from '@ace/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeCardView } from '../nodes/NodeCard';
import { createNode } from '../nodes/factory';
import { useWorkflowGraph } from '../workflows/hooks';
import { queryKeys } from '../workflows/query-keys';
import { resetGraphSyncRegistry } from '../workflows/sync-registry';
import { InputDropZone } from './InputDropZone';

const uploadArtifact = vi.fn();
const getArtifact = vi.fn();
const artifactContentUrl = vi.fn((id: string) => `/artifacts/${id}/content`);
const applyGraphOps = vi.fn(() => new Promise<never>(() => {}));
const getWorkflow = vi.fn();

vi.mock('../app/api', () => ({
  api: () => ({ uploadArtifact, getArtifact, artifactContentUrl, applyGraphOps, getWorkflow }),
}));

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  id: 'art-5',
  hash: 'a'.repeat(64),
  mime: 'image/png',
  name: 'sample.png',
  size: 2048,
  createdAt: new Date('2026-01-01').toISOString(),
  ...over,
});

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

/** Feeds the node's live config into the drop zone around the real card, as the Canvas does. */
function Harness({ nodeId }: { nodeId: string }) {
  const graph = useWorkflowGraph(WF);
  const node = graph.data?.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== 'input') return null;
  return (
    <ReactFlowProvider>
      <InputDropZone workflowId={WF} nodeId={nodeId} config={node.config}>
        <NodeCardView node={node} state="IDLE" selected={false} connectedPortIds={new Set()} />
      </InputDropZone>
    </ReactFlowProvider>
  );
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

const fileDrag = (file: File) => ({ dataTransfer: { types: ['Files'], files: [file] } });
const png = () => new File([new Uint8Array([1, 2, 3])], 'sample.png', { type: 'image/png' });

beforeEach(() => {
  resetGraphSyncRegistry();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

afterEach(() => vi.clearAllMocks());

describe('InputDropZone (M4 §2 item 1, FR-MM-007)', () => {
  it('TC-MM-007: dropping a file on the card uploads and attaches it', async () => {
    const node = seed();
    uploadArtifact.mockResolvedValue(artifact());
    getArtifact.mockResolvedValue(artifact());
    renderHarness(node.id);

    fireEvent.drop(screen.getByTestId(`input-dropzone-${node.id}`), fileDrag(png()));

    await waitFor(() => expect(cachedIds()).toEqual(['art-5']));
    expect(uploadArtifact).toHaveBeenCalledTimes(1);
    // D332: the count is the card's own meta line, INPUT · 1 FILE
    expect(await screen.findByTestId(`input-attachment-count-${node.id}`)).toHaveTextContent(
      '1 FILE',
    );
    expect(screen.getByTestId(`node-meta-${node.id}`)).toHaveTextContent('INPUT · 1 FILE');
  });

  it('a file drag shows the "drop to attach" overlay, and leaving clears it', () => {
    const node = seed();
    renderHarness(node.id);
    const zone = screen.getByTestId(`input-dropzone-${node.id}`);
    fireEvent.dragOver(zone, fileDrag(png()));
    expect(screen.getByTestId(`input-drop-overlay-${node.id}`)).toBeInTheDocument();
    fireEvent.dragLeave(zone, { relatedTarget: document.body });
    expect(screen.queryByTestId(`input-drop-overlay-${node.id}`)).not.toBeInTheDocument();
  });

  it('a non-file drag (a node connection) is ignored', () => {
    const node = seed();
    renderHarness(node.id);
    const zone = screen.getByTestId(`input-dropzone-${node.id}`);
    fireEvent.dragOver(zone, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(screen.queryByTestId(`input-drop-overlay-${node.id}`)).not.toBeInTheDocument();
  });

  it('an oversized drop shows the inline 413 error and attaches nothing', async () => {
    const node = seed();
    const { AceApiError } = await import('@ace/sdk');
    uploadArtifact.mockRejectedValue(
      new AceApiError(413, {
        kind: 'invalid_config',
        code: 'upload_too_large',
        message: 'too big',
        details: { maxBytes: 1024 * 1024 },
        retryable: false,
      }),
    );
    renderHarness(node.id);

    fireEvent.drop(screen.getByTestId(`input-dropzone-${node.id}`), fileDrag(png()));

    const error = await screen.findByTestId(`input-drop-error-${node.id}`);
    expect(error).toHaveAttribute('data-code', 'upload_too_large');
    expect(cachedIds()).toEqual([]);
  });
});
