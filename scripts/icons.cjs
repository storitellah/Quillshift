// Rasterises icons/icon.svg into the PNG sizes iOS and Android expect: `npm run icons`.
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, '../icons');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const shot = async (svgFile, size, out, square) => {
    let svg = fs.readFileSync(path.join(dir, svgFile), 'utf8');
    if (square) svg = svg.replace('rx="112"', 'rx="0"'); // iOS applies its own corner mask
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: path.join(dir, out), omitBackground: true });
  };
  await shot('icon.svg', 192, 'icon-192.png');
  await shot('icon.svg', 512, 'icon-512.png');
  await shot('icon-maskable.svg', 192, 'maskable-192.png');
  await shot('icon-maskable.svg', 512, 'maskable-512.png');
  await shot('icon.svg', 180, 'apple-touch-icon.png', true);
  await shot('icon.svg', 32, 'favicon-32.png');
  await browser.close();
})();
