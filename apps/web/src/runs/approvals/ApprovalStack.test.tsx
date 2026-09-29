import type { ApprovalRequest } from '@ace/contracts';
import { screen } from '@testing-library/react';

import { renderWithQuery, installMockServer } from '../../test/app';
import { ApprovalStack } from './ApprovalStack';

/**
 * The approval card's destructive-tool preview (round 4 §5 item 8, FR-GRD-006, BR-14): a
 * `destructive_action` request names the tool and the args it wants to run, above the card.
 */

installMockServer();

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'REQ1',
    runId: 'RUN1',
    nodeRunId: 'NR1',
    nodeId: 'N1',
    nodeName: 'Cleaner',
    point: 'tool',
    checkType: 'destructive_action',
    reason: 'sandbox_delete is destructive and needs approval.',
    preview: 'sandbox_delete {"path":"notes.txt"}',
    requestedAt: '2026-09-29T10:00:00.000Z',
    ...over,
  };
}

describe('FR-GRD-006 the approval card previews a destructive tool call', () => {
  it('names the tool and shows its args for a destructive_action request', () => {
    renderWithQuery(<ApprovalStack requests={[request()]} />);

    const preview = screen.getByTestId('approval-tool-preview');
    expect(preview).toBeInTheDocument();
    expect(screen.getByTestId('approval-tool-name')).toHaveTextContent('sandbox_delete');
    expect(screen.getByTestId('approval-tool-args')).toHaveTextContent('"path":"notes.txt"');
  });

  it('shows no tool preview for a non-tool approval', () => {
    renderWithQuery(
      <ApprovalStack
        requests={[
          request({
            id: 'REQ2',
            point: 'output',
            checkType: 'pii',
            preview: 'contact [email redacted] for details',
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId('approval-tool-preview')).not.toBeInTheDocument();
    // The card itself still renders.
    expect(screen.getByTestId('approval-card-NR1')).toBeInTheDocument();
  });
});
