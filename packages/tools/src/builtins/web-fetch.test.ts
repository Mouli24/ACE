import { afterEach, describe, expect, it } from 'vitest';

import { startHttpServer, makeContext } from '../__tests__/helpers.js';
import { WEB_FETCH_BODY_CAP_BYTES, WEB_FETCH_TEXT_CAP, createWebFetchTool, extractReadable } from './web-fetch.js';

// The test servers listen on 127.0.0.1, which only an IP entry on the allow-list reaches [audit S-2].
const context = makeContext({ allowedDomains: ['127.0.0.1'] });
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const tool = createWebFetchTool();

describe('extractReadable', () => {
  it('takes the title and strips scripts, styles and tags', () => {
    const html = `<html><head><title>Hi &amp; Bye</title><style>.x{}</style></head>
      <body><script>evil()</script><p>Hello <b>world</b>.</p></body></html>`;
    const { title, text } = extractReadable(html);
    expect(title).toBe('Hi & Bye');
    expect(text).toContain('Hello');
    expect(text).toContain('world');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('.x{}');
  });
});

describe('TC-TOOL-005 web_fetch', () => {
  it('fetches a page and returns its title and readable text', async () => {
    const server = await startHttpServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<title>Doc</title><body><h1>Heading</h1><p>Body text here.</p></body>');
    });
    close = server.close;

    const result = (await tool.implementation({ url: server.url }, context)) as { title: string; text: string };
    expect(result.title).toBe('Doc');
    expect(result.text).toContain('Heading');
    expect(result.text).toContain('Body text here.');
  });

  it('caps the text at 100k characters', async () => {
    const server = await startHttpServer((_req, res) => {
      res.end(`<body>${'a'.repeat(WEB_FETCH_TEXT_CAP + 5_000)}</body>`);
    });
    close = server.close;
    const result = (await tool.implementation({ url: server.url }, context)) as { text: string };
    expect(result.text.length).toBeLessThanOrEqual(WEB_FETCH_TEXT_CAP);
  });

  it('stops reading an endless body at the cap instead of holding it all [audit S-2]', async () => {
    let written = 0;
    const server = await startHttpServer((_req, res) => {
      const chunk = `<p>${'b'.repeat(64 * 1024)}</p>`;
      const pump = (): void => {
        // Writes until the reader hangs up; a reader that never stops would see no end.
        while (!res.destroyed && written < WEB_FETCH_BODY_CAP_BYTES * 4) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    close = server.close;

    const result = (await tool.implementation({ url: server.url }, context)) as { text: string };
    expect(result.text.length).toBeLessThanOrEqual(WEB_FETCH_TEXT_CAP);
    expect(written).toBeLessThan(WEB_FETCH_BODY_CAP_BYTES * 4);
  });

  it('follows a redirect on the allow-list and refuses one off it [audit S-2]', async () => {
    const page = await startHttpServer((_req, res) => res.end('<head><title>Moved</title></head><p>arrived</p>'));
    const hop = await startHttpServer((req, res) => {
      res.writeHead(302, { location: req.url === '/off' ? 'http://example.org/' : page.url });
      res.end();
    });
    close = async () => {
      await hop.close();
      await page.close();
    };

    const result = (await tool.implementation({ url: hop.url }, context)) as { title: string; text: string };
    expect(result).toMatchObject({ title: 'Moved', text: 'arrived' });
    await expect(tool.implementation({ url: `${hop.url}/off` }, context)).rejects.toMatchObject({ kind: 'denied' });
  });

  it('decodes numeric HTML entities', () => {
    expect(extractReadable('<body>&#65;&#66;&amp;C</body>').text).toBe('AB&C');
  });

  it('refuses a non-http scheme', async () => {
    await expect(tool.implementation({ url: 'file:///etc/passwd' }, context)).rejects.toMatchObject({
      kind: 'invalid_args',
    });
  });

  it('reports a failure when the host cannot be reached', async () => {
    // Port 1 on localhost refuses at once.
    await expect(tool.implementation({ url: 'http://127.0.0.1:1' }, context)).rejects.toMatchObject({
      kind: 'failed',
    });
  });

  it('reports a timeout when the server stalls', async () => {
    const server = await startHttpServer(() => {
      // Never responds.
    });
    close = server.close;
    const fast = createWebFetchTool({ timeoutMs: 200 });
    await expect(fast.implementation({ url: server.url }, context)).rejects.toMatchObject({ kind: 'timeout' });
  });
});
