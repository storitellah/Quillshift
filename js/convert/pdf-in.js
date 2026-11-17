// Reading PDFs with pdf.js: page images, and text reflowed back into paragraphs.

import { libs, PDFJS_ASSETS } from '../core/loader.js';
import { canvasToBlob, esc, baseName, nextFrame } from '../core/util.js';

export async function openPdf(blob) {
  const pdfjs = await libs.pdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), ...PDFJS_ASSETS, isEvalSupported: false });
  let cancelled = false;
  task.onPassword = (update, reason) => {
    const pw = window.prompt(reason === 2 ? 'That password did not work. Try again:' : 'This PDF is password-protected. Enter its password to open it:');
    if (pw === null) { cancelled = true; task.destroy(); } else update(pw);
  };
  try {
    return await task.promise;
  } catch (e) {
    if (cancelled || e?.name === 'PasswordException') throw new Error('This PDF needs a password to open.');
    throw new Error('This PDF could not be opened. It may be damaged.');
  }
}

const MAX_AREA = 16_000_000;

export async function renderPage(page, scale, canvas = document.createElement('canvas')) {
  let viewport = page.getViewport({ scale });
  if (viewport.width * viewport.height > MAX_AREA) viewport = page.getViewport({ scale: scale * Math.sqrt(MAX_AREA / (viewport.width * viewport.height)) });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
  return canvas;
}

/** @returns {Promise<{blob: Blob, format: string, pages: number}>} one image, or a ZIP of them */
export async function pdfToImages(file, target, opts = {}, onProgress = () => {}) {
  const pdf = await openPdf(file.blob);
  const mime = target === 'png' ? 'image/png' : 'image/jpeg';
  const scale = (Number(opts.dpi) || 150) / 72;
  const base = baseName(file.name);
  const digits = String(pdf.numPages).length;
  const out = {};
  let single = null;
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      onProgress((n - 1) / pdf.numPages, `Rendering page ${n} of ${pdf.numPages}`);
      const page = await pdf.getPage(n);
      const canvas = await renderPage(page, scale);
      const blob = await canvasToBlob(canvas, mime, Number(opts.quality) || 0.85);
      canvas.width = canvas.height = 0;
      page.cleanup();
      if (pdf.numPages === 1) single = blob;
      else out[`${base}-page-${String(n).padStart(digits, '0')}.${target}`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
      await nextFrame();
    }
  } finally { pdf.destroy(); }
  if (single) return { blob: single, format: target, pages: 1 };
  const { zipSync } = await libs.fflate();
  return { blob: new Blob([zipSync(out)], { type: 'application/zip' }), format: 'zip', pages: Object.keys(out).length };
}

/* ---------- text reconstruction ---------- */

const BULLET = /^\s*[•◦▪■●○·‣⁃–\-*\uE000-\uF8FF]\s+/; // includes private-use glyphs from symbol fonts
const NUMBERED = /^\s*(\d{1,3}|[a-z])[.)]\s+\S/;
const mode = (pairs) => { // value with the greatest total weight
  const m = new Map();
  for (const [v, w] of pairs) m.set(v, (m.get(v) || 0) + w);
  let best = null;
  let bw = -1;
  for (const [v, w] of m) if (w > bw) { best = v; bw = w; }
  return best;
};

