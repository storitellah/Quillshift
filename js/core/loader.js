// Lazy engine loader. Nothing here is downloaded until a conversion or the reader
// actually needs it; the service worker then keeps it for offline use.

const url = (p) => new URL(`../../vendor/${p}`, import.meta.url).href;
const pending = new Map();

function script(path) {
  if (!pending.has(path)) {
    pending.set(path, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url(path);
      s.onload = resolve;
      s.onerror = () => {
        pending.delete(path);
        s.remove();
        reject(new Error('A conversion engine could not be loaded. Connect to the internet once so it can be saved for offline use.'));
      };
      document.head.append(s);
    }));
  }
  return pending.get(path);
}

function once(key, fn) {
  if (!pending.has(key)) pending.set(key, fn().catch((e) => { pending.delete(key); throw e; }));
  return pending.get(key);
}

const esm = (path) => import(url(path)).catch(() => {
  throw new Error('A conversion engine could not be loaded. Connect to the internet once so it can be saved for offline use.');
});

export const libs = {
  fflate: () => once('fflate', () => esm('fflate.mjs')),
  marked: () => once('marked', () => esm('marked.esm.js')),
  dompurify: () => script('purify.min.js').then(() => window.DOMPurify),
  mammoth: () => script('mammoth.browser.min.js').then(() => window.mammoth),
  pdflib: () => script('pdf-lib.min.js').then(() => window.PDFLib),
  html2canvas: () => script('html2canvas.min.js').then(() => window.html2canvas),
  turndown: () => once('turndown', async () => {
    await script('turndown.js');
    await script('turndown-plugin-gfm.js');
    return { TurndownService: window.TurndownService, gfm: window.turndownPluginGfm.gfm };
  }),
  pdfmake: () => once('pdfmake', async () => {
    await script('pdfmake.min.js');
    await Promise.all([script('vfs_fonts.js'), script('vfs_mono.js'), script('html-to-pdfmake.js')]);
    // vfs_fonts.js registers its font table by reference; add the Courier metrics to it.
    Object.assign(window.vfs, window.quillshiftMonoMetrics);
    return { pdfMake: window.pdfMake, htmlToPdfmake: window.htmlToPdfmake };
  }),
  tesseract: () => script('ocr/tesseract.min.js').then(() => window.Tesseract),
  pdfjs: () => once('pdfjs', async () => {
    const m = await esm('pdfjs/pdf.min.mjs');
    m.GlobalWorkerOptions.workerSrc = url('pdfjs/pdf.worker.min.mjs');
    return m;
  }),
};

/** Text recognition (OCR). The worker, its WebAssembly core and the language data are all local files. */
export const OCR_ASSETS = {
  workerPath: url('ocr/worker.min.js'),
  langPath: url('ocr'),
  core: (simd) => url(simd ? 'ocr/tesseract-core-simd-lstm.wasm.js' : 'ocr/tesseract-core-lstm.wasm.js'),
};

export const PDFJS_ASSETS = {
  cMapUrl: url('pdfjs/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: url('pdfjs/standard_fonts/'),
};

/** Engine packs, for the storage screen and the "download everything" button. */
export const PACKS = [
  { id: 'core', label: 'Essentials', size: 0.2, detail: 'Archives, Markdown, clean-up', files: ['fflate.mjs', 'marked.esm.js', 'purify.min.js', 'turndown.js', 'turndown-plugin-gfm.js'] },
  { id: 'word', label: 'Word import', size: 0.4, detail: 'Reads DOCX files', files: ['mammoth.browser.min.js'] },
  { id: 'pdfwrite', label: 'PDF writer', size: 3.1, detail: 'Creates PDFs with real, selectable text', files: ['pdfmake.min.js', 'vfs_fonts.js', 'vfs_mono.js', 'html-to-pdfmake.js', 'pdf-lib.min.js', 'html2canvas.min.js'] },
  { id: 'pdfread', label: 'PDF reader', size: 1.8, detail: 'Opens, reads and extracts PDFs', files: ['pdfjs/pdf.min.mjs', 'pdfjs/pdf.worker.min.mjs'] },
  { id: 'ocr', label: 'Text recognition', size: 7.0, detail: 'Reads scans and photos (OCR, English)', files: ['ocr/tesseract.min.js', 'ocr/worker.min.js', 'ocr/tesseract-core-simd-lstm.wasm.js', 'ocr/eng.traineddata.gz'] },
];
export const packUrl = url;
