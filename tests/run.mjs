// End-to-end tests: `npm test`. Drives the real app in headless Chromium.
//   1. engine round-trips through tests/harness.html (under the production CSP)
//   2. the UI flow on a phone-sized screen
//   3. offline behaviour once the service worker has taken over
// Every request made during the run must stay on the local origin.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4311;
const ORIGIN = `http://localhost:${PORT}`;
const FX = join(root, 'tests/fixtures');

const results = [];
async function test(name, fn) {
  const t = Date.now();
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name} (${Date.now() - t} ms)`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
const has = (text, needle) => assert(text.includes(needle), `expected output to contain “${needle}”`);

const server = spawn(process.execPath, [join(root, 'scripts/serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch();
const offOrigin = [];
const problems = [];
const watch = (page) => {
  page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url()) && !r.url().startsWith(ORIGIN)) offOrigin.push(r.url()); });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED/.test(m.text())) problems.push(m.text()); });
};

try {
  /* ---------- 1. engines ---------- */
  console.log('\nConversion engines');
  const page = await browser.newPage();
  watch(page);
  await page.goto(`${ORIGIN}/tests/harness.html`);
  await page.waitForFunction('window.qsReady');
  const run = (key, target, opts = {}) => page.evaluate(([k, t, o]) => window.qs.convert(k, t, o), [key, target, opts]);
  const text = (key) => page.evaluate((k) => window.qs.text(k), key);
  const magic = async (key, n = 4) => Buffer.from(await page.evaluate((k) => window.qs.b64(k), key), 'base64').subarray(0, n);

  await test('DOCX → PDF keeps its text (read back through PDF → TXT)', async () => {
    const pdf = await run('report.docx', 'pdf');
    assert((await magic(pdf.key)).toString() === '%PDF', 'not a PDF');
    const txt = await text((await run(pdf.key, 'txt')).key);
    has(txt, 'Quarterly Field Report'); has(txt, 'Zoë Müller'); has(txt, '1. Audit the fleet');
  });
  await test('DOCX → DOCX writer produces a document Word importers can read', async () => {
    const docx = await run('report.docx', 'docx');
    assert((await magic(docx.key, 2)).toString() === 'PK', 'not a zip container');
    const txt = await text((await run(docx.key, 'txt')).key);
    has(txt, 'Highlights'); has(txt, 'North\t120,400'); has(txt, '• Opened two new depots');
  });
  await test('DOCX → EPUB → TXT round-trips chapters', async () => {
    const epub = await run('report.docx', 'epub');
    const txt = await text((await run(epub.key, 'txt')).key);
    has(txt, 'Quarterly Field Report'); has(txt, 'Renew supplier contracts');
  });
  await test('ODT import', async () => has(await text((await run('report.odt', 'txt')).key), 'Reduced delivery time'));
  await test('Markdown → HTML is a standalone page with a table', async () => {
    const html = await text((await run('notes.md', 'html')).key);
    has(html, '<h1>Trail Notes</h1>'); has(html, '<table>'); has(html, '<!doctype html>');
  });
  await test('HTML import strips scripts and styles', async () => {
    const html = await text((await run('report.html', 'html')).key);
    assert(!html.includes('alert(1)'), 'script content leaked into output');
    const md = await text((await run('report.html', 'md')).key);
    has(md, '# Quarterly Field Report'); has(md, '| Region | Revenue | Growth |');
  });
  await test('Markdown → PDF uses the text renderer; CJK falls back to snapshot', async () => {
    assert((await run('notes.md', 'pdf')).note === null, 'expected text mode');
    assert(/snapshot/i.test((await run('cjk.md', 'pdf')).note || ''), 'expected snapshot mode');
  });
  await test('XLSX → CSV preserves text, numbers and dates', async () => {
    const csv = await text((await run('people.xlsx', 'csv')).key);
    has(csv, 'name,age,city,joined,notes'); has(csv, 'Ada,36,London,1843-07-01,"First, programmer"');
  });
  await test('CSV → XLSX → JSON keeps types', async () => {
    const json = JSON.parse(await text((await run((await run('people.csv', 'xlsx')).key, 'json')).key));
    assert(json.length === 3 && json[0].age === 36 && json[1].city === 'New York', 'unexpected rows');
    assert(json[1].notes === 'Said "it\'s easier to ask forgiveness"', 'quoted cell was mangled');
  });
  await test('JSON → CSV and Markdown tables', async () => {
    has(await text((await run('data.json', 'csv')).key), 'id,item,price,tags,stock');
    has(await text((await run('people.csv', 'md')).key), '| Ada | 36 | London |');
  });
  await test('Images: PNG → JPG, JPG → PNG, PNG → PDF', async () => {
    assert((await magic((await run('photo.png', 'jpg')).key, 2)).equals(Buffer.from([0xff, 0xd8])), 'not a JPEG');
    assert((await magic((await run('photo.jpg', 'png')).key)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'not a PNG');
    assert((await magic((await run('photo.png', 'pdf')).key)).toString() === '%PDF', 'not a PDF');
  });
  await test('PDF → extract pages → page images (zipped)', async () => {
    const part = await run('report.pdf', 'pages', { pages: '2-3' });
    has(part.note, '2 pages');
    const zip = await run(part.key, 'jpg', { dpi: 96 });
    assert(zip.format === 'zip', 'expected a zip of page images'); has(zip.note, '2 page images');
  });
  await test('PDF → DOCX rebuilds headings and lists', async () => {
    const txt = await text((await run((await run('report.pdf', 'docx')).key, 'txt')).key);
    has(txt, 'Quarterly Field Report'); has(txt, '• Opened two new depots');
  });
  await test('Combine PDF + images + Markdown into one PDF', async () => {
    const out = await page.evaluate(() => window.qs.combine(['photo.png', 'report.pdf', 'notes.md', 'photo.jpg']));
    has(out.note, '4 files');
    has(await text((await run(out.key, 'txt')).key), 'Trail Notes');
  });
  await test('Formats are recognised from content alone', async () => {
    for (const [file, want] of [['report.docx', 'docx'], ['people.xlsx', 'xlsx'], ['report.pdf', 'pdf'], ['photo.png', 'png'], ['photo.jpg', 'jpg'], ['report.odt', 'odt'], ['report.html', 'html']]) {
      const got = await page.evaluate((k) => window.qs.sniff(k), file);
      assert(got === want, `${file} detected as ${got}`);
    }
  });
  await page.close();

  /* ---------- 2. interface ---------- */
  console.log('\nInterface (390 × 844)');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const app = await ctx.newPage();
  watch(app);
  await app.goto(`${ORIGIN}/`);
  await app.waitForSelector('.drop');

  await test('No horizontal overflow on a phone', async () => {
    await app.setInputFiles('[data-picker]', [join(FX, 'report.pdf'), join(FX, 'notes.md')]);
    await app.waitForSelector('.item');
    assert(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'page is wider than the screen');
  });
  await test('Convert, then find the result in the Library', async () => {
    await app.click('[data-item] [data-target="txt"]');
    await app.click('[data-act="convert"]');
    await app.waitForFunction(() => document.querySelectorAll('.result').length === 2, null, { timeout: 60000 });
    assert((await app.$$('.errorbox')).length === 0, 'a conversion failed');
    await app.goto(`${ORIGIN}/#/library`);
    await app.waitForSelector('.lib-item');
    assert((await app.$$('.lib-item')).length === 2, 'expected two library items');
  });
  await test('Reader opens a converted file and remembers text settings', async () => {
    await app.click('.lib-open >> text=notes.pdf');
    await app.waitForSelector('.pdfpage canvas', { timeout: 30000 });
    await app.click('[data-act="pdf-text"]');
    await app.waitForSelector('.prose h1');
    assert((await app.textContent('.prose h1')).includes('Trail Notes'), 'reflowed text is missing');
    await app.click('[data-act="type"]');
    await app.click('[data-v="sepia"]');
    await app.click('[data-step="size"][data-d="1"]');
    await app.click('[data-close]');
    await app.reload();
    await app.waitForSelector('.reader[data-theme="sepia"]');
    assert((await app.evaluate(() => getComputedStyle(document.querySelector('.reader')).getPropertyValue('--r-size'))).trim() === '19px', 'text size was not remembered');
  });
  await test('Settings render and report storage', async () => {
    await app.goto(`${ORIGIN}/#/settings`);
    await app.waitForSelector('.meter');
    has(await app.textContent('#view'), 'Your files never leave this device');
  });

  /* ---------- 3. offline ---------- */
  console.log('\nOffline');
  await test('App shell and used engines work with the network off', async () => {
    await app.goto(`${ORIGIN}/`);
    await app.evaluate(() => navigator.serviceWorker.ready);
    await app.reload();                       // now controlled by the service worker
    await app.waitForSelector('[data-picker]', { state: 'attached' });
    if (await app.$('[data-act="clear"]')) await app.click('[data-act="clear"]');
    await app.setInputFiles('[data-picker]', [join(FX, 'notes.md')]);
    await app.click('[data-target="docx"]');
    await app.click('[data-act="convert"]');   // warms the engine cache through the worker
    await app.waitForSelector('.result', { timeout: 30000 });
    await ctx.setOffline(true);
    await app.reload();
    await app.waitForSelector('.drop', { timeout: 15000 });
    await app.setInputFiles('[data-picker]', [join(FX, 'letter.txt')]);
    await app.click('[data-target="docx"]');
    await app.click('[data-act="convert"]');
    await app.waitForSelector('.result', { timeout: 30000 });
    await ctx.setOffline(false);
  });
  await ctx.close();

  await test('Nothing was requested from another origin', async () => assert(offOrigin.length === 0, `off-origin requests: ${offOrigin.slice(0, 3).join(', ')}`));
  await test('No uncaught errors or CSP violations', async () => assert(problems.length === 0, problems.slice(0, 3).join(' | ')));
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
