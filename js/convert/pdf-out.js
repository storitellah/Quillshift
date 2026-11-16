// HTML → PDF, two ways:
//   text      real, selectable, searchable text laid out by pdfmake (small files)
//   snapshot  the page as the browser draws it, for scripts the bundled font
//             cannot write (Chinese, Arabic, Hindi, emoji …)
// "auto" picks text whenever every letter in the document can be written.

import { libs } from '../core/loader.js';
import { loadImage, canvasToBlob, blobToDataURL, nextFrame } from '../core/util.js';
import { pageGeometry } from './page.js';
import { ROBOTO_RANGES } from './roboto-coverage.js';

function covered(cp) {
  if (cp === 9 || cp === 10 || cp === 13) return true;
  let lo = 0;
  let hi = ROBOTO_RANGES.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ROBOTO_RANGES[mid * 2]) hi = mid - 1;
    else if (cp > ROBOTO_RANGES[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

const SUBSTITUTES = { '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇐': '<=', '➜': '->', '➔': '->', '✓': '√', '✔': '√', '☑': '[x]', '☐': '[ ]', '✗': 'x', '✘': 'x', '★': '*', '☆': '*', '▪': '•', '■': '•', '●': '•', '○': '◦', '‣': '•', '⁃': '-', '−': '-', '‑': '-', ' ': '\n', ' ': '\n' };
const LETTER = /\p{L}/u;

/** Does this text contain letters the text renderer cannot draw? */
export function needsSnapshot(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp > 0x7e && !covered(cp) && LETTER.test(ch)) return true;
  }
  return false;
}

function writable(text) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7e || covered(cp)) out += ch;
    else if (SUBSTITUTES[ch]) out += [...SUBSTITUTES[ch]].every((c) => covered(c.codePointAt(0))) ? SUBSTITUTES[ch] : '';
    else if (/\s/u.test(ch)) out += ' ';
    // anything else (emoji, dingbats, joiners) has no glyph and is dropped
  }
  return out;
}

/* ---------- text renderer ---------- */

const STYLES = {
  h1: { fontSize: 23, bold: true, marginTop: 6, marginBottom: 10, lineHeight: 1.15 },
  h2: { fontSize: 17, bold: true, marginTop: 14, marginBottom: 7, lineHeight: 1.2 },
  h3: { fontSize: 13.5, bold: true, marginTop: 12, marginBottom: 5, lineHeight: 1.2 },
  h4: { fontSize: 11.5, bold: true, marginTop: 10, marginBottom: 4 },
  h5: { fontSize: 11, bold: true, marginTop: 8, marginBottom: 4 },
  h6: { fontSize: 11, bold: true, italics: true, marginTop: 8, marginBottom: 4 },
  p: { margin: [0, 0, 0, 8] },
  ul: { marginBottom: 8 },
  ol: { marginBottom: 8 },
  li: { marginLeft: 4, marginBottom: 2 },
  a: { color: '#b8321a', decoration: 'underline' },
  blockquote: { margin: [16, 2, 0, 8], italics: true, color: '#55536a' },
  pre: { margin: [0, 2, 0, 10] },
  code: { fontSize: 9.5 },
  th: { bold: true, fillColor: '#f1ece1' },
  table: { marginBottom: 10 },
  mark: { background: '#fff2a8' },
};

async function prepareImages(root, maxWidth, maxHeight) {
  for (const img of [...root.querySelectorAll('img')]) {
    try {
      const el = await loadImage(img.getAttribute('src'));
      const nw = el.naturalWidth || 300;
      const nh = el.naturalHeight || 150;
      // CSS pixels → points, then fit inside the text block.
      let w = nw * 0.75;
      let h = nh * 0.75;
      const s = Math.min(1, maxWidth / w, maxHeight / h);
      w *= s; h *= s;
      // pdfmake embeds PNG and JPEG only; shrink anything far larger than it will print.
      const src = img.getAttribute('src');
      const oversize = nw > w * 3.2;
      if (oversize || !/^data:image\/(png|jpeg)/i.test(src)) {
        const scale = oversize ? (w * 3) / nw : 1;
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(nw * scale));
        c.height = Math.max(1, Math.round(nh * scale));
        const jpeg = /^data:image\/jpe?g/i.test(src);
        const ctx = c.getContext('2d');
        if (jpeg) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
        ctx.drawImage(el, 0, 0, c.width, c.height);
        img.setAttribute('src', await blobToDataURL(await canvasToBlob(c, jpeg ? 'image/jpeg' : 'image/png', 0.86)));
      }
      img.setAttribute('width', String(Math.round(w)));
      img.setAttribute('height', String(Math.round(h)));
    } catch { img.remove(); }
  }
}

