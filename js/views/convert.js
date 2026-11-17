// The Convert screen: pick files, choose a target for each, convert on-device.

import { FORMATS, OPERATIONS, detectFormat, targetsFor, toolsFor, targetLabel, targetName } from '../core/formats.js';
import { esc, fmtBytes, uid, timeAgo, baseName } from '../core/util.js';
import { icon, tile, toast, saveBlob, shareBlob, canShare } from '../core/ui.js';
import { library, settings } from '../core/store.js';
import { session } from '../core/session.js';
import { convert, combine, canCombine } from '../convert/index.js';
import { makePreview } from '../core/thumb.js';

const state = { items: [], combine: false, combined: null, running: false, optionsOpen: false };
let root = null;
let recents = [];

const DEFAULT_TARGET = { doc: 'pdf', pdf: 'docx', sheet: 'xlsx', image: 'pdf' };

function pickTarget(format) {
  const targets = targetsFor(format);
  const remembered = settings.get('lastTarget')?.[format];
  if (targets.includes(remembered)) return remembered;
  const preferred = DEFAULT_TARGET[FORMATS[format].kind];
  return targets.includes(preferred) ? preferred : targets[0];
}

export async function addFiles(files) {
  let added = 0;
  for (const f of files) {
    if (!f || !f.size) { if (f) toast(`“${f.name}” is empty.`); continue; }
    const format = await detectFormat(f);
    state.items.push({
      id: uid(), name: f.name || 'untitled', blob: f, size: f.size, format,
      target: format ? pickTarget(format) : null, pages: '', level: 'balanced', watermark: '', numbers: false,
      status: format ? 'ready' : 'error',
      error: format ? null : 'This file type is not supported yet.',
    });
    added++;
  }
  if (added) { state.combined = null; render(); }
}

const combinable = () => state.items.filter((i) => i.format && canCombine(i.format));
const pending = () => state.items.filter((i) => (i.status === 'ready' || (i.status === 'error' && i.format)) && !OPERATIONS[i.target]?.interactive);

/* ---------- rendering ---------- */

function resultHtml(r, id) {
  const share = canShare(r.blob, r.name);
  return `<div class="result">${tile(r.format)}<div class="result-main"><div class="result-name">${esc(r.name)}</div><div class="result-meta">${icon('check', 'sr')}Ready · ${fmtBytes(r.blob.size)}${r.libId ? ' · saved to Library' : ''}</div></div></div>
    ${r.preview?.thumb ? `<button class="preview" data-act="read" data-id="${id}" aria-label="Preview ${esc(r.name)}"><img src="${r.preview.thumb}" alt=""></button>` : r.preview?.snippet ? `<button class="preview" data-act="read" data-id="${id}" aria-label="Preview ${esc(r.name)}"><p>${esc(r.preview.snippet)}…</p></button>` : ''}
    ${r.note ? `<p class="result-note">${esc(r.note)}</p>` : ''}
    <div class="result-actions">
      <button class="btn btn-ink btn-sm" data-act="read" data-id="${id}">${icon('book')}Read</button>
      <button class="btn btn-quiet btn-sm" data-act="save" data-id="${id}">${icon('download')}Save</button>
      ${share ? `<button class="btn btn-quiet btn-sm" data-act="share" data-id="${id}">${icon('share')}Share</button>` : ''}
    </div>`;
}

