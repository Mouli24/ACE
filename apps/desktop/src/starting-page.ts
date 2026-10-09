/**
 * The small local page the window shows before the app loads: "Starting ACE…", or what the dev
 * window is still waiting for. A `data:` URL, so nothing is fetched and there is no file to package.
 * The colours are the Night theme's canvas and text (`@ace/ui` theme.css).
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function startingPageHtml(title: string, detail?: string): string {
  const body = detail === undefined ? '' : `<p>${escapeHtml(detail)}</p>`;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ACE</title>',
    '<style>',
    'html,body{height:100%;margin:0}',
    'body{display:flex;align-items:center;justify-content:center;background:#0a0a0b;color:#e7e5e0;',
    'font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}',
    'main{max-width:34rem;padding:2rem;text-align:center}',
    'h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}',
    'p{margin:0;color:#9b9890}',
    '</style></head><body><main>',
    `<h1>${escapeHtml(title)}</h1>${body}`,
    '</main></body></html>',
  ].join('');
}

export function startingPageUrl(title: string, detail?: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(startingPageHtml(title, detail))}`;
}