const TABLE_LAYOUT = {
  hLineWidth: () => 0.6, vLineWidth: () => 0.6,
  hLineColor: () => '#cfc7b6', vLineColor: () => '#cfc7b6',
  paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 4, paddingBottom: () => 4,
};

/** Tidy what html-to-pdfmake produced: tables that fit the page, shaded code blocks. */
function tune(node) {
  if (Array.isArray(node)) return node.map(tune);
  if (!node || typeof node !== 'object') return node;
  if (node.nodeName === 'PRE') {
    const plain = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(plain).join('') : n?.text !== undefined ? plain(n.text) : '');
    return {
      table: { widths: ['*'], body: [[{ text: plain(node).replace(/\n$/, ''), font: 'Mono', fontSize: 9, lineHeight: 1.25, preserveLeadingSpaces: true, color: '#1c1b29' }]] },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 9, paddingRight: () => 9, paddingTop: () => 7, paddingBottom: () => 7, fillColor: () => '#f4f0e7' },
      margin: [0, 2, 0, 10],
    };
  }
  if (node.nodeName === 'CODE' || node.nodeName === 'KBD' || node.nodeName === 'SAMP') node.font = 'Mono';
  if (node.table) {
    const cols = Math.max(1, ...node.table.body.map((r) => r.length));
    node.table.widths = Array(cols).fill('*');
    node.table.dontBreakRows = true;
    node.layout = TABLE_LAYOUT;
    if (cols > 5) node.fontSize = cols > 8 ? 7.5 : 9;
    if (node.table.body[0]?.some((c) => c?.nodeName === 'TH')) node.table.headerRows = 1;
  }
  for (const key of ['text', 'stack', 'ul', 'ol', 'columns']) if (Array.isArray(node[key])) node[key] = node[key].map(tune);
  if (node.table) node.table.body = node.table.body.map((row) => row.map(tune));
  return node;
}