async function pageLines(page, pageNo) {
  const { items } = await page.getTextContent();
  const { height: pageH, width: pageW } = page.getViewport({ scale: 1 });
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str) continue;
    const [a, b, , , x, y] = it.transform;
    if (Math.abs(b) > Math.abs(a) * 0.3) continue; // rotated text (watermarks, margin notes)
    const size = Math.round(Math.hypot(a, b) * 10) / 10 || it.height || 10;
    const blank = !it.str.trim();
    if (!cur || Math.abs(y - cur.y) >= Math.max(cur.size, size) * 0.45) {
      if (blank) continue;
      cur = { parts: [], y, size, page: pageNo, pageH, pageW, rtl: false };
      lines.push(cur);
    }
    cur.parts.push({ x, end: x + it.width, str: it.str, size });
    if (!blank) cur.size = Math.max(cur.size, size);
    if (it.dir === 'rtl') cur.rtl = true;
  }
  for (const l of lines) {
    // List markers and table cells are often drawn out of order; put each line left to right.
    if (!l.rtl) l.parts.sort((p, q) => p.x - q.x);
    let text = '';
    let prevEnd = null;
    for (const p of l.parts) {
      if (prevEnd !== null && Math.abs(p.x - prevEnd) > p.size * 0.18 && !text.endsWith(' ') && !p.str.startsWith(' ')) text += ' ';
      text += p.str;
      prevEnd = p.end;
    }
    l.text = text.replace(/\s+/g, ' ').trim();
    l.x = Math.min(...l.parts.map((p) => p.x));
    l.end = Math.max(...l.parts.map((p) => p.end));
    // Wide gaps on a line mark table columns.
    l.cells = [];
    let cell = null;
    for (const p of l.parts) {
      if (!p.str.trim()) continue;
      if (!cell || p.x - cell.end > Math.max(p.size * 1.6, 11)) { cell = { x: p.x, end: p.end, text: p.str.trim() }; l.cells.push(cell); }
      else { cell.text += (p.x - cell.end > p.size * 0.18 && !cell.text.endsWith(' ') ? ' ' : '') + p.str.trim(); cell.end = p.end; }
    }
    delete l.parts;
  }
  return lines.filter((l) => l.text);
}

/** Extract a PDF's text and rebuild headings, paragraphs and bullet lists from its geometry. */
export async function pdfToHtml(file, onProgress = () => {}) {
  const pdf = await openPdf(file.blob);
  let lines = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      onProgress((n - 1) / pdf.numPages * 0.9, `Reading page ${n} of ${pdf.numPages}`);
      const page = await pdf.getPage(n);
      lines.push(...await pageLines(page, n));
      page.cleanup();
      if (n % 8 === 0) await nextFrame();
    }
  } finally { pdf.destroy(); }
  if (!lines.length) throw Object.assign(new Error('This PDF has no selectable text — it is a scan.'), { code: 'NO_TEXT' });

  // Running heads, footers and page numbers: short lines in the page margins that repeat.
  const edge = (l) => (l.y < l.pageH * 0.055 || l.y > l.pageH * 0.95) && l.text.length < 90;
  const repeats = new Map();
  for (const l of lines) if (edge(l)) { const k = l.text.replace(/\d+/g, '#'); repeats.set(k, (repeats.get(k) || 0) + 1); }
  const pages = lines[lines.length - 1].page;
  lines = lines.filter((l) => !(edge(l) && (/^(page\s+)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.text) || (pages > 2 && repeats.get(l.text.replace(/\d+/g, '#')) >= Math.max(3, pages * 0.5)))));

  const body = mode(lines.map((l) => [l.size, l.text.length])) || 10;
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (lines[i].page === lines[i - 1].page && lines[i].size === body && lines[i - 1].size === body && g > body * 0.8 && g < body * 2.4) gaps.push([Math.round(g * 2) / 2, 1]);
  }
  const leading = mode(gaps) || body * 1.25;
  const right = new Map();
  for (const l of lines) if (l.size === body) right.set(l.page, Math.max(right.get(l.page) || 0, l.end));

  const blocks = [];
  let cur = null;
  const push = (type, l) => { cur = { type, text: l.text, last: l }; blocks.push(cur); };
  for (const l of lines) {
    const level = l.size >= body * 1.75 ? 1 : l.size >= body * 1.35 ? 2 : l.size >= body * 1.12 ? 3 : 0;
    const prev = cur?.last;
    const samePage = prev && prev.page === l.page;
    const gap = samePage ? prev.y - l.y : 0;
    if (level && l.text.length < 180) {
      if (cur?.type === `h${level}` && samePage && gap < l.size * 1.6 && gap > 0) { cur.text += ' ' + l.text; cur.last = l; } else push(`h${level}`, l);
      continue;
    }
    const bullet = BULLET.test(l.text) && l.text.replace(BULLET, '').length > 0;
    if (bullet) { push('li', { ...l, text: l.text.replace(BULLET, '') }); cur.last = l; continue; }
    const continues = cur && !NUMBERED.test(l.text) && (cur.type === 'p' || cur.type === 'li') && Math.abs(prev.size - l.size) < 0.6 && (
      samePage
        ? gap > 0 && gap < leading * 1.45 && !(l.x > prev.x + body * 0.9 && cur.type === 'p') && !(prev.end < (right.get(prev.page) || 0) - Math.max(body * 6, ((right.get(prev.page) || 0) - prev.x) * 0.2) && cur.type === 'p')
        : !/[.!?:"”]$/.test(prev.text) && cur.type === 'p'
    );
    if (continues) {
      cur.text = /[A-Za-zÀ-ÿ]-$/.test(cur.text) && /^[a-zà-ÿ]/.test(l.text) ? cur.text.slice(0, -1) + l.text : `${cur.text} ${l.text}`;
      cur.last = l;
    } else push('p', l);
  }

  let html = '';
  let inList = false;
  for (const b of blocks) {
    if (b.type === 'li') { if (!inList) { html += '<ul>\n'; inList = true; } html += `<li>${esc(b.text)}</li>\n`; continue; }
    if (inList) { html += '</ul>\n'; inList = false; }
    html += `<${b.type}>${esc(b.text)}</${b.type}>\n`;
  }
  if (inList) html += '</ul>\n';
  onProgress(1);
  const firstHeading = blocks.find((b) => b.type === 'h1' || b.type === 'h2');
  return { html, title: firstHeading && firstHeading.text.length <= 140 ? firstHeading.text : baseName(file.name), pages };
}

