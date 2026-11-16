// Small shared helpers. No dependencies.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
export const baseName = (name) => String(name || 'document').replace(/\.[a-z0-9]+$/i, '') || 'document';
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const nextFrame = () => new Promise((r) => setTimeout(r, 0));

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Decode text as UTF-8 (honouring BOMs), falling back to Windows-1252 for legacy files. */
export async function readText(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function dataURLToBytes(url) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url || '');
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  if (/;base64/i.test(m[2])) {
    const bin = atob(m[3].replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, bytes };
  }
  return { mime, bytes: new TextEncoder().encode(decodeURIComponent(m[3])) };
}

/** Load an image from a URL (data:, blob: or same-origin) and wait until it is decoded. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This image could not be decoded by your browser.'));
    img.src = src;
  });
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), type, quality);
  });
}

/** Parse "1-3, 5, 8-" into a sorted list of zero-based page indexes. */
export function parsePageRange(text, total) {
  const out = new Set();
  for (const part of String(text || '').split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d*)\s*(-)?\s*(\d*)$/.exec(t);
    if (!m || (!m[1] && !m[3])) throw new Error(`“${t}” is not a valid page range. Try something like 1-3, 5.`);
    let a = m[1] ? parseInt(m[1], 10) : 1;
    let b = m[2] ? (m[3] ? parseInt(m[3], 10) : total) : a;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.add(i - 1);
  }
  if (!out.size) throw new Error(`No pages matched. This document has ${total} page${total === 1 ? '' : 's'}.`);
  return [...out].sort((x, y) => x - y);
}

export function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}