async function textPdf(html, title, opts, onProgress) {
  onProgress(0.05, 'Loading the PDF writer');
  const { pdfMake, htmlToPdfmake } = await libs.pdfmake();
  const geo = pageGeometry(opts);
  const root = document.createElement('div');
  root.innerHTML = html;
  onProgress(0.2, 'Preparing images');
  await prepareImages(root, geo.contentWidth, geo.contentHeight - 30);

  // Courier is one of the PDF base fonts and can only write Latin-1.
  let monoSafe = true;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    n.nodeValue = writable(n.nodeValue);
    if (monoSafe && n.parentElement.closest('pre, code, kbd, samp') && /[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/.test(n.nodeValue)) monoSafe = false;
  }
  // Layout whitespace between blocks would otherwise become blank lines.
  const blanks = [];
  const ws = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = ws.nextNode(); n; n = ws.nextNode()) {
    if (!n.nodeValue.trim() && !n.parentElement.closest('pre') && /^(DIV|BLOCKQUOTE|UL|OL|LI|TABLE|THEAD|TBODY|TR|TD|TH|SECTION|ARTICLE|FIGURE|DL)$/.test(n.parentElement.tagName)) blanks.push(n);
  }
  for (const n of blanks) n.remove();
  for (const cell of root.querySelectorAll('td, th')) {
    if (cell.children.length === 1 && cell.firstElementChild.tagName === 'P' && cell.childNodes.length === 1) cell.firstElementChild.replaceWith(...cell.firstElementChild.childNodes);
  }
  for (const bq of root.querySelectorAll('blockquote')) {
    if (bq.children.length === 1 && bq.firstElementChild.tagName === 'P') bq.firstElementChild.replaceWith(...bq.firstElementChild.childNodes);
  }
  for (const list of root.querySelectorAll('li ul, li ol')) list.setAttribute('data-pdfmake', '{"marginBottom":0}');
  for (const hr of root.querySelectorAll('hr')) hr.setAttribute('data-pdfmake', '{"width":' + Math.floor(geo.contentWidth) + ',"thickness":0.6,"color":"#cfc7b6","margin":[0,10,0,14]}');

  onProgress(0.35, 'Laying out pages');
  await nextFrame();
  const content = tune(htmlToPdfmake(root.innerHTML, { defaultStyles: STYLES, removeExtraBlanks: true }));
  const roboto = { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' };
  const fonts = {
    Roboto: roboto,
    Mono: monoSafe ? { normal: 'Courier', bold: 'Courier-Bold', italics: 'Courier-Oblique', bolditalics: 'Courier-BoldOblique' } : roboto,
  };
  const m = geo.margin;
  const dd = {
    info: { title, creator: 'Quillshift', producer: 'Quillshift (pdfmake)' },
    pageSize: { width: geo.width, height: geo.height },
    pageMargins: [m, m, m, m],
    content,
    defaultStyle: { font: 'Roboto', fontSize: 10.8, lineHeight: 1.32, color: '#1c1b29' },
    footer: opts.pageNumbers ? (page, pages) => ({ text: `${page} / ${pages}`, alignment: 'center', fontSize: 8, color: '#8a879b', margin: [0, m / 2 - 6, 0, 0] }) : undefined,
  };
  return new Promise((resolve, reject) => {
    // pdfmake reports layout errors as unhandled rejections; catch them for this job.
    const fail = (e) => { e.preventDefault?.(); done(); reject(new Error(`The document could not be laid out as a PDF (${e.reason?.message || e.reason || e.message || 'unknown error'}). Try the “Snapshot” PDF style.`)); };
    const done = () => window.removeEventListener('unhandledrejection', fail);
    window.addEventListener('unhandledrejection', fail);
    try {
      pdfMake.createPdf(dd, null, fonts).getBlob((blob) => { done(); onProgress(1); resolve(blob); });
    } catch (e) { fail(e); }
  });
}

/* ---------- snapshot renderer ---------- */

const SHEET_CSS = `
.qs-sheet{position:absolute;left:-12000px;top:0;box-sizing:border-box;background:#fff;color:#1c1b29;font:15px/1.6 Charter,"Iowan Old Style","Palatino Linotype","Noto Serif",Georgia,"Songti SC","Noto Serif CJK SC",serif;overflow-wrap:break-word;text-align:start}
.qs-sheet *{box-sizing:border-box;max-width:100%}
.qs-sheet h1,.qs-sheet h2,.qs-sheet h3,.qs-sheet h4{line-height:1.25;margin:1.3em 0 .5em;font-weight:700}
.qs-sheet h1{font-size:2em;margin-top:0}.qs-sheet h2{font-size:1.5em}.qs-sheet h3{font-size:1.2em}
.qs-sheet p,.qs-sheet ul,.qs-sheet ol,.qs-sheet blockquote,.qs-sheet pre,.qs-sheet table{margin:0 0 .9em}
.qs-sheet ul,.qs-sheet ol{padding-left:1.6em}.qs-sheet img{height:auto;display:block}
.qs-sheet a{color:#b8321a}.qs-sheet blockquote{padding-left:1em;border-left:3px solid #d8cfbd;color:#55536a}
.qs-sheet pre,.qs-sheet code{font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace}.qs-sheet pre{padding:.8em;background:#f4f0e7;white-space:pre-wrap}
.qs-sheet table{border-collapse:collapse;width:100%;font-size:.88em}.qs-sheet th,.qs-sheet td{border:1px solid #cfc7b6;padding:.35em .55em;text-align:start;vertical-align:top}.qs-sheet th{background:#f1ece1}
.qs-sheet hr{border:0;border-top:1px solid #cfc7b6;margin:1.6em 0}`;

