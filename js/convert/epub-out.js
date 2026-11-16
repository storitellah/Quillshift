// EPUB 3 writer (with an EPUB 2 NCX for older e-readers). Chapters are split at
// top-level headings so the book has a real, navigable table of contents.

import { libs } from '../core/loader.js';
import { esc } from '../core/util.js';
import { parseHtml } from './doc-out.js';
import { collectImages } from './docx-out.js';

const CSS = `body{font-family:serif;line-height:1.55;margin:5%;overflow-wrap:break-word}
h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .5em;page-break-after:avoid}h1{font-size:1.7em}h2{font-size:1.35em}h3{font-size:1.15em}
p{margin:0 0 .9em}img{max-width:100%;height:auto}blockquote{margin:1em 0 1em 1em;padding-left:1em;border-left:3px solid #bbb}
pre,code{font-family:monospace;font-size:.85em}pre{white-space:pre-wrap;padding:.8em;background:#f2f2f2}
table{border-collapse:collapse;margin:1em 0;font-size:.9em}th,td{border:1px solid #999;padding:.3em .5em;text-align:left;vertical-align:top}
hr{border:0;border-top:1px solid #999;margin:2em 20%}`;

const XHTML = 'http://www.w3.org/1999/xhtml';

function toXhtml(nodes, title, lang) {
  const doc = document.implementation.createDocument(XHTML, 'html', null);
  const html = doc.documentElement;
  html.setAttribute('lang', lang);
  html.setAttribute('xml:lang', lang);
  const head = doc.createElementNS(XHTML, 'head');
  const t = doc.createElementNS(XHTML, 'title');
  t.textContent = title;
  const link = doc.createElementNS(XHTML, 'link');
  link.setAttribute('rel', 'stylesheet');
  link.setAttribute('type', 'text/css');
  link.setAttribute('href', 'style.css');
  head.append(t, link);
  const body = doc.createElementNS(XHTML, 'body');
  for (const n of nodes) body.append(doc.importNode(n, true));
  html.append(head, body);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n${new XMLSerializer().serializeToString(doc)}`;
}

function splitChapters(root, bookTitle) {
  const kids = [...root.childNodes].filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.nodeValue.trim()));
  const count = (tag) => kids.filter((n) => n.tagName === tag).length;
  const breakTag = count('H1') >= 2 ? 'H1' : count('H2') >= 2 ? 'H2' : null;
  const chapters = [];
  let cur = null;
  for (const n of kids) {
    if (!cur || (breakTag && n.tagName === breakTag && cur.nodes.length)) {
      cur = { title: null, nodes: [] };
      chapters.push(cur);
    }
    if (!cur.title && /^H[1-3]$/.test(n.tagName || '')) cur.title = n.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    // A rule directly before a chapter break is redundant in a paginated book.
    cur.nodes.push(n);
  }
  for (const c of chapters) while (c.nodes.length > 1 && c.nodes[c.nodes.length - 1].tagName === 'HR') c.nodes.pop();
  chapters.forEach((c, i) => { c.title ||= chapters.length === 1 ? bookTitle : i === 0 ? 'Opening' : `Section ${i + 1}`; c.file = `ch${String(i + 1).padStart(3, '0')}.xhtml`; });
  return chapters;
}

export async function htmlToEpub(html, title, opts = {}) {
  const { zipSync, strToU8 } = await libs.fflate();
  const lang = (opts.lang || navigator.language || 'en').split('-')[0];
  const root = parseHtml(html);
  const images = await collectImages(root, 'img');
  for (const img of [...root.querySelectorAll('img')]) {
    const im = images.get(img.getAttribute('src'));
    if (im) { img.setAttribute('src', `images/${im.file}`); if (!img.hasAttribute('alt')) img.setAttribute('alt', ''); } else img.remove();
  }
  const chapters = splitChapters(root, title);
  if (!chapters.length) throw new Error('There is nothing to put in the e-book.');

  // Point in-document anchors at whichever chapter file now holds their target.
  const home = new Map();
  for (const c of chapters) for (const n of c.nodes) {
    if (n.nodeType !== 1) continue;
    if (n.id) home.set(n.id, c.file);
    for (const el of n.querySelectorAll('[id]')) home.set(el.id, c.file);
  }
  for (const c of chapters) for (const n of c.nodes) {
    if (n.nodeType !== 1) continue;
    for (const a of [n, ...n.querySelectorAll('a[href^="#"]')]) {
      const href = a.getAttribute?.('href');
      if (!href?.startsWith('#')) continue;
      const file = home.get(href.slice(1));
      if (!file) a.removeAttribute('href'); else if (file !== c.file) a.setAttribute('href', file + href);
    }
  }

  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...chapters.map((c, i) => `<item id="c${i}" href="${c.file}" media-type="application/xhtml+xml"/>`),
    ...[...images.values()].map((im, i) => `<item id="i${i}" href="images/${im.file}" media-type="${im.mime}"/>`),
  ];
  const zip = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:${id}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">
${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('\n')}
</spine>
</package>`),
    'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${chapters.map((c) => `<li><a href="${c.file}">${esc(c.title)}</a></li>`).join('\n')}
</ol></nav></body>
</html>`),
    'OEBPS/toc.ncx': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${id}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${esc(title)}</text></docTitle>
<navMap>
${chapters.map((c, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="${c.file}"/></navPoint>`).join('\n')}
</navMap>
</ncx>`),
    'OEBPS/style.css': strToU8(CSS),
  };
  for (const c of chapters) zip[`OEBPS/${c.file}`] = strToU8(toXhtml(c.nodes, c.title, lang));
  for (const im of images.values()) zip[`OEBPS/images/${im.file}`] = [im.bytes, { level: 0 }];
  return new Blob([zipSync(zip, { level: 6 })], { type: 'application/epub+zip' });
}
