// 128x64 OLED screens, drawn from a simulator snapshot exactly as firmware 1.0.13
// Ui::draw* does (src/main.cpp). Font = Adafruit GFX classic 5x7, "°" = the
// firmware's custom degree glyph.
import { C } from './sim.js';

const FONT = [0x00,0x00,0x00,0x00,0x00,0x3E,0x5B,0x4F,0x5B,0x3E,0x3E,0x6B,0x4F,0x6B,0x3E,0x1C,0x3E,0x7C,0x3E,0x1C,0x18,0x3C,0x7E,0x3C,0x18,0x1C,0x57,0x7D,0x57,0x1C,0x1C,0x5E,0x7F,0x5E,0x1C,0x00,0x18,0x3C,0x18,0x00,0xFF,0xE7,0xC3,0xE7,0xFF,0x00,0x18,0x24,0x18,0x00,0xFF,0xE7,0xDB,0xE7,0xFF,0x30,0x48,0x3A,0x06,0x0E,0x26,0x29,0x79,0x29,0x26,0x40,0x7F,0x05,0x05,0x07,0x40,0x7F,0x05,0x25,0x3F,0x5A,0x3C,0xE7,0x3C,0x5A,0x7F,0x3E,0x1C,0x1C,0x08,0x08,0x1C,0x1C,0x3E,0x7F,0x14,0x22,0x7F,0x22,0x14,0x5F,0x5F,0x00,0x5F,0x5F,0x06,0x09,0x7F,0x01,0x7F,0x00,0x66,0x89,0x95,0x6A,0x60,0x60,0x60,0x60,0x60,0x94,0xA2,0xFF,0xA2,0x94,0x08,0x04,0x7E,0x04,0x08,0x10,0x20,0x7E,0x20,0x10,0x08,0x08,0x2A,0x1C,0x08,0x08,0x1C,0x2A,0x08,0x08,0x1E,0x10,0x10,0x10,0x10,0x0C,0x1E,0x0C,0x1E,0x0C,0x30,0x38,0x3E,0x38,0x30,0x06,0x0E,0x3E,0x0E,0x06,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x5F,0x00,0x00,0x00,0x07,0x00,0x07,0x00,0x14,0x7F,0x14,0x7F,0x14,0x24,0x2A,0x7F,0x2A,0x12,0x23,0x13,0x08,0x64,0x62,0x36,0x49,0x56,0x20,0x50,0x00,0x08,0x07,0x03,0x00,0x00,0x1C,0x22,0x41,0x00,0x00,0x41,0x22,0x1C,0x00,0x2A,0x1C,0x7F,0x1C,0x2A,0x08,0x08,0x3E,0x08,0x08,0x00,0x80,0x70,0x30,0x00,0x08,0x08,0x08,0x08,0x08,0x00,0x00,0x60,0x60,0x00,0x20,0x10,0x08,0x04,0x02,0x3E,0x51,0x49,0x45,0x3E,0x00,0x42,0x7F,0x40,0x00,0x72,0x49,0x49,0x49,0x46,0x21,0x41,0x49,0x4D,0x33,0x18,0x14,0x12,0x7F,0x10,0x27,0x45,0x45,0x45,0x39,0x3C,0x4A,0x49,0x49,0x31,0x41,0x21,0x11,0x09,0x07,0x36,0x49,0x49,0x49,0x36,0x46,0x49,0x49,0x29,0x1E,0x00,0x00,0x14,0x00,0x00,0x00,0x40,0x34,0x00,0x00,0x00,0x08,0x14,0x22,0x41,0x14,0x14,0x14,0x14,0x14,0x00,0x41,0x22,0x14,0x08,0x02,0x01,0x59,0x09,0x06,0x3E,0x41,0x5D,0x59,0x4E,0x7C,0x12,0x11,0x12,0x7C,0x7F,0x49,0x49,0x49,0x36,0x3E,0x41,0x41,0x41,0x22,0x7F,0x41,0x41,0x41,0x3E,0x7F,0x49,0x49,0x49,0x41,0x7F,0x09,0x09,0x09,0x01,0x3E,0x41,0x41,0x51,0x73,0x7F,0x08,0x08,0x08,0x7F,0x00,0x41,0x7F,0x41,0x00,0x20,0x40,0x41,0x3F,0x01,0x7F,0x08,0x14,0x22,0x41,0x7F,0x40,0x40,0x40,0x40,0x7F,0x02,0x1C,0x02,0x7F,0x7F,0x04,0x08,0x10,0x7F,0x3E,0x41,0x41,0x41,0x3E,0x7F,0x09,0x09,0x09,0x06,0x3E,0x41,0x51,0x21,0x5E,0x7F,0x09,0x19,0x29,0x46,0x26,0x49,0x49,0x49,0x32,0x03,0x01,0x7F,0x01,0x03,0x3F,0x40,0x40,0x40,0x3F,0x1F,0x20,0x40,0x20,0x1F,0x3F,0x40,0x38,0x40,0x3F,0x63,0x14,0x08,0x14,0x63,0x03,0x04,0x78,0x04,0x03,0x61,0x59,0x49,0x4D,0x43,0x00,0x7F,0x41,0x41,0x41,0x02,0x04,0x08,0x10,0x20,0x00,0x41,0x41,0x41,0x7F,0x04,0x02,0x01,0x02,0x04,0x40,0x40,0x40,0x40,0x40,0x00,0x03,0x07,0x08,0x00,0x20,0x54,0x54,0x78,0x40,0x7F,0x28,0x44,0x44,0x38,0x38,0x44,0x44,0x44,0x28,0x38,0x44,0x44,0x28,0x7F,0x38,0x54,0x54,0x54,0x18,0x00,0x08,0x7E,0x09,0x02,0x18,0xA4,0xA4,0x9C,0x78,0x7F,0x08,0x04,0x04,0x78,0x00,0x44,0x7D,0x40,0x00,0x20,0x40,0x40,0x3D,0x00,0x7F,0x10,0x28,0x44,0x00,0x00,0x41,0x7F,0x40,0x00,0x7C,0x04,0x78,0x04,0x78,0x7C,0x08,0x04,0x04,0x78,0x38,0x44,0x44,0x44,0x38,0xFC,0x18,0x24,0x24,0x18,0x18,0x24,0x24,0x18,0xFC,0x7C,0x08,0x04,0x04,0x08,0x48,0x54,0x54,0x54,0x24,0x04,0x04,0x3F,0x44,0x24,0x3C,0x40,0x40,0x20,0x7C,0x1C,0x20,0x40,0x20,0x1C,0x3C,0x40,0x30,0x40,0x3C,0x44,0x28,0x10,0x28,0x44,0x4C,0x90,0x90,0x90,0x7C,0x44,0x64,0x54,0x4C,0x44,0x00,0x08,0x36,0x41,0x00,0x00,0x00,0x77,0x00,0x00,0x00,0x41,0x36,0x08,0x00,0x02,0x01,0x02,0x04,0x02];
const W = 128, H = 64;

