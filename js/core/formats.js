// The format registry: what Quillshift can open, and what each kind can become.

import { extOf } from './util.js';

/** kind: doc (reflowable text), pdf, sheet (tabular), image, archive */
export const FORMATS = {
  pdf:  { label: 'PDF',  name: 'PDF document',        kind: 'pdf',   ext: ['pdf'],  mime: 'application/pdf', tone: 'red' },
  docx: { label: 'DOCX', name: 'Word document',       kind: 'doc',   ext: ['docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', tone: 'blue' },
  odt:  { label: 'ODT',  name: 'OpenDocument text',   kind: 'doc',   ext: ['odt'],  mime: 'application/vnd.oasis.opendocument.text', tone: 'blue', inputOnly: true },
  epub: { label: 'EPUB', name: 'E-book',              kind: 'doc',   ext: ['epub'], mime: 'application/epub+zip', tone: 'teal' },
  html: { label: 'HTML', name: 'Web page',            kind: 'doc',   ext: ['html', 'htm', 'xhtml'], mime: 'text/html', tone: 'amber' },
  md:   { label: 'MD',   name: 'Markdown',            kind: 'doc',   ext: ['md', 'markdown'], mime: 'text/markdown', tone: 'slate' },
  txt:  { label: 'TXT',  name: 'Plain text',          kind: 'doc',   ext: ['txt', 'text', 'log'], mime: 'text/plain', tone: 'slate' },
  xlsx: { label: 'XLSX', name: 'Excel workbook',      kind: 'sheet', ext: ['xlsx'], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', tone: 'green' },
  csv:  { label: 'CSV',  name: 'Comma-separated',     kind: 'sheet', ext: ['csv', 'tsv'], mime: 'text/csv', tone: 'green' },
  json: { label: 'JSON', name: 'JSON data',           kind: 'sheet', ext: ['json'], mime: 'application/json', tone: 'slate' },
  png:  { label: 'PNG',  name: 'PNG image',           kind: 'image', ext: ['png'],  mime: 'image/png',  tone: 'violet' },
  jpg:  { label: 'JPG',  name: 'JPEG image',          kind: 'image', ext: ['jpg', 'jpeg'], mime: 'image/jpeg', tone: 'violet' },
  webp: { label: 'WEBP', name: 'WebP image',          kind: 'image', ext: ['webp'], mime: 'image/webp', tone: 'violet' },
  gif:  { label: 'GIF',  name: 'GIF image',           kind: 'image', ext: ['gif'],  mime: 'image/gif',  tone: 'violet', inputOnly: true },
  bmp:  { label: 'BMP',  name: 'Bitmap image',        kind: 'image', ext: ['bmp'],  mime: 'image/bmp',  tone: 'violet', inputOnly: true },
  svg:  { label: 'SVG',  name: 'Vector image',        kind: 'image', ext: ['svg'],  mime: 'image/svg+xml', tone: 'violet', inputOnly: true },
  avif: { label: 'AVIF', name: 'AVIF image',          kind: 'image', ext: ['avif'], mime: 'image/avif', tone: 'violet', inputOnly: true },
  heic: { label: 'HEIC', name: 'iPhone photo',        kind: 'image', ext: ['heic', 'heif'], mime: 'image/heic', tone: 'violet', inputOnly: true },
  zip:  { label: 'ZIP',  name: 'Image archive',       kind: 'archive', ext: ['zip'], mime: 'application/zip', tone: 'slate', outputOnly: true },
};

const TARGETS = {
  doc:   ['pdf', 'docx', 'epub', 'html', 'md', 'txt'],
  pdf:   ['docx', 'txt', 'epub', 'html', 'md', 'jpg', 'png', 'pages'],
  sheet: ['xlsx', 'csv', 'json', 'pdf', 'html', 'md'],
  image: ['pdf', 'jpg', 'png', 'webp'],
  archive: [],
};

/** Pseudo-targets that are operations rather than formats. */
export const OPERATIONS = {
  pages: { label: 'Pages', name: 'Extract pages to a new PDF', output: 'pdf' },
};

let webpEncode;
export function canEncodeWebp() {
  if (webpEncode === undefined) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      webpEncode = c.toDataURL('image/webp').startsWith('data:image/webp');
    } catch { webpEncode = false; }
  }
  return webpEncode;
}

export function targetsFor(formatId) {
  const f = FORMATS[formatId];
  if (!f) return [];
  return TARGETS[f.kind].filter((t) => t !== formatId && (t !== 'webp' || canEncodeWebp()));
}

export const targetLabel = (t) => OPERATIONS[t]?.label ?? FORMATS[t]?.label ?? t.toUpperCase();
export const targetName = (t) => OPERATIONS[t]?.name ?? FORMATS[t]?.name ?? t;
export const outputFormat = (t) => OPERATIONS[t]?.output ?? t;

const BY_EXT = new Map();
const BY_MIME = new Map();
for (const [id, f] of Object.entries(FORMATS)) {
  for (const e of f.ext) BY_EXT.set(e, id);
  BY_MIME.set(f.mime, id);
}
BY_MIME.set('image/jpg', 'jpg');
BY_MIME.set('image/heif', 'heic');
BY_MIME.set('text/tab-separated-values', 'csv');
BY_MIME.set('application/xhtml+xml', 'html');

const startsWith = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);

/** Identify a file by extension, then MIME type, then by sniffing its first bytes. */
export async function detectFormat(file) {
  const byExt = BY_EXT.get(extOf(file.name));
  if (byExt && !FORMATS[byExt].outputOnly) return byExt;
  const byMime = BY_MIME.get((file.type || '').split(';')[0]);
  if (byMime && !FORMATS[byMime].outputOnly) return byMime;

  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(head, [0x42, 0x4d])) return 'bmp';
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    const text = new TextDecoder('latin1').decode(head);
    if (text.includes('application/epub+zip')) return 'epub';
    if (text.includes('opendocument.text')) return 'odt';
    if (text.includes('word/')) return 'docx';
    if (text.includes('xl/')) return 'xlsx';
    // Office files usually start with [Content_Types].xml; look further in.
    const more = new TextDecoder('latin1').decode(await file.slice(0, Math.min(file.size, 200000)).arrayBuffer());
    if (more.includes('word/document.xml')) return 'docx';
    if (more.includes('xl/workbook.xml')) return 'xlsx';
    return null;
  }
  const text = new TextDecoder().decode(head).trimStart().toLowerCase();
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'html';
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'svg';
  // Mostly printable? Treat it as plain text.
  let printable = 0;
  for (const b of head) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127)) printable++;
  if (head.length && printable / head.length > 0.97) return 'txt';
  return null;
}

/** The value for <input accept>. Empty on purpose for iOS, which greys out unknown extensions. */
export const ACCEPT = Object.values(FORMATS)
  .filter((f) => !f.outputOnly)
  .flatMap((f) => [...f.ext.map((e) => `.${e}`), f.mime])
  .join(',');
