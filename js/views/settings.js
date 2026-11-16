// Settings: install, appearance, library retention, storage and offline engines.

import { fmtBytes } from '../core/util.js';
import { icon, toast, confirmSheet, isStandalone } from '../core/ui.js';
import { library, settings } from '../core/store.js';
import { PACKS, packUrl } from '../core/loader.js';
import { session, promptInstall, onInstallChange } from '../core/session.js';
import { VERSION, ENGINE_CACHE } from '../core/version.js';
import { applyTheme, showInstallHelp } from '../core/shell.js';

const seg = (key, options, value) => `<div class="seg" role="group">${options.map(([v, label]) => `<button type="button" data-set="${key}" data-val="${v}" aria-pressed="${String(value) === String(v)}">${label}</button>`).join('')}</div>`;

async function engineState() {
  const state = new Map();
  if (!('caches' in window)) return state;
  const cache = await caches.open(ENGINE_CACHE);
  for (const p of PACKS) {
    let have = 0;
    let bytes = 0;
    for (const f of p.files) {
      const res = await cache.match(packUrl(f));
      if (res) { have++; bytes += Number(res.headers.get('Content-Length')) || (await res.clone().blob()).size; }
    }
    state.set(p.id, { ready: have === p.files.length, bytes });
  }
  return state;
}