class G {
  constructor() { this.b = new Uint8Array(W * H); this.log = []; }
  px(x, y, c = 1) { if (x >= 0 && y >= 0 && x < W && y < H) this.b[y * W + x] = c; }
  fill(x, y, w, h, c = 1) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c); }
  hline(x, y, w, c = 1) { this.fill(x, y, w, 1, c); }
  vline(x, y, h, c = 1) { this.fill(x, y, 1, h, c); }
  rrect(x, y, w, h, c = 1) { this.hline(x + 1, y, w - 2, c); this.hline(x + 1, y + h - 1, w - 2, c); this.vline(x, y + 1, h - 2, c); this.vline(x + w - 1, y + 1, h - 2, c); }
  rfill(x, y, w, h, c = 1) { this.fill(x + 1, y, w - 2, h, c); this.vline(x, y + 1, h - 2, c); this.vline(x + w - 1, y + 1, h - 2, c); }
  char(x, y, code, s, c) { for (let i = 0; i < 5; i++) { let line = FONT[code * 5 + i] ?? 0; for (let j = 0; j < 8; j++, line >>= 1) if (line & 1) this.fill(x + i * s, y + j * s, s, s, c); } }
  deg(x, y, s, c) { for (const [i, j] of [[1, 0], [0, 1], [2, 1], [1, 2]]) this.fill(x + i * s, y + j * s, s, s, c); }
  text(x, y, str, s = 1, c = 1) {
    this.log.push(str);
    for (const ch of str) { if (ch === '°') { this.deg(x, y, s, c); x += 4 * s; continue; } this.char(x, y, ch.charCodeAt(0), s, c); x += 6 * s; }
    return x;
  }
  tw(str, s = 1) { let w = 0; for (const ch of str) w += (ch === '°' ? 4 : 6) * s; return w - s; }
  bmp(x, y, rows, c = 1, s = 1) { rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === '#') this.fill(x + i * s, y + j * s, s, s, c); }); }
}

