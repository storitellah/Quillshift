// The conversion pipeline. Every job is (file, target, options) → a new file.
// file = { name, blob, format }.

import { FORMATS, OPERATIONS, outputFormat } from '../core/formats.js';
import { baseName } from '../core/util.js';
import { docToHtml } from './doc-in.js';
import { htmlToText, htmlToMarkdown, htmlToStandalone } from './doc-out.js';

const text = (s, mime) => new Blob([s], { type: `${mime};charset=utf-8` });

async function exportHtml(html, title, target, opts, onProgress) {
  switch (target) {
    case 'pdf': {
      const { htmlToPdf } = await import('./pdf-out.js');
      const r = await htmlToPdf(html, title, opts, onProgress);
      return { blob: r.blob, note: r.mode === 'snapshot' ? 'Saved as page snapshots so every character is preserved.' : null };
    }
    case 'docx': return { blob: await (await import('./docx-out.js')).htmlToDocx(html, title, opts) };
    case 'epub': return { blob: await (await import('./epub-out.js')).htmlToEpub(html, title, opts) };
    case 'html': return { blob: text(htmlToStandalone(html, title), 'text/html') };
    case 'md': return { blob: text(await htmlToMarkdown(html), 'text/markdown') };
    case 'txt': return { blob: text(htmlToText(html), 'text/plain') };
    default: throw new Error(`Converting to ${target} is not supported for this file.`);
  }
}

async function convertSheet(file, target, opts, onProgress) {
  const S = await import('./sheet.js');
  const book = await S.readBook(file);
  switch (target) {
    case 'xlsx': return { blob: await S.writeXlsx(book) };
    case 'json': return { blob: text(S.toJson(book), 'application/json') };
    case 'md': return { blob: text(S.toMarkdown(book), 'text/markdown') };
    case 'html': return { blob: text(htmlToStandalone(S.toHtml(book), baseName(file.name)), 'text/html') };
    case 'pdf': return exportHtml(S.toHtml(book), baseName(file.name), 'pdf', opts, onProgress);
    case 'csv': {
      if (book.sheets.length === 1) return { blob: text(S.toCsv(book.sheets[0].rows), 'text/csv') };
      const { libs } = await import('../core/loader.js');
      const { zipSync, strToU8 } = await libs.fflate();
      const zip = {};
      book.sheets.forEach((s, i) => { zip[`${String(s.name || `Sheet${i + 1}`).replace(/[\\/:*?"<>|]/g, '_')}.csv`] = strToU8(S.toCsv(s.rows)); });
      return { blob: new Blob([zipSync(zip)], { type: 'application/zip' }), format: 'zip', note: `One CSV per sheet (${book.sheets.length} sheets), zipped.` };
    }
    default: throw new Error(`Converting to ${target} is not supported for this file.`);
  }
}

async function convertPdf(file, target, opts, onProgress) {
  if (target === 'pages') {
    const r = await (await import('./pdf-tools.js')).extractPages(file.blob, opts.pages);
    return { blob: r.blob, suffix: '-pages', note: `${r.count} page${r.count === 1 ? '' : 's'} extracted.` };
  }
  const P = await import('./pdf-in.js');
  if (target === 'jpg' || target === 'png') {
    const r = await P.pdfToImages(file, target, opts, onProgress);
    return { blob: r.blob, format: r.format, note: r.pages > 1 ? `${r.pages} page images, zipped.` : null };
  }
  const { html, title } = await P.pdfToHtml(file, (p, m) => onProgress(p * 0.7, m));
  const out = await exportHtml(html, title, target, opts, (p, m) => onProgress(0.7 + p * 0.3, m));
  return { ...out, note: out.note || 'Text and headings were rebuilt from the PDF; its original page layout is not kept.' };
}

async function convertImage(file, target, opts, onProgress) {
  if (target === 'pdf') return { blob: await (await import('./pdf-tools.js')).imagesToPdf([file], opts, onProgress) };
  return { blob: await (await import('./image.js')).convertImage(file, target, opts) };
}

/**
 * @param {{name: string, blob: Blob, format: string}} file
 * @param {string} target a format id, or an operation such as "pages"
 * @returns {Promise<{name: string, blob: Blob, format: string, note: string|null}>}
 */
export async function convert(file, target, opts = {}, onProgress = () => {}) {
  const src = FORMATS[file.format];
  if (!src) throw new Error('This file type is not supported.');
  if (!FORMATS[target] && !OPERATIONS[target]) throw new Error(`Unknown target format “${target}”.`);
  onProgress(0.02, 'Reading');
  let out;
  if (src.kind === 'doc') {
    const { html, title } = await docToHtml(file);
    out = await exportHtml(html, title, target, opts, onProgress);
  } else if (src.kind === 'sheet') out = await convertSheet(file, target, opts, onProgress);
  else if (src.kind === 'pdf') out = await convertPdf(file, target, opts, onProgress);
  else if (src.kind === 'image') out = await convertImage(file, target, opts, onProgress);
  else throw new Error('This file type cannot be converted.');
  const format = out.format || outputFormat(target);
  onProgress(1, 'Done');
  return { name: `${baseName(file.name)}${out.suffix || ''}.${FORMATS[format].ext[0]}`, blob: out.blob, format, note: out.note || null };
}

/** Combine any mix of PDFs, images, documents and sheets into a single PDF, in order. */
export async function combine(files, opts = {}, onProgress = () => {}) {
  const T = await import('./pdf-tools.js');
  const parts = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const step = (p, m) => onProgress((i + p) / (files.length + 1), m || `Preparing ${f.name}`);
    step(0);
    if (f.format === 'pdf') parts.push(f.blob);
    else if (FORMATS[f.format]?.kind === 'image') {
      // Consecutive images share one imagesToPdf call so they are embedded only once.
      const run = [f];
      while (i + 1 < files.length && FORMATS[files[i + 1].format]?.kind === 'image') run.push(files[++i]);
      parts.push(await T.imagesToPdf(run, opts));
    } else parts.push((await convert(f, 'pdf', opts, step)).blob);
  }
  const name = files.length ? `${baseName(files[0].name)}-combined.pdf` : 'combined.pdf';
  const blob = await T.mergePdfs(parts, baseName(name), (p, m) => onProgress((files.length + p) / (files.length + 1), m));
  onProgress(1, 'Done');
  return { name, blob, format: 'pdf', note: `${files.length} files combined.` };
}

export const canCombine = (format) => ['doc', 'pdf', 'image', 'sheet'].includes(FORMATS[format]?.kind);
