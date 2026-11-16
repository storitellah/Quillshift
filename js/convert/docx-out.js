// A compact WordprocessingML writer: HTML in, a genuine .docx out (headings,
// lists, tables, links, images, code). Roughly 12 KB instead of a 400 KB library.

import { libs } from '../core/loader.js';
import { dataURLToBytes, loadImage, canvasToBlob } from '../core/util.js';
import { parseHtml } from './doc-out.js';
import { pageGeometry } from './page.js';

const xml = (s) => String(s)
  .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'ADDRESS', 'DETAILS', 'SUMMARY']);
const INLINE_FMT = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', CITE: 'i', VAR: 'i', DFN: 'i', U: 'u', INS: 'u', S: 'strike', DEL: 'strike', STRIKE: 'strike', CODE: 'code', KBD: 'code', SAMP: 'code', TT: 'code', SUP: 'sup', SUB: 'sub', MARK: 'mark' };
const EMU_PER_PX = 9525;

function runProps(f) {
  let s = '';
  if (f.code) s += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';
  if (f.b) s += '<w:b/><w:bCs/>';
  if (f.i) s += '<w:i/><w:iCs/>';
  if (f.strike) s += '<w:strike/>';
  if (f.link) s += '<w:color w:val="0563C1"/>';
  if (f.code) s += '<w:sz w:val="19"/><w:szCs w:val="19"/>';
  if (f.mark) s += '<w:highlight w:val="yellow"/>';
  if (f.u || f.link) s += '<w:u w:val="single"/>';
  if (f.sup) s += '<w:vertAlign w:val="superscript"/>';
  else if (f.sub) s += '<w:vertAlign w:val="subscript"/>';
  return s ? `<w:rPr>${s}</w:rPr>` : '';
}

class Writer {
  constructor(images, contentWidthEmu) {
    this.images = images;
    this.maxEmu = contentWidthEmu;
    this.rels = [];
    this.nums = [];
    this.picId = 0;
  }

  rel(type, target, external) {
    const id = `rId${this.rels.length + 10}`;
    this.rels.push({ id, type, target, external });
    return id;
  }

  drawing(src, widthLimit) {
    const im = this.images.get(src);
    if (!im) return '';
    im.rid ??= this.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `media/${im.file}`);
    let cx = im.w * EMU_PER_PX;
    let cy = im.h * EMU_PER_PX;
    const limit = Math.min(this.maxEmu, widthLimit || this.maxEmu);
    if (cx > limit) { cy = Math.round(cy * (limit / cx)); cx = limit; }
    const n = ++this.picId;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="${im.file}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${im.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }

  /** Flatten inline content into segments: text, line breaks and images. */
  inline(node, f, segs, ctx) {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        const text = ctx.pre ? n.nodeValue : n.nodeValue.replace(/\s+/g, ' ');
        if (text) segs.push({ text, f });
      } else if (n.nodeType === 1) {
        const tag = n.tagName;
        if (tag === 'BR') segs.push({ br: true });
        else if (tag === 'IMG') segs.push({ img: n.getAttribute('src') });
        else if (tag === 'A' && /^(https?:|mailto:|tel:)/i.test(n.getAttribute('href') || '')) this.inline(n, { ...f, link: n.getAttribute('href') }, segs, ctx);
        else if (INLINE_FMT[tag]) this.inline(n, { ...f, [INLINE_FMT[tag]]: true }, segs, ctx);
        else this.inline(n, f, segs, ctx);
      }
    }
    return segs;
  }

  paragraph(segs, ctx, extra = '') {
    if (!ctx.pre) {
      // Collapse whitespace across segment boundaries and trim the paragraph's ends.
      let prevSpace = true;
      for (const s of segs) {
        if (s.text === undefined) { prevSpace = true; continue; }
        if (prevSpace) s.text = s.text.replace(/^ +/, '');
        if (s.text) prevSpace = s.text.endsWith(' ');
      }
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segs[i];
        if (s.text === undefined) break;
        s.text = s.text.replace(/ +$/, '');
        if (s.text) break;
      }
    }
    const live = segs.filter((s) => s.br || s.img || s.text);
    if (!live.some((s) => s.img || s.text) && !ctx.keepEmpty) return '';

    let pPr = extra;
    if (ctx.style) pPr = `<w:pStyle w:val="${ctx.style}"/>` + pPr;
    if (ctx.list) {
      if (!ctx.list.used) {
        ctx.list.used = true;
        pPr = (ctx.style ? pPr : '<w:pStyle w:val="ListParagraph"/>' + pPr) + `<w:numPr><w:ilvl w:val="${ctx.list.ilvl}"/><w:numId w:val="${ctx.list.numId}"/></w:numPr>`;
      } else pPr += `<w:ind w:left="${720 * (ctx.list.ilvl + 1)}"/>`;
    } else if (ctx.indent) pPr += `<w:ind w:left="${ctx.indent}"/>`;
    if (ctx.align) pPr += `<w:jc w:val="${ctx.align}"/>`;

    let out = '';
    let openLink = null;
    const closeLink = () => { if (openLink) { out += '</w:hyperlink>'; openLink = null; } };
    for (const s of live) {
      const link = s.f?.link || null;
      if (link !== openLink) {
        closeLink();
        if (link) { out += `<w:hyperlink r:id="${this.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', link, true)}" w:history="1">`; openLink = link; }
      }
      if (s.br) out += '<w:r><w:br/></w:r>';
      else if (s.img) out += this.drawing(s.img, ctx.widthLimit);
      else {
        const f = ctx.bold ? { ...s.f, b: true } : s.f;
        const parts = s.text.split('\n');
        out += `<w:r>${runProps(f)}${parts.map((p, i) => `${i ? '<w:br/>' : ''}${p ? `<w:t xml:space="preserve">${xml(p.replace(/\t/g, '    '))}</w:t>` : ''}`).join('')}</w:r>`;
      }
    }
    closeLink();
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${out}</w:p>`;
  }

  blocks(parent, ctx) {
    let out = '';
    let segs = [];
    const flush = () => { if (segs.length) { out += this.paragraph(segs, ctx); segs = []; } };
    for (const n of parent.childNodes) {
      if (n.nodeType === 3) {
        const text = n.nodeValue.replace(/\s+/g, ' ');
        if (text.trim() || segs.length) segs.push({ text, f: {} });
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (!BLOCKS.has(tag)) {
        if (tag === 'BR') segs.push({ br: true });
        else if (tag === 'IMG') segs.push({ img: n.getAttribute('src') });
        else {
          const f = tag === 'A' && /^(https?:|mailto:|tel:)/i.test(n.getAttribute('href') || '') ? { link: n.getAttribute('href') } : INLINE_FMT[tag] ? { [INLINE_FMT[tag]]: true } : {};
          this.inline(n, f, segs, ctx);
        }
        continue;
      }
      flush();
      if (/^H[1-6]$/.test(tag)) out += this.paragraph(this.inline(n, {}, [], ctx), { ...ctx, style: `Heading${tag[1]}`, list: null, bold: false });
      else if (tag === 'P' || tag === 'FIGCAPTION' || tag === 'SUMMARY' || tag === 'ADDRESS') {
        if ([...n.children].some((c) => BLOCKS.has(c.tagName))) out += this.blocks(n, ctx);
        else out += this.paragraph(this.inline(n, tag === 'FIGCAPTION' ? { i: true } : {}, [], ctx), ctx);
      } else if (tag === 'DT') out += this.paragraph(this.inline(n, { b: true }, [], ctx), ctx);
      else if (tag === 'DD') out += this.blocks(n, { ...ctx, indent: (ctx.indent || 0) + 720 });
      else if (tag === 'UL' || tag === 'OL') {
        const ilvl = ctx.list ? Math.min(8, ctx.list.ilvl + 1) : 0;
        const numId = this.nums.length + 1;
        this.nums.push({ numId, ordered: tag === 'OL', ilvl, start: parseInt(n.getAttribute('start') || '1', 10) || 1 });
        for (const li of n.children) {
          if (li.tagName !== 'LI') continue;
          const lctx = { ...ctx, style: null, list: { numId, ilvl, used: false }, keepEmpty: false };
          let item = this.blocks(li, lctx);
          if (!lctx.list.used) item = this.paragraph([{ text: '', f: {} }], { ...lctx, keepEmpty: true }) + item;
          out += item;
        }
      } else if (tag === 'BLOCKQUOTE') out += this.blocks(n, { ...ctx, style: 'Quote' });
      else if (tag === 'PRE') out += this.paragraph([{ text: n.textContent.replace(/\r\n?/g, '\n').replace(/\n$/, ''), f: {} }], { ...ctx, pre: true, style: 'Code', list: null });
      else if (tag === 'HR') out += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="A8A8A8"/></w:pBdr></w:pPr></w:p>';
      else if (tag === 'TABLE') out += this.table(n, ctx);
      else out += this.blocks(n, ctx);
    }
    flush();
    return out;
  }

  table(table, ctx) {
    const rows = [...table.querySelectorAll('tr')].filter((r) => r.closest('table') === table);
    const span = (c) => Math.max(1, parseInt(c.getAttribute('colspan') || '1', 10) || 1);
    const cols = Math.max(1, ...rows.map((r) => [...r.children].reduce((n, c) => n + span(c), 0)));
    const total = Math.round((ctx.widthLimit || this.maxEmu) / 635); // EMU → twentieths of a point
    const colW = Math.floor(total / cols);
    const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="B5B5B5"/>`;
    let out = `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${colW}"/>`.repeat(cols)}</w:tblGrid>`;
    for (const r of rows) {
      let used = 0;
      out += '<w:tr>';
      for (const c of r.children) {
        if (c.tagName !== 'TD' && c.tagName !== 'TH') continue;
        const s = Math.min(span(c), cols - used);
        if (s < 1) break;
        used += s;
        const head = c.tagName === 'TH';
        let inner = this.blocks(c, { widthLimit: colW * s * 635 - 130000, bold: head, list: null, style: 'TableText' });
        if (!inner || inner.endsWith('</w:tbl>')) inner += '<w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr></w:p>';
        out += `<w:tc><w:tcPr><w:tcW w:w="${colW * s}" w:type="dxa"/>${s > 1 ? `<w:gridSpan w:val="${s}"/>` : ''}${head ? '<w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>' : ''}</w:tcPr>${inner}</w:tc>`;
      }
      while (used < cols) { out += `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`; used++; }
      out += '</w:tr>';
    }
    return out + '</w:tbl><w:p><w:pPr><w:spacing w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>';
  }
}

const heading = (n, size, before) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="100" w:line="264" w:lineRule="auto"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1C1B29"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${heading(1, 40, 360)}${heading(2, 32, 320)}${heading(3, 26, 280)}${heading(4, 24, 240)}${heading(5, 22, 200)}${heading(6, 22, 200)}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="C9C9C9"/></w:pBdr><w:ind w:left="540"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F3"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="252" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
</w:styles>`;