const FLAME = [[
  '....#.....', '...##.....', '...###....', '..####.#..', '..######..', '.########.',
  '.###..###.', '###....###', '##......##', '##..##..##', '.##.##.##.', '..######..',
], [
  '.....#....', '....##....', '...####...', '.#.#####..', '..######..', '.########.',
  '.###..###.', '###....###', '##......##', '##.##...##', '.##.##.##.', '..######..',
]];
const CHECK = ['..........##', '.........###', '........###.', '.......###..', '......###...', '##...###....', '###.###.....', '.#####......', '..###.......'];
const WARN = ['......#......', '.....###.....', '.....#.#.....', '....##.##....', '....#.#.#....', '...##.#.##...', '...#..#..#...', '..##..#..##..', '..#.......#..', '.##...#...##.', '.#.........#.', '#############'];
const DROP = ['..#..', '..#..', '.###.', '#####', '#####', '#####', '.###.'];

const thermoLevel = t => Math.min(1, Math.max(0, (t - 25) / (C.SAFETY_MAX_C - 25)));
const mmss = ms => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const rightText = (g, y, s, sz = 1, c = 1) => g.text(W - g.tw(s, sz), y, s, sz, c);
const centerText = (g, y, s, c = 1) => g.text(Math.round((W - g.tw(s)) / 2), y, s, 1, c);
const chip = (g, label) => { const w = g.tw(label) + 6; g.rfill(W - w, 0, w, 9); g.text(W - w + 3, 1, label, 1, 0); };
function titleBar(g, label, filled = true) {
  if (filled) { g.rfill(0, 0, W, 10); centerText(g, 1, label, 0); } else { g.rrect(0, 0, W, 10); centerText(g, 1, label); }
}
function hourglass(g, x, y, k, c = 1) {
  g.hline(x, y, 9, c); g.hline(x, y + 11, 9, c);
  for (let j = 1; j <= 4; j++) { g.px(x + j, y + j, c); g.px(x + 8 - j, y + j, c); }
  g.px(x + 4, y + 5, c); g.px(x + 4, y + 6, c);
  for (let j = 1; j <= 4; j++) { g.px(x + 4 - j, y + 6 + j, c); g.px(x + 4 + j, y + 6 + j, c); }
  const top = 3 - k, bot = k;
  for (let j = 0; j < top; j++) g.hline(x + 2 + j, y + 2 + j + (3 - top), 5 - 2 * j > 0 ? 5 - 2 * j : 1, c);
  for (let j = 0; j < bot; j++) g.hline(x + 4 - j, y + 10 - j, 2 * (j + 1) - 1, c);
  if (k < 3) g.px(x + 4, y + 7 + (k % 2), c);
}
function thermo(g, x, y, lvl, c = 1) {
  const b = 1 - c;
  g.rrect(x + 1, y, 5, 10, c); g.fill(x, y + 9, 7, 4, c); g.px(x, y + 9, b); g.px(x + 6, y + 9, b); g.px(x, y + 12, b); g.px(x + 6, y + 12, b);
  const h = Math.round(lvl * 7); g.fill(x + 3, y + 9 - h, 1, h, c);
}
function chevrons(g, x, y, f) { for (let k = 0; k < 3; k++) { if ((f + k) % 3 === 0) continue; const yy = y + k * 5; for (let i = 0; i < 4; i++) { g.px(x + 3 - i, yy + i); g.px(x + 3 + i, yy + i); } } }
function steamBowl(g, x, y, f, s) {
  const cell = (i, j, w = 1, h = 1) => g.fill(x + i * s, y + j * s, w * s, h * s);
  cell(0, 9, 16, 1); cell(0, 9, 1, 3); cell(15, 9, 1, 3); cell(1, 12, 14, 1); cell(2, 13, 12, 1); cell(4, 14, 8, 1);
  for (let i = 2; i < 14; i += 2) cell(i, 11);
  for (let k = 0; k < 3; k++) for (let j = 0; j < 7; j++) if ((j + f + k) % 7 < 5) cell(3 + k * 5 + ((j + f) >> 1) % 2, 7 - j);
}
function cupOnPlate(g, x, y, s) {
  const cell = (i, j, w = 1, h = 1) => g.fill(x + i * s, y + j * s, w * s, h * s);
  cell(4, 2, 12, 1); cell(6, 8, 8, 1);
  for (let j = 0; j < 6; j++) { cell(4 + (j >> 1), 3 + j); cell(15 - (j >> 1), 3 + j); }
  cell(0, 9, 20, 3);
}
function dropIntoCup(g, x, y, f) {
  cupOnPlate(g, x, y + 16, 1);
  if (f % 6 < 5) g.bmp(x + 8, y + (f % 6) * 3, DROP);
  g.fill(x + 7, y + 22, 6, 1);
}
function noDrop(g, x, y, c) {
  g.bmp(x + 3, y, DROP, c);
  const b = 1 - c;
  for (let i = 0; i < 11; i++) { g.px(x + i, y + 9 - i, b); g.px(x + 1 + i, y + 9 - i, c); }
}
function fingerprint(g, x, y) {
  for (let j = 0; j < 30; j++) for (let i = 0; i < 26; i++) {
    const ex = (i - 12.5) / 13, ey = (j - 15) / 15;
    if (ex * ex + ey * ey > 1) continue;
    const dx = (i - 12.5) / 0.78, dy = j - 11, d = dy < 0 ? Math.hypot(dx, dy) : Math.abs(dx) + dy * 0.18;
    const ring = Math.floor(d / 2);
    if ((ring & 1) && Math.sin(i * 0.9 + j * 0.55 + ring) < 0.78) g.px(x + i, y + j);
  }
}

