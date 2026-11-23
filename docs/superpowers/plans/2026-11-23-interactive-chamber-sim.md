# Interactive Chamber Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 3D chamber model a hands-on simulator: every physical action and key press is a click on the model, and the controller behaves like firmware 1.0.13.

**Architecture:** Pure-JS simulation core (`sim.js`, no three.js, Node-testable) holds the controller state machine, PID, thermal model and coaching hints. `oled.js` draws the 128×64 screens from a Sim snapshot. `play.js` wires three.js picking, physical world state, effects and sound to the model page. The page imports the three modules through its importmap; the offline builder inlines them.

**Tech Stack:** three.js r160 (importmap), plain ES modules, Web Audio, Node 24 for the self-check.

**Spec:** `docs/superpowers/specs/2026-11-23-interactive-chamber-sim-design.md`

## Global Constraints

- Firmware constants copied exactly: target 30–180 °C step 1 default 130; time 1–240 min step 1 default 20; HYSTERESIS 1 °C; PREHEAT_TIMEOUT 15 min; READY_TIMEOUT 10 min; SAFETY_MAX 200 °C; SAFETY_REARM 150 °C; HOT_WARN 40 °C; FAULT_STRIKES 3; TC read every 250 ms; SEL hold 1000 ms; repeat delay 500 ms, rate 120 ms; SAVED flash 1500 ms.
- PID: proportional-on-measurement, KP 2.0, KI 0.02, KD 40, D filter 4 s, duty cap 40 %.
- Thermal: pad 40 J/K, heater 300 W × duty, loss 0.6 W/K to ambient 30 °C, probe first-order lag 66 s.
- Beeps: key 40 ms; boot 2 × 120 ms; ready 2 × 150 ms every 3000 ms until key; done 1000 ms every 2000 ms until key.
- Screen wording exactly as firmware 1.0.13 (`src/main.cpp` Ui::draw*), "cyanoacrylate", never "glue".
- Door: lifts off forward once the lock is released (user did not specify; my call, one function to change).
- `#render;...` figure mode must render exactly as before (sim off).
- UI labels short nouns (CLAUDE.md).
- One page + supporting modules for the artifact; offline file `documents/Smart_CFC_3D_Model.html` stays single-file.

## Review Focus

1. Speed 60× = 60 sim-seconds per real second: Sim must sub-step in 250 ms ticks, never one big step (PID/TC timing) — test `60x matches 1x`.
2. Tab hidden then shown: frame dt spikes — cap real dt at 0.25 s per frame so nothing jumps — test `long gap is capped`.
3. Phone long-press on SEL opens the context menu / selects text — pointer capture + `contextmenu` prevented; hold works with touch.
4. Power off mid-cycle: OLED black, heater off, state back to boot on next power-on, pad cools.
5. Render mode untouched: figure PNGs from `render3d.ps1` identical in labels/framing.

---

### Task 1: Move model sources into the repo

**Files:**
- Create: `model/cfc-chamber-model.html` (copy of scratchpad `cfc-model/cfc-chamber-model.html`)
- Create: `model/make-offline.cjs` (from scratchpad `make-offline.js`, extended)
- Create: `model/package.json` → `{ "type": "module", "private": true }`
- Create: `model/render3d.ps1` (from scratchpad, page path → `model/`)

**Interfaces:**
- Produces: importmap entries `"sim": "./sim.js"`, `"oled": "./oled.js"`, `"play": "./play.js"`; `make-offline.cjs <src.html> <threeDir> <out.html>` inlines three + every importmap entry starting `./` as a data URL.

- [ ] Step 1: Copy files; update paths; add the three importmap entries (empty stub modules so the page loads).
- [ ] Step 2: Run `render3d.ps1 -Only overview,p-pad` → PNGs identical to current `img/` (compare file hash or eyeball).
- [ ] Step 3: Commit `Move 3D model sources into the repo`, push.

### Task 2: Simulation core

**Files:**
- Create: `model/sim.js`
- Test: `model/sim-check.js` (run `node model/sim-check.js`, exits 1 on failure)

**Interfaces:**
- Produces:
  - `export const C` — the constants above.
  - `export function createSim(opts?: {ambient?: number}) => Sim`
  - `Sim.power(on: boolean)`; `Sim.key(name: 'inc'|'dec'|'next'|'prev'|'sel', down: boolean)`; `Sim.advance(simMs: number)` (sub-steps 250 ms internally); `Sim.fault(kind: 'probeOff'|'probeUnplugged'|'heaterStuck'|null)`; `Sim.snap() => {on, booting, state, targetC, durationMin, field, tempC, tempValid, padC, duty, heaterOn, remainingMs, preheatElapsedMs, preheatStartC, fault, saved, progressPct, beeping}`
  - `Sim.onBeep(cb: (ms: number) => void)`
  - `export function hints(world, snap) => string[]` — world = `{doorOpen, locked, water, cup, drops, objects: [...]}`; returns coaching lines from the spec table.
- States/transitions exactly `Controller::update` (main.cpp:407-533). Boot: power on → 2 s splash (`booting`) → Idle. `sel` held ≥1000 ms fires selHold once; release before → selTap. INC/DEC: step on press, auto-repeat after 500 ms every 120 ms. Any tap (any key release before hold) = anyTap. SEL tap in Idle → `saved` for 1500 ms.
- Faults: `probeOff` → probe reads ambient-ish (lag to 30 °C) so preheat times out; `probeUnplugged` → invalid reads → Fault after 3 strikes; `heaterStuck` → duty forced 1.0 → SafetyTrip at 200 °C.

