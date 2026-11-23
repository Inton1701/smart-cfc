# Interactive chamber simulation — design

Date: 2026-11-23
Status: draft, waiting for approval

## Intent

Turn the 3D chamber model into a hands-on simulator. The person using it drives every
step themselves on the model: unlock the door, open it, put the water in, place the cup,
press the membrane keys, add the cyanoacrylate, close the door, wait for fuming, finish.
Nothing plays by itself. The controller (OLED, beeps, heater, timers) behaves the way
firmware 1.0.13 does, so practice on the simulator carries over to the real chamber.

## Goals

- Every physical action is a click on the model itself (option 1, chosen by the user):
  lock PUSH buttons, door, water tray, foil cup, cyanoacrylate bottle, S-hook specimen,
  power switch, the five keypad keys.
- The OLED on the model is a live screen showing the same screens as the firmware.
- The heating plate glows red as it heats (grey → dull red → bright red with temperature,
  plus a faint heat shimmer).
- Fumes: white smoke/fog rises from the cup once the cyanoacrylate is on the hot plate and
  slowly fills the chamber; it thins out when the cycle ends and pours out if the door is opened.
- Hot water evaporates: steam rises from the water tray, stronger while it is hot, fading
  as it cools.
- Test objects (requested): a glass bottle and a drinking glass beside the chamber. The user
  picks one up and places it in the chamber (stands on the grill or hangs from an S-hook).
  During fuming, white fingerprint ridges slowly appear on it; when it is taken out after
  the cycle the developed prints stay visible. Too short a cycle = faint prints.
- Beeps match the firmware (key click, two boot beeps, Step 4 double beep repeating,
  done long beep repeating until a key).
- User-controlled speed: 1×, 10×, 60×, so the warm-up does not drag.
- Works in the published artifact and in the offline `documents/Smart_CFC_3D_Model.html`.

## Non-goals

- Wi-Fi, web page, OTA, NVS saving (SEL tap shows "SAVED" but nothing persists across reloads).
- Exact physics; the thermal model only has to look and behave like the real pad.

## Anti-goals (would be a failure even if it works)

- The simulator teaching something the real chamber does differently.
- Click targets too small to hit (keys, lock buttons).
- Breaking the manual's figure render mode (`#render;...`).

## Constraints

- One HTML file; three.js r160 as now; offline build via `make-offline.js` keeps working.
- Must stay usable on a phone (touch: tap, press-and-hold).

## Approaches considered

1. **Everything clicked on the 3D model** — chosen. Most like the real thing.
   Small keys solved by zooming the camera to the controller front when the keypad is used.
2. Physical actions in 3D plus a large 2D keypad/OLED panel beside it — easier to hit,
   less hands-on. Not chosen.
3. 2D panel only, 3D as a picture — simplest, loses the hands-on part. Not chosen.

## How it works

### Simulation core (pure JS, no three.js)

- `Sim` object = port of firmware `Controller::update`: states Idle, StepWater, StepCup,
  Preheat, Ready, Running, Complete, Fault, SafetyTrip, with the same transitions,
  key rules (tap vs 1 s SEL hold), constants (target 30–180 °C default 130,
  time 1–240 min default 20, preheat timeout 15 min, ready timeout 10 min,
  trip 200 °C / rearm 150 °C, hot warning 40 °C, duty cap 40 %).
- Same proportional-on-measurement PID (KP 2.0, KI 0.02, KD 40, 4 s D filter).
- Thermal model from the firmware notes: pad ~40 J/K, 300 W heater, loss ~0.6 W/K,
  probe lag ~66 s, ambient 28 °C. Probe reading feeds the Sim like the MAX6675 (every 250 ms).
- Sim time advances by real time × speed.
- Power switch off = everything off and pad cools; on = splash then Setup.

### Screens

- 128×64 canvas, drawn by the screen code already written for the manual
  (`oled-render.html`), updated to read live Sim values; used as the OLED mesh texture
  (scaled up, nearest-neighbour). Replaces the current static setup picture.

### Physical actions on the model

| Click | Effect |
|---|---|
| Power switch | on/off; boot beeps + splash |
| Lock PUSH button (either piece) | lock releases; second click re-latches |
| Door (lock released) | door opens; click again closes; lock latches when closed (user to confirm how the door opens, see open questions) |
| Bottle / glass (beside the chamber) | pick up, then click the grill or an S-hook to place it; click again to take it out |
| Water tray | put in with hot water (steam) / take out |
| Foil cup | place on / remove from the plate |
| Cyanoacrylate bottle (beside the chamber) | add drops to the cup (door must be open) |
| Keypad keys | INC/DEC/NEXT/BEFORE/SEL; press-and-hold works for SEL hold and auto-repeat |

- Clicking the keypad or OLED area first flies the camera to the controller front so the
  keys are large; a "Back" view button returns.
- Hover/tap highlight shows what is clickable.

### Coaching (my call)

The real controller cannot see the water, cup, door or drops, so the Sim screens behave
exactly like the firmware whatever the user does. A separate hint strip under the model
names mistakes as they happen, without changing controller behaviour:
- cyanoacrylate added before Step 4 / before the plate is ready;
- key pressed on Step 1/2 without water or cup actually placed;
- starting fuming with the door open;
- opening the door while fuming (fumes escape — shown);
- touching the cup/plate while PLATE HOT.

### Practice faults (my call)

Small menu: "Probe off the plate" (no heat rise → FAULT after 15 min sim time),
"Probe unplugged" (sensor fault), "Heater stuck on" (rises to OVERTEMP trip). Clears
the same way as the firmware.

### Speed

Buttons 1× / 10× / 60× beside the view buttons. Default 10×.

## Testing

- One Node self-check (`sim-check.js`) runs the Sim headless: full happy-path cycle,
  SEL-hold cancels each step, ready timeout, preheat timeout fault, overtemp trip and rearm.
  Mirrors the firmware Unity tests.
- Visual check via the existing headless Edge screenshots.

## Left to the builder

- Exact look of the bottle, specimen card, steam and fume effects.
- Camera fly-to framing.

## Open questions (user)

1. How does the real door open: hinged (which side) or lifted off once the lock is released?
