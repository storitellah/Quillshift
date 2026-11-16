// Tiny UI toolkit: icons, toasts, bottom sheets, saving and sharing.

import { esc } from './util.js';
import { FORMATS } from './formats.js';

export const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export function tile(format) {
  const f = FORMATS[format];
  return `<div class="tile tone-${f?.tone || 'slate'}" aria-hidden="true">${esc(f?.label || '?')}</div>`;
}

export function toast(message, { action, onAction, ms = 3800 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  const close = () => el.remove();
  el.querySelector('button')?.addEventListener('click', () => { close(); onAction?.(); });
  document.getElementById('toasts').append(el);
  if (ms) setTimeout(close, ms);
  return close;
}

let closeCurrent = null;

/** A modal bottom sheet. `body` is trusted HTML built by the app (escape user text first). */
export function openSheet({ title, body, onMount }) {
  closeCurrent?.();
  const host = document.getElementById('overlay');
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="iconbtn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-body">${body}</div></div>`;
  const previous = document.activeElement;
  const close = () => {
    if (!scrim.isConnected) return;
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    if (closeCurrent === close) closeCurrent = null;
    previous?.focus?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  scrim.addEventListener('click', (e) => { if (e.target === scrim || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  host.append(scrim);
  closeCurrent = close;
  onMount?.(scrim.querySelector('.sheet-body'), close);
  scrim.querySelector('[data-close]').focus();
  return close;
}

export function confirmSheet({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const close = openSheet({
      title,
      body: `<p class="muted">${esc(message)}</p><div style="display:flex;gap:10px"><button class="btn btn-quiet btn-block" data-no>Cancel</button><button class="btn ${danger ? 'btn-ink' : 'btn-primary'} btn-block" data-yes>${esc(confirm)}</button></div>`,
      onMount(el) {
        el.querySelector('[data-yes]').onclick = () => { answered = true; resolve(true); close(); };
        el.querySelector('[data-no]').onclick = () => close();
      },
    });
    const watch = new MutationObserver(() => { if (!document.querySelector('.scrim')) { watch.disconnect(); if (!answered) resolve(false); } });
    watch.observe(document.getElementById('overlay'), { childList: true });
  });
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const asFile = (blob, name) => new File([blob], name, { type: blob.type || 'application/octet-stream' });

export function canShare(blob, name) {
  try { return !!navigator.canShare?.({ files: [asFile(blob, name)] }); } catch { return false; }
}

/** The system share sheet — on a phone this is how a file reaches Files, Mail or another app. */
export async function shareBlob(blob, name) {
  try {
    await navigator.share({ files: [asFile(blob, name)], title: name });
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') saveBlob(blob, name);
    return false;
  }
}

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
