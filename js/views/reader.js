// The reader: reflowable text with typography controls, a lazy PDF page viewer,
// spreadsheet grids, images and archives. Remembers where you stopped.

import { FORMATS } from '../core/formats.js';
import { esc, fmtBytes, debounce } from '../core/util.js';
import { icon, toast, openSheet, saveBlob, shareBlob, canShare } from '../core/ui.js';
import { library, settings } from '../core/store.js';
import { session } from '../core/session.js';
import { addFiles } from './convert.js';

const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

export async function mount(el, id) {
  const prefs = { ...settings.get('reader') };
  const cleanups = [];
  let dead = false;
  let file = id === 'temp' ? session.temp : await library.get(id).catch(() => null);

  el.innerHTML = `<div class="reader">
    <div class="reader-progress"><i></i></div>
    <header class="reader-bar">
      <button class="iconbtn" data-act="back" aria-label="Back">${icon('back')}</button>
      <div class="reader-title">${esc(file?.name || 'Reader')}</div>
      <span data-tools style="display:contents"></span>
      <button class="iconbtn" data-act="more" aria-label="More actions" ${file ? '' : 'hidden'}>${icon('more')}</button>
    </header>
    <div class="reader-scroll" tabindex="0"><div class="reader-state"><div class="spinner"></div><p>Opening…</p></div></div>
    <div data-float></div>
  </div>`;
  const reader = el.querySelector('.reader');
  const scroll = el.querySelector('.reader-scroll');
  const tools = el.querySelector('[data-tools]');
  const float = el.querySelector('[data-float]');
  const bar = el.querySelector('.reader-progress i');

  const applyPrefs = () => {
    if (prefs.theme === 'auto') delete reader.dataset.theme; else reader.dataset.theme = prefs.theme;
    reader.dataset.font = prefs.font;
    reader.dataset.width = prefs.width;
    reader.dataset.justify = String(!!prefs.justify);
    reader.style.setProperty('--r-size', `${prefs.size}px`);
    reader.style.setProperty('--r-leading', String(prefs.leading));
  };
  const savePrefs = () => { settings.set('reader', { ...prefs }); applyPrefs(); };
  applyPrefs();

  const fail = (message) => {
    tools.innerHTML = '';
    float.innerHTML = '';
    scroll.innerHTML = `<div class="reader-state">${icon('alert')}<p>${esc(message)}</p><a class="btn btn-quiet" href="#/library">Back to Library</a></div>`;
  };

  /* ---------- progress & chrome ---------- */

  const saveProgress = debounce((p) => { if (file?.id) library.patch(file.id, { progress: p }).catch(() => {}); }, 600);
  let lastY = 0;
  let restoring = false;
  const onScroll = () => {
    const max = scroll.scrollHeight - scroll.clientHeight;
    const p = max > 0 ? Math.min(1, scroll.scrollTop / max) : 1;
    bar.style.width = `${p * 100}%`;
    if (!restoring && max > 0) saveProgress(p);
    const dy = scroll.scrollTop - lastY;
    if (Math.abs(dy) > 12) {
      reader.classList.toggle('bars-hidden', dy > 0 && scroll.scrollTop > 120 && !speech.active);
      lastY = scroll.scrollTop;
    }
  };
  scroll.addEventListener('scroll', onScroll, { passive: true });
  const restore = () => {
    const p = file?.progress || 0;
    if (p <= 0.005 || p >= 0.995) return;
    restoring = true;
    requestAnimationFrame(() => {
      scroll.scrollTop = p * (scroll.scrollHeight - scroll.clientHeight);
      lastY = scroll.scrollTop;
      setTimeout(() => { restoring = false; }, 300);
    });
  };

  /* ---------- reflowable documents ---------- */

  let prose = null;
  const speech = { active: false, paused: false, queue: [], index: 0, block: null };

  function showProse(html, extraTools = '') {
    stopSpeech();
    scroll.innerHTML = '<article class="prose"></article>';
    prose = scroll.firstElementChild;
    prose.innerHTML = html; // sanitised by cleanHtml()
    let n = 0;
    for (const h of prose.querySelectorAll('h1, h2, h3')) if (!h.id) h.id = `doc-h-${++n}`;
    for (const a of prose.querySelectorAll('a[href]')) {
      if (!a.getAttribute('href').startsWith('#')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    }
    const headings = prose.querySelectorAll('h1, h2, h3').length;
    tools.innerHTML = `${extraTools}
      ${headings > 1 ? `<button class="iconbtn" data-act="toc" aria-label="Contents">${icon('list')}</button>` : ''}
      ${'speechSynthesis' in window ? `<button class="iconbtn" data-act="listen" aria-label="Listen">${icon('listen')}</button>` : ''}
      <button class="iconbtn" data-act="type" aria-label="Text settings">${icon('type')}</button>`;
    float.innerHTML = '';
    scroll.scrollTop = 0;
  }

  const jump = (target) => {
    if (!target) return;
    scroll.scrollTo({ top: Math.max(0, target.offsetTop - 64), behavior: 'smooth' });
  };

  function openToc() {
    const hs = [...prose.querySelectorAll('h1, h2, h3')];
    openSheet({
      title: 'Contents',
      body: `<div class="toc">${hs.map((h, i) => `<button class="l${h.tagName[1]}" data-i="${i}">${esc(h.textContent.trim().slice(0, 140))}</button>`).join('')}</div>`,
      onMount(body, close) {
        body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-i]');
          if (b) { close(); jump(hs[Number(b.dataset.i)]); }
        });
      },
    });
  }

  function openTypeSettings() {
    const seg = (key, options) => `<div class="seg" role="group">${options.map(([v, l]) => `<button type="button" data-p="${key}" data-v="${v}" aria-pressed="${String(prefs[key]) === String(v)}">${l}</button>`).join('')}</div>`;
    const html = () => `
      <div><div class="eyebrow" style="margin-bottom:8px">Theme</div><div class="swatches">
        ${[['auto', 'Auto', 'var(--surface-2)', 'var(--ink)'], ['paper', 'Paper', '#fffdf8', '#1c1b29'], ['sepia', 'Sepia', '#f4e9d3', '#43301d'], ['night', 'Night', '#101014', '#d9d5cc']].map(([v, l, bg, fg]) => `<button class="swatch" data-p="theme" data-v="${v}" aria-pressed="${prefs.theme === v}" style="background:${bg};color:${fg}"><b>Aa</b>${l}</button>`).join('')}</div></div>
      <div><div class="eyebrow" style="margin-bottom:8px">Typeface</div>${seg('font', [['serif', 'Serif'], ['sans', 'Sans'], ['mono', 'Mono']])}</div>
      <div class="opt-row"><b>Text size</b><div class="stepper"><button class="iconbtn" data-step="size" data-d="-1" aria-label="Smaller text">${icon('minus')}</button><output>${prefs.size}</output><button class="iconbtn" data-step="size" data-d="1" aria-label="Larger text">${icon('plus')}</button></div></div>
      <div class="opt-row"><b>Line spacing</b><div class="stepper"><button class="iconbtn" data-step="leading" data-d="-0.1" aria-label="Tighter lines">${icon('minus')}</button><output>${prefs.leading.toFixed(1)}</output><button class="iconbtn" data-step="leading" data-d="0.1" aria-label="Looser lines">${icon('plus')}</button></div></div>
      <div><div class="eyebrow" style="margin-bottom:8px">Column width</div>${seg('width', [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']])}</div>
      <div class="opt-row"><b>Justify text</b><label class="switch"><input type="checkbox" data-justify ${prefs.justify ? 'checked' : ''} aria-label="Justify text"><i></i></label></div>`;
    openSheet({
      title: 'Text settings',
      body: html(),
      onMount(body) {
        body.addEventListener('click', (e) => {
          const p = e.target.closest('[data-p]');
          const s = e.target.closest('[data-step]');
          if (p) prefs[p.dataset.p] = p.dataset.v;
          else if (s) {
            if (s.dataset.step === 'size') prefs.size = Math.min(30, Math.max(13, prefs.size + Number(s.dataset.d)));
            else prefs.leading = Math.min(2.2, Math.max(1.2, Math.round((prefs.leading + Number(s.dataset.d)) * 10) / 10));
          } else return;
          savePrefs();
          body.innerHTML = html();
        });
        body.addEventListener('change', (e) => { if (e.target.matches('[data-justify]')) { prefs.justify = e.target.checked; savePrefs(); } });
      },
    });
  }

  /* ---------- listen (text to speech) ---------- */

  function stopSpeech() {
    if (!('speechSynthesis' in window)) return;
    speech.active = false; speech.paused = false;
    speechSynthesis.cancel();
    speech.block?.classList.remove('speaking');
    speech.block = null;
    if (float.querySelector('[data-speech]')) float.innerHTML = '';
  }

  function speechBar() {
    float.innerHTML = `<div class="floatbar" data-speech>
      <button class="iconbtn" data-act="speech-toggle" aria-label="${speech.paused ? 'Resume' : 'Pause'}">${icon(speech.paused ? 'play' : 'pause')}</button>
      <button class="iconbtn" data-act="speech-stop" aria-label="Stop listening">${icon('stop')}</button>
      <select data-rate aria-label="Speaking speed">${[0.8, 1, 1.25, 1.5, 2].map((r) => `<option value="${r}" ${Number(prefs.rate) === r ? 'selected' : ''}>${r}×</option>`).join('')}</select></div>`;
  }

  function speakNext() {
    if (!speech.active) return;
    const item = speech.queue[speech.index];
    if (!item) return stopSpeech();
    if (item.block !== speech.block) {
      speech.block?.classList.remove('speaking');
      speech.block = item.block;
      item.block.classList.add('speaking');
      const top = item.block.offsetTop;
      if (top < scroll.scrollTop + 70 || top > scroll.scrollTop + scroll.clientHeight * 0.7) scroll.scrollTo({ top: Math.max(0, top - scroll.clientHeight * 0.3), behavior: 'smooth' });
    }
    const u = new SpeechSynthesisUtterance(item.text);
    u.rate = Number(prefs.rate) || 1;
    u.onend = () => { if (speech.active && !speech.paused) { speech.index++; speakNext(); } };
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') stopSpeech(); };
    speechSynthesis.speak(u);
  }

  function startSpeech() {
    if (speech.active) return stopSpeech();
    const blocks = [...prose.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th, pre, dt, dd')]
      .filter((b) => b.textContent.trim() && !b.querySelector('p, li, blockquote, pre, table'));
    const from = Math.max(0, blocks.findIndex((b) => b.offsetTop + b.offsetHeight > scroll.scrollTop + 60));
    speech.queue = [];
    for (const block of blocks.slice(from)) {
      // Short utterances keep every browser's speech engine from cutting off mid-paragraph.
      const sentences = block.textContent.replace(/\s+/g, ' ').trim().match(/[^.!?。！？]+[.!?。！？]*["”’)]*\s*|.+$/g) || [];
      let chunk = '';
      for (const s of sentences) {
        if ((chunk + s).length > 220 && chunk) { speech.queue.push({ block, text: chunk }); chunk = ''; }
        chunk += s;
      }
      if (chunk.trim()) speech.queue.push({ block, text: chunk });
    }
    if (!speech.queue.length) return toast('There is no text to read aloud here.');
    speech.active = true; speech.paused = false; speech.index = 0;
    reader.classList.remove('bars-hidden');
    speechSynthesis.cancel();
    speechBar();
    speakNext();
  }

  /* ---------- PDF pages ---------- */

  const pdf = { doc: null, zoom: 1, mode: 'pages', textHtml: null, visible: new Set(), chain: Promise.resolve(), observer: null };

  async function showPdfPages() {
    const { openPdf, renderPage } = await import('../convert/pdf-in.js');
    pdf.doc ??= await openPdf(file.blob);
    if (dead) return;
    stopSpeech();
    prose = null;
    const doc = pdf.doc;
    const first = await doc.getPage(1);
    const vp1 = first.getViewport({ scale: 1 });
    const ratios = Array(doc.numPages).fill(vp1.height / vp1.width);
    scroll.innerHTML = `<div class="pdfview">${ratios.map((_, i) => `<div class="pdfpage" data-n="${i + 1}" role="img" aria-label="Page ${i + 1}"></div>`).join('')}</div>`;
    const pages = [...scroll.querySelectorAll('.pdfpage')];
    const baseWidth = () => Math.round(Math.min(scroll.clientWidth - 20, 920) * pdf.zoom);
    const layout = () => {
      const w = baseWidth();
      pages.forEach((p, i) => { p.style.width = `${w}px`; p.style.height = `${Math.round(w * ratios[i])}px`; });
      return w;
    };
    layout();

    const draw = (pageEl) => {
      pdf.chain = pdf.chain.then(async () => {
        const n = Number(pageEl.dataset.n);
        const w = baseWidth();
        if (dead || pdf.mode !== 'pages' || !pdf.visible.has(pageEl) || Number(pageEl.dataset.w) === w) return;
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        if (Math.abs(ratios[n - 1] - vp.height / vp.width) > 0.001) { ratios[n - 1] = vp.height / vp.width; pageEl.style.height = `${Math.round(w * ratios[n - 1])}px`; }
        const canvas = await renderPage(page, (w * Math.min(window.devicePixelRatio || 1, 2.5)) / vp.width);
        page.cleanup();
        pageEl.replaceChildren(canvas);
        pageEl.dataset.w = String(w);
      }).catch((e) => console.warn(e));
    };
    pdf.observer?.disconnect();
    pdf.visible.clear();
    pdf.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { pdf.visible.add(e.target); draw(e.target); }
        else {
          pdf.visible.delete(e.target);
          const c = e.target.firstElementChild; // free canvas memory for pages far off-screen
          if (c) { c.width = c.height = 0; e.target.replaceChildren(); delete e.target.dataset.w; }
        }
      }
    }, { root: scroll, rootMargin: '900px 0px' });
    pages.forEach((p) => pdf.observer.observe(p));

    tools.innerHTML = `<button class="iconbtn" data-act="pdf-text" aria-label="Read as text" title="Read as text">${icon('text')}</button>`;
    float.innerHTML = `<div class="floatbar autohide"><button class="iconbtn" data-act="zoom-out" aria-label="Zoom out">${icon('minus')}</button><span data-pageno>1 / ${doc.numPages}</span><button class="iconbtn" data-act="zoom-in" aria-label="Zoom in">${icon('plus')}</button></div>`;
    const label = float.querySelector('[data-pageno]');
    let raf = 0;
    const where = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const mid = scroll.scrollTop + scroll.clientHeight / 2;
        let cur = 1;
        for (const p of pages) { if (p.offsetTop <= mid) cur = Number(p.dataset.n); else break; }
        label.textContent = `${cur} / ${doc.numPages}`;
      });
    };
    scroll.addEventListener('scroll', where, { passive: true });
    pdf.setZoom = (z) => {
      const max = scroll.scrollHeight - scroll.clientHeight;
      const frac = max > 0 ? scroll.scrollTop / max : 0;
      pdf.zoom = Math.min(4, Math.max(0.5, z));
      layout();
      scroll.scrollTop = frac * (scroll.scrollHeight - scroll.clientHeight);
      for (const p of pdf.visible) draw(p);
    };
    const onResize = debounce(() => { if (pdf.mode === 'pages') pdf.setZoom(pdf.zoom); }, 200);
    window.addEventListener('resize', onResize);
    pdf.teardownPages = () => { scroll.removeEventListener('scroll', where); window.removeEventListener('resize', onResize); pdf.observer?.disconnect(); pdf.visible.clear(); };
    scroll.scrollTop = 0;
    restore();
  }

  async function showPdfText() {
    scroll.innerHTML = '<div class="reader-state"><div class="spinner"></div><p>Reflowing the text for comfortable reading…</p></div>';
    float.innerHTML = '';
    try {
      if (!pdf.textHtml) {
        const { pdfToHtml } = await import('../convert/pdf-in.js');
        const { cleanHtml } = await import('../convert/doc-in.js');
        pdf.textHtml = await cleanHtml((await pdfToHtml(file)).html);
      }
      if (dead) return;
      pdf.teardownPages?.();
      pdf.mode = 'text';
      showProse(pdf.textHtml, `<button class="iconbtn" data-act="pdf-pages" aria-label="Show original pages" title="Show original pages">${icon('pages')}</button>`);
    } catch (e) {
      toast(e.message);
      pdf.mode = 'pages';
      await showPdfPages();
    }
  }

  /* ---------- sheets, images, archives ---------- */

  async function showSheet() {
    const { readBook } = await import('../convert/sheet.js');
    const book = await readBook(file);
    if (dead) return;
    let active = 0;
    let limit = 500;
    const cell = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
    const draw = () => {
      const s = book.sheets[active];
      const [head = [], ...rows] = s.rows;
      const shown = rows.slice(0, limit);
      scroll.innerHTML = `<div class="sheetview">
        ${book.sheets.length > 1 ? `<div class="sheet-tabs">${book.sheets.map((sh, i) => `<button class="chip" data-sheet="${i}" role="tab" aria-checked="${i === active}" aria-selected="${i === active}">${esc(sh.name)}</button>`).join('')}</div>` : ''}
        ${s.rows.length ? `<div class="gridwrap"><table class="grid"><thead><tr><th class="rn"></th>${head.map((h) => `<th>${esc(cell(h))}</th>`).join('')}</tr></thead>
        <tbody>${shown.map((r, i) => `<tr><td class="rn">${i + 2}</td>${r.map((c) => `<td${typeof c === 'number' ? ' class="num"' : ''}>${esc(cell(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <p class="small" style="padding:12px 18px;color:var(--r-ink-2)">${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'} · ${head.length} column${head.length === 1 ? '' : 's'}${rows.length > limit ? ` · showing the first ${limit.toLocaleString()} <button class="btn btn-quiet btn-sm" data-act="all-rows" style="margin-left:8px">Show all</button>` : ''}</p>` : '<div class="reader-state"><p>This sheet is empty.</p></div>'}
      </div>`;
    };
    scroll.addEventListener('click', (e) => {
      const t = e.target.closest('[data-sheet]');
      if (t) { active = Number(t.dataset.sheet); limit = 500; draw(); } else if (e.target.closest('[data-act="all-rows"]')) { limit = Infinity; draw(); }
    });
    tools.innerHTML = '';
    draw();
  }

  function showImage() {
    const url = URL.createObjectURL(file.blob);
    cleanups.push(() => URL.revokeObjectURL(url));
    scroll.innerHTML = `<div class="imgview"><img src="${url}" alt="${esc(file.name)}"></div>`;
    const img = scroll.querySelector('img');
    img.addEventListener('click', () => img.classList.toggle('actual'));
    img.addEventListener('error', () => fail('This image cannot be displayed by your browser.'));
    tools.innerHTML = '';
  }

  async function showArchive() {
    const { libs } = await import('../core/loader.js');
    const { unzipSync } = await libs.fflate();
    const zip = unzipSync(new Uint8Array(await file.blob.arrayBuffer()));
    if (dead) return;
    const names = Object.keys(zip).filter((n) => !n.endsWith('/')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    let html = '';
    for (const name of names) {
      const mime = IMAGE_EXT[name.split('.').pop().toLowerCase()];
      if (mime) {
        const url = URL.createObjectURL(new Blob([zip[name]], { type: mime }));
        cleanups.push(() => URL.revokeObjectURL(url));
        html += `<figure><img src="${url}" alt="${esc(name)}" loading="lazy"><figcaption>${esc(name)}</figcaption></figure>`;
      } else html += `<div class="zfile">${esc(name)} · ${fmtBytes(zip[name].length)}</div>`;
    }
    scroll.innerHTML = `<div class="zipview"><p class="small" style="color:var(--r-ink-2)">${names.length} file${names.length === 1 ? '' : 's'} in this archive. Use Save to keep them.</p>${html}</div>`;
    tools.innerHTML = '';
  }

  /* ---------- actions ---------- */

  function openMore() {
    const share = canShare(file.blob, file.name);
    openSheet({
      title: file.name,
      body: `<div class="menu">
        <button data-a="save">${icon('download')}Save to device</button>
        ${share ? `<button data-a="share">${icon('share')}Share…</button>` : ''}
        ${FORMATS[file.format]?.kind !== 'archive' ? `<button data-a="convert">${icon('convert')}Convert or use tools</button>` : ''}
        ${file.format === 'pdf' ? `<button data-a="organise">${icon('pages')}Organise pages</button>` : ''}
        ${file.id ? `<button data-a="delete" class="danger">${icon('trash')}Remove from Library</button>` : ''}</div>
        <p class="small muted">${esc(FORMATS[file.format]?.name || '')} · ${fmtBytes(file.blob.size)}</p>`,
      onMount(body, close) {
        body.addEventListener('click', async (e) => {
          const a = e.target.closest('[data-a]')?.dataset.a;
          if (!a) return;
          close();
          if (a === 'save') { saveBlob(file.blob, file.name); toast(`Saved ${file.name}`); }
          else if (a === 'share') shareBlob(file.blob, file.name);
          else if (a === 'convert') { await addFiles([new File([file.blob], file.name, { type: file.blob.type })]); location.hash = '#/'; }
          else if (a === 'organise') {
            const { openOrganizer } = await import('./organizer.js');
            const blob = await openOrganizer(file);
            if (!blob) return;
            const { makePreview } = await import('../core/thumb.js');
            const { uid, baseName } = await import('../core/util.js');
            const out = { name: `${baseName(file.name)}-organised.pdf`, blob, format: 'pdf' };
            const meta = { id: uid(), name: out.name, format: 'pdf', mime: 'application/pdf', size: blob.size, created: Date.now(), from: file.name, ...(await makePreview(out)) };
            try { await library.add(meta, blob); location.hash = `#/read/${meta.id}`; } catch { saveBlob(blob, out.name); toast('Storage is full, so the new PDF was saved to your device instead.'); }
          }
          else if (a === 'delete') { await library.remove(file.id); toast(`Removed ${file.name}`); location.hash = '#/library'; }
        });
      },
    });
  }

  const onClick = async (e) => {
    const link = e.target.closest('.prose a[href^="#"]');
    if (link) {
      e.preventDefault();
      return jump(prose.querySelector(`[id="${CSS.escape(link.getAttribute('href').slice(1))}"]`));
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    switch (act) {
      case 'back': if (session.routes > 1) history.back(); else location.hash = file?.id ? '#/library' : '#/'; break;
      case 'more': openMore(); break;
      case 'toc': openToc(); break;
      case 'type': openTypeSettings(); break;
      case 'listen': startSpeech(); break;
      case 'speech-stop': stopSpeech(); break;
      case 'speech-toggle':
        speech.paused = !speech.paused;
        if (speech.paused) speechSynthesis.cancel(); else speakNext();
        speechBar();
        break;
      case 'zoom-in': pdf.setZoom?.(pdf.zoom * 1.25); break;
      case 'zoom-out': pdf.setZoom?.(pdf.zoom / 1.25); break;
      case 'pdf-text': await showPdfText(); break;
      case 'pdf-pages': pdf.mode = 'pages'; await showPdfPages(); break;
      default:
        // A tap on the text brings the bars back.
        if (!act && e.target.closest('.reader-scroll') && !e.target.closest('a, button, img')) reader.classList.remove('bars-hidden');
    }
  };
  const onChange = (e) => {
    if (e.target.matches('[data-rate]')) {
      prefs.rate = Number(e.target.value); savePrefs();
      if (speech.active && !speech.paused) { speechSynthesis.cancel(); speakNext(); }
    }
  };
  const onKey = (e) => {
    if (e.target.closest('input, select, textarea') || document.querySelector('.scrim')) return;
    if (e.key === 'Escape') { if (speech.active) stopSpeech(); else el.querySelector('[data-act="back"]').click(); }
  };
  reader.addEventListener('click', onClick);
  reader.addEventListener('change', onChange);
  document.addEventListener('keydown', onKey);

  /* ---------- open ---------- */

  if (!file) fail('This file is no longer in your Library.');
  else {
    try {
      const kind = FORMATS[file.format]?.kind;
      if (kind === 'doc') {
        const { docToHtml } = await import('../convert/doc-in.js');
        const { html } = await docToHtml(file);
        if (!dead) { showProse(html); restore(); }
      } else if (kind === 'pdf') await showPdfPages();
      else if (kind === 'sheet') await showSheet();
      else if (kind === 'image') showImage();
      else if (kind === 'archive') await showArchive();
      else fail('This file type cannot be displayed.');
    } catch (e) {
      console.error(e);
      if (!dead) fail(e?.message || 'This file could not be opened.');
    }
  }

  return () => {
    dead = true;
    stopSpeech();
    pdf.teardownPages?.();
    pdf.doc?.destroy();
    document.removeEventListener('keydown', onKey);
    for (const fn of cleanups) fn();
  };
}
