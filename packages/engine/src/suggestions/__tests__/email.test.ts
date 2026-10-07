import { describe, expect, it } from 'vitest';

import { decodeHeader, htmlToText, parseEmail } from '../email.js';

describe('D282 reading an .eml', () => {
  it('reads a plain message with folded headers', () => {
    const parsed = parseEmail(
      [
        'From: Ann Lee <ann@example.com>',
        'To: support@shop.test',
        'Subject: Search is',
        '  very slow',
        'Date: Tue, 6 Oct 2026 09:30:00 +0000',
        '',
        'Typing in search takes 3 seconds.',
        'Can you look?',
      ].join('\r\n'),
    );
    expect(parsed).toEqual({
      from: 'Ann Lee <ann@example.com>',
      to: 'support@shop.test',
      subject: 'Search is very slow',
      date: 'Tue, 6 Oct 2026 09:30:00 +0000',
      text: 'Typing in search takes 3 seconds.\nCan you look?',
    });
  });

  it('decodes encoded words, quoted-printable and base64', () => {
    expect(decodeHeader('=?utf-8?B?Q2Fmw6k=?= =?iso-8859-1?Q?d=E9j=E0_vu?=')).toBe('Cafédéjà vu');
    const parsed = parseEmail(
      [
        'From: a@b.c',
        'Subject: =?utf-8?Q?R=C3=A9sum=C3=A9?=',
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Caf=C3=A9 is open, soft=',
        'break joined.',
      ].join('\n'),
    );
    expect(parsed.subject).toBe('Résumé');
    expect(parsed.text).toBe('Café is open, softbreak joined.');
  });

  it('prefers the plain part of a multipart message and drops attachments', () => {
    const parsed = parseEmail(
      [
        'From: a@b.c',
        'Subject: Report',
        'Content-Type: multipart/mixed; boundary="outer"',
        '',
        '--outer',
        'Content-Type: multipart/alternative; boundary=inner',
        '',
        '--inner',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('The plain text.').toString('base64'),
        '--inner',
        'Content-Type: text/html',
        '',
        '<p>The <b>html</b> text.</p>',
        '--inner--',
        '--outer',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="secret.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQ=',
        '--outer--',
      ].join('\r\n'),
    );
    expect(parsed.text).toBe('The plain text.');
  });

  it('reduces HTML to text when there is no plain part', () => {
    expect(
      htmlToText('<p>Hi&nbsp;there</p><p>Line&#33;<br>Next &amp; last</p><style>p{}</style>'),
    ).toBe('Hi there\nLine!\nNext & last\n');
    const parsed = parseEmail(
      ['From: a@b.c', 'Content-Type: text/html', '', '<div>Only <i>html</i></div>'].join('\n'),
    );
    expect(parsed.text).toBe('Only html');
  });
});
