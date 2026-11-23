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
        // What the controller commands (firmware heater.isOn()): the OLED flame. A stuck SSR heats with this off.
        heaterCmd: controlling() && HEATING.has(k.state) && k.duty > 0,
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
    // Touch taken away by the OS: key up with no tap, hold or step.
    cancel(name) { Object.assign(keys[name], { down: false, press: false, step: false, tap: false, hold: false }); },
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
  if (s === 'Preheat' && world.doorOpen) out.push('Close and lock the door while the plate heats');
  if (after(['Preheat', 'Running']) && !world.doorOpen && !world.locked) out.push('Door not locked: press PUSH to lock it');
  if (s === 'Running' && world.objectsInside === 0) out.push('No test object in the chamber');
  if (world.touchedHot) out.push('PLATE HOT: let it cool before touching');
  return out;
}

// The one thing to do next, following the manual's procedure (chapter 6).
export function nextStep(world, snap) {
  const open = world.doorOpen, s = snap.on ? snap.state : 'Off';
  const toOpen = world.locked ? 'Press PUSH on the lock, then click the door to open it' : 'Click the door to open it';
  switch (s) {
    case 'Off': return 'Turn on the power switch (back of the controller)';
    case 'Idle':
      if (snap.booting) return 'Starting…';
      if (world.objectsInside === 0) return open ? 'Put a test object in the chamber (click the bottle or glass)' : toOpen;
      return 'Set TEMP and TIME with the keys, then hold SEL for 1 s to start';
    case 'StepWater':
      if (!world.water) return open ? 'Put the hot water tray in the chamber, then press any key' : toOpen;
      return 'Press any key';
    case 'StepCup':
      if (!world.cup) return open ? 'Put the empty foil cup on the heating plate, then press any key' : toOpen;
      return 'Press any key to start heating';
    case 'Preheat':
      if (open) return 'Close the door, then lock it (press PUSH)';
      if (!world.locked) return 'Lock the door (press PUSH)';
      return "Plate heating: don't add cyanoacrylate yet";
    case 'Ready':
      if (world.drops === 0) return open ? 'Add cyanoacrylate to the cup (click the bottle)' : toOpen;
      if (open) return 'Close the door';
      if (!world.locked) return 'Lock the door (press PUSH)';
      return 'Press any key to start fuming';
    case 'Running': return 'Fuming: keep the door closed';
    case 'Complete': return 'Press any key, then take the objects out somewhere ventilated';
    case 'Fault': return 'Fix the fault, then press SEL';
    case 'SafetyTrip': return 'Turn off the power: the heater may be stuck on. Let it cool below 150 °C before using it again';
  }
  return '';
}

// The whole procedure (manual chapter 6), for the checklist.
export const STEPS = [
  'Turn on the power',
  'Unlock and open the door',
  'Put test objects on the grill',
  'Set temperature and time, hold SEL',
  'Step 1: hot water in, press a key',
  'Step 2: empty cup on the plate, press a key',
  'Step 3: close and lock the door, wait for heating',
  'Step 4: open the door, add 3 to 5 drops',
  'Close and lock the door, press a key',
  'Fuming: wait for DONE',
  'Press a key, let the plate cool',
  'Take the objects out in a ventilated area',
];

// Index into STEPS of what the user is on now; STEPS.length when all done, -1 on a fault.
// world.cycleDone is set by the page once a cycle has reached DONE.
export function currentStep(world, snap) {
  const s = snap.on ? snap.state : 'Off';
  if (s === 'Fault' || s === 'SafetyTrip') return -1;
  if (world.cycleDone && s !== 'StepWater') {
    if (s === 'Complete') return 10;
    return world.objectsInside > 0 ? 11 : STEPS.length;
  }
  switch (s) {
    case 'Off': return 0;
    case 'Idle': return world.objectsInside > 0 ? 3 : world.doorOpen ? 2 : 1;
    case 'StepWater': return 4;
    case 'StepCup': return 5;
    case 'Preheat': return 6;
    case 'Ready': return world.drops === 0 ? 7 : 8;
    case 'Running': return 9;
    case 'Complete': return 10;
  }
  return 0;
}

