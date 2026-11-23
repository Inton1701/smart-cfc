// Builds a standalone copy of the 3D model page: three.js and the local modules
// (sim.js, oled.js, play.js) are embedded, so the file opens without internet.
// Usage: node model/make-offline.cjs <page.html> <three-r160-dir> <out.html>
const fs = require('fs'), path = require('path');
const [src, lib, out] = process.argv.slice(2);
const b64 = file => 'data:text/javascript;base64,' + fs.readFileSync(file).toString('base64');
// Local modules import each other as './x.js'; a data: URL has no base to resolve
// that against, so rewrite to the bare importmap name 'x'.
const b64Local = file => 'data:text/javascript;base64,' + Buffer.from(
  fs.readFileSync(file, 'utf8').replace(/from '\.\/(\w+)\.js'/g, "from '$1'")).toString('base64');

let html = fs.readFileSync(src, 'utf8');
const re = /<script type="importmap">([\s\S]*?)<\/script>/;
const m = html.match(re);
if (!m) throw new Error('importmap not found');
const local = Object.entries(JSON.parse(m[1]).imports).filter(([, url]) => url.startsWith('./'));
const map = { imports: {
  'three': b64(path.join(lib, 'three.module.js')),
  'three/addons/controls/OrbitControls.js': b64(path.join(lib, 'OrbitControls.js')),
  'three/addons/geometries/RoundedBoxGeometry.js': b64(path.join(lib, 'RoundedBoxGeometry.js')),
  ...Object.fromEntries(local.map(([name, url]) => [name, b64Local(path.join(path.dirname(src), url))])),
} };
html = html.replace(re, () => `<script type="importmap">${JSON.stringify(map)}</script>`);
fs.writeFileSync(out, html);
console.log('wrote', out, (html.length / 1e6).toFixed(2), 'MB, local modules:', local.map(([n]) => n).join(', '));
