// Image decoding and re-encoding through a canvas.

import { canvasToBlob, loadImage } from '../core/util.js';
import { FORMATS } from '../core/formats.js';

const MAX_AREA = 16_000_000; // iOS Safari refuses canvases much larger than this

async function decode(blob, format) {
  if (format !== 'svg' && 'createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close?.() };
    } catch { /* fall through to <img>, which supports more formats on some browsers */ }
  }
  const url = URL.createObjectURL(format === 'svg' ? new Blob([blob], { type: 'image/svg+xml' }) : blob);
  try {
    const img = await loadImage(url);
    return { src: img, w: img.naturalWidth || 1024, h: img.naturalHeight || 768, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    const label = FORMATS[format]?.label || 'This';
    throw new Error(`${label} images cannot be decoded by this browser.${format === 'heic' ? ' Open it in Safari, or export it as JPEG from Photos first.' : ''}`);
  }
}

/** Draw an image file onto a canvas, optionally shrinking it and flattening transparency. */
export async function toCanvas(file, { maxEdge = 0, background = null } = {}) {
  const im = await decode(file.blob, file.format);
  let scale = 1;
  if (maxEdge && Math.max(im.w, im.h) > maxEdge) scale = maxEdge / Math.max(im.w, im.h);
  if (im.w * im.h * scale * scale > MAX_AREA) scale = Math.sqrt(MAX_AREA / (im.w * im.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(im.w * scale));
  canvas.height = Math.max(1, Math.round(im.h * scale));
  const ctx = canvas.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(im.src, 0, 0, canvas.width, canvas.height);
  im.done();
  return canvas;
}

export async function convertImage(file, target, opts = {}) {
  const mime = FORMATS[target].mime;
  const canvas = await toCanvas(file, { maxEdge: Number(opts.maxEdge) || 0, background: target === 'jpg' ? '#ffffff' : null });
  const blob = await canvasToBlob(canvas, mime, target === 'png' ? undefined : Number(opts.quality) || 0.85);
  canvas.width = canvas.height = 0;
  if (blob.type !== mime) throw new Error(`This browser cannot save ${FORMATS[target].label} images.`);
  return blob;
}
