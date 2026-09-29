import type { Artifact } from '@ace/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AttachmentList } from './AttachmentList';

const getArtifact = vi.fn();
const artifactContentUrl = vi.fn((id: string) => `http://mock.local/api/v1/artifacts/${id}/content?token=t`);
vi.mock('../app/api', () => ({ api: () => ({ getArtifact, artifactContentUrl }) }));

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  id: 'art-1',
  hash: 'a'.repeat(64),
  mime: 'image/png',
  name: 'sample.png',
  size: 2048,
  createdAt: new Date('2026-01-01').toISOString(),
  ...over,
});

function renderList(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('AttachmentList (M4 §2, FR-MM-006/009)', () => {
  it('renders name, size and mime for each attachment', async () => {
    getArtifact.mockResolvedValue(artifact());
    renderList(<AttachmentList artifactIds={['art-1']} />);
    expect(await screen.findByText('sample.png')).toBeInTheDocument();
    expect(screen.getByText(/2 KB · image\/png/)).toBeInTheDocument();
  });

  it('offers a download link to the content URL (FR-MM-009)', async () => {
    getArtifact.mockResolvedValue(artifact());
    renderList(<AttachmentList artifactIds={['art-1']} />);
    const link = await screen.findByTestId('attachment-download-art-1');
    expect(link).toHaveAttribute('href', expect.stringContaining('/artifacts/art-1/content'));
    expect(link).toHaveAttribute('download', 'sample.png');
  });

  it('remove calls onRemove with the artifact id', async () => {
    getArtifact.mockResolvedValue(artifact());
    const onRemove = vi.fn();
    renderList(<AttachmentList artifactIds={['art-1']} onRemove={onRemove} />);
    await screen.findByText('sample.png');
    await userEvent.click(screen.getByTestId('attachment-remove-art-1'));
    expect(onRemove).toHaveBeenCalledWith('art-1');
  });

  it('renders nothing when there are no attachments', () => {
    const { container } = renderList(<AttachmentList artifactIds={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('read-only (no onRemove) shows no remove control', async () => {
    getArtifact.mockResolvedValue(artifact());
    renderList(<AttachmentList artifactIds={['art-1']} />);
    await screen.findByText('sample.png');
    await waitFor(() =>
      expect(screen.queryByTestId('attachment-remove-art-1')).not.toBeInTheDocument(),
    );
  });
});
