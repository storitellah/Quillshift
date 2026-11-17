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

/* ---------- Acrobat-style tools ---------- */

const LEVELS = { light: { edge: 2200, q: 0.8 }, balanced: { edge: 1500, q: 0.68 }, strong: { edge: 1000, q: 0.52 } };

/**
 * Reduce file size without touching text or vectors: embedded JPEG photos are
 * downsampled and re-encoded, and the file is rewritten with compressed object tables.
 */
export async function compressPdf(blob, level = 'balanced', onProgress = () => {}) {
  const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFArray } = await libs.pdflib();
  const { edge, q } = LEVELS[level] || LEVELS.balanced;
  const doc = await load(PDFDocument, await blob.arrayBuffer());
  const N = (s) => PDFName.of(s);
  const ctx = doc.context;
  const colours = (cs) => {
    cs = ctx.lookup(cs);
    if (cs === N('DeviceRGB')) return 3;
    if (cs === N('DeviceGray')) return 1;
    if (cs instanceof PDFArray && ctx.lookup(cs.get(0)) === N('ICCBased')) {
      const n = ctx.lookup(cs.get(1))?.dict?.get(N('N'));
      return n ? n.asNumber() : 0;
    }
    return 0; // CMYK, indexed, spot colours: leave alone
  };
  const images = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (ctx.lookup(d.get(N('Subtype'))) !== N('Image')) continue;
    let filter = ctx.lookup(d.get(N('Filter')));
    if (filter instanceof PDFArray) filter = filter.size() === 1 ? ctx.lookup(filter.get(0)) : null;
    if (filter !== N('DCTDecode') || d.has(N('Decode')) || d.has(N('ImageMask'))) continue;
    const n = colours(d.get(N('ColorSpace')));
    if (n !== 1 && n !== 3) continue;
    images.push([ref, obj]);
  }
  let changed = 0;
  for (let i = 0; i < images.length; i++) {
    const [ref, obj] = images[i];
    onProgress(i / Math.max(1, images.length), `Compressing image ${i + 1} of ${images.length}`);
    try {
      const bmp = await createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
      const s = Math.min(1, edge / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * s));
      canvas.height = Math.max(1, Math.round(bmp.height * s));
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close?.();
      const bytes = new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', q)).arrayBuffer());
      const [w, h] = [canvas.width, canvas.height];
      canvas.width = canvas.height = 0;
      if (bytes.length > obj.contents.length * 0.9) continue; // not worth the quality loss
      const dict = obj.dict.clone(ctx);
      dict.set(N('Width'), PDFNumber.of(w));
      dict.set(N('Height'), PDFNumber.of(h));
      dict.set(N('ColorSpace'), N('DeviceRGB'));
      dict.set(N('BitsPerComponent'), PDFNumber.of(8));
      dict.set(N('Filter'), N('DCTDecode'));
      dict.set(N('Length'), PDFNumber.of(bytes.length));
      dict.delete(N('DecodeParms'));
      ctx.assign(ref, PDFRawStream.of(dict, bytes));
      changed++;
    } catch { /* an image the browser cannot decode stays as it is */ }
  }
  onProgress(0.95, 'Rewriting the file');
  const out = new Blob([await doc.save({ useObjectStreams: true })], { type: PDF_MIME });
  if (out.size >= blob.size * 0.98) return { blob, saved: 0, images: changed };
  return { blob: out, saved: 1 - out.size / blob.size, images: changed };
}

/** One PDF per page, zipped. */
export async function splitPdf(blob, name, onProgress = () => {}) {
  const { PDFDocument } = await libs.pdflib();
  const { zipSync } = await libs.fflate();
  const src = await load(PDFDocument, await blob.arrayBuffer());
  const total = src.getPageCount();
  if (total < 2) throw new Error('This PDF has only one page, so there is nothing to split.');
  const digits = String(total).length;
  const zip = {};
  for (let i = 0; i < total; i++) {
    onProgress(i / total, `Splitting page ${i + 1} of ${total}`);
    const out = await PDFDocument.create();
    out.setCreator('Quillshift');
    const [page] = await out.copyPages(src, [i]);
    out.addPage(page);
    zip[`${name}-page-${String(i + 1).padStart(digits, '0')}.pdf`] = await out.save();
  }
  return { blob: new Blob([zipSync(zip, { level: 6 })], { type: 'application/zip' }), count: total };
}

/** Diagonal text watermark and/or page numbers on every page. */
export async function stampPdf(blob, { watermark = '', numbers = false } = {}) {
  const { PDFDocument, StandardFonts, rgb, degrees } = await libs.pdflib();
  // The built-in PDF fonts write Latin-1 only.
  const text = String(watermark).replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/[^\x20-\x7e\xa1-\xff]/g, '').trim().slice(0, 60);
  if (watermark.trim() && !text) throw new Error('Watermark text can only use Latin letters, numbers and common punctuation.');
  if (!text && !numbers) throw new Error('Type some watermark text, or switch on page numbers.');
  const doc = await load(PDFDocument, await blob.arrayBuffer());
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const { width, height } = page.getSize();
    if (text) {
      const angle = Math.atan2(height, width);
      const diagonal = Math.hypot(width, height);
      const size = Math.min(110, (diagonal * 0.72) / bold.widthOfTextAtSize(text, 1));
      const w = bold.widthOfTextAtSize(text, size);
      const lift = size * 0.3; // roughly centre the glyphs on the diagonal
      page.drawText(text, {
        x: width / 2 - (w / 2) * Math.cos(angle) + lift * Math.sin(angle),
        y: height / 2 - (w / 2) * Math.sin(angle) - lift * Math.cos(angle),
        size, font: bold, color: rgb(0.45, 0.45, 0.5), opacity: 0.2, rotate: degrees((angle * 180) / Math.PI),
      });
    }
    if (numbers) {
      const label = `${i + 1} / ${pages.length}`;
      page.drawText(label, { x: width / 2 - regular.widthOfTextAtSize(label, 9) / 2, y: 22, size: 9, font: regular, color: rgb(0.4, 0.4, 0.45) });
    }
  });
  return new Blob([await doc.save()], { type: PDF_MIME });
}

/** Apply a page plan from the organiser: [{ index, rotate }] in the new order. */
export async function arrangePdf(blob, plan) {
  const { PDFDocument, degrees } = await libs.pdflib();
  if (!plan.length) throw new Error('A PDF needs at least one page.');
  const src = await load(PDFDocument, await blob.arrayBuffer());
  const out = await PDFDocument.create();
  out.setCreator('Quillshift');
  out.setProducer('Quillshift');
  const copies = await out.copyPages(src, plan.map((p) => p.index));
  copies.forEach((page, i) => {
    const turn = ((plan[i].rotate || 0) % 360 + 360) % 360;
    if (turn) page.setRotation(degrees((page.getRotation().angle + turn) % 360));
    out.addPage(page);
  });
  return new Blob([await out.save()], { type: PDF_MIME });
}
