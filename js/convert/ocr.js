// Text recognition (OCR) with Tesseract, running in a Web Worker on the device.
// Turns scans and photos into text, or into PDFs with an invisible, selectable
// text layer over the original image — what Acrobat calls "Recognize Text".

import { libs, OCR_ASSETS } from '../core/loader.js';
import { canvasToBlob, esc, baseName, nextFrame } from '../core/util.js';

let workerPromise = null;
let progressSink = null;

// A tiny module that uses a SIMD instruction; validating it tells us which core to load.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

async function getWorker() {
  workerPromise ??= (async () => {
    const Tesseract = await libs.tesseract();
    let simd = false;
    try { simd = WebAssembly.validate(SIMD_PROBE); } catch {}
    return Tesseract.createWorker('eng', 1, {
      workerPath: OCR_ASSETS.workerPath,
      corePath: OCR_ASSETS.core(simd),
      langPath: OCR_ASSETS.langPath,
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none', // the service worker already keeps the language data
      logger: (m) => { if (m.status === 'recognizing text') progressSink?.(m.progress); },
      errorHandler: () => {},
    });
  })().catch((e) => {
    workerPromise = null;
    console.error(e);
    throw new Error('The text-recognition engine could not be loaded. Connect to the internet once so it can be saved for offline use.');
  });
  return workerPromise;
}

/** Free the recognition engine's memory (about 100 MB) once a batch is finished. */
export async function releaseOcr() {
  const p = workerPromise;
  workerPromise = null;
  try { (await p)?.terminate(); } catch {}
}

async function recognize(image, wantPdf, onProgress) {
  const worker = await getWorker();
  progressSink = onProgress;
  try {
    const { data } = await worker.recognize(image, wantPdf ? { pdfTitle: 'Quillshift' } : {}, { text: true, pdf: !!wantPdf });
    return { text: (data.text || '').trim(), pdf: wantPdf && data.pdf ? new Uint8Array(data.pdf) : null, confidence: data.confidence };
  } finally { progressSink = null; }
}

/** Recognised text → paragraphs. Tesseract separates blocks with blank lines. */
function textToHtml(text) {
  return text.replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const lines = p.split('\n').map((l) => l.trim()).filter(Boolean);
    // Re-join lines that were only wrapped by the page width; keep short lines (addresses, lists) apart.
    const longest = Math.max(...lines.map((l) => l.length));
    let out = '';
    lines.forEach((l, i) => {
      if (!i) { out = l; return; }
      const prev = lines[i - 1];
      if (prev.length > longest * 0.72) out = /[A-Za-z]-$/.test(out) && /^[a-z]/.test(l) ? out.slice(0, -1) + l : `${out} ${l}`;
      else out += `\n${l}`;
    });
    return `<p>${esc(out).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

/** Rasterise each page of a PDF and hand it to `each(canvas, n, total)`. */
async function eachPage(file, dpi, each) {
  const { openPdf, renderPage } = await import('./pdf-in.js');
  const pdf = await openPdf(file.blob);
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const canvas = await renderPage(page, dpi / 72);
      page.cleanup();
      await each(canvas, n, pdf.numPages);
      canvas.width = canvas.height = 0;
      await nextFrame();
    }
    return pdf.numPages;
  } finally { pdf.destroy(); }
}

const NO_TEXT = 'No readable text was found. Text recognition works best on sharp, upright, printed English text.';

/** A photo or scan → { html, title }. */
export async function imageToHtml(file, onProgress = () => {}) {
  const { toCanvas } = await import('./image.js');
  onProgress(0.05, 'Loading text recognition');
  const canvas = await toCanvas(file, { maxEdge: 3200, background: '#ffffff' });
  const { text } = await recognize(canvas, false, (p) => onProgress(0.1 + p * 0.85, 'Recognising text'));
  canvas.width = canvas.height = 0;
  if (!text) throw new Error(NO_TEXT);
  return { html: textToHtml(text), title: baseName(file.name) };
}

/** A scanned PDF → { html, title, pages }. */
export async function scannedPdfToHtml(file, onProgress = () => {}) {
  onProgress(0.02, 'Loading text recognition');
  const parts = [];
  const pages = await eachPage(file, 200, async (canvas, n, total) => {
    const { text } = await recognize(canvas, false, (p) => onProgress((n - 1 + p) / total, `Recognising text on page ${n} of ${total}`));
    if (text) parts.push(textToHtml(text));
  });
  if (!parts.length) throw new Error(NO_TEXT);
  return { html: parts.join('\n<hr>\n'), title: baseName(file.name), pages };
}

/** Images or a scanned PDF → one PDF whose pages keep their look and gain selectable, searchable text. */
export async function toSearchablePdf(files, onProgress = () => {}) {
  onProgress(0.02, 'Loading text recognition');
  const { PDFDocument } = await libs.pdflib();
  const out = await PDFDocument.create();
  out.setCreator('Quillshift');
  out.setProducer('Quillshift (Tesseract)');
  let words = 0;
  const add = async (canvas, label, done, total) => {
    // JPEG keeps a scanned page small; the recognised text is layered invisibly on top.
    const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.82);
    const { pdf, text } = await recognize(jpeg, true, (p) => onProgress((done + p) / total, label));
    words += text ? text.split(/\s+/).length : 0;
    if (!pdf) throw new Error('This page could not be processed.');
    const src = await PDFDocument.load(pdf);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  };
  if (files.length === 1 && files[0].format === 'pdf') {
    await eachPage(files[0], 200, (canvas, n, total) => add(canvas, `Recognising text on page ${n} of ${total}`, n - 1, total));
  } else {
    const { toCanvas } = await import('./image.js');
    for (let i = 0; i < files.length; i++) {
      const canvas = await toCanvas(files[i], { maxEdge: 3200, background: '#ffffff' });
      await add(canvas, `Recognising text in image ${i + 1} of ${files.length}`, i, files.length);
      canvas.width = canvas.height = 0;
    }
  }
  onProgress(1);
  return { blob: new Blob([await out.save()], { type: 'application/pdf' }), words };
}
