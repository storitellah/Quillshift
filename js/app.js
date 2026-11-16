// Application shell: routing, theme, install prompt, service worker, incoming files.

import { settings, library } from './core/store.js';
import { toast, isStandalone, isIOS } from './core/ui.js';
import { applyTheme, showInstallHelp } from './core/shell.js';
import { session, promptInstall, onInstallChange } from './core/session.js';
import * as convertView from './views/convert.js';

const view = document.getElementById('view');
const VIEWS = {
  '': () => convertView,
  library: () => import('./views/library.js'),
  settings: () => import('./views/settings.js'),
  read: () => import('./views/reader.js'),
};
let unmount = null;
let ticket = 0;

async function route() {
  const [name = '', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const key = VIEWS[name] ? name : '';
  const mine = ++ticket;
  session.routes = (session.routes || 0) + 1;
  try { unmount?.(); } catch (e) { console.error(e); }
  unmount = null;
  document.getElementById('overlay').replaceChildren();
  document.body.classList.toggle('reading', key === 'read');
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === (key || 'convert')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  let mod;
  try { mod = await VIEWS[key](); } catch {
    view.innerHTML = '<div class="empty"><h2>This screen is not available offline yet</h2><p>Connect to the internet once and it will be saved for next time.</p></div>';
    return;
  }
  if (mine !== ticket) return;
  view.replaceChildren();
  window.scrollTo(0, 0);
  const off = await mod.mount(view, decodeURIComponent(rest.join('/')));
  if (mine !== ticket) off?.(); else unmount = off;
}

function wireInstall() {
  const btn = document.getElementById('install-btn');
  const refresh = () => { btn.hidden = isStandalone() || !(session.installPrompt || isIOS()); };
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    session.installPrompt = e;
    for (const fn of session.installListeners) fn();
  });
  window.addEventListener('appinstalled', () => {
    session.installPrompt = null;
    for (const fn of session.installListeners) fn();
    toast('Quillshift is installed.');
  });
  onInstallChange(refresh);
  btn.addEventListener('click', async () => { if (session.installPrompt) await promptInstall(); else showInstallHelp(); });
  refresh();
}

/* ---------- service worker ---------- */

async function wireServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https:|^http:\/\/(localhost|127\.)/.test(location.href)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    const offer = (worker) => {
      toast('A new version of Quillshift is ready.', { action: 'Update', ms: 0, onAction: () => worker.postMessage({ type: 'SKIP_WAITING' }) });
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    let reloading = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
  } catch (e) { console.warn('Service worker registration failed', e); }
}

/* ---------- files arriving from outside ---------- */

async function takeSharedFiles() {
  // Files shared to the installed app (Android share sheet) are parked in a cache by the service worker.
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname + '#/');
  try {
    const inbox = await caches.open('quillshift-inbox');
    const files = [];
    for (const req of await inbox.keys()) {
      const res = await inbox.match(req);
      const name = decodeURIComponent(res.headers.get('X-File-Name') || 'shared-file');
      files.push(new File([await res.blob()], name, { type: res.headers.get('Content-Type') || '' }));
      await inbox.delete(req);
    }
    if (files.length) await convertView.addFiles(files);
  } catch (e) { console.warn(e); }
}

function wireLaunchQueue() {
  // Desktop "Open with Quillshift" (File Handling API).
  window.launchQueue?.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    location.hash = '#/';
    await convertView.addFiles(files);
  });
}

/* ---------- boot ---------- */

applyTheme();
wireInstall();
wireLaunchQueue();
window.addEventListener('hashchange', route);
await takeSharedFiles();
await route();
wireServiceWorker();
library.prune(settings.get('retention')).catch(() => {});
