// Regenerates the README / store screenshots in docs/: `node scripts/screenshots.cjs`
// (start nothing first — the script runs its own server).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const FX = path.join(root, 'tests/fixtures');
const OUT = path.join(root, 'docs/screens');
const U = 'http://localhost:4312/';

(async () => {
  const srv = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs')], { env: { ...process.env, PORT: '4312' }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 700));
  const browser = await chromium.launch();
  const phone = async (scheme) => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: scheme });

  let ctx = await phone('light');
  let page = await ctx.newPage();
  await page.goto(U); await page.waitForSelector('.drop');
  await page.screenshot({ path: path.join(OUT, 'phone-home.png') });
  await page.setInputFiles('[data-picker]', [path.join(FX, 'report.docx'), path.join(FX, 'people.xlsx'), path.join(FX, 'photo.jpg')]);
  await page.waitForSelector('.item');
  await page.click('[data-act="convert"]');
  await page.waitForFunction(() => document.querySelectorAll('.result').length === 3, null, { timeout: 60000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, 'phone-convert.png') });
  await page.setInputFiles('[data-picker]', [path.join(FX, 'notes.md')]);
  await page.click('[data-item]:last-of-type [data-target="epub"]');
  await page.click('[data-act="convert"]');
  await page.waitForFunction(() => document.querySelectorAll('.result').length === 4, null, { timeout: 60000 });
  await page.goto(U + '#/library'); await page.waitForSelector('.lib-item');
  await page.screenshot({ path: path.join(OUT, 'phone-library.png') });
  await page.click('.lib-open >> text=notes.epub'); await page.waitForSelector('.prose'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'phone-reader.png') });
  await ctx.close();

  ctx = await phone('dark');
  page = await ctx.newPage();
  await page.goto(U); await page.waitForSelector('.drop');
  await page.setInputFiles('[data-picker]', [path.join(FX, 'report.docx')]);
  await page.click('[data-target="epub"]'); await page.click('[data-act="convert"]');
  await page.waitForSelector('.result', { timeout: 60000 });
  await page.click('[data-act="read"]'); await page.waitForSelector('.prose'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'phone-reader-dark.png') });
  await ctx.close();

  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page = await ctx.newPage();
  await page.goto(U); await page.waitForSelector('.drop');
  await page.setInputFiles('[data-picker]', [path.join(FX, 'report.docx'), path.join(FX, 'report.pdf')]);
  await page.waitForSelector('.item');
  await page.click('[data-act="convert"]');
  await page.waitForFunction(() => document.querySelectorAll('.result').length === 2, null, { timeout: 60000 });
  await page.screenshot({ path: path.join(OUT, 'desktop-convert.png') });
  await ctx.close();

  // Banner and social card, composed from the shots above.
  const b64 = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, f)).toString('base64');
  const logo = fs.readFileSync(path.join(root, 'icons/icon.svg'), 'utf8');
  const html = (w, h) => `<style>
    body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#f6f2ea;font-family:"Iowan Old Style",Charter,Palatino,Georgia,serif;color:#1c1b29;position:relative}
    .copy{position:absolute;left:${w * 0.06}px;top:${h * 0.1}px;width:${w * 0.43}px}
    .brand{display:flex;align-items:center;gap:18px;font-size:${h * 0.062}px;font-weight:600}
    .brand svg{width:${h * 0.1}px;height:${h * 0.1}px}
    h1{font-size:${h * 0.094}px;line-height:1.05;letter-spacing:-.02em;margin:${h * 0.055}px 0 ${h * 0.035}px;font-weight:600}
    h1 em{color:#b22f17}
    p{font:${h * 0.038}px/1.45 system-ui,sans-serif;color:#55536a;margin:0}
    .tags{display:flex;gap:10px;flex-wrap:wrap;margin-top:${h * 0.06}px;font:700 ${h * 0.024}px system-ui,sans-serif;letter-spacing:.06em}
    .tags b{padding:9px 16px;border-radius:99px;background:#1c1b29;color:#f6f2ea}
    .ph{position:absolute;width:${h * 0.42}px;border-radius:${h * 0.05}px;border:${h * 0.013}px solid #1c1b29;box-shadow:0 30px 60px rgba(28,27,41,.25);overflow:hidden;background:#000}
    .ph img{display:block;width:100%}
  </style><div class="copy"><div class="brand">${logo}Quillshift</div><h1>Any document, <em>reshaped</em> on your own device.</h1><p>Convert Word, PDF, e-books, spreadsheets and images — then read them. Offline. Private. Installable.</p><div class="tags"><b>PWA</b><b>NO UPLOADS</b><b>iOS · ANDROID · DESKTOP</b></div></div>
  <div class="ph" style="left:${w * 0.53}px;top:${h * 0.16}px;transform:rotate(-4deg)"><img src="${b64('phone-convert.png')}"></div>
  <div class="ph" style="left:${w * 0.73}px;top:${h * 0.08}px;transform:rotate(3deg)"><img src="${b64('phone-reader-dark.png')}"></div>`;
  for (const [name, w, h] of [['banner.png', 1600, 800], ['social.png', 1280, 640]]) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    await p.setContent(html(w, h)); await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(root, 'docs', name) });
    await p.close();
  }
  await browser.close(); srv.kill();
})();
