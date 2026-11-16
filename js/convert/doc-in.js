// Importers: every "document" source is turned into clean, sanitised HTML — the
// intermediate form the reader displays and every exporter starts from.

import { libs } from '../core/loader.js';
import { readText, blobToDataURL, bytesToBase64, baseName, esc } from '../core/util.js';

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' };

/** Strip scripts, styles and anything active; drop images we cannot embed; namespace ids. */
export async function cleanHtml(html) {
  const DOMPurify = await libs.dompurify();
  const frag = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'video', 'audio', 'source', 'link', 'meta', 'nav', 'dialog', 'svg', 'canvas', 'picture', 'map', 'area'],
    FORBID_ATTR: ['style', 'class', 'bgcolor', 'color', 'face', 'srcset', 'sizes', 'loading', 'background', 'contenteditable', 'tabindex', 'hidden'],
    ADD_FORBID_CONTENTS: ['nav', 'form', 'select', 'button', 'dialog', 'canvas', 'map', 'textarea'],
    RETURN_DOM_FRAGMENT: true,
  });
  const root = document.createElement('div');
  root.append(frag);

  for (const img of [...root.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || '';
    if (!/^data:image\//i.test(src)) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (alt) { const em = document.createElement('em'); em.textContent = `[${alt}]`; img.replaceWith(em); } else img.remove();
    }
  }
  // Ids are prefixed so document anchors can never collide with the app's own.
  for (const el of root.querySelectorAll('[id]')) el.id = `doc-${el.id}`;
  for (const el of root.querySelectorAll('[name]')) el.removeAttribute('name');
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) a.setAttribute('href', `#doc-${href.slice(1)}`);
    else if (!/^(https?:|mailto:|tel:)/i.test(href)) a.removeAttribute('href');
  }
  // Remove wrappers that end up empty (common in exported Word and web pages).
  for (const el of [...root.querySelectorAll('p, div, span, section, article')].reverse()) {
    if (!el.textContent.trim() && !el.querySelector('img, br, hr, table')) el.remove();
  }
  return root.innerHTML;
}

export function titleOf(html, fallbackName) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (m) {
    const t = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    if (t && t.length <= 140) return t;
  }
  return baseName(fallbackName);
}

async function fromDocx(blob) {
  const mammoth = await libs.mammoth();
  let result;
  try {
    result = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() }, {
      styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => p > em:fresh", 'u => u', 'strike => s', "p[style-name='Quote'] => blockquote > p:fresh", "p[style-name='Intense Quote'] => blockquote > p:fresh"],
    });
  } catch {
    throw new Error('This Word file could not be opened. It may be damaged, password-protected, or an older .doc file saved with a .docx name.');
  }
  return result.value;
}

async function fromMarkdown(blob) {
  const { marked } = await libs.marked();
  return marked.parse(await readText(blob), { gfm: true, breaks: false, async: false });
}

