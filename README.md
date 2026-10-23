# Smart CFC

Temperature and timer controller for a cyanoacrylate (superglue) fuming chamber.
ESP32, K-type thermocouple on a MAX6675, 220 V 300 W heating pad switched
through an SSR-40DA, 2.42" OLED, 5-key membrane keypad, buzzer, and a 40 mm
circulation fan on a relay module.

Holds a set temperature for a set dwell time, then shuts the heater off by
itself and sounds one long beep. Aborts on over-temperature, on a bad
thermocouple, and on a heater that fails to warm up.

Parts list: [documents/Heating_Chamber_Materials.docx](documents/Heating_Chamber_Materials.docx).
Circuit summary: [documents/Heating_Chamber_Circuit_Documentation.docx](documents/Heating_Chamber_Circuit_Documentation.docx).
Full pin-to-pin wiring: [documents/WIRING.md](documents/WIRING.md).

---

## Safety first — three hardware items are not optional

This controller switches 220 V mains inside a sealed chamber containing
flammable vapour. **Software cannot be its own safety device.** Industrial
practice is that the thing which controls is never the thing which protects, and
this build follows that.

**1. Thermal fuses in series with the AC line.**
Both thermal fuses clamped to the heater plate, wired in series with the live
conductor feeding the pad, before the SSR. They must open the circuit with the
ESP32 dead, hung, or unplugged. Without them, a stuck SSR has nothing stopping
it. Their rating should be around 100 °C: above anything a normal run reaches,
below the point where the acrylic softens.

**2. SSR heatsinked for the current you actually draw.**
The 40 A on the label is a heatsinked rating. A bare 40 A SSR passing 2 A still
dissipates around 2 W across its junction and will drift hot. Bolt it to a
finned heatsink with thermal paste.

**3. No earth, so: RCD on the supply, plate insulated, line fused.**
This build has no earth wire. Plug it in only through a 30 mA RCD/GFCI, and
keep the heating plate electrically isolated from the rack, the legs and the
thermocouple — the full list is in [documents/WIRING.md](documents/WIRING.md).
Never tie an earth terminal to neutral. Fuse the live feed at or below
the element rating. Keep mains wiring physically separated from the ESP32, the
thermocouple leads, and the I2C run — a thermocouple is a millivolt signal and
will pick up everything.

### The limits, in layers

| Layer | Limit | Independent of |
|---|---|---|
| PID setpoint | 49 °C (adjustable 30–60) | — |
| Software trip, latching | **70 °C** | the control loop |
| Thermal fuses on the plate | **~100 °C** | the ESP32 and the SSR entirely |

The 300 W pad is **not** assumed to limit its own temperature. If the listing
for yours states a self-limiting (PTC) surface temperature, that is one more
layer; the firmware does not rely on it. Left fully on with nothing stopping
it, 300 W will take a small chamber well past the point where acrylic softens,
which is why the thermal fuses are not optional.

### Temperatures that matter

- CA fumes usefully at **45–55 °C**. Default target is 49 °C.
- Hotter over-develops the print — white powdery frosting buries ridge detail.
- **Ethyl cyanoacrylate flash point is around 83 °C.** Staying well under it
  is the reason the software trip sits at 70 °C.
- Acrylic (PMMA) softens near 105 °C. Polycarbonate is fine; acrylic is not.
- Cyanide release needs roughly 200 °C+. Not reachable in this design.

---

## Wiring

Every connection, pin to pin, is in [documents/WIRING.md](documents/WIRING.md).
The short version:

| Signal | ESP32 pin |
|---|---|
| MAX6675 SCK / CS / SO | D18 / D5 / D19 |
| OLED SDA / SCL | D21 / D22 |
| SSR input + | D25, **plus 10 kΩ from D25 to GND** |
| Keypad INC / DEC / NEXT / STORE / SEL | D32 / D33 / D26 / D27 / D13 |
| Buzzer + | D4 |
| Fan relay IN | D23 |

