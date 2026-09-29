import type { Part } from '@ace/contracts';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { CodeBlock, highlight } from '../components/code-block.js';
import { JsonTree } from '../components/json-tree.js';
import { Markdown } from '../components/markdown.js';
import { PartRenderer } from '../components/part-renderer.js';
import { formatBytes } from '../lib/format.js';

const ART = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const contentUrl = (id: string) => `/api/v1/artifacts/${id}/content?token=t`;

describe('TC-MM-006 typed output renderers, one per data type', () => {
  it('text → Markdown with headings, emphasis, lists and a fenced code block', () => {
    render(
      <Markdown text={'# Title\n\nSome **bold** and *italic* and `inline`.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```'} />,
    );
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
  });

  it('Markdown makes http links but never a javascript: link', () => {
    render(<Markdown text={'[safe](https://example.com) and [bad](javascript:alert(1))'} />);
    const link = screen.getByRole('link', { name: 'safe' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    // The unsafe link is rendered as text, not as an anchor.
    expect(screen.queryByRole('link', { name: 'bad' })).not.toBeInTheDocument();
    expect(screen.getByTestId('markdown')).toHaveTextContent('[bad](javascript:alert(1))');
  });

  it('code → highlighted, and the highlighter never changes a byte of the source', () => {
    const source = 'function add(a, b) {\n  // sum\n  return a + b; // 42\n}\nconst s = "hi";';
    render(<CodeBlock language="javascript" text={source} />);
    const body = screen.getByTestId('code-body');
    expect(body).toHaveTextContent('function');
    // Text integrity: the concatenation of every token equals the input.
    expect(body.textContent).toBe(source);
    expect(screen.getByTestId('code-block')).toHaveAttribute('data-language', 'javascript');
  });

  it('highlight() preserves text for tricky inputs (empty, only-string, unicode)', () => {
    for (const s of ['', '"only a string"', 'π = 3.14 // note', 'no tokens here at all']) {
      const joined = highlight(s)
        .map((node) => (typeof node === 'string' ? node : ''))
        .join('');
      // Rendered spans also carry text; assert via a render for the full guarantee.
      const { container, unmount } = render(<CodeBlock language="text" text={s} />);
      expect(container.querySelector('[data-testid="code-body"]')?.textContent).toBe(s);
      expect(joined.length).toBeLessThanOrEqual(s.length);
      unmount();
    }
  });

  it('copy button writes the source to the clipboard', async () => {
    const user = userEvent.setup();
    // userEvent installs a clipboard stub on setup(); spy on its writeText.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<CodeBlock language="ts" text={'const a = 1;'} />);
    await user.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('const a = 1;');
    writeText.mockRestore();
  });

  it('json → collapsible tree with a node per nested container and primitives shown', () => {
    render(<JsonTree value={{ name: 'ace', nested: { deep: [1, 2] }, ok: true }} />);
    expect(screen.getByTestId('json-tree')).toBeInTheDocument();
    // Root object + nested object + inner array = at least 3 disclosure nodes.
    expect(screen.getAllByTestId('json-node').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('"ace"')).toBeInTheDocument();
    expect(screen.getByText('true')).toBeInTheDocument();
  });

  it('image → an <img> whose src comes from contentUrl, and a zoom toggle', async () => {
    const part: Part = { type: 'image', artifactId: ART, mime: 'image/png', name: 'shot.png', size: 10 };
    const user = userEvent.setup();
    render(<PartRenderer part={part} contentUrl={contentUrl} />);
    const img = screen.getByRole('img', { name: 'shot.png' });
    expect(img).toHaveAttribute('src', contentUrl(ART));
    const toggle = screen.getByRole('button', { name: /zoom in/i });
    await user.click(toggle);
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
  });

  it('audio and video → native players with a plain src (Range-friendly)', () => {
    const audio: Part = { type: 'audio', artifactId: ART, mime: 'audio/mpeg', name: 'a.mp3', size: 5 };
    const video: Part = { type: 'video', artifactId: ART, mime: 'video/mp4', name: 'v.mp4', size: 9 };
    const { rerender } = render(<PartRenderer part={audio} contentUrl={contentUrl} />);
    expect(screen.getByTestId('audio-el')).toHaveAttribute('src', contentUrl(ART));
    rerender(<PartRenderer part={video} contentUrl={contentUrl} />);
    expect(screen.getByTestId('video-el')).toHaveAttribute('src', contentUrl(ART));
  });

  it('file → a download card with name, size, mime, hash and a download href', () => {
    const part: Part = {
      type: 'file',
      artifactId: ART,
      mime: 'application/zip',
      name: 'bundle.zip',
      size: 2048,
    };
    render(<PartRenderer part={part} contentUrl={contentUrl} hash={'a'.repeat(64)} />);
    const card = screen.getByTestId('file-card');
    expect(card).toHaveAttribute('href', contentUrl(ART));
    expect(card).toHaveAttribute('download', 'bundle.zip');
    expect(card).toHaveTextContent('bundle.zip');
    expect(card).toHaveTextContent(formatBytes(2048));
    expect(screen.getByTestId('file-hash')).toBeInTheDocument();
  });

  it('a media part with no contentUrl still names the file instead of vanishing', () => {
    const part: Part = { type: 'file', artifactId: ART, mime: 'application/zip', name: 'x.zip', size: 3 };
    render(<PartRenderer part={part} />);
    expect(screen.getByTestId('part-missing-url')).toHaveTextContent('x.zip');
  });
});

describe('Markdown covers the block kinds an agent answer uses', () => {
  it('ordered lists, blockquotes, thematic breaks, underscore italic and soft line breaks', () => {
    const { container } = render(
      <Markdown
        text={'1. first\n2. second\n\n> a quote\n> continued\n\n---\n\nplain _under_ text\nsecond line'}
      />,
    );
    expect(container.querySelector('ol')?.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('blockquote')).toBeInTheDocument();
    expect(container.querySelector('hr')).toBeInTheDocument();
    expect(screen.getByText('under').tagName).toBe('EM');
    // The soft line break inside a paragraph becomes a <br>.
    expect(container.querySelector('p br')).toBeInTheDocument();
  });
});

describe('renderers hold at 380 px (NFR-USE-03)', () => {
  it('media and code use wrapping/overflow classes so nothing forces horizontal scroll on the page', () => {
    const image: Part = { type: 'image', artifactId: ART, mime: 'image/png', name: 'p.png', size: 1 };
    const { container, rerender } = render(
      <div style={{ width: 380 }}>
        <PartRenderer part={image} contentUrl={contentUrl} />
      </div>,
    );
    expect(container.querySelector('img')?.className).toContain('max-w-full');

    rerender(
      <div style={{ width: 380 }}>
        <PartRenderer part={{ type: 'code', language: 'ts', text: 'x'.repeat(500) }} />
      </div>,
    );
    expect(container.querySelector('pre')?.className).toContain('overflow-x-auto');

    rerender(
      <div style={{ width: 380 }}>
        <PartRenderer part={{ type: 'text', text: 'word '.repeat(200) }} />
      </div>,
    );
    expect(container.querySelector('[data-testid="markdown"]')?.className).toContain('break-words');
  });
});

describe('formatBytes', () => {
  it('scales through the units and guards bad input', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
    expect(formatBytes(-1)).toBe('—');
  });
});