function pageBreaks(host, pageH) {
  const top0 = host.getBoundingClientRect().top;
  const boxes = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.height > 0) boxes.push([r.top - top0, r.bottom - top0]);
  }
  for (const el of host.querySelectorAll('img, tr, li')) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.height < pageH * 0.6) boxes.push([r.top - top0, r.bottom - top0]);
  }
  const heads = [...host.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => { const r = h.getBoundingClientRect(); return [r.top - top0, r.bottom - top0]; });
  boxes.sort((a, b) => a[0] - b[0]);
  const total = Math.ceil(host.getBoundingClientRect().height);
  const cuts = [0];
  let y = 0;
  while (y + pageH < total) {
    let cut = y + pageH;
    for (let guard = 0; guard < 40; guard++) {
      let moved = false;
      for (const [t, b] of boxes) {
        if (t >= cut) break;
        if (b > cut && b - t < pageH * 0.9) { cut = Math.floor(t) - 1; moved = true; break; }
      }
      if (!moved) break;
    }
    for (const [t, b] of heads) if (b <= cut && b > cut - 56 && t > y) cut = Math.floor(t) - 1; // no heading stranded at a page foot
    if (cut <= y + pageH * 0.25) cut = y + pageH;
    cuts.push(cut);
    y = cut;
  }
  cuts.push(total);
  return cuts;
}

async function snapshotPdf(html, title, opts, onProgress) {
  onProgress(0.03, 'Loading the PDF writer');
  const [html2canvas, { PDFDocument }] = await Promise.all([libs.html2canvas(), libs.pdflib()]);
  const geo = pageGeometry(opts);
  const px = (pt) => (pt * 96) / 72;
  const width = Math.round(px(geo.contentWidth));
  const pageH = Math.floor(px(geo.contentHeight));

  const host = document.createElement('div');
  host.className = 'qs-sheet';
  host.style.width = `${width}px`;
  host.setAttribute('dir', 'auto');
  const style = document.createElement('style');
  style.textContent = SHEET_CSS;
  const body = document.createElement('div');
  body.innerHTML = html;
  for (const el of body.querySelectorAll('p, li, h1, h2, h3, h4, td, th, blockquote')) el.setAttribute('dir', 'auto');
  host.append(style, body);
  document.body.append(host);
  try {
    await Promise.all([...host.querySelectorAll('img')].map((img) => img.decode?.().catch(() => {})));
    if (document.fonts?.ready) await document.fonts.ready;
    const cuts = pageBreaks(host, pageH);
    const doc = await PDFDocument.create();
    doc.setTitle(title);
    doc.setCreator('Quillshift');
    doc.setProducer('Quillshift');
    const scale = Math.min(2, Math.sqrt(12_000_000 / (width * pageH)));
    const keep = (el) => el === host || el.contains(host) || host.contains(el) || el.closest?.('head');
    for (let i = 0; i < cuts.length - 1; i++) {
      onProgress(0.08 + (0.9 * i) / (cuts.length - 1), `Drawing page ${i + 1} of ${cuts.length - 1}`);
      const h = cuts[i + 1] - cuts[i];
      if (h < 2) continue;
      const canvas = await html2canvas(host, { x: 0, y: cuts[i], width, height: h, scale, backgroundColor: '#ffffff', logging: false, ignoreElements: (el) => !keep(el) });
      const bytes = new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', 0.9)).arrayBuffer());
      canvas.width = canvas.height = 0;
      const img = await doc.embedJpg(bytes);
      const hPt = (h * 72) / 96;
      doc.addPage([geo.width, geo.height]).drawImage(img, { x: geo.margin, y: geo.height - geo.margin - hPt, width: geo.contentWidth, height: hPt });
      await nextFrame();
    }
    onProgress(1);
    return new Blob([await doc.save()], { type: 'application/pdf' });
  } finally { host.remove(); }
}

/** @returns {Promise<{blob: Blob, mode: 'text'|'snapshot'}>} */
export async function htmlToPdf(html, title, opts = {}, onProgress = () => {}) {
  let mode = opts.pdfMode || 'auto';
  if (mode === 'auto') {
    const probe = document.createElement('div');
    probe.innerHTML = html;
    mode = needsSnapshot(probe.textContent) ? 'snapshot' : 'text';
  }
  const blob = mode === 'snapshot' ? await snapshotPdf(html, title, opts, onProgress) : await textPdf(html, title, opts, onProgress);
  return { blob, mode };
}