The 10 kΩ pulldown on D25 is what makes the output fail safe: during reset
and while the ESP32 is unprogrammed or dead, that pin floats, and a floating SSR
input can latch the heater on.

Mount the thermocouple bead against the underside of the glue tray with a
metal clamp or high-temp tape — not loose in the air, and not in the glue.

---

## Keypad

### Setup screen

| Key | Action |
|---|---|
| INC | increase the selected field (hold to repeat) |
| DEC | decrease the selected field (hold to repeat) |
| NEXT | move the highlight between Target and Time |
| STORE | save Target and Time; they come back at every power-on |
| SEL, hold 1 s | start the cycle |

### While running

| Key | Action |
|---|---|
| SEL | stop now — heater off, back to setup |
| SEL in a fault | clear the latch, once the condition has gone |

Long-press to start is deliberate: a single tap should never be able to energise
a mains heater. Stopping takes only a tap.

### Sounds and fan

| Event | Buzzer |
|---|---|
| Power-on | two short beeps |
| Any key press | one click |
| Cycle complete | one long beep, 3 s |

The fan runs for the whole cycle (Preheat and Running) and after an
over-temperature trip. It is off on the setup screen.

---

## How a cycle runs

```
Idle ──hold SEL──> Preheat ──reaches target──> Running ──timer hits 0──> Complete ──> Idle
  ^                   |                           |                                    ^
  |                   └──────── SEL ──────────────┴────────────────────────────────────┘
  |
  └── Fault  (probe open, sensor invalid, or no heat rise in 15 min)
  └── SafetyTrip  (>= 70 C, latched, needs cooling below 55 C to clear)
```

**Preheat** runs the heater but does **not** count down. The dwell timer starts
when the tray first reaches target minus 1 °C. This is how fuming dwell is
normally measured — otherwise a cold chamber gets less dwell than a warm one,
and the same settings give different results.

Want the literal "countdown starts on the button press" behaviour instead? Set
`TIMER_STARTS_AFTER_PREHEAT = false` in the Config section of [src/main.cpp](src/main.cpp).

**Fault and SafetyTrip both latch.** They do not self-clear when the reading
comes good — someone has to press SEL. A fault that clears itself is a
fault nobody investigates.

---

## Control

Bang-bang was in the original spec and was replaced with **PID driving a
time-proportional output**, which is what industrial temperature controllers
actually do.

The PID produces a duty percentage. `HeaterOut` converts that percentage into
on and off time inside a repeating 1 second window — 15 % output means 150 ms on,
850 ms off. Holding 49 °C only needs about 15–25 % duty, so bang-bang would sit
there slamming a 300 W pad fully on and fully off and overshooting on every
swing.

Details worth knowing before you touch the gains:

- **Derivative on measurement**, so changing the target does not kick the output.
- **Conditional-integration anti-windup**: the integral stops accumulating while
  the output is saturated, which it is for the whole preheat.
- **The PID steps on thermocouple samples, not on loop iterations.** The MAX6675
  needs up to 220 ms per conversion, so it is polled at 250 ms. Buttons and the
  countdown still update every loop, which is why `Controller::update` takes a
  `freshSample` flag.
- **`TPO_MIN_DWELL_MS` collapses slivers.** A 20 ms pulse heats nothing and just
  makes the display flicker.

### Tuning it against your chamber

The gains in the Config section of `src/main.cpp` are estimates. The firmware logs a line per second over
serial at 115200:

```
t=142s state=1 temp=41.25 valid=1 target=49 duty=68.4 htr=1 fan=1 rem=1200s
```

Capture one full cold start, then look at two numbers:

1. **Time to reach target.** Expect 1–3 minutes for the tray.
2. **Peak overshoot past target before it settles.**

More than about 2 °C of overshoot: lower `PID_KP` or raise `PID_KD`.
Slow to close the last degree: raise `PID_KI`.
Hunting up and down around target: lower `PID_KI` first, then `PID_KP`.

`PID_KD` is kept small on purpose. The MAX6675 quantises to 0.25 °C, so a large
derivative gain mostly amplifies quantisation steps into output noise.