function numberingXml(nums) {
  const bullets = ['•', '◦', '▪'];
  const fmts = [['decimal', '.'], ['lowerLetter', '.'], ['lowerRoman', '.']];
  const lvl = (i, fmt, text, start = 1) => `<w:lvl w:ilvl="${i}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  const levels = [...Array(9).keys()];
  const abstracts = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels.map((i) => lvl(i, 'bullet', bullets[i % 3])).join('')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels.map((i) => lvl(i, fmts[i % 3][0], `%${i + 1}${fmts[i % 3][1]}`)).join('')}</w:abstractNum>`;
  const list = nums.map((n) => `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="${n.ordered ? 1 : 0}"/>${n.ordered ? `<w:lvlOverride w:ilvl="${n.ilvl}"><w:startOverride w:val="${n.start}"/></w:lvlOverride>` : ''}</w:num>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${abstracts}${list}</w:numbering>`;
}

/** Decode every embedded image once, converting anything Word cannot display to PNG. */
export async function collectImages(root, prefix = 'image') {
  const images = new Map();
  let i = 0;
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (!src || images.has(src)) continue;
    try {
      const el = await loadImage(src);
      let { mime, bytes } = dataURLToBytes(src);
      const w = el.naturalWidth || 300;
      const h = el.naturalHeight || 150;
      if (!/^image\/(png|jpeg|gif)$/.test(mime)) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(el, 0, 0, w, h);
        bytes = new Uint8Array(await (await canvasToBlob(c, 'image/png')).arrayBuffer());
        mime = 'image/png';
      }
      const ext = mime === 'image/jpeg' ? 'jpeg' : mime.split('/')[1];
      images.set(src, { file: `${prefix}${++i}.${ext}`, bytes, mime, w, h });
    } catch { /* undecodable image: leave it out */ }
  }
  return images;
}

export async function htmlToDocx(html, title, opts = {}) {
  const { zipSync, strToU8 } = await libs.fflate();
  const root = parseHtml(html);
  const geo = pageGeometry(opts);
  const images = await collectImages(root);
  const w = new Writer(images, Math.round(geo.contentWidth * 12700));
  const body = w.blocks(root, {});
  const tw = (pt) => Math.round(pt * 20);
  const sect = `<w:sectPr><w:pgSz w:w="${tw(geo.width)}" w:h="${tw(geo.height)}"${geo.landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${tw(geo.margin)}" w:right="${tw(geo.margin)}" w:bottom="${tw(geo.margin)}" w:left="${tw(geo.margin)}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  const files = {
    '[Content_Types].xml': `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'docProps/core.xml': `${head}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>Quillshift</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
    'word/document.xml': `${head}<w:document ${NS}><w:body>${body || '<w:p/>'}${sect}</w:body></w:document>`,
    'word/styles.xml': STYLES,
    'word/numbering.xml': numberingXml(w.nums),
    'word/_rels/document.xml.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>${w.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xml(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`,
  };
  const zip = {};
  for (const [k, v] of Object.entries(files)) zip[k] = strToU8(v);
  for (const im of images.values()) if (im.rid) zip[`word/media/${im.file}`] = [im.bytes, { level: 0 }];
  return new Blob([zipSync(zip, { level: 6 })], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
