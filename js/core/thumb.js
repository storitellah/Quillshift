// Small previews for the Library and result cards: a rendered first page for
// PDFs, a scaled copy for images, and an opening line for text formats.

import { FORMATS } from './formats.js';

const EDGE = 320;

export async function makePreview(file) {
  try {
    const kind = FORMATS[file.format]?.kind;
    if (kind === 'pdf') {
      const { openPdf, renderPage } = await import('../convert/pdf-in.js');
      const pdf = await openPdf(file.blob);
      try {
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const canvas = await renderPage(page, EDGE / Math.max(vp.width, vp.height));
        const thumb = canvas.toDataURL('image/jpeg', 0.72);
        canvas.width = canvas.height = 0;
        return { thumb, pages: pdf.numPages };
      } finally { pdf.destroy(); }
    }
    if (kind === 'image') {
      const { toCanvas } = await import('../convert/image.js');
      const canvas = await toCanvas(file, { maxEdge: EDGE, background: '#ffffff' });
      const thumb = canvas.toDataURL('image/jpeg', 0.72);
      canvas.width = canvas.height = 0;
      return { thumb };
    }
    if (['txt', 'md', 'csv', 'json', 'html'].includes(file.format)) {
      let text = await file.blob.slice(0, 6000).text();
      if (file.format === 'html') text = text.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
      const snippet = text.replace(/[#*_`>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
      return snippet ? { snippet } : {};
    }
  } catch { /* a preview is a nicety; never fail a conversion over it */ }
  return {};
}
