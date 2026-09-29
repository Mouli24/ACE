import type { Artifact } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentPicker } from './AttachmentPicker';

const uploadArtifact = vi.fn();
vi.mock('../app/api', () => ({ api: () => ({ uploadArtifact }) }));

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  id: 'art-1',
  hash: 'a'.repeat(64),
  mime: 'image/png',
  name: 'sample.png',
  size: 2048,
  createdAt: new Date('2026-01-01').toISOString(),
  ...over,
});

const png = (name = 'sample.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

afterEach(() => {
  uploadArtifact.mockReset();
});

describe('AttachmentPicker (M4 §2, FR-MM-001/007)', () => {
  it('uploads a chosen file and reports the artifact to onUploaded', async () => {
    uploadArtifact.mockResolvedValue(artifact());
    const onUploaded = vi.fn();
    render(<AttachmentPicker onUploaded={onUploaded} />);
    await userEvent.upload(screen.getByTestId('attachment-picker-input'), png());
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(artifact()));
  });

  it('shows a progress bar while the bytes go up', async () => {
    let report: ((p: { loaded: number; total: number; ratio: number }) => void) | undefined;
    uploadArtifact.mockImplementation((_file: File, opts: { onProgress?: typeof report }) => {
      report = opts.onProgress;
      return new Promise<Artifact>(() => {}); // never resolves: stays uploading
    });
    render(<AttachmentPicker onUploaded={vi.fn()} />);
    await userEvent.upload(screen.getByTestId('attachment-picker-input'), png());
    await waitFor(() => expect(screen.getByTestId('attachment-picker-progress')).toBeInTheDocument());
    report?.({ loaded: 512, total: 1024, ratio: 0.5 });
    await waitFor(() =>
      expect(screen.getByTestId('attachment-picker-progress')).toHaveAttribute(
        'aria-valuenow',
        '50',
      ),
    );
  });

  it('TC-MM-001: a 413 is shown inline with the limit', async () => {
    uploadArtifact.mockRejectedValue(
      new AceApiError(413, {
        kind: 'invalid_config',
        code: 'upload_too_large',
        message: 'too big',
        details: { maxBytes: 1024 * 1024 },
        retryable: false,
      }),
    );
    render(<AttachmentPicker onUploaded={vi.fn()} />);
    await userEvent.upload(screen.getByTestId('attachment-picker-input'), png());
    const alert = await screen.findByTestId('attachment-picker-error');
    expect(alert).toHaveAttribute('data-code', 'upload_too_large');
    expect(alert).toHaveTextContent(/1 MB/);
  });

  it('a 415 is shown inline as an unsupported type', async () => {
    uploadArtifact.mockRejectedValue(
      new AceApiError(415, {
        kind: 'invalid_config',
        code: 'unsupported_type',
        message: 'nope',
        retryable: false,
      }),
    );
    render(<AttachmentPicker onUploaded={vi.fn()} />);
    await userEvent.upload(screen.getByTestId('attachment-picker-input'), new File(['x'], 'a.exe'));
    const alert = await screen.findByTestId('attachment-picker-error');
    expect(alert).toHaveAttribute('data-code', 'unsupported_type');
    expect(alert).toHaveTextContent(/type/i);
  });

  it('dismissing the error clears it', async () => {
    uploadArtifact.mockRejectedValue(
      new AceApiError(415, {
        kind: 'invalid_config',
        code: 'unsupported_type',
        message: 'nope',
        retryable: false,
      }),
    );
    render(<AttachmentPicker onUploaded={vi.fn()} />);
    await userEvent.upload(screen.getByTestId('attachment-picker-input'), new File(['x'], 'a.exe'));
    await screen.findByTestId('attachment-picker-error');
    await userEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    expect(screen.queryByTestId('attachment-picker-error')).not.toBeInTheDocument();
  });
});