async function fromText(blob) {
  const text = (await readText(blob)).replace(/\r\n?/g, '\n');
  return text.split(/\n{2,}/).map((p) => p.replace(/^\n+|\s+$/g, '')).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

async function fromHtml(blob) {
  const doc = new DOMParser().parseFromString(await readText(blob), 'text/html');
  for (const el of doc.querySelectorAll('script, style, noscript, template, header nav, footer nav, [aria-hidden="true"]')) el.remove();
  const main = doc.querySelector('article, main, [role="main"]');
  const body = main && main.textContent.trim().length > doc.body.textContent.trim().length * 0.6 ? main : doc.body;
  const title = doc.querySelector('title')?.textContent.trim();
  const html = body.innerHTML;
  return !/<h1[\s>]/i.test(html) && title ? `<h1>${esc(title)}</h1>${html}` : html;
}

const zipText = (zip, path) => (zip[path] ? new TextDecoder().decode(zip[path]) : null);
function resolvePath(base, rel) {
  const parts = base.split('/').slice(0, -1);
  for (const seg of decodeURIComponent(rel.split('#')[0]).split('/')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
const zipImage = (zip, path) => {
  const bytes = zip[path];
  const mime = MIME_BY_EXT[path.split('.').pop().toLowerCase()];
  return bytes && mime ? `data:${mime};base64,${bytesToBase64(bytes)}` : null;
};

async function fromEpub(blob) {
  const { unzipSync } = await libs.fflate();
  let zip;
  try { zip = unzipSync(new Uint8Array(await blob.arrayBuffer())); } catch { throw new Error('This EPUB could not be opened. It may be damaged or copy-protected.'); }
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const container = zipText(zip, 'META-INF/container.xml');
  const opfPath = container && xml(container).querySelector('rootfile')?.getAttribute('full-path');
  const opfText = opfPath && zipText(zip, opfPath);
  if (!opfText) throw new Error('This EPUB is missing its table of contents and cannot be read.');
  if (zip['META-INF/encryption.xml'] && /EncryptedData/.test(zipText(zip, 'META-INF/encryption.xml')) && !/font/i.test(zipText(zip, 'META-INF/encryption.xml'))) {
    throw new Error('This EPUB is copy-protected (DRM) and cannot be converted.');
  }
  const opf = xml(opfText);
  const items = new Map();
  for (const it of opf.getElementsByTagNameNS('*', 'item')) items.set(it.getAttribute('id'), it.getAttribute('href'));
  const title = opf.getElementsByTagNameNS('*', 'title')[0]?.textContent.trim();
  const parts = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    const href = items.get(ref.getAttribute('idref'));
    if (!href) continue;
    const path = resolvePath(opfPath, href);
    const text = zipText(zip, path);
    if (!text) continue;
    let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    if (doc.querySelector('parsererror') || !doc.body) doc = new DOMParser().parseFromString(text, 'text/html');
    const isToc = [...doc.getElementsByTagName('nav')].some((n) => (n.getAttribute('epub:type') || '').includes('toc'));
    if (isToc && opf.getElementsByTagNameNS('*', 'itemref').length > 1) continue;
    for (const img of doc.querySelectorAll('img, image')) {
      const src = img.getAttribute('src') || img.getAttribute('xlink:href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      const data = src && zipImage(zip, resolvePath(path, src));
      if (img.localName === 'image') {
        const el = doc.createElement('img');
        if (data) el.setAttribute('src', data);
        (img.closest('svg') || img).replaceWith(el);
      } else if (data) img.setAttribute('src', data); else img.removeAttribute('src');
    }
    // Chapter-local ids are made unique per file; cross-file links become plain text.
    const tag = `c${parts.length}-`;
    for (const el of doc.querySelectorAll('[id]')) el.id = tag + el.id;
    for (const a of doc.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href');
      if (h.startsWith('#')) a.setAttribute('href', `#${tag}${h.slice(1)}`);
      else if (!/^(https?:|mailto:)/i.test(h)) a.removeAttribute('href');
    }
    const html = doc.body.innerHTML.trim();
    if (html) parts.push(html);
  }
  if (!parts.length) throw new Error('No readable chapters were found in this EPUB.');
  const body = parts.join('\n<hr>\n');
  return !/<h1[\s>]/i.test(body) && title ? `<h1>${esc(title)}</h1>${body}` : body;
}

async function fromOdt(blob) {
  const { unzipSync } = await libs.fflate();
  let zip;
  try { zip = unzipSync(new Uint8Array(await blob.arrayBuffer())); } catch { throw new Error('This OpenDocument file could not be opened.'); }
  const content = zipText(zip, 'content.xml');
  if (!content) throw new Error('This OpenDocument file has no readable content.');
  const doc = new DOMParser().parseFromString(content, 'application/xml');
  const styles = new Map();
  for (const st of doc.getElementsByTagNameNS('*', 'style')) {
    const tp = st.getElementsByTagNameNS('*', 'text-properties')[0];
    if (!tp) continue;
    const a = (n) => [...tp.attributes].find((x) => x.localName === n)?.value;
    styles.set(st.getAttribute('style:name'), {
      b: a('font-weight') === 'bold', i: a('font-style') === 'italic',
      u: !!a('text-underline-style') && a('text-underline-style') !== 'none',
      s: !!a('text-line-through-style') && a('text-line-through-style') !== 'none',
    });
  }
  const wrapStyle = (name, inner) => {
    const s = styles.get(name);
    if (!s || !inner) return inner;
    if (s.b) inner = `<strong>${inner}</strong>`;
    if (s.i) inner = `<em>${inner}</em>`;
    if (s.u) inner = `<u>${inner}</u>`;
    if (s.s) inner = `<s>${inner}</s>`;
    return inner;
  };
  const inline = (node) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return esc(n.nodeValue);
    if (n.nodeType !== 1) return '';
    switch (n.localName) {
      case 'span': return wrapStyle(n.getAttribute('text:style-name'), inline(n));
      case 'a': return `<a href="${esc(n.getAttribute('xlink:href') || '')}">${inline(n)}</a>`;
      case 'line-break': return '<br>';
      case 'tab': return '&emsp;';
      case 's': return ' '.repeat(parseInt(n.getAttribute('text:c') || '1', 10));
      case 'frame': {
        const img = n.getElementsByTagNameNS('*', 'image')[0];
        const data = img && zipImage(zip, img.getAttribute('xlink:href') || '');
        return data ? `<img src="${data}" alt="">` : '';
      }
      case 'note': return `<sup>${esc(n.getElementsByTagNameNS('*', 'note-citation')[0]?.textContent || '*')}</sup>`;
      case 'annotation': case 'soft-page-break': return '';
      default: return inline(n);
    }
  }).join('');
  const rowsOf = (t) => [...t.children].flatMap((c) => (c.localName === 'table-row' ? [c] : /^table-(header-rows|rows|row-group)$/.test(c.localName) ? rowsOf(c) : []));
  const block = (node) => [...node.children].map((n) => {
    switch (n.localName) {
      case 'h': { const l = Math.min(6, Math.max(1, parseInt(n.getAttribute('text:outline-level') || '1', 10))); return `<h${l}>${inline(n)}</h${l}>`; }
      case 'p': { const h = wrapStyle(n.getAttribute('text:style-name'), inline(n)); return h.trim() ? `<p>${h}</p>` : ''; }
      case 'list': return `<ul>${[...n.children].filter((c) => c.localName === 'list-item').map((li) => `<li>${block(li)}</li>`).join('')}</ul>`;
      case 'table': return `<table>${rowsOf(n)
        .map((r) => `<tr>${[...r.children].filter((c) => c.localName === 'table-cell').map((c) => `<td>${block(c)}</td>`).join('')}</tr>`).join('')}</table>`;
      case 'section': case 'text-box': return block(n);
      default: return '';
    }
  }).join('\n');
  const body = doc.getElementsByTagNameNS('*', 'text')[0];
  if (!body) throw new Error('This OpenDocument file is not a text document.');
  return block(body);
}

const IMPORTERS = { docx: fromDocx, md: fromMarkdown, txt: fromText, html: fromHtml, epub: fromEpub, odt: fromOdt };

/** @returns {Promise<{html: string, title: string}>} */
export async function docToHtml(file) {
  const importer = IMPORTERS[file.format];
  if (!importer) throw new Error(`Reading .${file.format} files is not supported yet.`);
  const html = await cleanHtml(await importer(file.blob));
  if (!html.trim()) throw new Error('This file appears to be empty.');
  return { html, title: titleOf(html, file.name) };
}

export { blobToDataURL };
