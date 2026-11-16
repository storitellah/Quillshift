// The Library: everything you have converted, stored on this device.

import { esc, fmtBytes, timeAgo, uid } from '../core/util.js';
import { FORMATS, detectFormat } from '../core/formats.js';
import { icon, tile, toast, openSheet, saveBlob, shareBlob, canShare } from '../core/ui.js';
import { library } from '../core/store.js';
import { addFiles } from './convert.js';

const EMPTY_ART = `<svg viewBox="0 0 96 96" fill="none" aria-hidden="true"><rect x="18" y="14" width="44" height="58" rx="6" fill="var(--surface-2)" stroke="var(--line)" stroke-width="2"/><rect x="34" y="24" width="44" height="58" rx="6" fill="var(--surface)" stroke="var(--ink-3)" stroke-width="2"/><path d="M44 40h24M44 50h24M44 60h14" stroke="var(--ink-3)" stroke-width="2.5" stroke-linecap="round"/><circle cx="72" cy="74" r="12" fill="var(--accent)"/><path d="M67 74h10m-4-4 4 4-4 4" stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export async function mount(el) {
  let items = [];
  let query = '';

  const listHtml = () => {
    const q = query.trim().toLowerCase();
    const shown = q ? items.filter((m) => m.name.toLowerCase().includes(q) || m.format.includes(q)) : items;
    if (!shown.length) return `<p class="muted" style="padding:24px 4px;text-align:center">Nothing matches “${esc(query)}”.</p>`;
    return shown.map((m) => `<div class="card lib-item">
      <button class="lib-open" data-open="${m.id}" aria-label="Read ${esc(m.name)}">${tile(m.format)}<div class="item-main"><div class="item-name">${esc(m.name)}</div><div class="item-meta">${fmtBytes(m.size)} · ${timeAgo(m.created)}</div>${m.progress > 0.01 && m.progress < 0.995 ? `<div class="lib-bar" title="${Math.round(m.progress * 100)}% read"><i style="width:${Math.round(m.progress * 100)}%"></i></div>` : ''}</div></button>
      <button class="iconbtn" data-more="${m.id}" aria-label="More actions for ${esc(m.name)}">${icon('more')}</button></div>`).join('');
  };

  const render = () => {
    const total = items.reduce((n, m) => n + m.size, 0);
    el.innerHTML = `<div class="page-head"><div><h1>Library</h1><p>${items.length ? `${items.length} file${items.length === 1 ? '' : 's'} · ${fmtBytes(total)} on this device` : 'Stored only on this device'}</p></div>
      <button class="btn btn-quiet btn-sm" data-import>${icon('plus')}Open file</button></div>
      ${items.length > 5 ? `<div class="searchbox">${icon('search')}<input type="search" placeholder="Search your library" aria-label="Search your library" value="${esc(query)}"></div>` : ''}
      ${items.length ? `<div class="lib-list" data-list>${listHtml()}</div>` : `<div class="empty">${EMPTY_ART}<h2>Your shelf is empty</h2><p>Files you convert are kept here so you can read them later, even offline. You can also open a file just to read it.</p><a class="btn btn-primary" href="#/">${icon('convert')}Convert a file</a></div>`}
      <input type="file" hidden data-picker>`;
  };

  const reload = async () => { items = await library.list(); render(); };

  const more = (m) => openSheet({
    title: m.name,
    body: `<div class="menu">
      <button data-a="read">${icon('book')}Read</button>
      <button data-a="save">${icon('download')}Save to device</button>
      ${navigator.share ? `<button data-a="share">${icon('share')}Share…</button>` : ''}
      ${FORMATS[m.format]?.kind !== 'archive' ? `<button data-a="convert">${icon('convert')}Convert to another format</button>` : ''}
      <button data-a="delete" class="danger">${icon('trash')}Remove from Library</button></div>
      <p class="small muted">${esc(FORMATS[m.format]?.name || m.format)} · ${fmtBytes(m.size)}${m.from ? ` · from ${esc(m.from)}` : ''}</p>`,
    onMount(body, close) {
      body.addEventListener('click', async (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        close();
        if (a === 'read') { location.hash = `#/read/${m.id}`; return; }
        if (a === 'delete') { await library.remove(m.id); toast(`Removed ${m.name}`); return reload(); }
        const full = await library.get(m.id);
        if (!full) return toast('That file is no longer available.');
        if (a === 'save') { saveBlob(full.blob, full.name); toast(`Saved ${full.name}`); }
        else if (a === 'share') { if (canShare(full.blob, full.name)) shareBlob(full.blob, full.name); else { saveBlob(full.blob, full.name); toast('Sharing files is not supported here, so it was saved instead.'); } }
        else if (a === 'convert') { await addFiles([new File([full.blob], full.name, { type: full.mime })]); location.hash = '#/'; }
      });
    },
  });

  const onClick = async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { location.hash = `#/read/${open.dataset.open}`; return; }
    const m = e.target.closest('[data-more]');
    if (m) return more(items.find((x) => x.id === m.dataset.more));
    if (e.target.closest('[data-import]')) el.querySelector('[data-picker]').click();
  };
  const onChange = async (e) => {
    if (!e.target.matches('[data-picker]')) return;
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const format = await detectFormat(f);
    if (!format) return toast('This file type cannot be opened yet.');
    try {
      const meta = { id: uid(), name: f.name, format, mime: f.type || FORMATS[format].mime, size: f.size, created: Date.now(), from: null };
      await library.add(meta, f);
      location.hash = `#/read/${meta.id}`;
    } catch { toast('There is not enough storage to add this file.'); }
  };
  const onInput = (e) => {
    if (!e.target.matches('input[type="search"]')) return;
    query = e.target.value;
    el.querySelector('[data-list]').innerHTML = listHtml();
  };

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('input', onInput);
  await reload();
  return () => {
    el.removeEventListener('click', onClick);
    el.removeEventListener('change', onChange);
    el.removeEventListener('input', onInput);
  };
}