export async function mount(el) {
  let busy = false;

  const render = async () => {
    const s = settings.all();
    const [items, engines, est] = await Promise.all([
      library.list().catch(() => []),
      engineState().catch(() => new Map()),
      navigator.storage?.estimate?.().catch(() => null) ?? null,
    ]);
    const libBytes = items.reduce((n, m) => n + m.size, 0);
    const engBytes = [...engines.values()].reduce((n, e) => n + e.bytes, 0);
    const quota = est?.quota || 0;
    const scale = Math.max(libBytes + engBytes, 1) / 0.6; // the bar shows proportions, not the (huge) quota
    const allReady = PACKS.every((p) => engines.get(p.id)?.ready);
    const installed = isStandalone();

    el.innerHTML = `<div class="page-head"><div><h1>Settings</h1></div></div>

    <section class="group"><h2 class="eyebrow">App</h2><div class="card rows">
      <div class="row"><div><b>${installed ? 'Installed' : 'Install Quillshift'}</b><span>${installed ? 'Running as an app on this device.' : 'Full-screen, offline, on your Home Screen.'}</span></div>
        ${installed ? `<span class="pill ok">${icon('check')}Installed</span>` : `<button class="btn btn-primary btn-sm" data-act="install">${icon('install')}Install</button>`}</div>
      <div class="row row-stack"><div><b>Appearance</b></div>${seg('theme', [['auto', 'Match device'], ['light', 'Light'], ['dark', 'Dark']], s.theme)}</div>
    </div></section>

    <section class="group"><h2 class="eyebrow">Conversions</h2><div class="card rows">
      <div class="row"><div><b>Keep converted files</b><span>Save results to your Library so you can read them later.</span></div><label class="switch"><input type="checkbox" data-check="keep" ${s.keep ? 'checked' : ''} aria-label="Keep converted files"><i></i></label></div>
      <div class="row row-stack"><div><b>Tidy up automatically</b><span>Remove Library files after a while to save space.</span></div>${seg('retention', [[0, 'Never'], [30, 'After 30 days'], [7, 'After 7 days']], s.retention)}</div>
      <div class="row row-stack"><div><b>Default page size</b></div>${seg('pageSize', [['A4', 'A4'], ['LETTER', 'US Letter']], s.pageSize)}</div>
    </div></section>

    <section class="group"><h2 class="eyebrow">Storage</h2><div class="card rows">
      <div class="row row-stack"><div><b>${fmtBytes(libBytes + engBytes)} used on this device</b>${quota ? `<span>Your browser allows up to about ${fmtBytes(quota)}.</span>` : ''}</div>
        <div class="meter"><i class="m-lib" style="width:${(libBytes / scale) * 100}%"></i><i class="m-eng" style="width:${(engBytes / scale) * 100}%"></i></div>
        <div class="legend"><span><i style="background:var(--accent)"></i>Library ${fmtBytes(libBytes)}</span><span><i style="background:var(--ink-3)"></i>Engines ${fmtBytes(engBytes)}</span></div></div>
      <div class="row"><div><b>Library</b><span>${items.length} file${items.length === 1 ? '' : 's'}</span></div><button class="btn btn-quiet btn-sm btn-danger" data-act="clear-library" ${items.length ? '' : 'disabled'}>Clear</button></div>
    </div></section>

    <section class="group"><h2 class="eyebrow">Offline engines</h2>
      <p class="small muted" style="margin:0 4px 10px">Quillshift itself is tiny. Each engine is downloaded the first time you need it, then kept for offline use.</p>
      <div class="card rows">
      ${PACKS.map((p) => { const e = engines.get(p.id); return `<div class="row"><div><b>${p.label}</b><span>${p.detail}</span></div><span class="pill ${e?.ready ? 'ok' : ''}">${e?.ready ? `${icon('check')}Offline` : `${p.size} MB`}</span></div>`; }).join('')}
      <div class="row"><button class="btn btn-quiet btn-sm" data-act="get-engines" ${allReady || busy ? 'disabled' : ''}>${icon('download')}${busy ? 'Downloading…' : allReady ? 'All available offline' : 'Download all'}</button><button class="btn btn-ghost btn-sm btn-danger" data-act="drop-engines" ${engBytes && !busy ? '' : 'disabled'}>Remove</button></div>
    </div></section>

    <section class="group"><h2 class="eyebrow">Privacy</h2><div class="card rows"><div class="row"><div><b>Your files never leave this device</b><span>Every conversion runs in your browser. Quillshift has no server, no account, no analytics and no trackers, and the app is blocked from contacting any other site.</span></div></div></div></section>

    <p class="about">Quillshift ${VERSION} · <a href="vendor/THIRD-PARTY.md" target="_blank" rel="noopener">Open-source licences</a></p>`;
  };

  const onClick = async (e) => {
    const set = e.target.closest('[data-set]');
    if (set) {
      const v = set.dataset.val;
      settings.set(set.dataset.set, /^\d+$/.test(v) ? Number(v) : v);
      if (set.dataset.set === 'theme') applyTheme();
      if (set.dataset.set === 'retention') { const n = await library.prune(settings.get('retention')); if (n) toast(`Removed ${n} old file${n === 1 ? '' : 's'}.`); }
      return render();
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'install') {
      if (session.installPrompt) await promptInstall(); else showInstallHelp();
    } else if (act === 'clear-library') {
      if (await confirmSheet({ title: 'Clear your Library?', message: 'Every converted file stored in Quillshift will be removed from this device. Files you already saved elsewhere are not affected.', confirm: 'Clear Library', danger: true })) {
        await library.clear(); toast('Library cleared.'); render();
      }
    } else if (act === 'get-engines') {
      busy = true; await render();
      try {
        const cache = await caches.open(ENGINE_CACHE);
        for (const f of PACKS.flatMap((p) => p.files)) if (!(await cache.match(packUrl(f)))) await cache.add(packUrl(f));
        toast('Everything is ready for offline use.');
      } catch { toast('Download failed. Check your connection and try again.'); }
      busy = false; render();
    } else if (act === 'drop-engines') {
      await caches.delete(ENGINE_CACHE);
      toast('Engines removed. They will download again when needed.');
      render();
    }
  };
  const onChange = (e) => { if (e.target.dataset.check) settings.set(e.target.dataset.check, e.target.checked); };

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  const off = onInstallChange(render);
  await render();
  return () => { el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); off(); };
}
