// Exposes the conversion pipeline to the Playwright-driven test runner.
import { convert, combine } from '../js/convert/index.js';
import { detectFormat } from '../js/core/formats.js';
import { bytesToBase64 } from '../js/core/util.js';

const files = new Map();

async function get(key) {
  if (!files.has(key)) {
    const res = await fetch(`fixtures/${key}`);
    if (!res.ok) throw new Error(`Missing fixture ${key}`);
    const blob = await res.blob();
    // Detect from a nameless, typeless copy too, to exercise content sniffing.
    files.set(key, { name: key, blob, format: await detectFormat(new File([blob], key)) });
  }
  return files.get(key);
}

window.qs = {
  async convert(key, target, opts = {}) {
    const out = await convert(await get(key), target, opts);
    const outKey = `${key}→${target}`;
    files.set(outKey, out);
    return { key: outKey, name: out.name, format: out.format, size: out.blob.size, note: out.note };
  },
  async combine(keys, opts = {}) {
    const out = await combine(await Promise.all(keys.map(get)), opts);
    const outKey = `combined:${keys.join('+')}`;
    files.set(outKey, out);
    return { key: outKey, name: out.name, format: out.format, size: out.blob.size, note: out.note };
  },
  async sniff(key) {
    const f = await get(key);
    return detectFormat(new File([f.blob], 'unnamed'));
  },
  async text(key) { return (await get(key)).blob.text(); },
  async b64(key) { return bytesToBase64(new Uint8Array(await (await get(key)).blob.arrayBuffer())); },
};
window.qsReady = true;
