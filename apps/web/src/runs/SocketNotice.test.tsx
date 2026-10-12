import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SocketNotice } from './SocketNotice';

describe('the connection indicator says what is wrong with the connection', () => {
  it('says reconnecting while the socket retries (FR-EXE-014)', () => {
    render(<SocketNotice status="reconnecting" />);
    expect(screen.getByTestId('socket-reconnecting')).toHaveTextContent('reconnecting…');
  });

  it('says this address may not connect after a 4403, and how to fix it (FR-SYS-003, D301)', () => {
    render(<SocketNotice status="forbidden_origin" />);
    const notice = screen.getByRole('alert');
    expect(notice).toHaveAttribute('data-testid', 'socket-forbidden-origin');
    expect(notice).toHaveTextContent('this address may not connect to the engine');
    expect(notice).toHaveAttribute('title', expect.stringContaining('allowedOrigins'));
  });

  it('says nothing while the connection is fine', () => {
    const { container } = render(<SocketNotice status="open" />);
    expect(container).toBeEmptyDOMElement();
  });
});