- [ ] Step 1: Write `sim-check.js` with these tests (assert-based, print PASS/FAIL per test):
  - `full cycle`: power on, advance 2 s, hold sel 1.1 s → StepWater; tap → StepCup; tap → Preheat; advance until Ready (≤ 15 min), probe within 130±2; tap → Running; advance 20 min → Complete; tap → Idle.
  - `sel hold cancels each step` (StepWater, StepCup, Ready → Idle; Preheat/Running cancel on tap).
  - `ready timeout`: at Ready, advance 10 min no key → Idle, duty 0.
  - `preheat timeout`: fault probeOff, start, advance 15 min → Fault 'NO HEAT RISE'.
  - `overtemp`: fault heaterStuck in Running → SafetyTrip; clear fault, cool <150 → sel tap → Idle; ≥150 tap ignored.
  - `probe unplugged`: → Fault; tap while unplugged ignored; replug + tap → Idle.
  - `no overshoot`: max probe ≤ target + 2 at 85 and 150 °C.
  - `60x matches 1x`: advance(600000) once vs 2400 × advance(250) → same state/temp ±0.01.
  - `long gap is capped`: (in play-side helper `realToSim(dtReal, speed)`, exported from sim.js) dtReal 5 s → treated as 0.25 s.
  - `hints`: drops>0 while state ∉ {Ready, Running} → "Cyanoacrylate added too early"; Running && doorOpen → "Close the door: fumes escape"; StepWater tap with !water → "No water tray in the chamber"; etc. per spec.
- [ ] Step 2: Run `node model/sim-check.js` → fails (module empty).
- [ ] Step 3: Implement `sim.js`.
- [ ] Step 4: Run → all PASS.
- [ ] Step 5: Commit `Add chamber simulation core with self-check`, push.

### Task 3: Live OLED

**Files:**
- Create: `model/oled.js` (port from scratchpad `manual/oled-render.html` primitives + screens, text exactly per firmware)
- Modify: `model/cfc-chamber-model.html` (OLED material uses live 128×64 canvas, scaled with NearestFilter)

**Interfaces:**
- Consumes: `Sim.snap()`.
- Produces: `export function drawOled(ctx: CanvasRenderingContext2D, snap, frame: number)` (frame = sim ms / 250), draws splash/setup/step1/step2/heating/ready/done/fault/trip; black when off.

- [ ] Step 1: Add dev hash `#sim;state=<State>` that forces a snapshot (for screenshots only).
- [ ] Step 2: Implement `drawOled`; screenshot each state with headless Edge; compare against `manual/img/oled-*.png`.
- [ ] Step 3: Commit `Live OLED screen on the model`, push.

### Task 4: Clicks on the model

**Files:**
- Create: `model/play.js`
- Modify: `model/cfc-chamber-model.html` (Simulate toggle, speed buttons 1×/10×/60× default 10×, hint strip, practice-fault menu, `parts` additions: lock buttons, keypad, power, cup, water, bottle, glass, cyano bottle)

**Interfaces:**
- Consumes: `createSim`, `hints`, `realToSim`, `drawOled`.
- Produces: `export function startPlay({THREE, scene, camera, controls, renderer, parts, dom}) => {frame(dtReal), stop()}`; `world` object as in Task 2.

- Picking: Raycaster on pointerdown/up; hover outline (emissive tint) on clickable parts; cursor pointer.
- Keypad: hit UV on the keypad face → key by region (centre SEL, up INC, down DEC, left BEFORE, right NEXT); pointer capture until up; `contextmenu` prevented on the stage.
- Clicking keypad/OLED first flies camera to controller front (existing camAnim); "Back" returns to the previous view.
- Lock: PUSH click → `locked=false` (pod lifts 0.3 cm); door click when unlocked → lifts off forward (animate z+8, y+2); click again → back and re-latch.
- Water tray, cup, cyano bottle (adds 1 drop per click, only with door open), bottle/glass (pick → place on grill or S-hook → take out) per spec table.
- Power switch rocker flips; calls `Sim.power`.

- [ ] Step 1: Implement; manual check in Edge: full happy path by clicks only at 60×.
- [ ] Step 2: Phone check: Edge device emulation (`--window-size=390,844`), long-press SEL starts the cycle.
- [ ] Step 3: Commit `Clickable simulator on the 3D model`, push.

### Task 5: Effects and sound

**Files:**
- Modify: `model/play.js`

- Plate glow: plate emissive colour lerp grey→#7a1a0a→#ff3b1a over padC 40→200 °C; additive glow sprite above it.
- Steam: sprite particles from water tray, rate ∝ water temp (water starts 80 °C, cools to ambient, warms slowly with chamber).
- Fumes: sprite particles from cup when drops>0 and padC ≥ 100; chamber fog density builds while Running with door closed; door open → particles drift out the front; fades after Complete.
- Prints: each test object has a fingerprint canvas texture (reuse firmware fingerprint pattern) whose opacity = exposure (fume density × time, 1.0 ≈ 15 min dense fumes); stays after removal.
- Sound: Web Audio square wave 2.7 kHz for `onBeep`; starts after first user gesture.
- Respect `prefers-reduced-motion`: fewer particles, no shimmer.

- [ ] Step 1: Implement; screenshot Preheat, Running, Complete at 60×.
- [ ] Step 2: Commit `Simulator effects: plate glow, steam, fumes, developing prints, beeps`, push.

### Task 6: Ship

- [ ] Step 1: `node model/sim-check.js` → all PASS; `render3d.ps1` figures unchanged.
- [ ] Step 2: Republish artifact https://claude.ai/artifact/7h4zz6ALejVUEQ59pqNcrZ with `files` {sim.js, oled.js, play.js}.
- [ ] Step 3: `node model/make-offline.cjs model/cfc-chamber-model.html <three160> documents/Smart_CFC_3D_Model.html`; open with CDN blocked → simulator works.
- [ ] Step 4: Commit `Offline simulator build`, push.