function itemHtml(it, index) {
  const f = FORMATS[it.format];
  const targets = it.format ? targetsFor(it.format) : [];
  const busy = it.status === 'working';
  const order = state.combine && state.items.length > 1
    ? `<div class="reorder"><button class="iconbtn" data-act="up" data-id="${it.id}" aria-label="Move up" ${index === 0 || state.running ? 'disabled' : ''}>${icon('up')}</button><button class="iconbtn" data-act="down" data-id="${it.id}" aria-label="Move down" ${index === state.items.length - 1 || state.running ? 'disabled' : ''}>${icon('down')}</button></div>` : '';
  let body = '';
  if (!state.combine && targets.length) {
    body += `<div class="item-to"><span>To</span><div class="chips" role="radiogroup" aria-label="Convert ${esc(it.name)} to">${targets.map((t) => `<button class="chip" role="radio" aria-checked="${t === it.target}" data-act="target" data-id="${it.id}" data-target="${t}" title="${esc(targetName(t))}" ${busy ? 'disabled' : ''}>${esc(targetLabel(t))}</button>`).join('')}</div></div>`;
    const tools = toolsFor(it.format);
    if (tools.length) body += `<div class="item-to"><span>Tools</span><div class="chips" role="radiogroup" aria-label="Tools for ${esc(it.name)}">${tools.map((t) => `<button class="chip tool" role="radio" aria-checked="${t === it.target}" data-act="target" data-id="${it.id}" data-target="${t}" title="${esc(targetName(t))}" ${busy ? 'disabled' : ''}>${esc(targetLabel(t))}</button>`).join('')}</div></div>`;
    if (OPERATIONS[it.target]) body += `<p class="small muted" style="margin-top:8px">${esc(OPERATIONS[it.target].name)}${it.target === 'ocr' ? '. English text; the engine (7 MB) downloads on first use.' : '.'}</p>`;
    if (it.target === 'compress') body += `<div class="item-extra"><div class="seg" role="group">${[['light', 'Light'], ['balanced', 'Balanced'], ['strong', 'Strongest']].map(([v, l]) => `<button type="button" data-act="level" data-id="${it.id}" data-val="${v}" aria-pressed="${it.level === v}">${l}</button>`).join('')}</div></div>`;
    if (it.target === 'stamp') body += `<div class="item-extra"><label for="wm-${it.id}">Watermark text</label><input type="text" id="wm-${it.id}" data-field="watermark" data-for="${it.id}" maxlength="60" autocomplete="off" placeholder="e.g. DRAFT or CONFIDENTIAL" value="${esc(it.watermark)}"><div class="opt-row" style="margin-top:10px"><b>Add page numbers</b><label class="switch"><input type="checkbox" data-field="numbers" data-for="${it.id}" ${it.numbers ? 'checked' : ''} aria-label="Add page numbers"><i></i></label></div></div>`;
    if (it.target === 'pages') body += `<div class="item-extra"><label for="pg-${it.id}">Pages to keep</label><input type="text" id="pg-${it.id}" data-pages="${it.id}" inputmode="text" autocomplete="off" placeholder="e.g. 1-3, 5, 8-" value="${esc(it.pages)}"></div>`;
  }
  if (!state.combine) {
    if (busy) body += `<div class="progress" role="progressbar" aria-label="Converting"><i style="width:${Math.round((it.progress || 0.02) * 100)}%"></i></div><div class="status">${esc(it.message || 'Working…')}</div>`;
    else if (it.status === 'done' && it.result) body += resultHtml(it.result, it.id);
  }
  if (it.status === 'error' && it.error && (!state.combine || !it.format)) body += `<div class="errorbox" role="alert">${icon('alert')}<span>${esc(it.error)}</span></div>`;
  return `<article class="card item" data-item="${it.id}">
    <div class="item-top">${order}${tile(it.format)}
      <div class="item-main"><div class="item-name">${esc(it.name)}</div><div class="item-meta">${fmtBytes(it.size)}${f ? ` · ${esc(f.name)}` : ''}</div></div>
      <button class="iconbtn" data-act="remove" data-id="${it.id}" aria-label="Remove ${esc(it.name)}" ${busy || state.running ? 'disabled' : ''}>${icon('x')}</button>
    </div>${body}</article>`;
}

const seg = (key, options, value) => `<div class="seg" role="group">${options.map(([v, label]) => `<button type="button" data-opt="${key}" data-val="${v}" aria-pressed="${String(value) === String(v)}">${label}</button>`).join('')}</div>`;