// ---- screens (Ui::draw*) ----
function splash(g, s) {
  fingerprint(g, 4, 6); g.text(40, 4, 'CFC', 3); g.text(40, 30, 'cyanoacrylate'); g.text(40, 40, 'fuming chamber');
  g.rrect(0, 54, W, 10); const w = Math.trunc((W - 4) * Math.min(1, s.bootProgress)); if (w > 0) g.fill(2, 56, w, 6);
}
function setup(g, s, f) {
  const hot = s.tempValid && s.tempC >= C.HOT_WARN_C;
  if (s.saved) { g.rfill(0, 0, g.tw('SAVED') + 6, 9); g.text(3, 1, 'SAVED', 1, 0); }
  else if (hot) { if (f % 2 === 0) { g.rfill(0, 0, g.tw('HOT!') + 6, 9); g.text(3, 1, 'HOT!', 1, 0); } }
  else g.text(0, 1, 'SETUP');
  thermo(g, 82, 0, thermoLevel(s.tempC));
  rightText(g, 1, s.tempValid ? `${s.tempC.toFixed(1)}°C` : '--.-°C');
  g.hline(0, 13, W);
  for (let i = 0; i < 2; i++) {
    const x0 = i * 65, cx = x0 + 31, sel = (s.field === 'Target' ? 0 : 1) === i, col = sel ? 0 : 1;
    if (sel) g.rfill(x0, 15, 63, 38); else g.rrect(x0, 15, 63, 38);
    let buf, unit;
    if (i === 0) { thermo(g, cx - 3, 17, thermoLevel(s.targetC), col); buf = String(Math.trunc(s.targetC)); unit = '°C'; }
    else { hourglass(g, cx - 4, 17, sel ? Math.floor(f / 2) % 4 : 0, col); buf = String(s.durationMin); unit = 'min'; }
    const w = g.tw(buf, 2) + 2 + g.tw(unit);
    const x = g.text(cx - Math.trunc(w / 2), 34, buf, 2, col);
    g.text(x, 41, unit, 1, col);
  }
  if (hot && Math.floor(f / 4) % 2 === 0) { g.rfill(0, 55, W, 9); centerText(g, 56, `PLATE HOT ${Math.trunc(s.tempC)}°C`, 0); }
  else g.text(0, 56, 'SEL:save hold:start');
}
function stepWater(g, f) {
  titleBar(g, 'STEP 1 OF 4'); steamBowl(g, 2, 13, f, 2);
  g.text(42, 16, 'Put a bowl of'); g.text(42, 26, 'hot water in'); g.text(42, 36, 'the chamber');
  g.hline(0, 52, W); centerText(g, 56, 'any key: next');
}
function stepCup(g, f) {
  titleBar(g, 'STEP 2 OF 4'); cupOnPlate(g, 1, 14, 2);
  g.text(46, 13, 'Put empty cup'); g.text(46, 22, 'on heating'); g.text(46, 31, 'plate.');
  if (f % 4 !== 3) { g.rfill(0, 40, W, 10); centerText(g, 41, 'NO CYANOACRYLATE YET', 0); }
  g.hline(0, 52, W); centerText(g, 56, 'any key: start heat');
}
function ready(g, s, f) {
  titleBar(g, `STEP 4  ${Math.trunc(s.targetC)}°C READY`, f % 2 === 0);
  dropIntoCup(g, 4, 13, f);
  g.text(34, 14, 'Add the'); g.text(34, 23, 'cyanoacrylate'); g.text(34, 32, 'to cup, then'); g.text(34, 41, 'close chamber');
  g.hline(0, 52, W); centerText(g, 56, 'any key: start');
}
function heating(g, s, f) {
  const pre = s.state === 'Preheat';
  thermo(g, 0, 1, pre ? (f % 8) / 8 * 0.6 + 0.3 : thermoLevel(s.tempC));
  let x = g.text(10, 0, s.tempC.toFixed(1), 2); x = g.text(x + 1, 0, '°'); g.text(x, 0, 'C');
  thermo(g, 11, 16, thermoLevel(s.targetC)); g.text(22, 19, `set ${Math.trunc(s.targetC)}°C`);
  chip(g, pre ? 'HEAT' : 'RUN');
  if (s.heaterCmd) g.bmp(116, 13, FLAME[f % 2]); else g.bmp(116, 13, FLAME[f % 2].map(r => r.replace(/#(.)/g, '#.')));
  if (pre && Math.floor(f / 6) % 2 === 1) {
    g.rfill(0, 30, W, 16); noDrop(g, 3, 33, 0); g.text(18, 31, "DON'T ADD", 1, 0); g.text(18, 38, 'CYANOACRYLATE YET', 1, 0);
  } else if (pre) { chevrons(g, 0, 31, f); x = g.text(12, 31, mmss(s.preheatElapsedMs), 2); g.text(x + 3, 39, 'warm'); }
  else { hourglass(g, 0, 32, Math.floor(f / 2) % 4); x = g.text(12, 31, mmss(s.remainingMs), 2); g.text(x + 3, 39, 'left'); }
  g.rrect(0, 54, 98, 10); const w = Math.trunc(94 * s.progressPct / 100); if (w > 0) g.fill(2, 56, w, 6);
  rightText(g, 55, `${s.progressPct}%`);
}
function done(g, s, f) {
  g.bmp(4, 14, CHECK, 1, 3); g.text(48, 8, 'DONE', 2);
  if (s.tempValid && s.tempC >= C.HOT_WARN_C && f % 4 !== 3) { g.text(44, 28, 'PLATE HOT!'); g.text(44, 38, `${Math.trunc(s.tempC)}°C no touch`); }
  else { g.text(48, 28, 'heater off'); g.text(48, 38, `${s.durationMin} min cycle`); }
  const sx = f % 2 ? 42 : 2, sy = f % 2 ? 10 : 44;
  g.px(sx, sy); g.px(sx - 1, sy + 1); g.px(sx + 1, sy + 1); g.px(sx, sy + 2);
  g.hline(0, 52, W); centerText(g, 56, 'press any key');
}
function fault(g, s, f) {
  if (f % 4 !== 3) g.bmp(2, 8, WARN, 1, 3);
  g.text(46, 6, 'FAULT', 2); g.text(46, 26, s.fault); g.text(46, 36, 'heater off');
  g.rfill(0, 54, W, 10); centerText(g, 55, 'SEL: clear', 0);
}
function trip(g, s, f) {
  thermo(g, 6, 8, 1);
  if (f % 2 === 0) { for (let i = 0; i < 4; i++) { g.px(21 - i, 12 + i); g.px(21 + i, 12 + i); } g.vline(21, 12, 9); }
  let x = g.text(34, 4, s.tempC.toFixed(1), 2); x = g.text(x + 1, 4, '°'); g.text(x, 4, 'C');
  g.text(34, 24, `OVERTEMP > ${C.SAFETY_MAX_C}°C`); g.text(34, 34, 'heater off');
  g.rfill(0, 54, W, 10); centerText(g, 55, `cool <${C.SAFETY_REARM_C}°C, SEL`, 0);
}

function render(snap, frame) {
  const g = new G();
  if (!snap.on) return g;
  if (snap.booting) { splash(g, snap); return g; }
  switch (snap.state) {
    case 'Idle': setup(g, snap, frame); break;
    case 'StepWater': stepWater(g, frame); break;
    case 'StepCup': stepCup(g, frame); break;
    case 'Ready': ready(g, snap, frame); break;
    case 'Preheat': case 'Running': heating(g, snap, frame); break;
    case 'Complete': done(g, snap, frame); break;
    case 'Fault': fault(g, snap, frame); break;
    case 'SafetyTrip': trip(g, snap, frame); break;
  }
  return g;
}

// frame: animation frame, 4 per second (firmware: millis() / 250).
export const oledBuffer = (snap, frame) => render(snap, frame).b;
export const oledText = (snap, frame) => render(snap, frame).log;

// Paints the screen into a canvas (any size, 2:1), pixels as small squares.
export function drawOled(ctx, snap, frame) {
  const { width: cw, height: ch } = ctx.canvas, s = cw / W, b = oledBuffer(snap, frame);
  ctx.fillStyle = '#05080c'; ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = '#eef6ff';
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (b[y * W + x]) ctx.fillRect(x * s, y * s, s * 0.86, s * 0.86);
}
