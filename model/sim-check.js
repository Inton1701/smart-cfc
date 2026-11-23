// Self-check for sim.js. Run: node model/sim-check.js  (exit 1 on any failure)
import assert from 'node:assert/strict';
import { C, createSim, createPanel, createBeeper, hints } from './sim.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- helpers ----
const MIN = 60000;
function run(sim, realMs, speed = 60) {          // advance in 250 ms real frames
  for (let t = 0; t < realMs; t += 250) sim.advance(250, speed);
}
function until(sim, cond, maxSimMs, speed = 60) {
  const frames = Math.ceil(maxSimMs / (250 * speed));
  for (let i = 0; i < frames; i++) { if (cond(sim.snap())) return true; sim.advance(250, speed); }
  return cond(sim.snap());
}
const tap = (sim, ev = 'selTap') => { sim.input({ [ev]: true, anyTap: ev !== 'selHold' }); sim.advance(250, 1); };
const hold = sim => { sim.input({ selHold: true }); sim.advance(250, 1); };
function booted() { const s = createSim(); s.power(true); run(s, 2500, 1); return s; }
function heating() { const s = booted(); hold(s); tap(s); tap(s); return s; }
function ready() { const s = heating(); assert.ok(until(s, x => x.state === 'Ready', 15 * MIN)); return s; }

// ---- controller ----
test('boots to setup with firmware defaults', () => {
  const s = createSim(); s.power(true);
  assert.equal(s.snap().booting, true);
  run(s, 2500, 1);
  const x = s.snap();
  assert.equal(x.booting, false); assert.equal(x.state, 'Idle');
  assert.equal(x.targetC, 130); assert.equal(x.durationMin, 20); assert.equal(x.field, 'Target');
});

test('full cycle', () => {
  const s = booted();
  hold(s); assert.equal(s.snap().state, 'StepWater');
  tap(s);  assert.equal(s.snap().state, 'StepCup');
  tap(s);  assert.equal(s.snap().state, 'Preheat');
  assert.ok(until(s, x => x.state === 'Ready', 15 * MIN), 'reaches Ready within 15 min');
  assert.ok(Math.abs(s.snap().tempC - 130) <= 2);
  tap(s);  assert.equal(s.snap().state, 'Running');
  assert.ok(until(s, x => x.state === 'Complete', 21 * MIN), 'completes after 20 min');
  assert.equal(s.snap().duty, 0);
  tap(s);  assert.equal(s.snap().state, 'Idle');
});

test('setup keys change the selected field within limits', () => {
  const s = booted();
  for (let i = 0; i < 60; i++) { s.input({ incStep: true }); s.advance(10, 1); }
  assert.equal(s.snap().targetC, 180);
  tap(s, 'nextTap'); assert.equal(s.snap().field, 'Duration');
  for (let i = 0; i < 30; i++) { s.input({ decStep: true }); s.advance(10, 1); }
  assert.equal(s.snap().durationMin, 1);
  tap(s, 'prevTap'); assert.equal(s.snap().field, 'Target');
});

test('sel tap on setup flashes SAVED for 1.5 s and survives a power cycle', () => {
  const s = booted();
  s.input({ incStep: true }); s.advance(10, 1);
  tap(s); assert.equal(s.snap().saved, true);
  run(s, 1500, 1); assert.equal(s.snap().saved, false);
  s.power(false); assert.equal(s.snap().on, false);
  s.power(true); run(s, 2500, 1); assert.equal(s.snap().targetC, 131);
});

test('sel hold cancels each step; tap stops heating', () => {
  let s = booted(); hold(s); hold(s); assert.equal(s.snap().state, 'Idle');
  s = booted(); hold(s); tap(s); hold(s); assert.equal(s.snap().state, 'Idle');
  s = heating(); tap(s); assert.equal(s.snap().state, 'Idle');
  s = ready(); hold(s); assert.equal(s.snap().state, 'Idle');
  s = ready(); tap(s); assert.equal(s.snap().state, 'Running'); tap(s); assert.equal(s.snap().state, 'Idle');
});

test('ready times out after 10 min with the heater off', () => {
  const s = ready();
  assert.ok(until(s, x => x.state === 'Idle', 10 * MIN + 2000));
  assert.equal(s.snap().duty, 0);
});

test('preheat timeout: probe off the plate -> NO HEAT RISE', () => {
  const s = booted(); s.fault('probeOff'); hold(s); tap(s); tap(s);
  assert.ok(until(s, x => x.state === 'Fault', 15 * MIN + 2000));
  assert.equal(s.snap().fault, 'NO HEAT RISE');
});

test('probe unplugged -> PROBE OPEN; clears only when replugged', () => {
  const s = booted(); s.fault('probeUnplugged'); run(s, 1000, 1);
  assert.equal(s.snap().state, 'Fault'); assert.equal(s.snap().fault, 'PROBE OPEN');
  tap(s); assert.equal(s.snap().state, 'Fault');
  s.fault(null); run(s, 500, 1); tap(s); assert.equal(s.snap().state, 'Idle');
});

test('heater stuck on -> OVERTEMP; rearm only below 150 C', () => {
  const s = ready(); tap(s); s.fault('heaterStuck');
  assert.ok(until(s, x => x.state === 'SafetyTrip', 20 * MIN));
  tap(s); assert.equal(s.snap().state, 'SafetyTrip');
  s.fault(null);
  assert.ok(until(s, x => x.tempC < 160 && x.tempC >= 150, 30 * MIN, 10));
  tap(s); assert.equal(s.snap().state, 'SafetyTrip', 'no clear at >= 150 C');
  assert.ok(until(s, x => x.tempC < 149, 30 * MIN));
  tap(s); assert.equal(s.snap().state, 'Idle');
});