function optionsHtml() {
  const s = settings.all();
  const live = state.items.filter((i) => i.format);
  const toPdf = state.combine || live.some((i) => i.target === 'pdf' && i.format !== 'pdf');
  const reflowPdf = state.combine ? live.some((i) => ['doc', 'sheet'].includes(FORMATS[i.format].kind)) : live.some((i) => i.target === 'pdf' && FORMATS[i.format].kind !== 'image');
  const lossy = !state.combine && live.some((i) => i.target === 'jpg' || i.target === 'webp');
  const imgToImg = !state.combine && live.some((i) => FORMATS[i.format].kind === 'image' && i.target !== 'pdf');
  const pdfToImg = !state.combine && live.some((i) => i.format === 'pdf' && (i.target === 'jpg' || i.target === 'png'));
  const toDocx = !state.combine && live.some((i) => i.target === 'docx');
  if (!toPdf && !lossy && !imgToImg && !pdfToImg && !toDocx) return '';
  let h = '';
  if (toPdf || toDocx) {
    h += `<div class="opt"><div class="lbl">Page size</div>${seg('pageSize', [['A4', 'A4'], ['LETTER', 'US Letter']], s.pageSize)}</div>`;
    if (reflowPdf || toDocx) {
      h += `<div class="opt"><div class="lbl">Orientation</div>${seg('orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']], s.orientation)}</div>`;
      h += `<div class="opt"><div class="lbl">Margins</div>${seg('margin', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']], s.margin)}</div>`;
    }
    if (reflowPdf) {
      h += `<div class="opt"><div class="lbl">PDF style</div>${seg('pdfMode', [['auto', 'Auto'], ['text', 'Text'], ['snapshot', 'Snapshot']], s.pdfMode)}<p class="small muted" style="margin-top:6px">Text makes small PDFs you can select and search. Snapshot draws every script and emoji exactly. Auto chooses for you.</p></div>`;
      h += `<div class="opt opt-row"><div><b>Page numbers</b><span>Text-style PDFs only</span></div><label class="switch"><input type="checkbox" data-check="pageNumbers" ${s.pageNumbers ? 'checked' : ''} aria-label="Page numbers"><i></i></label></div>`;
    }
  }
  if (lossy) h += `<div class="opt"><label for="opt-q"><span>Image quality</span><output id="opt-q-out">${Math.round(s.quality * 100)}%</output></label><input type="range" id="opt-q" data-range="quality" min="0.4" max="1" step="0.05" value="${s.quality}"></div>`;
  if (imgToImg) h += `<div class="opt"><div class="lbl">Resize</div>${seg('maxEdge', [[0, 'Original'], [2560, '2560 px'], [1600, '1600 px'], [1024, '1024 px']], s.maxEdge)}</div>`;
  if (pdfToImg) h += `<div class="opt"><div class="lbl">Page image sharpness</div>${seg('dpi', [[96, 'Screen'], [150, 'Standard'], [220, 'Sharp'], [300, 'Print']], s.dpi)}</div>`;
  return `<details class="card options" ${state.optionsOpen ? 'open' : ''}><summary>${icon('sliders')}Options${icon('down')}</summary><div class="opts">${h}</div></details>`;
}

function combinedHtml() {
  const c = state.combined;
  if (!c) return '';
  if (c.status === 'working') return `<div class="card item"><div class="item-name">Combining into one PDF</div><div class="progress" role="progressbar"><i style="width:${Math.round((c.progress || 0.02) * 100)}%"></i></div><div class="status">${esc(c.message || 'Working…')}</div></div>`;
  if (c.status === 'error') return `<div class="card item"><div class="errorbox" role="alert" style="margin:0">${icon('alert')}<span>${esc(c.error)}</span></div></div>`;
  return `<div class="card item" data-item="combined">${resultHtml(c.result, 'combined')}</div>`;
}

