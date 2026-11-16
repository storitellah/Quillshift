// Exporters for the light text formats. The heavier ones (PDF, DOCX, EPUB) have
// their own modules.

import { libs } from '../core/loader.js';
import { esc } from '../core/util.js';

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'HR', 'FIGURE', 'FIGCAPTION', 'HEADER', 'FOOTER', 'ASIDE', 'DL', 'DT', 'DD']);

export function parseHtml(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

/** Plain text with paragraph spacing, list markers and tab-separated table cells. */
export function htmlToText(html) {
  const out = [];
  let line = '';
  const flush = (blank) => {
    const t = line.replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(t);
    line = '';
    if (blank && out.length && out[out.length - 1] !== '') out.push('');
  };
  const walk = (node, ctx) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { line += ctx.pre ? n.nodeValue : n.nodeValue.replace(/\s+/g, ' '); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') { flush(false); continue; }
      if (tag === 'HR') { flush(true); out.push('* * *', ''); continue; }
      if (tag === 'IMG') { const alt = n.getAttribute('alt'); if (alt) line += `[${alt}]`; continue; }
      if (tag === 'PRE') {
        flush(true);
        out.push(...n.textContent.replace(/\n$/, '').split('\n'), '');
        continue;
      }
      if (tag === 'TR') {
        flush(false);
        out.push([...n.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join('\t'));
        continue;
      }
      if (tag === 'LI') {
        flush(false);
        const parent = n.parentElement;
        const marker = parent?.tagName === 'OL' ? `${[...parent.children].indexOf(n) + (parseInt(parent.getAttribute('start') || '1', 10))}. ` : '• ';
        line = '  '.repeat(Math.max(0, ctx.depth - 1)) + marker;
        walk(n, ctx);
        flush(false);
        continue;
      }
      const block = BLOCK.has(tag);
      if (block) flush(tag !== 'DIV' && tag !== 'SECTION' && tag !== 'ARTICLE');
      walk(n, tag === 'UL' || tag === 'OL' ? { ...ctx, depth: ctx.depth + 1 } : ctx);
      if (block) flush(tag !== 'DIV' && tag !== 'SECTION' && tag !== 'ARTICLE' && !(ctx.depth && (tag === 'UL' || tag === 'OL' || tag === 'P')));
    }
  };
  walk(parseHtml(html), { depth: 0, pre: false });
  flush(false);
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

export async function htmlToMarkdown(html) {
  const { TurndownService, gfm } = await libs.turndown();
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', hr: '---' });
  td.use(gfm);
  // Embedded images would bloat a Markdown file with megabytes of base64.
  td.addRule('dataImages', {
    filter: (n) => n.nodeName === 'IMG' && /^data:/i.test(n.getAttribute('src') || ''),
    replacement: (_c, n) => (n.getAttribute('alt') ? `*[image: ${n.getAttribute('alt')}]*` : ''),
  });
  // Turndown only emits a pipe table when the first row is a header row.
  const frag = parseHtml(html);
  for (const table of frag.querySelectorAll('table')) {
    const first = table.querySelector('tr');
    if (first && !first.querySelector('th')) {
      for (const td of [...first.children]) {
        const th = document.createElement('th');
        th.append(...td.childNodes);
        td.replaceWith(th);
      }
    }
    for (const cell of table.querySelectorAll('td p, th p')) cell.replaceWith(...cell.childNodes, ' ');
  }
  const host = document.createElement('div');
  host.append(frag);
  return td.turndown(host).trim() + '\n';
}

export const DOC_CSS = `
:root{color-scheme:light dark}
body{font:18px/1.65 Charter,"Iowan Old Style","Palatino Linotype",Georgia,serif;max-width:42rem;margin:0 auto;padding:2.5rem 1.25rem 5rem;color:#1c1b29;background:#fffdf8;overflow-wrap:break-word}
h1,h2,h3,h4{line-height:1.25;margin:2em 0 .5em}h1{font-size:2em;margin-top:0}h2{font-size:1.45em}h3{font-size:1.2em}
p,ul,ol,blockquote,pre,table,figure{margin:0 0 1.1em}img{max-width:100%;height:auto}
a{color:#b8321a}blockquote{margin-left:0;padding-left:1em;border-left:3px solid #d8cfbd;color:#55536a}
pre,code{font:.85em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}pre{padding:1em;overflow:auto;background:#f1ece1;border-radius:8px}
table{border-collapse:collapse;display:block;overflow-x:auto;font-size:.9em}th,td{border:1px solid #d8cfbd;padding:.4em .7em;text-align:left;vertical-align:top}th{background:#f1ece1}
hr{border:0;border-top:1px solid #d8cfbd;margin:2.5em 0}
@media (prefers-color-scheme:dark){body{color:#ece8df;background:#15151c}a{color:#ff8a70}blockquote{color:#b5b1c2;border-color:#3a3a4a}pre,th{background:#22222e}th,td,hr{border-color:#3a3a4a}}
@media print{body{max-width:none;padding:0;font-size:11pt;background:#fff;color:#000}}`.trim();

/** A self-contained, readable web page: one file, embedded styles, dark-mode aware. */
export function htmlToStandalone(html, title) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${DOC_CSS}</style>
</head>
<body>
${html}
</body>
</html>
`;
}
