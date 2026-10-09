import { describe, expect, it } from 'vitest';

import { decideLink, engineOrigins, type ShellOrigins } from '../navigation.js';

const TOKEN = 'a'.repeat(64);

const DEV: ShellOrigins = {
  app: 'http://localhost:5173',
  engine: engineOrigins('http://127.0.0.1:4747'),
  token: TOKEN,
};

const PACKAGED: ShellOrigins = {
  app: 'http://127.0.0.1:51234',
  engine: engineOrigins('http://127.0.0.1:51234'),
  token: TOKEN,
};

describe('FR-DSK-002 where a link may take the window (D294)', () => {
  it('engineOrigins: both loopback spellings at the engine’s port', () => {
    expect(engineOrigins('http://127.0.0.1:4747')).toEqual([
      'http://127.0.0.1:4747',
      'http://localhost:4747',
    ]);
  });

  it('the app’s own origin stays in the window', () => {
    expect(decideLink('http://localhost:5173/projects/p1', DEV)).toBe('allow');
    expect(decideLink('http://127.0.0.1:51234/help/start', PACKAGED)).toBe('allow');
  });

  it('artifact content on the engine is downloaded, in dev and packaged alike', () => {
    const content = `/api/v1/artifacts/art_1/content?token=${TOKEN}`;
    expect(decideLink(`http://127.0.0.1:4747${content}`, DEV)).toBe('download');
    expect(decideLink(`http://localhost:4747${content}`, DEV)).toBe('download');
    expect(decideLink(`http://127.0.0.1:51234${content}`, PACKAGED)).toBe('download');
  });

  it('the engine’s other routes are never opened as pages', () => {
    expect(decideLink('http://127.0.0.1:4747/api/v1/health', DEV)).toBe('deny');
    expect(decideLink('http://127.0.0.1:51234/api/v1/settings', PACKAGED)).toBe('deny');
    expect(decideLink('http://127.0.0.1:4747/', DEV)).toBe('deny');
  });

  it('other http(s) and mailto links go to the default browser or mail client', () => {
    expect(decideLink('https://docs.anthropic.com/en/docs', DEV)).toBe('external');
    expect(decideLink('http://example.com/a?b=c', PACKAGED)).toBe('external');
    expect(decideLink('mailto:someone@example.com', DEV)).toBe('external');
    // Vite's other spelling is not the app origin.
    expect(decideLink('http://127.0.0.1:5173/', DEV)).toBe('external');
  });

  it('a URL holding the session token never leaves the app, encoded or not', () => {
    expect(decideLink(`https://evil.example/?t=${TOKEN}`, DEV)).toBe('deny');
    expect(decideLink(`https://evil.example/${TOKEN}`, PACKAGED)).toBe('deny');
    const encoded = TOKEN.split('')
      .map((c) => `%${c.charCodeAt(0).toString(16)}`)
      .join('');
    expect(decideLink(`https://evil.example/?t=${encoded}`, DEV)).toBe('deny');
    expect(decideLink('https://evil.example/?t=%E0%A4%A', DEV)).toBe('deny');
  });

  it('without a token known yet, an external link still goes out', () => {
    expect(decideLink('https://example.com/', { ...DEV, token: undefined })).toBe('external');
  });

  it('everything else is refused', () => {
    expect(decideLink('file:///C:/Windows/win.ini', DEV)).toBe('deny');
    expect(decideLink('javascript:alert(1)', DEV)).toBe('deny');
    expect(decideLink('data:text/html,<p>x</p>', DEV)).toBe('deny');
    expect(decideLink('not a url', DEV)).toBe('deny');
    expect(decideLink('chrome://settings', DEV)).toBe('deny');
  });
});
