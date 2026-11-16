// Quillshift service worker.
//   shell    the app itself — precached, versioned, replaced atomically on update
//   engines  conversion libraries — cached the first time each one is used
//   inbox    files shared to the installed app from another app's share sheet

importScripts('precache-manifest.js');

const { version, files } = self.__QUILLSHIFT;
const SHELL = `quillshift-shell-${version}`;
const ENGINES = 'quillshift-engines-v1';
const INBOX = 'quillshift-inbox';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(files.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('quillshift-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const inbox = await caches.open(INBOX);
    let i = 0;
    for (const file of form.getAll('files')) {
      if (!(file instanceof File) || !file.size) continue;
      await inbox.put(`inbox/${Date.now()}-${i++}`, new Response(file, {
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'shared-file') },
      }));
    }
  } catch (e) { /* fall through to the app, which will simply have nothing new */ }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

async function engine(request) {
  const cache = await caches.open(ENGINES);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function shell(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  if (hit) return hit;
  try {
    return await fetch(request);
  } catch (e) {
    if (request.mode === 'navigate') return (await cache.match('./')) || (await cache.match('index.html')) || Response.error();
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) return event.respondWith(receiveShare(request));
  if (request.method !== 'GET') return;
  event.respondWith(url.pathname.includes('/vendor/') ? engine(request) : shell(request));
});
