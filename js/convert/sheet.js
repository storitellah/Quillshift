// Spreadsheets without a spreadsheet library: a small XLSX reader and writer,
// RFC 4180 CSV, and JSON. A workbook is { sheets: [{ name, rows: any[][] }] }.

import { libs } from '../core/loader.js';
import { readText, esc, baseName } from '../core/util.js';

const xml = (s) => String(s)
  .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- CSV ---------- */

function sniffDelimiter(text) {
  const sample = text.slice(0, 20000).split(/\r?\n/).slice(0, 12).filter(Boolean);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => l.split(d).length - 1);
    if (!counts[0]) continue;
    const consistent = counts.filter((c) => c === counts[0]).length / counts.length;
    const score = counts[0] * consistent;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = sniffDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

const NUMERIC = /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?(?:e[+-]?\d+)?$/i;
/** CSV cells are all text; give numbers their type back for XLSX and JSON output. */
const typed = (rows) => rows.map((r) => r.map((c) => (typeof c === 'string' && NUMERIC.test(c) ? Number(c) : c)));

export function toCsv(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/* ---------- XLSX reader ---------- */

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const isDateFormat = (code) => /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^general$/i.test(code);
const pad = (n) => String(n).padStart(2, '0');

function serialToDate(serial, date1904) {
  const ms = Math.round(serial * 864e5) + (date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30));
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return serial;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ''}`;
  if (serial >= 0 && serial < 1) return time;
  return Number.isInteger(serial) ? date : `${date} ${time}`;
}

function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export async function readXlsx(blob) {
  const { unzipSync } = await libs.fflate();
  let zip;
  try { zip = unzipSync(new Uint8Array(await blob.arrayBuffer())); } catch { throw new Error('This workbook could not be opened. It may be damaged, password-protected, or an older .xls file.'); }
  const text = (p) => (zip[p] ? new TextDecoder().decode(zip[p]) : null);
  const parse = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const wbText = text('xl/workbook.xml');
  if (!wbText) throw new Error('This file is not a valid Excel workbook.');
  const wb = parse(wbText);
  const date1904 = wb.getElementsByTagName('workbookPr')[0]?.getAttribute('date1904') === '1';

  const rels = new Map();
  const relText = text('xl/_rels/workbook.xml.rels');
  if (relText) for (const r of parse(relText).getElementsByTagName('Relationship')) rels.set(r.getAttribute('Id'), r.getAttribute('Target'));

  const strings = [];
  const ssText = text('xl/sharedStrings.xml');
  if (ssText) for (const si of parse(ssText).getElementsByTagName('si')) {
    let s = '';
    for (const t of si.getElementsByTagName('t')) if (t.parentNode.localName !== 'rPh') s += t.textContent;
    strings.push(s);
  }

  const dateStyles = [];
  const stText = text('xl/styles.xml');
  if (stText) {
    const st = parse(stText);
    const custom = new Map();
    for (const f of st.getElementsByTagName('numFmt')) custom.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') || '');
    const xfs = st.getElementsByTagName('cellXfs')[0];
    if (xfs) for (const xf of xfs.getElementsByTagName('xf')) {
      const id = Number(xf.getAttribute('numFmtId') || 0);
      dateStyles.push(BUILTIN_DATE_FMTS.has(id) || (custom.has(id) && isDateFormat(custom.get(id))));
    }
  }

  const sheets = [];
  for (const sh of wb.getElementsByTagName('sheet')) {
    if (sh.getAttribute('state') === 'hidden' || sh.getAttribute('state') === 'veryHidden') continue;
    const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let target = rels.get(rid) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const sheetText = text(target);
    if (!sheetText) continue;
    const rows = [];
    let rowIdx = -1;
    for (const r of parse(sheetText).getElementsByTagName('row')) {
      rowIdx = r.hasAttribute('r') ? Number(r.getAttribute('r')) - 1 : rowIdx + 1;
      const row = [];
      let ci = -1;
      for (const c of r.getElementsByTagName('c')) {
        ci = c.hasAttribute('r') ? colIndex(c.getAttribute('r')) : ci + 1;
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0]?.textContent;
        let val = null;
        if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
        else if (v == null || v === '') val = null;
        else if (t === 's') val = strings[Number(v)] ?? '';
        else if (t === 'str' || t === 'e') val = v;
        else if (t === 'b') val = v === '1';
        else {
          const num = Number(v);
          val = Number.isNaN(num) ? v : dateStyles[Number(c.getAttribute('s') || 0)] ? serialToDate(num, date1904) : num;
        }
        if (val !== null && val !== '') row[ci] = val;
      }
      if (row.length) rows[rowIdx] = row;
    }
    // Fill holes and square the grid off.
    const width = rows.reduce((m, r) => Math.max(m, r ? r.length : 0), 0);
    const grid = [];
    for (let i = 0; i < rows.length; i++) grid.push(Array.from({ length: width }, (_, j) => rows[i]?.[j] ?? ''));
    while (grid.length && grid[grid.length - 1].every((c) => c === '')) grid.pop();
    sheets.push({ name: sh.getAttribute('name') || `Sheet${sheets.length + 1}`, rows: grid });
  }
  if (!sheets.length) throw new Error('This workbook has no visible sheets.');
  return { sheets };
}

/* ---------- XLSX writer ---------- */

function colName(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

export async function writeXlsx(book) {
  const { zipSync, strToU8 } = await libs.fflate();
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const seen = new Set();
  const names = book.sheets.map((s, i) => {
    let n = String(s.name || `Sheet${i + 1}`).replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    for (let k = 2; seen.has(n.toLowerCase()); k++) n = `${n.slice(0, 28)} ${k}`;
    seen.add(n.toLowerCase());
    return n;
  });
  const zip = {
    '[Content_Types].xml': `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${head}<workbook xmlns="${M}" xmlns:r="${R}"><sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${head}<styleSheet xmlns="${M}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
  };
  book.sheets.forEach((sheet, si) => {
    const rows = sheet.rows;
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const widths = Array(width).fill(6);
    let data = '';
    rows.forEach((row, ri) => {
      let cells = '';
      row.forEach((v, ci) => {
        if (v == null || v === '') return;
        const ref = colName(ci) + (ri + 1);
        const style = ri === 0 ? ' s="1"' : '';
        if (ri < 200) widths[ci] = Math.min(60, Math.max(widths[ci], String(v).length + 2));
        if (typeof v === 'number' && Number.isFinite(v)) cells += `<c r="${ref}"${style}><v>${v}</v></c>`;
        else if (typeof v === 'boolean') cells += `<c r="${ref}" t="b"${style}><v>${v ? 1 : 0}</v></c>`;
        else cells += `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(String(v).slice(0, 32767))}</t></is></c>`;
      });
      if (cells) data += `<row r="${ri + 1}">${cells}</row>`;
    });
    const cols = width ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const freeze = rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
    zip[`xl/worksheets/sheet${si + 1}.xml`] = `${head}<worksheet xmlns="${M}">${freeze}${cols}<sheetData>${data}</sheetData></worksheet>`;
  });
  const packed = {};
  for (const [k, v] of Object.entries(zip)) packed[k] = strToU8(v);
  return new Blob([zipSync(packed, { level: 6 })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/* ---------- JSON ---------- */

const flat = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v ?? '');

function rowsFromJson(data) {
  if (Array.isArray(data)) {
    if (data.every((r) => Array.isArray(r))) return data.map((r) => r.map(flat));
    if (data.every((r) => r && typeof r === 'object')) {
      const keys = [...new Set(data.flatMap((r) => Object.keys(r)))];
      return [keys, ...data.map((r) => keys.map((k) => flat(r[k])))];
    }
    return [['value'], ...data.map((v) => [flat(v)])];
  }
  if (data && typeof data === 'object') return [['key', 'value'], ...Object.entries(data).map(([k, v]) => [k, flat(v)])];
  return [['value'], [flat(data)]];
}

function bookFromJson(text, name) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`This file is not valid JSON (${e.message}).`); }
  const tabular = (v) => Array.isArray(v) && v.length && v.every((r) => r && typeof r === 'object');
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data);
    if (entries.length && entries.every(([, v]) => tabular(v))) return { sheets: entries.map(([k, v]) => ({ name: k, rows: rowsFromJson(v) })) };
  }
  return { sheets: [{ name: baseName(name).slice(0, 31), rows: rowsFromJson(data) }] };
}

