// Copies the browser builds of third-party engines from node_modules into /vendor.
// Run with `npm run vendor` after upgrading a dependency. The output is committed
// so the app can be deployed as plain static files with no build step.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => join(root, 'node_modules', p);
const out = (p) => join(root, 'vendor', p);

const files = [
  ['fflate/esm/browser.js', 'fflate.mjs'],
  ['mammoth/mammoth.browser.min.js', 'mammoth.browser.min.js'],
  ['pdfjs-dist/legacy/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs'],
  ['pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
  ['pdfjs-dist/cmaps', 'pdfjs/cmaps'],
  ['pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
  ['pdfmake/build/pdfmake.min.js', 'pdfmake.min.js'],
  ['pdfmake/build/vfs_fonts.js', 'vfs_fonts.js'],
  ['html-to-pdfmake/browser.js', 'html-to-pdfmake.js'],
  ['pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.min.js'],
  ['html2canvas/dist/html2canvas.min.js', 'html2canvas.min.js'],
  ['marked/lib/marked.esm.js', 'marked.esm.js'],
  ['turndown/lib/turndown.browser.umd.js', 'turndown.js'],
  ['turndown-plugin-gfm/dist/turndown-plugin-gfm.js', 'turndown-plugin-gfm.js'],
  ['dompurify/dist/purify.min.js', 'purify.min.js'],
];

rmSync(out(''), { recursive: true, force: true });
mkdirSync(out('pdfjs'), { recursive: true });
for (const [from, to] of files) cpSync(nm(from), out(to), { recursive: true });

// Strip sourceMappingURL comments so the browser does not request missing .map files.
for (const [, to] of files) {
  if (!/\.(m?js)$/.test(to)) continue;
  const p = out(to);
  const src = readFileSync(p, 'utf8');
  const cleaned = src.replace(/\n?\/\/# sourceMappingURL=.*$/gm, '');
  if (cleaned !== src) writeFileSync(p, cleaned);
}

// Metrics for the PDF base font Courier, so code blocks can be monospaced without
// shipping another font file. pdfmake reads these from its virtual file system.
const afm = {};
for (const name of ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']) {
  afm[`data/${name}.afm`] = readFileSync(nm(`@foliojs-fork/pdfkit/js/data/${name}.afm`), 'utf8');
}
writeFileSync(out('vfs_mono.js'), `window.quillshiftMonoMetrics = ${JSON.stringify(afm)};\n`);

const pkgs = ['fflate', 'mammoth', 'pdfjs-dist', 'pdfmake', 'html-to-pdfmake', 'pdf-lib', 'html2canvas', 'marked', 'turndown', 'turndown-plugin-gfm', 'dompurify'];
const rows = pkgs.map((p) => {
  const j = JSON.parse(readFileSync(nm(`${p}/package.json`), 'utf8'));
  const lic = typeof j.license === 'string' ? j.license : (j.license?.type ?? 'see package');
  return `| ${j.name} | ${j.version} | ${lic} |`;
});
writeFileSync(out('THIRD-PARTY.md'), `# Third-party engines\n\nThese files are unmodified browser builds copied from npm by \`scripts/vendor.mjs\`.\nEach is distributed under its own licence.\n\n| Package | Version | Licence |\n| --- | --- | --- |\n${rows.join('\n')}\n`);
console.log('vendored', files.length, 'entries');