function homeHtml() {
  const labels = ['PDF', 'DOCX', 'EPUB', 'XLSX', 'CSV', 'MD', 'HTML', 'TXT', 'JPG', 'PNG', 'WEBP'];
  return `<section class="hero"><h1>Any document, <em>reshaped</em> on your own device.</h1><p>Convert Word, PDF, e-books, spreadsheets and images. Organise, compress and search PDFs. Read everything comfortably. Nothing is ever uploaded.</p></section>
    <button class="drop" data-act="pick" type="button"><div class="drop-ic">${icon('upload')}</div><strong>Choose files</strong><span>or drop them anywhere on this page</span><div class="formats" aria-label="Supported formats">${labels.map((l) => `<b>${l}</b>`).join('')}</div></button>
    <div class="trust">
      <div>${icon('lock')}<b>Private by design</b><span>Files stay on this device. There is no server.</span></div>
      <div>${icon('offline')}<b>Works offline</b><span>Install it and convert on a plane.</span></div>
      <div>${icon('book')}<b>Built-in reader</b><span>Read anything you convert, in comfort.</span></div>
    </div>
    ${recents.length ? `<section class="recents"><div class="section-head"><h2>Recently converted</h2><a class="btn btn-ghost btn-sm" href="#/library">See all</a></div><div class="lib-list">${recents.map((m) => `<a class="card lib-item" href="#/read/${m.id}" style="text-decoration:none;color:inherit">${m.thumb ? `<img class="thumb" src="${m.thumb}" alt="">` : tile(m.format)}<div class="item-main"><div class="item-name">${esc(m.name)}</div><div class="item-meta">${fmtBytes(m.size)} · ${timeAgo(m.created)}</div></div>${icon('book')}<span style="width:8px"></span></a>`).join('')}</div></section>` : ''}`;
}

function queueHtml() {
  const n = pending().length;
  const canMerge = combinable().length >= 2;
  if (!canMerge) state.combine = false;
  const label = state.running ? 'Converting…' : state.combine ? `Combine ${combinable().length} files into one PDF` : `Convert ${n} file${n === 1 ? '' : 's'}`;
  return `<div class="page-head"><div><h1>Convert</h1><p>${state.items.length} file${state.items.length === 1 ? '' : 's'} · converted on this device</p></div><button class="btn btn-ghost btn-sm" data-act="clear" ${state.running ? 'disabled' : ''}>Clear</button></div>
    <button class="drop compact" data-act="pick" type="button" ${state.running ? 'disabled' : ''}><div class="drop-ic">${icon('plus')}</div><strong>Add more files</strong></button>
    <div class="queue">
      ${canMerge ? `<div class="card combine"><div>${icon('layers')}</div><div><b>Combine into one PDF</b><span>Merge everything, in this order</span></div><label class="switch"><input type="checkbox" data-check="combine" ${state.combine ? 'checked' : ''} ${state.running ? 'disabled' : ''} aria-label="Combine into one PDF"><i></i></label></div>` : ''}
      ${state.combine ? combinedHtml() : ''}
      ${state.items.map(itemHtml).join('')}
      ${optionsHtml()}
      ${state.running || state.combine || n ? `<div class="actionbar"><button class="btn btn-primary btn-lg" data-act="convert" ${state.running ? 'disabled' : ''}>${icon('convert')}${label}</button></div>` : ''}
    </div>`;
}

function render() {
  if (!root) return;
  const scroll = window.scrollY;
  root.innerHTML = `${state.items.length ? queueHtml() : homeHtml()}<input type="file" multiple hidden data-picker>`;
  window.scrollTo(0, scroll);
}

function patchItem(it) {
  const el = root?.querySelector(`[data-item="${it.id}"]`);
  if (!el) return render();
  const bar = el.querySelector('.progress i');
  if (bar && it.status === 'working') {
    bar.style.width = `${Math.round((it.progress || 0.02) * 100)}%`;
    el.querySelector('.status').textContent = it.message || 'Working…';
  } else el.outerHTML = itemHtml(it, state.items.indexOf(it));
}

/* ---------- actions ---------- */