test('power off cuts everything, even a stuck heater', () => {
  const s = heating(); s.fault('heaterStuck'); run(s, 1000);
  s.power(false);
  const x = s.snap(); assert.equal(x.on, false); assert.equal(x.heaterOn, false);
  const hot = x.padC; run(s, 5000); assert.ok(s.snap().padC < hot, 'pad cools');
});

test('no overshoot at 85 C and 150 C', () => {
  for (const target of [85, 150]) {
    const s = booted();
    const steps = target - 130;
    for (let i = 0; i < Math.abs(steps); i++) { s.input({ [steps > 0 ? 'incStep' : 'decStep']: true }); s.advance(10, 1); }
    hold(s); tap(s); tap(s);
    assert.ok(until(s, x => x.state === 'Ready', 15 * MIN), `Ready at ${target}`);
    tap(s);
    let max = 0;
    for (let i = 0; i < 80; i++) { s.advance(250, 60); max = Math.max(max, s.snap().tempC); }
    assert.ok(max <= target + 2, `max ${max.toFixed(1)} at ${target}`);
  }
});

test('60x matches 1x', () => {
  const a = heating(), b = heating();
  for (let i = 0; i < 2400; i++) a.advance(250, 1);
  for (let i = 0; i < 40; i++) b.advance(250, 60);
  assert.equal(a.snap().state, b.snap().state);
  assert.ok(Math.abs(a.snap().tempC - b.snap().tempC) < 0.01);
});

test('long gap is capped', () => {
  const a = heating(), b = heating();
  a.advance(5000, 10); b.advance(250, 10);
  assert.ok(Math.abs(a.snap().tempC - b.snap().tempC) < 1e-9);
});

// ---- panel (real-time key handling, like the firmware Panel) ----
test('panel: short sel press = selTap + anyTap on release, click on press', () => {
  const p = createPanel();
  p.key('sel', true, 0); let r = p.poll(0); assert.equal(r.click, true); assert.equal(r.ev.selTap, false);
  p.key('sel', false, 300); r = p.poll(300);
  assert.equal(r.ev.selTap, true); assert.equal(r.ev.anyTap, true); assert.equal(r.ev.selHold, false);
});

test('panel: sel held 1 s fires selHold once and no tap', () => {
  const p = createPanel();
  p.key('sel', true, 0); p.poll(0);
  assert.equal(p.poll(999).ev.selHold, false);
  assert.equal(p.poll(1000).ev.selHold, true);
  assert.equal(p.poll(1500).ev.selHold, false);
  p.key('sel', false, 1600); const r = p.poll(1600);
  assert.equal(r.ev.selTap, false); assert.equal(r.ev.anyTap, false);
});

test('panel: inc steps on press, repeats after 500 ms every 120 ms', () => {
  const p = createPanel(); let n = 0;
  p.key('inc', true, 0);
  for (let t = 0; t <= 1000; t += 10) if (p.poll(t).ev.incStep) n++;
  assert.equal(n, 1 + 1 + Math.floor((1000 - 500) / 120));   // press, 500, 620 .. 980
});

// ---- beeper ----
test('beeper: key click 40 ms; ready double beep every 3 s; done 1 s every 2 s', () => {
  const b = createBeeper();
  assert.deepEqual(b.update('Idle', 0, true), [40]);
  const ready = []; for (let t = 0; t < 6000; t += 50) ready.push(...b.update('Ready', t, false));
  assert.deepEqual(ready, [150, 150, 150, 150]);
  const done = []; for (let t = 10000; t < 14000; t += 50) done.push(...b.update('Complete', t, false));
  assert.deepEqual(done, [1000, 1000]);
});

// ---- coaching hints ----
const W = (o = {}) => ({ doorOpen: false, locked: true, water: true, cup: true, drops: 0, objectsInside: 1, touchedHot: false, ...o });
const S = state => ({ on: true, state });
test('hints name the mistakes', () => {
  assert.deepEqual(hints(W(), S('Preheat')), []);
  assert.ok(hints(W({ drops: 2 }), S('Preheat')).some(h => /too early/i.test(h)));
  assert.ok(!hints(W({ drops: 2 }), S('Ready')).some(h => /too early/i.test(h)));
  assert.ok(hints(W({ water: false }), S('StepCup')).some(h => /water/i.test(h)));
  assert.ok(hints(W({ cup: false }), S('Preheat')).some(h => /cup/i.test(h)));
  assert.ok(hints(W({ drops: 0 }), S('Running')).some(h => /no cyanoacrylate/i.test(h)));
  assert.ok(hints(W({ drops: 3, doorOpen: true }), S('Running')).some(h => /door/i.test(h)));
  assert.ok(hints(W({ drops: 3, objectsInside: 0 }), S('Running')).some(h => /test object/i.test(h)));
  assert.ok(hints(W({ touchedHot: true }), S('Complete')).some(h => /hot/i.test(h)));
});

test('constants match firmware 1.0.13', () => {
  assert.deepEqual([C.TARGET_MIN_C, C.TARGET_MAX_C, C.TARGET_DEFAULT_C, C.DURATION_MAX_MIN, C.DURATION_DEFAULT_MIN],
                   [30, 180, 130, 240, 20]);
  assert.deepEqual([C.SAFETY_MAX_C, C.SAFETY_REARM_C, C.HOT_WARN_C, C.HYSTERESIS_C, C.DUTY_MAX_PCT], [200, 150, 40, 1, 40]);
  assert.deepEqual([C.PREHEAT_TIMEOUT_MS, C.READY_TIMEOUT_MS], [15 * MIN, 10 * MIN]);
});

// ---- runner ----
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '-', e.message.split('\n')[0]); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
