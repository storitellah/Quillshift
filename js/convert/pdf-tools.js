// Building and reshaping PDFs with pdf-lib: images → PDF, merge, extract pages.

import { libs } from '../core/loader.js';
import { canvasToBlob, parsePageRange } from '../core/util.js';
import { toCanvas } from './image.js';
import { pageGeometry } from './page.js';

const PDF_MIME = 'application/pdf';

async function load(PDFDocument, bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw new Error('This PDF is password-protected. Remove the password first, then try again.');
    throw new Error('This PDF could not be read. It may be damaged.');
  }
}

/** One page per image, scaled to fit and centred. Photos are re-encoded so phone
 *  orientation is honoured and a 12-megapixel picture does not make a 5 MB page. */
export async function imagesToPdf(files, opts = {}, onProgress = () => {}) {
  const { PDFDocument } = await libs.pdflib();
  const doc = await PDFDocument.create();
  doc.setCreator('Quillshift');
  doc.setProducer('Quillshift');
  const geo = pageGeometry({ ...opts, orientation: 'portrait' });
  const margin = Math.min(geo.margin, 36);
  let i = 0;
  for (const file of files) {
    onProgress(i++ / files.length, `Placing image ${i} of ${files.length}`);
    const keepPng = file.format === 'png' || file.format === 'svg' || file.format === 'gif';
    const canvas = await toCanvas(file, { maxEdge: 2600, background: keepPng ? null : '#ffffff' });
    const blob = await canvasToBlob(canvas, keepPng ? 'image/png' : 'image/jpeg', 0.88);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = keepPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const wide = canvas.width > canvas.height;
    const [pw, ph] = wide ? [geo.height, geo.width] : [geo.width, geo.height];
    const s = Math.min((pw - margin * 2) / canvas.width, (ph - margin * 2) / canvas.height);
    const w = canvas.width * s;
    const h = canvas.height * s;
    doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    canvas.width = canvas.height = 0;
  }
  return new Blob([await doc.save()], { type: PDF_MIME });
}

export async function mergePdfs(blobs, title, onProgress = () => {}) {
  const { PDFDocument } = await libs.pdflib();
  const out = await PDFDocument.create();
  out.setCreator('Quillshift');
  out.setProducer('Quillshift');
  if (title) out.setTitle(title);
  let i = 0;
  for (const blob of blobs) {
    onProgress(i++ / blobs.length, `Merging ${i} of ${blobs.length}`);
    const src = await load(PDFDocument, await blob.arrayBuffer());
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  return new Blob([await out.save()], { type: PDF_MIME });
}

export async function extractPages(blob, rangeText) {
  const { PDFDocument } = await libs.pdflib();
  const src = await load(PDFDocument, await blob.arrayBuffer());
  const picks = parsePageRange(rangeText, src.getPageCount());
  const out = await PDFDocument.create();
  out.setCreator('Quillshift');
  out.setProducer('Quillshift');
  for (const page of await out.copyPages(src, picks)) out.addPage(page);
  return { blob: new Blob([await out.save()], { type: PDF_MIME }), count: picks.length };
}