async function keep(out, from) {
  out.preview = await makePreview(out);
  if (!settings.get('keep')) return null;
  try {
    const meta = { id: uid(), name: out.name, format: out.format, mime: out.blob.type, size: out.blob.size, created: Date.now(), from, ...(out.preview || {}) };
    await library.add(meta, out.blob);
    navigator.storage?.persist?.().catch(() => {});
    return meta.id;
  } catch {
    toast('Storage is full, so this file was not added to your Library. Save it now to keep it.');
    return null;
  }
}

const options = (extra) => {
  const s = settings.all();
  return { pageSize: s.pageSize, orientation: s.orientation, margin: s.margin, pdfMode: s.pdfMode, pageNumbers: s.pageNumbers, quality: s.quality, maxEdge: s.maxEdge, dpi: s.dpi, ...extra };
};

async function runItem(it) {
  it.status = 'working'; it.progress = 0.02; it.message = 'Starting…'; it.error = null; it.result = null;
  patchItem(it);
  try {
    const out = await convert({ name: it.name, blob: it.blob, format: it.format }, it.target, options({ pages: it.pages, level: it.level, watermark: it.watermark, numbers: it.numbers }), (p, m) => {
      it.progress = Math.max(it.progress, p || 0); if (m) it.message = m;
      patchItem(it);
    });
    out.libId = await keep(out, it.name);
    it.result = out; it.status = 'done';
    const last = { ...(settings.get('lastTarget') || {}), [it.format]: it.target };
    settings.set('lastTarget', last);
  } catch (e) {
    console.error(e);
    it.status = 'error';
    it.error = e?.message || 'Something went wrong while converting this file.';
  }
  patchItem(it);
}

async function run() {
  if (state.running) return;
  state.running = true;
  if (state.combine) {
    const files = combinable();
    state.combined = { status: 'working', progress: 0.02, message: 'Starting…' };
    render();
    try {
      const out = await combine(files.map((i) => ({ name: i.name, blob: i.blob, format: i.format })), options(), (p, m) => {
        state.combined.progress = Math.max(state.combined.progress, p || 0); if (m) state.combined.message = m;
        const el = root?.querySelector('.queue .progress i');
        if (el) { el.style.width = `${Math.round(state.combined.progress * 100)}%`; el.closest('.item').querySelector('.status').textContent = state.combined.message; }
      });
      out.libId = await keep(out, `${files.length} files`);
      state.combined = { status: 'done', result: out };
    } catch (e) {
      console.error(e);
      state.combined = { status: 'error', error: e?.message || 'These files could not be combined.' };
    }
  } else {
    render();
    for (const it of pending()) {
      if (!state.items.includes(it)) continue;
      await runItem(it);
    }
  }
  state.running = false;
  render();
  const done = state.combine ? state.combined?.status === 'done' : state.items.some((i) => i.status === 'done');
  if (done && document.hidden === false) root?.querySelector('.result')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** The page organiser is hands-on, so it runs as soon as it is chosen rather than in the batch. */
async function organise(it) {
  const { openOrganizer } = await import('./organizer.js');
  const blob = await openOrganizer({ name: it.name, blob: it.blob });
  if (!blob) { it.target = pickTarget(it.format); return render(); }
  const out = { name: `${baseName(it.name)}-organised.pdf`, blob, format: 'pdf', note: null };
  out.libId = await keep(out, it.name);
  it.result = out; it.status = 'done';
  render();
}

function resultFor(id) {
  return id === 'combined' ? state.combined?.result : state.items.find((i) => i.id === id)?.result;
}

async function onClick(e) {
  const el = e.target.closest('[data-act], [data-opt]');
  if (!el || !root.contains(el)) return;
  if (el.dataset.opt) {
    const v = el.dataset.val;
    settings.set(el.dataset.opt, /^\d+$/.test(v) ? Number(v) : v);
    state.optionsOpen = true;
    return render();
  }
  const { act, id } = el.dataset;
  const it = state.items.find((i) => i.id === id);
  switch (act) {
    case 'pick': root.querySelector('[data-picker]').click(); break;
    case 'clear': state.items = []; state.combined = null; state.combine = false; await loadRecents(); render(); break;
    case 'remove': state.items = state.items.filter((i) => i.id !== id); state.combined = null; if (!state.items.length) await loadRecents(); render(); break;
    case 'target':
      if (!it || it.status === 'working' || state.running) break;
      it.target = el.dataset.target; it.status = 'ready'; it.result = null; it.error = null;
      render();
      if (OPERATIONS[it.target]?.interactive) organise(it);
      break;
    case 'level': if (it) { it.level = el.dataset.val; it.status = 'ready'; it.result = null; render(); } break;
    case 'up': case 'down': {
      const i = state.items.indexOf(it);
      const j = act === 'up' ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < state.items.length) { [state.items[i], state.items[j]] = [state.items[j], state.items[i]]; state.combined = null; render(); }
      break;
    }
    case 'convert': run(); break;
    case 'save': { const r = resultFor(id); if (r) { saveBlob(r.blob, r.name); toast(`Saved ${r.name}`); } break; }
    case 'share': { const r = resultFor(id); if (r) shareBlob(r.blob, r.name); break; }
    case 'read': {
      const r = resultFor(id);
      if (!r) break;
      if (r.libId) location.hash = `#/read/${r.libId}`;
      else { session.temp = { name: r.name, format: r.format, blob: r.blob }; location.hash = '#/read/temp'; }
      break;
    }
  }
}

