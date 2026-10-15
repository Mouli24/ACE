/**
 * PG-0 item 4: the visibility audit run inside the page (no axe-core in the workspace, and Phase 0
 * adds no dependency). A string so it needs no DOM types here; `page.evaluate(IN_PAGE_AUDIT)`
 * answers an `AuditResult`.
 *
 * Contrast is WCAG 2.x relative luminance, on the element's effective background: the nearest
 * ancestors' background colours composited bottom-up (a gradient or image under the text is
 * flagged `approx`), with every ancestor's `opacity` folded into the foreground's alpha.
 */
export interface AuditControl {
  name: string;
  text: string;
  testId: string;
  role: string;
  w: number;
  h: number;
  fg?: string;
  bg?: string;
  ratio?: number;
  approx?: boolean;
  opacity?: number;
}

export interface AuditText {
  text: string;
  fg: string;
  bg: string;
  ratio: number;
  size: number;
  large: boolean;
  approx: boolean;
  testId: string;
}

export interface AuditResult {
  controls: number;
  iconOnly: AuditControl[];
  glyph: AuditControl[];
  unnamed: AuditControl[];
  hidden: AuditControl[];
  small: AuditControl[];
  textContrast: AuditText[];
  iconContrast: AuditControl[];
  borderContrast: AuditControl[];
}

export const IN_PAGE_AUDIT = String.raw`(() => {
  const GLYPH = /[←-⯿\u{1F300}-\u{1FAFF}×⋯…]/u;
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, under) => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const bgOf = (el) => {
    const layers = [];
    let approx = false;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') approx = true;
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let base = [255, 255, 255, 1];
    const html = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (html && html[3] >= 1) base = html;
    for (let i = layers.length - 1; i >= 0; i--) base = layers[i][3] >= 1 ? layers[i] : over(layers[i], base);
    return { bg: base, approx };
  };
  const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none';
  };
  const testIdOf = (el) => { const t = el.closest('[data-testid]'); return t ? t.getAttribute('data-testid') : ''; };
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(' ').map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
    const text = (el.textContent || '').trim();
    if (/[\p{L}\p{N}]/u.test(text)) return text.slice(0, 60);
    return (el.getAttribute('title') || '').trim();
  };
  const out = { controls: 0, iconOnly: [], glyph: [], unnamed: [], hidden: [], small: [], textContrast: [], iconContrast: [], borderContrast: [] };
  const sel = 'button, a[href], [role=button], [role=tab], [role=radio], [role=menuitem], [role=switch], [role=checkbox], [role=combobox], input:not([type=hidden]), select, textarea';
  const seen = new Set();
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el)) continue;
    out.controls++;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    const base = { name: nameOf(el), text: text.slice(0, 40), testId: testIdOf(el), role: el.getAttribute('role') || el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) };
    const key = base.role + '|' + base.name + '|' + base.testId + '|' + base.text;
    const first = !seen.has(key);
    seen.add(key);
    const op = opacityOf(el);
    if (op < 0.05 || cs.visibility === 'hidden') { if (first) out.hidden.push({ ...base, opacity: op }); continue; }
    if (!first) continue;
    const isField = /^(input|select|textarea)$/.test(el.tagName.toLowerCase()) || base.role === 'combobox';
    const iconOnly = !isField && !/[\p{L}\p{N}]/u.test(text.replace(GLYPH, ''));
    if (iconOnly) out.iconOnly.push(base);
    if (GLYPH.test(text)) out.glyph.push(base);
    if (!base.name && !isField) out.unnamed.push(base);
    if ((r.width < 24 || r.height < 24) && base.role !== 'menuitem') out.small.push(base);
    if (disabled) continue;
    const { bg, approx } = bgOf(el.parentElement || el);
    const own = parse(cs.backgroundColor);
    const ground = own && own[3] > 0 ? (own[3] >= 1 ? own : over(own, bg)) : bg;
    if (iconOnly) {
      const fg = parse(cs.color);
      if (fg) {
        const f = over([fg[0], fg[1], fg[2], fg[3] * op], ground);
        const rt = ratio(f, ground);
        if (rt < 3) out.iconContrast.push({ ...base, fg: hex(f), bg: hex(ground), ratio: Math.round(rt * 100) / 100, approx });
      }
    }
    const bw = parseFloat(cs.borderTopWidth);
    const bc = parse(cs.borderTopColor);
    if (bw > 0 && bc && bc[3] > 0 && !(own && own[3] > 0 && ratio(own[3] >= 1 ? own : over(own, bg), bg) >= 3)) {
      const b = over([bc[0], bc[1], bc[2], bc[3] * op], bg);
      const rt = ratio(b, bg);
      if (rt < 3) out.borderContrast.push({ ...base, fg: hex(b), bg: hex(bg), ratio: Math.round(rt * 100) / 100, approx });
    }
  }
  const textSeen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.nodeValue || '').trim();
    if (!t || !/[\p{L}\p{N}]/u.test(t)) continue;
    const el = n.parentElement;
    if (!el || !visible(el)) continue;
    if (el.closest('[aria-hidden=true]') && !el.closest('button,a')) continue;
    if (el.closest('.monaco-editor, .xterm')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') continue;
    const ctl = el.closest('button, [role=button], [role=menuitem], input, textarea');
    if (ctl && (ctl.disabled === true || ctl.getAttribute('aria-disabled') === 'true')) continue;
    if (el.closest('input, textarea')) continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const op = opacityOf(el);
    if (op < 0.05) continue;
    const { bg, approx } = bgOf(el);
    const f = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const rt = ratio(f, bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const bar = large ? 3 : 4.5;
    if (rt >= bar) continue;
    const key = t.slice(0, 30) + hex(f) + hex(bg);
    if (textSeen.has(key)) continue;
    textSeen.add(key);
    out.textContrast.push({ text: t.slice(0, 40), fg: hex(f), bg: hex(bg), ratio: Math.round(rt * 100) / 100, size, large, approx, testId: testIdOf(el) });
  }
  return out;
})()`;
