// Smart CFC simulator core: a port of firmware 1.0.13 (src/main.cpp) Controller,
// Pid, Panel and beep timing, plus a thermal model of the pad and probe.
// No three.js here, so node model/sim-check.js can test it.

export const C = {
  TARGET_MIN_C: 30, TARGET_MAX_C: 180, TARGET_DEFAULT_C: 130, TARGET_STEP_C: 1,
  DURATION_MIN_MIN: 1, DURATION_MAX_MIN: 240, DURATION_DEFAULT_MIN: 20, DURATION_STEP_MIN: 1,
  SAFETY_MAX_C: 200, SAFETY_REARM_C: 150, FAULT_STRIKES: 3, HOT_WARN_C: 40, HYSTERESIS_C: 1,
  PREHEAT_TIMEOUT_MS: 15 * 60000, READY_TIMEOUT_MS: 10 * 60000,
  PID_KP: 2.0, PID_KI: 0.02, PID_KD: 40, PID_D_FILTER_S: 4, DUTY_MAX_PCT: 40,
  TC_READ_INTERVAL_MS: 250, BTN_LONGPRESS_MS: 1000, BTN_REPEAT_DELAY_MS: 500, BTN_REPEAT_RATE_MS: 120,
  SAVED_FLASH_MS: 1500, BOOT_MS: 2000,
  BEEP_KEY_MS: 40, BEEP_DONE_MS: 1000, BEEP_DONE_PERIOD_MS: 2000, BEEP_READY_MS: 150, BEEP_READY_PERIOD_MS: 3000,
  // Thermal model (firmware tuning notes): pad 40 J/K, 300 W heater, 0.6 W/K loss, probe lag 66 s.
  AMBIENT_C: 30, PAD_J_K: 40, HEATER_W: 300, LOSS_W_K: 0.6, PROBE_LAG_S: 66,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const HEATING = new Set(['Preheat', 'Ready', 'Running']);
const FAULT_TEXT = { SensorOpen: 'PROBE OPEN', SensorInvalid: 'SENSOR FAULT', PreheatTimeout: 'NO HEAT RISE' };
const NO_EVENTS = { incStep: false, decStep: false, nextTap: false, prevTap: false, selTap: false, selHold: false, anyTap: false };

// Proportional-on-measurement PID, as class Pid in main.cpp.
function createPid() {
  let sum = 0, prev = 0, rate = 0, hasPrev = false;
  return {
    reset() { sum = 0; rate = 0; hasPrev = false; },
    update(setpoint, measured, dt) {
      if (hasPrev && dt > 0) {
        const d = measured - prev;
        rate += (d / dt - rate) * dt / (C.PID_D_FILTER_S + dt);
        sum = clamp(sum + C.PID_KI * (setpoint - measured) * dt - C.PID_KP * d, 0, C.DUTY_MAX_PCT);
      }
      prev = measured; hasPrev = true;
      return clamp(sum - C.PID_KD * rate, 0, C.DUTY_MAX_PCT);
    },
  };
}

// opts.ambient: room temperature in C.
export function createSim(opts = {}) {
  const amb = opts.ambient ?? C.AMBIENT_C;
  const saved = { targetC: C.TARGET_DEFAULT_C, durationMin: C.DURATION_DEFAULT_MIN };
  const pid = createPid();
  let on = false, bootLeft = 0, savedLeft = 0, acc = 0, simMs = 0, faultKind = null;
  let padC = amb, probeC = amb, pending = { ...NO_EVENTS };
  let k;   // controller state, rebuilt at every power-on
  let reading = { valid: true, celsius: amb, openCircuit: false };

  function powerOnController() {
    k = { state: 'Idle', field: 'Target', targetC: saved.targetC, durationMin: saved.durationMin,
          tempC: probeC, tempValid: false, strikes: 0, duty: 0, remainingMs: 0, preheatElapsedMs: 0,
          preheatStartC: probeC, readyElapsedMs: 0, fault: null, hasLastSample: false };
  }
  function enterIdle() {
    Object.assign(k, { state: 'Idle', hasLastSample: false, fault: null, field: 'Target', duty: 0,
                       remainingMs: 0, preheatElapsedMs: 0 });
    pid.reset();
  }
  function enterFault(code) { Object.assign(k, { state: 'Fault', fault: code, duty: 0 }); pid.reset(); }
  function startCycle() {
    Object.assign(k, { fault: null, remainingMs: k.durationMin * 60000, preheatElapsedMs: 0,
                       preheatStartC: k.tempC, hasLastSample: false, state: 'Preheat' });
    pid.reset();
  }
  function adjust(dir) {
    if (k.field === 'Target') k.targetC = clamp(k.targetC + dir * C.TARGET_STEP_C, C.TARGET_MIN_C, C.TARGET_MAX_C);
    else k.durationMin = clamp(k.durationMin + dir * C.DURATION_STEP_MIN, C.DURATION_MIN_MIN, C.DURATION_MAX_MIN);
  }

  // Controller::update. Fresh samples arrive every 250 ms of sim time.
  function update(dtMs, ev, fresh) {
    const dtSec = fresh && k.hasLastSample ? C.TC_READ_INTERVAL_MS / 1000 : 0;
    if (fresh) k.hasLastSample = true;
    if (fresh && reading.valid) { k.strikes = 0; k.tempC = reading.celsius; k.tempValid = true; }
    else if (fresh) k.strikes++;
    const sensorBad = k.strikes >= C.FAULT_STRIKES;
    if (sensorBad) k.tempValid = false;

    if (k.tempValid && k.tempC >= C.SAFETY_MAX_C) {
      if (k.state !== 'SafetyTrip') { k.state = 'SafetyTrip'; k.duty = 0; pid.reset(); }
    } else if (sensorBad && k.state !== 'Fault' && k.state !== 'SafetyTrip') {
      enterFault(reading.openCircuit ? 'SensorOpen' : 'SensorInvalid');
    }
    const heat = () => { if (fresh) k.duty = pid.update(k.targetC, k.tempC, dtSec); };

    switch (k.state) {
      case 'Idle':
        k.duty = 0;
        if (ev.decStep) adjust(-1);
        if (ev.incStep) adjust(+1);
        if (ev.nextTap || ev.prevTap) k.field = k.field === 'Target' ? 'Duration' : 'Target';
        if (ev.selHold && k.tempValid) k.state = 'StepWater';
        break;
      case 'StepWater':
      case 'StepCup':
        k.duty = 0;
        if (ev.selHold) { enterIdle(); break; }
        if (ev.anyTap) {
          if (k.state === 'StepWater') k.state = 'StepCup';
          else if (k.tempValid) startCycle();
        }
        break;
      case 'Preheat':
        if (ev.selTap || ev.selHold) { enterIdle(); break; }
        k.preheatElapsedMs += dtMs;
        if (k.preheatElapsedMs >= C.PREHEAT_TIMEOUT_MS) { enterFault('PreheatTimeout'); break; }
        heat();
        if (k.tempC >= k.targetC - C.HYSTERESIS_C) { k.state = 'Ready'; k.readyElapsedMs = 0; }
        break;
      case 'Ready':
        if (ev.selHold) { enterIdle(); break; }
        heat();
        if (ev.anyTap) { k.state = 'Running'; break; }
        k.readyElapsedMs += dtMs;
        if (k.readyElapsedMs >= C.READY_TIMEOUT_MS) enterIdle();
        break;
      case 'Running':
        if (ev.selTap || ev.selHold) { enterIdle(); break; }
        heat();
        if (dtMs >= k.remainingMs) { k.remainingMs = 0; k.duty = 0; k.state = 'Complete'; pid.reset(); }
        else k.remainingMs -= dtMs;
        break;
      case 'Complete':
        k.duty = 0;
        if (ev.selTap || ev.selHold || ev.nextTap || ev.prevTap || ev.incStep || ev.decStep) enterIdle();
        break;
      case 'Fault':
        k.duty = 0;
        if (ev.selTap && reading.valid && k.strikes === 0) enterIdle();
        break;
      case 'SafetyTrip':
        k.duty = 0;
        if (ev.selTap && k.tempValid && k.tempC < C.SAFETY_REARM_C) enterIdle();
        break;
    }
  }

  const controlling = () => on && bootLeft <= 0;
  const heaterW = () => {
    if (!on) return 0;                                   // the power switch cuts mains, stuck SSR included
    if (faultKind === 'heaterStuck') return C.HEATER_W;
    return controlling() && HEATING.has(k.state) ? C.HEATER_W * k.duty / 100 : 0;
  };

  function tick(dtMs) {
    const dt = dtMs / 1000;
    padC += (heaterW() - C.LOSS_W_K * (padC - amb)) / C.PAD_J_K * dt;
    // Probe off the plate: it hangs in the chamber air, which barely warms.
    const src = faultKind === 'probeOff' ? amb + 0.1 * (padC - amb) : padC;
    probeC += (src - probeC) / C.PROBE_LAG_S * dt;
    simMs += dtMs;
    if (!controlling()) return;
    reading = faultKind === 'probeUnplugged'
      ? { valid: false, celsius: NaN, openCircuit: true }
      : { valid: true, celsius: probeC, openCircuit: false };
    update(dtMs, takeEvents(), true);
  }
  function takeEvents() { const ev = pending; pending = { ...NO_EVENTS }; return ev; }

  return {
    power(v) {
      if (v === on) return;
      on = v;
      if (on) { bootLeft = C.BOOT_MS; savedLeft = 0; powerOnController(); pid.reset(); }
      pending = { ...NO_EVENTS };
    },
    // ev: ButtonEvents from createPanel().poll(); applied on the next advance().
    input(ev) { for (const key in ev) if (ev[key]) pending[key] = true; },
    fault(kind) { faultKind = kind; },
    // realMs is capped at 250 so a hidden tab cannot jump the simulation.
    advance(realMs, speed = 1) {
      realMs = Math.min(realMs, 250);
      if (on && bootLeft > 0) { bootLeft -= realMs; if (bootLeft <= 0) pending = { ...NO_EVENTS }; }
      if (savedLeft > 0) savedLeft -= realMs;
      if (controlling()) {
        const ev = takeEvents();
        if (ev.selTap && k.state === 'Idle') {            // SEL tap on setup saves (main.cpp loop)
          saved.targetC = k.targetC; saved.durationMin = k.durationMin; savedLeft = C.SAVED_FLASH_MS;
        }
        update(0, ev, false);
      }
      for (acc += realMs * speed; acc >= C.TC_READ_INTERVAL_MS; acc -= C.TC_READ_INTERVAL_MS) tick(C.TC_READ_INTERVAL_MS);
    },
    snap() {
      const st = on ? (k ? k.state : 'Idle') : 'Off';
      let pct = 0;
      if (on && k) {
        if (k.state === 'Preheat') {
          const span = k.targetC - C.HYSTERESIS_C - k.preheatStartC;
          pct = Math.trunc(100 * clamp(span > 0 ? (k.tempC - k.preheatStartC) / span : 1, 0, 1));
        } else if (k.state === 'Ready') pct = 100;
        else if (k.state === 'Running') pct = Math.trunc(100 * (k.durationMin * 60000 - k.remainingMs) / (k.durationMin * 60000));
      }
      return {
        on, booting: on && bootLeft > 0, bootProgress: on ? clamp(1 - bootLeft / C.BOOT_MS, 0, 1) : 0,
        state: st, targetC: k?.targetC ?? saved.targetC, durationMin: k?.durationMin ?? saved.durationMin,
        field: k?.field ?? 'Target', tempC: k?.tempC ?? probeC, tempValid: on && !!k?.tempValid,
        padC, duty: on && k ? k.duty : 0, heaterOn: heaterW() > 0,
        remainingMs: k?.remainingMs ?? 0, preheatElapsedMs: k?.preheatElapsedMs ?? 0,
        preheatStartC: k?.preheatStartC ?? amb, fault: k?.fault ? FAULT_TEXT[k.fault] : '',
        saved: savedLeft > 0, progressPct: pct, simMs,
      };
    },
  };
}

// Five-key membrane keypad, as class Button/Panel in main.cpp. Times are real ms.
export function createPanel() {
  const keys = {};
  for (const n of ['inc', 'dec', 'next', 'prev', 'sel'])
    keys[n] = { down: false, pressedAt: 0, repeatAt: 0, holdFired: false, press: false, step: false, tap: false, hold: false };
  const take = (b, f) => { const v = b[f]; b[f] = false; return v; };
  return {
    key(name, down, t) {
      const b = keys[name];
      if (down && !b.down) Object.assign(b, { down: true, pressedAt: t, repeatAt: t + C.BTN_REPEAT_DELAY_MS, holdFired: false, press: true, step: true });
      else if (!down && b.down) { b.down = false; if (!b.holdFired && t - b.pressedAt < C.BTN_LONGPRESS_MS) b.tap = true; }
    },
    isDown: name => keys[name].down,
    poll(t) {
      let click = false;
      for (const b of Object.values(keys)) {
        if (b.down) {
          if (!b.holdFired && t - b.pressedAt >= C.BTN_LONGPRESS_MS) { b.holdFired = true; b.hold = true; }
          if (t >= b.repeatAt) { b.repeatAt = t + C.BTN_REPEAT_RATE_MS; b.step = true; }
        }
        if (take(b, 'press')) click = true;
      }
      const ev = {
        incStep: take(keys.inc, 'step'), decStep: take(keys.dec, 'step'),
        nextTap: take(keys.next, 'tap'), prevTap: take(keys.prev, 'tap'),
        selTap: take(keys.sel, 'tap'), selHold: take(keys.sel, 'hold'),
      };
      for (const n of ['next', 'prev', 'sel']) take(keys[n], 'step');
      take(keys.next, 'hold'); take(keys.prev, 'hold'); take(keys.inc, 'hold'); take(keys.dec, 'hold');
      const incTap = take(keys.inc, 'tap'), decTap = take(keys.dec, 'tap');
      ev.anyTap = incTap || decTap || ev.nextTap || ev.prevTap || ev.selTap;
      return { ev, click };
    },
  };
}

// Beep timing from main.cpp loop(). Returns the beeps (durations in ms) to start now.
export function createBeeper() {
  let last = null, doneAt = 0, readyAt = 0, readySecond = false;
  return {
    update(state, t, click) {
      const out = [];
      if (click) out.push(C.BEEP_KEY_MS);
      if (state === 'Complete' && (last !== 'Complete' || t - doneAt >= C.BEEP_DONE_PERIOD_MS)) {
        out.push(C.BEEP_DONE_MS); doneAt = t;
      }
      if (state === 'Ready') {
        if (last !== 'Ready' || t - readyAt >= C.BEEP_READY_PERIOD_MS) { out.push(C.BEEP_READY_MS); readyAt = t; readySecond = true; }
        else if (readySecond && t - readyAt >= 2 * C.BEEP_READY_MS) { out.push(C.BEEP_READY_MS); readySecond = false; }
      }
      last = state;
      return out;
    },
  };
}

// Coaching lines for the hint strip. The real controller cannot see any of this,
// so these never change what the simulated controller does.
// world: { doorOpen, locked, water, cup, drops, objectsInside, touchedHot }
export function hints(world, snap) {
  const s = snap.on ? snap.state : 'Off', out = [];
  const after = list => list.includes(s);
  if (world.drops > 0 && after(['StepWater', 'StepCup', 'Preheat'])) out.push('Cyanoacrylate added too early: wait for STEP 4 READY');
  if (!world.water && after(['StepCup', 'Preheat', 'Ready', 'Running'])) out.push('No hot water in the chamber (STEP 1)');
  if (!world.cup && after(['Preheat', 'Ready', 'Running'])) out.push('No cup on the heating plate (STEP 2)');
  if (s === 'Running' && world.drops === 0) out.push('No cyanoacrylate in the cup: nothing will develop');
  if (s === 'Running' && world.doorOpen) out.push('Close the door: fumes are escaping');
  if (s === 'Running' && world.objectsInside === 0) out.push('No test object in the chamber');
  if (world.touchedHot) out.push('PLATE HOT: let it cool before touching');
  return out;
}