function sheetToObjects(rows) {
  if (!rows.length) return [];
  const used = new Set();
  const keys = rows[0].map((h, i) => {
    let k = String(h ?? '').trim() || `column_${i + 1}`;
    for (let n = 2; used.has(k); n++) k = `${String(h).trim() || `column_${i + 1}`}_${n}`;
    used.add(k);
    return k;
  });
  return rows.slice(1).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] === '' || r[i] === undefined ? null : r[i]])));
}

export function toJson(book) {
  const data = book.sheets.length === 1 ? sheetToObjects(book.sheets[0].rows) : Object.fromEntries(book.sheets.map((s) => [s.name, sheetToObjects(s.rows)]));
  return JSON.stringify(data, null, 2) + '\n';
}

/* ---------- Views of a workbook ---------- */

const show = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));

export function toHtml(book, { maxRows = Infinity } = {}) {
  return book.sheets.map((s) => {
    const rows = s.rows.slice(0, maxRows);
    const head = rows[0] || [];
    const title = book.sheets.length > 1 ? `<h2>${esc(s.name)}</h2>\n` : '';
    if (!rows.length) return `${title}<p><em>This sheet is empty.</em></p>`;
    return `${title}<table>\n<thead><tr>${head.map((c) => `<th>${esc(show(c))}</th>`).join('')}</tr></thead>\n<tbody>\n${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${esc(show(c))}</td>`).join('')}</tr>`).join('\n')}\n</tbody>\n</table>`;
  }).join('\n');
}

export function toMarkdown(book) {
  const cell = (v) => show(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return book.sheets.map((s) => {
    const title = book.sheets.length > 1 ? `## ${s.name}\n\n` : '';
    if (!s.rows.length) return `${title}*This sheet is empty.*\n`;
    const [head, ...rest] = s.rows;
    return `${title}| ${head.map(cell).join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n${rest.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')}\n`;
  }).join('\n');
}

/** Open any tabular source as a workbook. */
export async function readBook(file) {
  if (file.format === 'xlsx') return readXlsx(file.blob);
  const text = await readText(file.blob);
  if (file.format === 'json') return bookFromJson(text, file.name);
  return { sheets: [{ name: baseName(file.name).slice(0, 31), rows: typed(parseCsv(text)) }] };
}