// Warning to show before an action that is wrong at this point, or null when it is fine.
// kind: the part clicked ('cyano', 'door', 'push', 'power', 'water', 'cup').
export function checkAction(kind, world, snap) {
  const s = snap.on ? snap.state : 'Off', heating = ['Preheat', 'Ready', 'Running'].includes(s);
  switch (kind) {
    case 'cyano':
      if (s === 'Ready' || s === 'Running') return null;
      if (s === 'Preheat') return { title: 'Plate still heating',
        text: 'Cyanoacrylate added now boils off while the plate warms up, before the fuming timer starts. Most of it is wasted and the prints come out weak. Wait for STEP 4 READY.' };
      return { title: 'Plate is cold',
        text: 'Cold cyanoacrylate does not fume. It will boil off later during warm-up, before the fuming timer starts, and the prints come out weak. Add it only at STEP 4 READY.' };
    case 'door':
      if (!world.doorOpen && s === 'Running') return { title: 'Fuming in progress',
        text: 'Opening the door now lets the fumes out into the room and the prints develop unevenly. Wait for DONE.' };
      return null;
    case 'push':
      if (world.locked && (s === 'Preheat' || s === 'Running')) return { title: 'Keep the door locked',
        text: s === 'Running' ? 'The chamber is full of cyanoacrylate fumes. Keep the door locked until DONE.'
                              : 'Keep the chamber locked while the plate heats. Unlock it only at STEP 4 READY to add the cyanoacrylate.' };
      return null;
    case 'power':
      if (heating) return { title: 'Cycle running',
        text: 'Turning off now stops the heater in the middle of the cycle. Use SEL to stop a cycle properly.' };
      return null;
    case 'water':
      if (world.water && heating) return { title: 'Water needed',
        text: 'The hot water keeps the air humid. Without it the prints develop weakly.' };
      return null;
    case 'cup':
      if (world.cup && heating) return { title: 'Cup needed',
        text: 'The cyanoacrylate goes in this cup on the hot plate. Leave it there until the cycle is done.' };
      return null;
  }
  return null;
}

// Warning before a key press moves the controller on to the next stage, or null.
// ev: ButtonEvents from the keypad. SEL hold during a cycle cancels and is always allowed.
export function checkKey(ev, world, snap) {
  const s = snap.on ? snap.state : 'Off';
  if (s === 'Idle' && ev.selHold && world.objectsInside === 0) return { title: 'No test object',
    text: 'There is nothing in the chamber to develop. Open the door and put the bottle or glass on the grill first.' };
  if (!ev.anyTap) return null;
  if (s === 'StepWater' && !world.water) return { title: 'No hot water',
    text: 'Step 1 is the bowl of hot water: it keeps the air humid so the prints develop. Put the water tray in first.' };
  if (s === 'StepCup' && !world.cup) return { title: 'No cup on the plate',
    text: 'Step 2 is the empty foil cup on the heating plate. Without it there is nowhere to put the cyanoacrylate.' };
  if (s === 'Ready') {
    if (world.drops === 0) return { title: 'No cyanoacrylate yet',
      text: 'The fuming timer would run with nothing in the cup, so nothing develops. Open the door and add 3 to 5 drops first.' };
    if (world.doorOpen) return { title: 'Door open',
      text: 'Fuming with the door open lets the fumes into the room. Close and lock the door first.' };
    if (!world.locked) return { title: 'Door not locked',
      text: 'The door is closed but not locked. Press PUSH to lock it before fuming starts.' };
  }
  return null;
}

// Warning right after the door is closed but left unlocked while it should be locked, or null.
export function afterDoorClosed(world, snap) {
  const s = snap.on ? snap.state : 'Off';
  if (world.locked || !['Preheat', 'Ready', 'Running'].includes(s)) return null;
  return { title: 'Door not locked',
    text: 'The door is closed but the lock is open. Lock it so the chamber stays sealed while it heats and fumes.' };
}
