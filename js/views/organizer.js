// Page organiser: see every page of a PDF, then reorder, rotate and delete.

import { esc } from '../core/util.js';
import { icon, toast } from '../core/ui.js';

// A sideways page swaps its box: size the image to the box's other axis, then turn it.
const turned = (p) => (p.rotate % 180
  ? `width:${100 / p.ratio}%;height:${100 * p.ratio}%;transform:translate(-50%,-50%) rotate(${p.rotate}deg)`
  : `width:100%;height:100%;transform:translate(-50%,-50%) rotate(${p.rotate}deg)`);

/**
 * @param {{name: string, blob: Blob}} file
 * @returns {Promise<Blob|null>} the rearranged PDF, or null if cancelled
 */
export function openOrganizer(file) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'organizer';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Organise pages');
    host.innerHTML = `<header class="org-bar"><button class="iconbtn" data-act="cancel" aria-label="Cancel">${icon('x')}</button><div class="reader-title">Organise pages<small>${esc(file.name)}</small></div><button class="btn btn-primary btn-sm" data-act="save" disabled>Save</button></header>
      <div class="org-scroll"><div class="reader-state"><div class="spinner"></div><p>Opening pages…</p></div></div>
      <footer class="org-tools">
        <button data-act="left" disabled>${icon('rotl')}<span>Left</span></button>
        <button data-act="right" disabled>${icon('rotr')}<span>Right</span></button>
        <button data-act="earlier" disabled>${icon('up')}<span>Earlier</span></button>
        <button data-act="later" disabled>${icon('down')}<span>Later</span></button>
        <button data-act="delete" class="danger" disabled>${icon('trash')}<span>Delete</span></button>
      </footer>`;
    document.body.append(host);
    const scroll = host.querySelector('.org-scroll');
    const saveBtn = host.querySelector('[data-act="save"]');

    let pdf = null;
    let pages = [];           // [{ index, rotate, ratio, thumb }]
    const selected = new Set(); // page objects
    let dirty = false;
    let observer = null;
    let busy = false;

    const finish = (result) => {
      observer?.disconnect();
      pdf?.destroy();
      document.removeEventListener('keydown', onKey);
      host.remove();
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);

    const sync = () => {
      const n = selected.size;
      for (const b of host.querySelectorAll('.org-tools button')) b.disabled = !n || busy;
      if (n === pages.length) host.querySelector('[data-act="delete"]').disabled = true;
      saveBtn.disabled = !dirty || busy;
    };

    const draw = () => {
      scroll.innerHTML = `<p class="org-hint">${pages.length} page${pages.length === 1 ? '' : 's'} · tap pages to select them</p><div class="org-grid">${pages.map((p, i) => `<button class="org-page" data-i="${i}" aria-pressed="${selected.has(p)}" aria-label="Page ${i + 1}">
        <span class="org-thumb" style="aspect-ratio:${p.rotate % 180 ? p.ratio : 1 / p.ratio}">${p.thumb ? `<img src="${p.thumb}" alt="" style="${turned(p)}">` : ''}</span><b>${i + 1}</b></button>`).join('')}</div>`;
      observer?.disconnect();
      observer = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); render(pages[Number(e.target.dataset.i)], e.target); }
      }, { root: scroll, rootMargin: '400px 0px' });
      for (const el of scroll.querySelectorAll('.org-page')) if (!pages[Number(el.dataset.i)].thumb) observer.observe(el);
      sync();
    };

    let chain = Promise.resolve();
    const render = (p, el) => {
      chain = chain.then(async () => {
        if (p.thumb || !host.isConnected) return;
        const { renderPage } = await import('../convert/pdf-in.js');
        const page = await pdf.getPage(p.index + 1);
        const vp = page.getViewport({ scale: 1 });
        const canvas = await renderPage(page, 300 / Math.max(vp.width, vp.height));
        p.thumb = canvas.toDataURL('image/jpeg', 0.7);
        canvas.width = canvas.height = 0;
        page.cleanup();
        const holder = el.isConnected ? el.querySelector('.org-thumb') : scroll.querySelector(`[data-i="${pages.indexOf(p)}"] .org-thumb`);
        if (holder) holder.innerHTML = `<img src="${p.thumb}" alt="" style="${turned(p)}">`;
      }).catch(() => {});
    };

    const move = (dir) => {
      const order = pages.map((p, i) => [p, i]).filter(([p]) => selected.has(p)).map(([, i]) => i);
      if (dir > 0) order.reverse();
      for (const i of order) {
        const j = i + dir;
        if (j < 0 || j >= pages.length || selected.has(pages[j])) continue;
        [pages[i], pages[j]] = [pages[j], pages[i]];
      }
    };

    host.addEventListener('click', async (e) => {
      const tile = e.target.closest('.org-page');
      if (tile && !busy) {
        const p = pages[Number(tile.dataset.i)];
        if (selected.has(p)) selected.delete(p); else selected.add(p);
        tile.setAttribute('aria-pressed', String(selected.has(p)));
        return sync();
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act || busy) return;
      if (act === 'cancel') return finish(null);
      if (act === 'save') {
        busy = true; sync();
        saveBtn.textContent = 'Saving…';
        try {
          const { arrangePdf } = await import('../convert/pdf-tools.js');
          return finish(await arrangePdf(file.blob, pages.map((p) => ({ index: p.index, rotate: p.rotate }))));
        } catch (err) { toast(err.message); busy = false; saveBtn.textContent = 'Save'; return sync(); }
      }
      if (act === 'left' || act === 'right') for (const p of selected) p.rotate = (p.rotate + (act === 'left' ? 270 : 90)) % 360;
      else if (act === 'earlier') move(-1);
      else if (act === 'later') move(1);
      else if (act === 'delete') { pages = pages.filter((p) => !selected.has(p)); selected.clear(); }
      dirty = true;
      const top = scroll.scrollTop;
      draw();
      scroll.scrollTop = top;
    });

    (async () => {
      try {
        const { openPdf } = await import('../convert/pdf-in.js');
        pdf = await openPdf(file.blob);
        const first = await pdf.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        pages = Array.from({ length: pdf.numPages }, (_, index) => ({ index, rotate: 0, ratio: vp.height / vp.width, thumb: null }));
        draw();
      } catch (err) { toast(err.message); finish(null); }
    })();
  });
}