const AMOUNT = /^[-+(]?[$€£¥]?\s?\d{1,3}(,\d{3})*(\.\d+)?\)?$|^[-+]?\d+(\.\d+)?$/;

/** Rebuild rows and columns from where text sits on each page: one sheet per page. */
export async function pdfToBook(file, onProgress = () => {}) {
  const pdf = await openPdf(file.blob);
  const sheets = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      onProgress((n - 1) / pdf.numPages, `Reading page ${n} of ${pdf.numPages}`);
      const page = await pdf.getPage(n);
      const lines = (await pageLines(page, n)).sort((a, b) => b.y - a.y);
      page.cleanup();
      // Column positions: left edges that recur across rows, merged when a few points apart.
      const starts = lines.filter((l) => l.cells.length > 1).flatMap((l) => l.cells.map((c) => c.x)).sort((a, b) => a - b);
      const cols = [];
      for (const x of starts) { if (!cols.length || x - cols[cols.length - 1] > 14) cols.push(x); }
      const rows = lines.map((l) => {
        const row = [];
        for (const c of l.cells) {
          let at = 0;
          if (l.cells.length > 1) { for (let i = 0; i < cols.length; i++) if (c.x >= cols[i] - 7) at = i; }
          else { const hit = cols.findIndex((x) => Math.abs(c.x - x) < 7); if (hit > 0) at = hit; } // a wrapped cell's second line
          while (row[at] !== undefined) at++;
          const plain = c.text.replace(/[$€£¥,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
          row[at] = AMOUNT.test(c.text) && plain !== '' && !Number.isNaN(Number(plain)) && !/^0\d/.test(plain) ? Number(plain) : c.text;
        }
        return Array.from(row, (v) => v ?? '');
      });
      const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
      if (rows.length) sheets.push({ name: `Page ${n}`, rows: rows.map((r) => [...r, ...Array(width - r.length).fill('')]) });
      if (n % 8 === 0) await nextFrame();
    }
  } finally { pdf.destroy(); }
  if (!sheets.length) throw Object.assign(new Error('This PDF has no selectable text — it is a scan.'), { code: 'NO_TEXT' });
  return { sheets };
}