function onChange(e) {
  const t = e.target;
  if (t.matches('[data-picker]')) { addFiles([...t.files]); t.value = ''; }
  else if (t.dataset.check === 'combine') { state.combine = t.checked; state.combined = null; render(); }
  else if (t.dataset.check) settings.set(t.dataset.check, t.checked);
  else if (t.dataset.field === 'numbers') { const it = state.items.find((i) => i.id === t.dataset.for); if (it) { it.numbers = t.checked; if (it.status !== 'working') it.status = 'ready'; } }
  else if (t.dataset.pages) { const it = state.items.find((i) => i.id === t.dataset.pages); if (it) { it.pages = t.value; if (it.status !== 'working') { it.status = 'ready'; } } }
}

function onInput(e) {
  const t = e.target;
  if (t.dataset.range) { settings.set(t.dataset.range, Number(t.value)); const out = root.querySelector(`#${t.id}-out`); if (out) out.textContent = `${Math.round(t.value * 100)}%`; }
  else if (t.dataset.pages) { const it = state.items.find((i) => i.id === t.dataset.pages); if (it) it.pages = t.value; }
  else if (t.dataset.field === 'watermark') { const it = state.items.find((i) => i.id === t.dataset.for); if (it) { it.watermark = t.value; if (it.status === 'done' || it.status === 'error') it.status = 'ready'; } }
}

async function loadRecents() {
  try { recents = (await library.list()).slice(0, 3); } catch { recents = []; }
}

export async function mount(el) {
  root = el;
  await loadRecents();
  render();
  let depth = 0;
  const zone = () => root?.querySelector('.drop');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const enter = (e) => { if (hasFiles(e)) { depth++; zone()?.classList.add('over'); } };
  const leave = (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; zone()?.classList.remove('over'); } };
  const over = (e) => { if (hasFiles(e)) e.preventDefault(); };
  const drop = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; zone()?.classList.remove('over'); if (!state.running) addFiles([...e.dataTransfer.files]); };
  const paste = (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length && !state.running) { e.preventDefault(); addFiles(files); } };
  const toggle = (e) => { if (e.target.matches?.('details.options')) state.optionsOpen = e.target.open; };
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('input', onInput);
  el.addEventListener('toggle', toggle, true);
  window.addEventListener('dragenter', enter);
  window.addEventListener('dragleave', leave);
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop);
  window.addEventListener('paste', paste);
  return () => {
    root = null;
    el.removeEventListener('click', onClick);
    el.removeEventListener('change', onChange);
    el.removeEventListener('input', onInput);
    el.removeEventListener('toggle', toggle, true);
    window.removeEventListener('dragenter', enter);
    window.removeEventListener('dragleave', leave);
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', drop);
    window.removeEventListener('paste', paste);
  };
}