---

## Building

PlatformIO. Three environments:

```bash
pio run -e esp32dev -t upload     # real hardware
pio run -e sim                    # firmware for the Wokwi simulator
pio test -e native                # desktop unit tests, no hardware
```

`pio test -e native` compiles only `test/`, which includes `src/main.cpp` with
`CFC_NATIVE` defined. That strips everything below the controller, which is why
the top half of the file is kept free of `Arduino.h`.

PlatformIO's native platform invokes `gcc`/`g++` by name, so on Windows it needs
MinGW-w64 on PATH and will not fall back to MSVC. If you have Visual Studio but
no MinGW, run the same tests directly:

```powershell
$vc = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$u  = ".pio\libdeps\native\Unity\src"
cmd /c "`"$vc`" >nul && cl /nologo /EHsc /std:c++17 /DCFC_NATIVE=1 /Fe:tests.exe /I`"$u`" `"$u\unity.c`" test\test_controller\test_main.cpp"
.\tests.exe
```

Run `pio run -e sim` once first so Unity is downloaded into `.pio/libdeps/`.

### Layout

```
src/main.cpp              the whole firmware, one file, in this order:
  Config                  every tunable constant, pin map, limits
  TempSource              sensor interface
  Pid                     PID with anti-windup
  Controller              state machine, safety latches, timer
  -- #ifndef CFC_NATIVE: Arduino-dependent from here down --
  Button / Panel          5-key keypad: debounce, long-press, auto-repeat
  Buzzer                  self-timed beeps
  Fan                     relay output
  HeaterOut               time-proportional output
  SimSource / Max6675Source   thermal model or real SPI driver
  Ui                      SSD1306 screens
  setup / loop            wiring
test/test_controller/     Unity tests for every safety path
```

---

## Simulation

Wokwi has no MAX6675 part, so `env:sim` swaps the driver for a lumped thermal
model driven by the real heater output. The PID, the preheat handover, the
countdown, and both fault latches all run for real — only the physics is
synthetic.

Open the project folder in VS Code with the Wokwi extension installed, build
`env:sim`, then start the simulator. `wokwi.toml` already points at the sim
build output.

The potentiometer on GPIO34 injects faults:

| Knob | Effect |
|---|---|
| fully counter-clockwise | open thermocouple → Fault after 3 strikes |
| fully clockwise | temperature above the trip → SafetyTrip |
| anywhere in between | model runs normally |

Model constants are in the `SimSource` section of [src/main.cpp](src/main.cpp).
`P_HEAT_W` is 300 W to match the pad.

In the diagram the top relay stands in for the SSR and the bottom one switches
the fan. Wokwi's buzzer is a passive piezo and its relay triggers on HIGH, so
the sim build sets `BUZZER_TONE_HZ` and `FAN_RELAY_ACTIVE_HIGH` to suit; the
hardware build uses a plain on/off buzzer and a LOW-trigger relay.

---

## Known limitations

- **MAX6675 only detects an open thermocouple.** It cannot tell a short to
  ground or to VCC from a real reading. **MAX31855** is the drop-in successor
  and reports all three, plus it is faster and gives you the cold-junction
  temperature. On a mains heater those two extra fault modes are worth the
  upgrade, and the `TempSource` interface means only one class changes.
- **One sensor, on the tray.** The controller knows the tray temperature, not
  the chamber air temperature. Chamber walls take 10–25 minutes to warm, and
  cold walls make CA condense on the chamber instead of the evidence. If fuming
  results look weak, a second probe for air temperature and a soak stage is the
  next thing to add.
- **No humidity reading or control.** The materials list has no humidity
  sensor, so the display shows temperature only. CA fuming wants roughly 80 %
  RH; currently that is a dish of warm water and your judgement.
- **PID gains are estimates.** They were scaled for the 300 W pad on paper, not
  measured. Do the ramp-log tuning above before trusting a run.
- **No alarm sound on a fault.** The buzzer does key clicks, the boot beeps and
  the completion beep. Fault and over-temperature are shown on the display only.
