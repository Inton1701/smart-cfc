// Smart CFC -- Cyanoacrylate Fuming Chamber controller
// ESP32 + MAX6675 K-type + 220 V 300 W heating pad via SSR-40DA + 2.42" OLED
// + 5-key membrane keypad + buzzer + circulation fan on a relay module.
//
// Single-file firmware. The top half (config, PID, controller) is pure logic
// with no Arduino in it; the desktop unit tests include this file with
// CFC_NATIVE defined and compile only that half.

#include <stdint.h>

#ifndef CFC_NATIVE
#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoOTA.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <WiFiClientSecure.h>
#include <Adafruit_SSD1306.h>
#include <esp_task_wdt.h>
#endif

// ============================================================
// Config
//
// Heater: 220 V AC 300 W heating pad, switched by the SSR-40DA.
// Nothing in the pad is trusted to limit its own temperature: software trips
// at 70 C, and the thermal fuses on the plate are the backstop if the firmware
// or the SSR fails.
//
// MAINS IN THE CHAMBER. Three hardware items are not optional -- see README:
//   1. Thermal fuses bonded to the plate, in series with the AC line.
//      They work with the ESP32 dead.
//   2. SSR heatsinked for the real current drawn, not the 40 A on the label.
//   3. No earth in this build: RCD/GFCI on the supply, plate insulated from
//      the rack, legs and probe, line fused, ESP32 side isolated from mains.
// ============================================================

// ---------- Pin map: ESP32 DevKit, 30-pin ----------
// MAX6675 is a read-only SPI device: no MOSI line.
constexpr int PIN_TC_SCK   = 18;  // MAX6675 SCK  (VSPI)
constexpr int PIN_TC_MISO  = 19;  // MAX6675 SO
constexpr int PIN_TC_CS    = 5;   // MAX6675 CS   (strapping pin, idles HIGH: safe)

// 2.42" 128x64 panel. Its SSD1309 driver takes the SSD1306 command set.
constexpr int PIN_OLED_SDA = 21;
constexpr int PIN_OLED_SCL = 22;
constexpr uint8_t OLED_ADDR = 0x3C;

// SSR control input. Needs a 10k pulldown to GND: a dead or resetting ESP32
// must release the heater, not float the SSR input.
// For a 12 V DC element instead, this same pin drives a logic-level N-channel
// MOSFET gate -- an AC SSR cannot switch DC, it latches on.
constexpr int  PIN_HEATER = 25;
constexpr bool HEATER_ACTIVE_HIGH = true;

// 5-key membrane keypad: common line to GND, one GPIO per key, INPUT_PULLUP,
// active LOW.
// Matched to the real keypad tail by pressing each key (see "key press on
// GPIO" in the serial log); its line order differs from the key labels.
constexpr int PIN_KEY_INC   = 26;
constexpr int PIN_KEY_DEC   = 27;
constexpr int PIN_KEY_NEXT  = 32;
constexpr int PIN_KEY_BEFORE = 33;
constexpr int PIN_KEY_SEL   = 13;

constexpr int  PIN_BUZZER = 4;
constexpr bool BUZZER_ACTIVE_HIGH = true;

// Relay module switching the 40 mm circulation fan.
constexpr int PIN_FAN_RELAY = 23;

// ---------- Web page and over-the-air updates ----------
// The chamber runs its own Wi-Fi hotspot; the page is at http://192.168.4.1.
// AP_PASS is the hotspot's Wi-Fi password. Firmware updates need no login.
constexpr char AP_SSID[]  = "CFC-Chamber";
constexpr char AP_PASS[]  = "12345678";        // Wi-Fi needs 8+ characters
constexpr char OTA_HOST[] = "cfc-chamber";
constexpr uint32_t OTA_TRIAL_MS = 60000;      // new firmware must run cleanly this long
// Updates from the internet: the newest GitHub Release of this repository.
// Bump FW_VERSION and tag the release to match (1.0.1 -> tag v1.0.1).
constexpr char FW_VERSION[] = "1.0.1";
constexpr char GH_REPO[]    = "Inton1701/smart-cfc";

#if CFC_SIM
// Wokwi parts: passive piezo, relay module that triggers on HIGH.
constexpr uint16_t BUZZER_TONE_HZ        = 2700;
constexpr bool     FAN_RELAY_ACTIVE_HIGH = true;
#else
// 0 = active buzzer (own oscillator, plain on/off). A passive piezo needs a
// frequency here instead.
constexpr uint16_t BUZZER_TONE_HZ        = 0;
// Blue 1-channel 5 V boards usually trigger on LOW. Fan running when it should
// be idle means yours triggers on HIGH: flip this.
constexpr bool     FAN_RELAY_ACTIVE_HIGH = false;
#endif

constexpr int PIN_SIM_POT = 34;   // sim build only: fault-injection knob (ADC1)

// ---------- Process limits ----------
// CA fumes at roughly 45-55 C. Hotter over-develops the print (white frosting)
// and past ~83 C the glue is above its flash point.
constexpr float TARGET_MIN_C     = 30.0f;
constexpr float TARGET_MAX_C     = 60.0f;
constexpr float TARGET_DEFAULT_C = 49.0f;
constexpr float TARGET_STEP_C    = 1.0f;

constexpr uint16_t DURATION_MIN_MIN     = 1;
constexpr uint16_t DURATION_MAX_MIN     = 240;
constexpr uint16_t DURATION_DEFAULT_MIN = 20;
constexpr uint16_t DURATION_STEP_MIN    = 1;

// ---------- Safety ----------
constexpr float SAFETY_MAX_C   = 70.0f;  // software trip, any state, latching
constexpr float SAFETY_REARM_C = 55.0f;  // must cool past this before trip clears
constexpr uint8_t FAULT_STRIKES = 3;     // consecutive bad reads before fault latch

// Heater cannot reach target within this long -> fault. Catches a dead element,
// an unplugged heater, or a probe that fell off the tray.
constexpr uint32_t PREHEAT_TIMEOUT_MS = 15UL * 60UL * 1000UL;

// ---------- Control ----------
// Countdown starts after preheat reaches target. Set false for the literal
// spec behaviour (countdown begins the instant Set/Start is pressed).
constexpr bool TIMER_STARTS_AFTER_PREHEAT = true;

// PI-dominant. D stays small: MAX6675 quantises to 0.25 C, so a large Kd
// mostly amplifies quantisation steps. Starting estimates for the 300 W pad:
// retune after the first ramp log.
constexpr float PID_KP = 12.5f;   // percent per degC
constexpr float PID_KI = 0.04f;   // percent per degC per second
constexpr float PID_KD = 4.0f;    // percent-seconds per degC
constexpr float DUTY_MAX_PCT = 100.0f;

// Time-proportional output: PID commands a duty percent, this window converts
// it to on/off time. 1 s window suits a thermal load with minutes of lag.
constexpr uint32_t TPO_WINDOW_MS     = 1000;
constexpr uint32_t TPO_MIN_DWELL_MS  = 50;   // ignore slivers below this

constexpr float HYSTERESIS_C = 1.0f;  // preheat->running threshold: target - this

// ---------- Timing ----------
constexpr uint32_t TC_READ_INTERVAL_MS = 250;  // MAX6675 conversion takes up to 220 ms
constexpr uint32_t UI_REFRESH_MS       = 200;
constexpr uint32_t BTN_DEBOUNCE_MS     = 30;
constexpr uint32_t BTN_LONGPRESS_MS    = 1000; // hold SEL this long to begin
constexpr uint32_t BTN_REPEAT_DELAY_MS = 500;
constexpr uint32_t BTN_REPEAT_RATE_MS  = 120;
constexpr uint32_t COMPLETE_SCREEN_MS  = 5000;
constexpr uint32_t SAVED_FLASH_MS      = 1500; // "SAVED" on the setup screen after a SEL tap
constexpr uint32_t WDT_TIMEOUT_S       = 5;

// ---------- Buzzer ----------
constexpr uint32_t BEEP_KEY_MS  = 40;    // every key press
constexpr uint32_t BEEP_BOOT_MS = 120;   // power-on: two of these
constexpr uint32_t BEEP_DONE_MS = 3000;  // cycle complete: one long beep

// ============================================================
// Temperature source interface
// ============================================================

// One temperature sample. `valid` is false whenever the controller must not
// trust `celsius` -- open thermocouple, SPI garbage, or a stale sample.
struct TempReading {
    float celsius   = 0.0f;
    bool  valid     = false;
    bool  openCircuit = false;   // MAX6675 D2: probe disconnected
};

// Implemented twice: Max6675Source on hardware, SimSource under CFC_SIM.
class TempSource {
public:
    virtual ~TempSource() {}
    virtual void begin() = 0;
    // Called no faster than TC_READ_INTERVAL_MS. `heaterOn` is ignored by the
    // real driver; the sim model needs it to integrate the thermal response.
    virtual TempReading read(bool heaterOn) = 0;
};

// ============================================================
// PID
// ============================================================

// PID with derivative-on-measurement (no setpoint kick on a target change)
// and conditional-integration anti-windup (the integral stops accumulating
// while the output is saturated, so it cannot wind up during a long preheat).
class Pid {
public:
    Pid(float kp, float ki, float kd, float outMin, float outMax)
        : kp_(kp), ki_(ki), kd_(kd), outMin_(outMin), outMax_(outMax) {}

    void reset();
    // dtSec <= 0 returns the proportional term only; safe to call on the
    // first sample or after a stall.
    float update(float setpoint, float measured, float dtSec);

    float integral() const { return integral_; }

private:
    // Not const: a const member would delete copy-assignment, and the unit
    // tests reset state with `c = Controller()`.
    float kp_, ki_, kd_, outMin_, outMax_;
    float integral_  = 0.0f;
    float prevMeas_  = 0.0f;
    bool  hasPrev_   = false;
};

void Pid::reset() {
    integral_ = 0.0f;
    hasPrev_  = false;
}

float Pid::update(float setpoint, float measured, float dtSec) {
    const float error = setpoint - measured;

    float d = 0.0f;
    if (hasPrev_ && dtSec > 0.0f) {
        // Derivative on measurement, negated: brakes the approach.
        d = -kd_ * ((measured - prevMeas_) / dtSec);
    }
    prevMeas_ = measured;
    hasPrev_  = true;

    const float p = kp_ * error;

    // Trial output with the integral as it stands.
    float out = p + (ki_ * integral_) + d;

    // Only integrate if doing so would not push further into saturation.
    if (dtSec > 0.0f) {
        const bool pinnedHigh = (out >= outMax_) && (error > 0.0f);
        const bool pinnedLow  = (out <= outMin_) && (error < 0.0f);
        if (!pinnedHigh && !pinnedLow) {
            integral_ += error * dtSec;
            out = p + (ki_ * integral_) + d;
        }
    }

    if (out > outMax_) out = outMax_;
    if (out < outMin_) out = outMin_;
    return out;
}

// ============================================================
// Controller
// ============================================================

enum class State : uint8_t {
    Idle,       // setup screen, heater off
    Preheat,    // heating to target, dwell countdown not started
    Running,    // at temp, dwell counting down
    Complete,   // cycle finished normally
    Fault,      // sensor problem or preheat timeout, latched
    SafetyTrip  // over temperature, latched
};

enum class Field : uint8_t { Target, Duration, Fan };

enum class FaultCode : uint8_t { None, SensorOpen, SensorInvalid, PreheatTimeout };

// Edge-detected button events for one update tick. The caller does debouncing,
// long-press detection, and auto-repeat; the controller sees only intent.
struct ButtonEvents {
    bool incStep  = false;  // INC press or auto-repeat: raise the selected field
    bool decStep  = false;  // DEC press or auto-repeat: lower the selected field
    bool nextTap  = false;  // NEXT: switch between Target and Time
    bool prevTap  = false;  // BEFORE: switch back to the previous field
    bool selTap   = false;  // SEL short press: save settings (setup screen), stop a cycle, or clear a latched fault
    bool selHold  = false;  // SEL held past BTN_LONGPRESS_MS: start cycle (fires once)
};

// Pure logic: no Arduino, no I/O. Compiles and runs on the desktop under
// env:native so the safety paths are unit tested without hardware.
class Controller {
public:
    Controller() : pid_(PID_KP, PID_KI, PID_KD, 0.0f, DUTY_MAX_PCT) {}

    void begin(uint32_t nowMs);
    // Restore saved settings. A value outside its limits is ignored, so corrupt
    // storage can never put the target above TARGET_MAX_C.
    void setSettings(float targetC, uint16_t durationMin, bool fanOn = true);
    // Call every loop iteration so buttons and the countdown stay responsive.
    // freshSample must be true only when `reading` is a new MAX6675 conversion:
    // the PID steps on samples, not on loop iterations, or the derivative term
    // would see a huge dTemp/dt spike each time a sample finally lands.
    void update(uint32_t nowMs, const TempReading& reading, const ButtonEvents& ev,
                bool freshSample = true);

    State     state()      const { return state_; }
    FaultCode faultCode()  const { return fault_; }
    Field     field()      const { return field_; }
    float     targetC()    const { return targetC_; }
    uint16_t  durationMin() const { return durationMin_; }
    bool      fanEnabled()  const { return fanEnabled_; }

    float tempC()     const { return tempC_; }
    bool  tempValid() const { return tempValid_; }

    // 0..100, fed to the time-proportional output stage.
    float dutyPct() const { return duty_; }
    bool  heaterDemanded() const { return duty_ > 0.0f; }

    uint32_t remainingMs()      const { return remainingMs_; }
    uint32_t preheatElapsedMs() const { return preheatElapsedMs_; }
    // Temperature when the cycle started: the 0 % point of warm-up progress.
    float     preheatStartC()   const { return preheatStartC_; }

    const char* faultText() const;

private:
    void enterIdle();
    void enterFault(FaultCode code);
    void startCycle(uint32_t nowMs);
    void adjust(int direction);
    void runHeat(float dtSec);

    Pid   pid_;
    State state_ = State::Idle;
    Field field_ = Field::Target;
    FaultCode fault_ = FaultCode::None;

    float    targetC_     = TARGET_DEFAULT_C;
    uint16_t durationMin_ = DURATION_DEFAULT_MIN;
    bool     fanEnabled_  = true;   // optional fan: operator can switch it off

    float   tempC_     = 0.0f;
    bool    tempValid_ = false;
    uint8_t strikes_   = 0;
    float   duty_      = 0.0f;

    uint32_t lastMs_           = 0;
    bool     hasLastMs_        = false;
    uint32_t remainingMs_      = 0;
    uint32_t preheatElapsedMs_ = 0;
    float    preheatStartC_    = 0.0f;
    uint32_t completeElapsedMs_ = 0;
    uint32_t lastSampleMs_    = 0;
    bool     hasLastSample_   = false;
};

namespace {
template <typename T>
T clampT(T v, T lo, T hi) { return v < lo ? lo : (v > hi ? hi : v); }
}

void Controller::begin(uint32_t nowMs) {
    lastMs_    = nowMs;
    hasLastMs_ = true;
    enterIdle();
}

void Controller::setSettings(float targetC, uint16_t durationMin, bool fanOn) {
    fanEnabled_ = fanOn;
    // Tested as "inside the range" so that a NaN fails it too.
    if (targetC >= TARGET_MIN_C && targetC <= TARGET_MAX_C) targetC_ = targetC;
    if (durationMin >= DURATION_MIN_MIN && durationMin <= DURATION_MAX_MIN) {
        durationMin_ = durationMin;
    }
}

void Controller::enterIdle() {
    state_ = State::Idle;
    hasLastSample_ = false;
    fault_ = FaultCode::None;
    field_ = Field::Target;
    duty_  = 0.0f;
    remainingMs_       = 0;
    preheatElapsedMs_  = 0;
    completeElapsedMs_ = 0;
    pid_.reset();
}

void Controller::enterFault(FaultCode code) {
    state_ = State::Fault;
    fault_ = code;
    duty_  = 0.0f;
    pid_.reset();
}

void Controller::startCycle(uint32_t nowMs) {
    (void)nowMs;
    fault_ = FaultCode::None;
    remainingMs_       = static_cast<uint32_t>(durationMin_) * 60UL * 1000UL;
    preheatElapsedMs_  = 0;
    preheatStartC_     = tempC_;
    completeElapsedMs_ = 0;
    pid_.reset();
    hasLastSample_ = false;
    state_ = TIMER_STARTS_AFTER_PREHEAT ? State::Preheat : State::Running;
}

void Controller::adjust(int direction) {
    if (field_ == Field::Fan) {
        fanEnabled_ = !fanEnabled_;   // two states: INC and DEC both toggle
    } else if (field_ == Field::Target) {
        targetC_ = clampT(targetC_ + direction * TARGET_STEP_C,
                          TARGET_MIN_C, TARGET_MAX_C);
    } else {
        const int next = static_cast<int>(durationMin_) + direction * DURATION_STEP_MIN;
        durationMin_ = static_cast<uint16_t>(
            clampT(next, static_cast<int>(DURATION_MIN_MIN),
                         static_cast<int>(DURATION_MAX_MIN)));
    }
}

void Controller::runHeat(float dtSec) {
    duty_ = pid_.update(targetC_, tempC_, dtSec);
}

void Controller::update(uint32_t nowMs, const TempReading& reading,
                        const ButtonEvents& ev, bool freshSample) {
    const uint32_t dtMs = hasLastMs_ ? (nowMs - lastMs_) : 0;
    lastMs_    = nowMs;
    hasLastMs_ = true;

    // PID timebase: interval between conversions, not between loop iterations.
    float dtSec = 0.0f;
    if (freshSample) {
        if (hasLastSample_) dtSec = (nowMs - lastSampleMs_) / 1000.0f;
        lastSampleMs_   = nowMs;
        hasLastSample_  = true;
    }

    // ---- sensor validity, debounced by strike count ----
    if (freshSample && reading.valid) {
        strikes_   = 0;
        tempC_     = reading.celsius;
        tempValid_ = true;
    } else if (freshSample && strikes_ < 0xFF) {
        ++strikes_;
    }
    const bool sensorBad = (strikes_ >= FAULT_STRIKES);
    if (sensorBad) tempValid_ = false;

    // ---- latching safety: supersedes every state below ----
    // Over temperature first: it is the more dangerous of the two.
    if (tempValid_ && tempC_ >= SAFETY_MAX_C) {
        if (state_ != State::SafetyTrip) {
            state_ = State::SafetyTrip;
            duty_  = 0.0f;
            pid_.reset();
        }
    } else if (sensorBad && state_ != State::Fault && state_ != State::SafetyTrip) {
        // A sensor we cannot read means we cannot know the temperature, so the
        // heater must not run -- including from Idle, where it is already off.
        enterFault(reading.openCircuit ? FaultCode::SensorOpen
                                       : FaultCode::SensorInvalid);
    }

    switch (state_) {

    case State::Idle:
        duty_ = 0.0f;
        if (ev.decStep) adjust(-1);
        if (ev.incStep) adjust(+1);
        // NEXT / BEFORE step through Target -> Duration -> Fan and wrap.
        if (ev.nextTap) field_ = static_cast<Field>((static_cast<int>(field_) + 1) % 3);
        if (ev.prevTap) field_ = static_cast<Field>((static_cast<int>(field_) + 2) % 3);
        // Never start a cycle without a trustworthy reading.
        if (ev.selHold && tempValid_) startCycle(nowMs);
        break;

    // Stopping is deliberately easier than starting: a tap or a hold both do it.
    case State::Preheat:
        if (ev.selTap || ev.selHold) { enterIdle(); break; }
        preheatElapsedMs_ += dtMs;
        if (preheatElapsedMs_ >= PREHEAT_TIMEOUT_MS) {
            enterFault(FaultCode::PreheatTimeout);
            break;
        }
        if (freshSample) runHeat(dtSec);
        if (tempC_ >= (targetC_ - HYSTERESIS_C)) {
            state_ = State::Running;
        }
        break;

    case State::Running:
        if (ev.selTap || ev.selHold) { enterIdle(); break; }
        if (freshSample) runHeat(dtSec);
        if (dtMs >= remainingMs_) {
            remainingMs_       = 0;
            duty_              = 0.0f;
            completeElapsedMs_ = 0;
            state_             = State::Complete;
            pid_.reset();
        } else {
            remainingMs_ -= dtMs;
        }
        break;

    case State::Complete:
        duty_ = 0.0f;
        completeElapsedMs_ += dtMs;
        if (completeElapsedMs_ >= COMPLETE_SCREEN_MS ||
            ev.selTap || ev.selHold || ev.nextTap || ev.prevTap ||
            ev.incStep || ev.decStep) {
            enterIdle();
        }
        break;

    case State::Fault:
        duty_ = 0.0f;
        // Clears only once readings are good again, and only on an explicit press.
        if (ev.selTap && reading.valid && strikes_ == 0) enterIdle();
        break;

    case State::SafetyTrip:
        duty_ = 0.0f;
        // Must cool well below the trip point before it can be cleared, so a
        // reading hovering at the threshold cannot be reset straight back into
        // a runaway.
        if (ev.selTap && tempValid_ && tempC_ < SAFETY_REARM_C) enterIdle();
        break;
    }

    if (duty_ > DUTY_MAX_PCT) duty_ = DUTY_MAX_PCT;
    if (duty_ < 0.0f)         duty_ = 0.0f;
}

const char* Controller::faultText() const {
    switch (fault_) {
    case FaultCode::SensorOpen:     return "PROBE OPEN";
    case FaultCode::SensorInvalid:  return "SENSOR FAULT";
    case FaultCode::PreheatTimeout: return "NO HEAT RISE";
    default:                        return "";
    }
}

// Cycle progress for the display and web page. Preheat: warm-up from the
// starting temperature to where the countdown begins. Running: share of the
// fuming time done. Other states: 0.
int cycleProgressPct(const Controller& c) {
    if (c.state() == State::Preheat) {
        const float span = (c.targetC() - HYSTERESIS_C) - c.preheatStartC();
        const float p = span > 0.0f ? (c.tempC() - c.preheatStartC()) / span : 1.0f;
        return static_cast<int>(100.0f * (p < 0.0f ? 0.0f : (p > 1.0f ? 1.0f : p)));
    }
    if (c.state() == State::Running) {
        const uint32_t totalMs = static_cast<uint32_t>(c.durationMin()) * 60000UL;
        return static_cast<int>(100UL * (totalMs - c.remainingMs()) / totalMs);
    }
    return 0;
}

// Everything below needs Arduino. The desktop unit tests stop here.
#ifndef CFC_NATIVE

// ============================================================
// Buttons
// ============================================================

// One debounced key. Produces distinct events so SEL can mean "stop" on a tap
// and "begin cycle" on a hold.
class Button {
public:
    void begin(int pin);
    void poll(uint32_t nowMs);

    bool takePress(); // once per physical press: the key click
    bool takeStep();  // initial press, then auto-repeat while held
    bool takeTap();   // released before BTN_LONGPRESS_MS, and no hold fired
    bool takeHold();  // fires once, the moment BTN_LONGPRESS_MS is passed
    bool isDown() const { return down_; }

private:
    int      pin_ = -1;
    bool     down_ = false;
    bool     rawLast_ = false;
    uint32_t changedAt_ = 0;
    uint32_t pressedAt_ = 0;
    uint32_t repeatAt_  = 0;
    bool     holdFired_ = false;
    bool     evPress_ = false, evStep_ = false, evTap_ = false, evHold_ = false;
};

// The five-key membrane keypad, collapsed into the events the controller
// consumes.
class Panel {
public:
    void begin();
    ButtonEvents poll(uint32_t nowMs);
    bool takeClick();  // true once after any key goes down
private:
    Button inc_, dec_, next_, before_, sel_;
    bool   click_ = false;
};

void Button::begin(int pin) {
    pin_ = pin;
    pinMode(pin_, INPUT_PULLUP);
    rawLast_ = false;
    down_    = false;
}

void Button::poll(uint32_t nowMs) {
    const bool raw = (digitalRead(pin_) == LOW);  // active low

    if (raw != rawLast_) {
        rawLast_   = raw;
        changedAt_ = nowMs;
    }

    if (raw != down_ && (nowMs - changedAt_) >= BTN_DEBOUNCE_MS) {
        down_ = raw;
        if (down_) {
            pressedAt_ = nowMs;
            repeatAt_  = nowMs + BTN_REPEAT_DELAY_MS;
            holdFired_ = false;
            evPress_   = true;
            // Keypad tails have no printed pin order: this line is how a key
            // gets matched to its GPIO when wiring a new keypad.
            Serial.printf("key press on GPIO %d\n", pin_);
            evStep_    = true;             // fire on press, not release
        } else {
            if (!holdFired_ && (nowMs - pressedAt_) < BTN_LONGPRESS_MS) {
                evTap_ = true;
            }
        }
    }

    if (down_) {
        if (!holdFired_ && (nowMs - pressedAt_) >= BTN_LONGPRESS_MS) {
            holdFired_ = true;
            evHold_    = true;
        }
        if (nowMs >= repeatAt_) {
            repeatAt_ = nowMs + BTN_REPEAT_RATE_MS;
            evStep_   = true;
        }
    }
}

bool Button::takePress() { const bool v = evPress_; evPress_ = false; return v; }
bool Button::takeStep()  { const bool v = evStep_;  evStep_  = false; return v; }
bool Button::takeTap()   { const bool v = evTap_;   evTap_   = false; return v; }
bool Button::takeHold()  { const bool v = evHold_;  evHold_  = false; return v; }

void Panel::begin() {
    inc_.begin(PIN_KEY_INC);
    dec_.begin(PIN_KEY_DEC);
    next_.begin(PIN_KEY_NEXT);
    before_.begin(PIN_KEY_BEFORE);
    sel_.begin(PIN_KEY_SEL);
}

ButtonEvents Panel::poll(uint32_t nowMs) {
    Button* const keys[] = { &inc_, &dec_, &next_, &before_, &sel_ };
    for (Button* k : keys) {
        k->poll(nowMs);
        if (k->takePress()) click_ = true;
    }

    ButtonEvents ev;
    ev.incStep  = inc_.takeStep();
    ev.decStep  = dec_.takeStep();
    ev.nextTap  = next_.takeTap();
    ev.prevTap  = before_.takeTap();
    ev.selTap   = sel_.takeTap();
    ev.selHold  = sel_.takeHold();
    return ev;
}

bool Panel::takeClick() { const bool v = click_; click_ = false; return v; }

// ============================================================
// Buzzer
// ============================================================

// One-shot beeps that time themselves out, so nothing in loop() ever waits on
// a sound.
class Buzzer {
public:
    void begin();
    void beep(uint32_t nowMs, uint32_t durMs);
    void service(uint32_t nowMs);      // call every loop iteration
    void bootBeeps();                  // two beeps, blocking: setup() only

private:
    void write(bool on);

    bool     on_      = false;
    uint32_t startMs_ = 0;
    uint32_t durMs_   = 0;
};

void Buzzer::begin() {
    pinMode(PIN_BUZZER, OUTPUT);
    write(false);
}

void Buzzer::write(bool on) {
    if (BUZZER_TONE_HZ != 0) {
        if (on)       tone(PIN_BUZZER, BUZZER_TONE_HZ);
        else if (on_) noTone(PIN_BUZZER);   // never before a tone has started
    } else {
        digitalWrite(PIN_BUZZER, (on == BUZZER_ACTIVE_HIGH) ? HIGH : LOW);
    }
    on_ = on;
}

void Buzzer::beep(uint32_t nowMs, uint32_t durMs) {
    // A key click must not cut the long completion beep short.
    const uint32_t elapsed = nowMs - startMs_;
    if (on_ && elapsed < durMs_ && (durMs_ - elapsed) > durMs) return;
    startMs_ = nowMs;
    durMs_   = durMs;
    write(true);
}

void Buzzer::service(uint32_t nowMs) {
    if (on_ && (nowMs - startMs_) >= durMs_) write(false);
}

void Buzzer::bootBeeps() {
    for (int i = 0; i < 2; ++i) {
        write(true);
        delay(BEEP_BOOT_MS);
        write(false);
        delay(BEEP_BOOT_MS);
    }
}

// ============================================================
// Fan
// ============================================================

static bool fanOn = false;

static void fanSet(bool on) {
    fanOn = on;
    digitalWrite(PIN_FAN_RELAY, (on == FAN_RELAY_ACTIVE_HIGH) ? HIGH : LOW);
}

static void fanBegin() {
    // Level first, then direction, so the relay never sees a stray pulse.
    fanSet(false);
    // A LOW-trigger 5 V board reads a 3.3 V "high" as still partly on, so its
    // off state has to float instead: open drain.
    pinMode(PIN_FAN_RELAY, FAN_RELAY_ACTIVE_HIGH ? OUTPUT : OUTPUT_OPEN_DRAIN);
}

// ============================================================
// Heater output
// ============================================================

// Time-proportional output. The PID commands a duty percent; this converts it
// to on/off time inside a fixed window, which is how an industrial controller
// runs a resistive heater off a single switching device.
class HeaterOut {
public:
    void begin();
    void setDuty(float pct);           // 0..100
    void service(uint32_t nowMs);      // call every loop iteration
    void forceOff();                   // immediate, bypasses the window
    bool isOn() const { return on_; }
    float duty() const { return duty_; }

private:
    void write(bool on);

    float    duty_        = 0.0f;
    bool     on_          = false;
    uint32_t windowStart_ = 0;
    uint32_t onMs_        = 0;
    bool     started_     = false;
};

void HeaterOut::begin() {
    pinMode(PIN_HEATER, OUTPUT);
    write(false);
    duty_ = 0.0f;
}

void HeaterOut::write(bool on) {
    on_ = on;
    digitalWrite(PIN_HEATER, (on == HEATER_ACTIVE_HIGH) ? HIGH : LOW);
}

void HeaterOut::setDuty(float pct) {
    if (pct < 0.0f)   pct = 0.0f;
    if (pct > 100.0f) pct = 100.0f;
    duty_ = pct;
}

void HeaterOut::forceOff() {
    duty_ = 0.0f;
    onMs_ = 0;
    write(false);
}

void HeaterOut::service(uint32_t nowMs) {
    if (!started_) {
        windowStart_ = nowMs;
        started_     = true;
    }

    // New window: latch the on-time so a mid-window duty change cannot
    // stretch the current pulse.
    if ((nowMs - windowStart_) >= TPO_WINDOW_MS) {
        windowStart_ += TPO_WINDOW_MS;
        // Catch up if the loop stalled longer than one window.
        if ((nowMs - windowStart_) >= TPO_WINDOW_MS) windowStart_ = nowMs;

        onMs_ = static_cast<uint32_t>((duty_ / 100.0f) * TPO_WINDOW_MS);
        // Collapse slivers at both ends: a 20 ms pulse does nothing useful.
        if (onMs_ < TPO_MIN_DWELL_MS) onMs_ = 0;
        if ((TPO_WINDOW_MS - onMs_) < TPO_MIN_DWELL_MS) onMs_ = TPO_WINDOW_MS;
    }

    write((nowMs - windowStart_) < onMs_);
}

// ============================================================
// Temperature source
// ============================================================

#if CFC_SIM

// Wokwi has no MAX6675 part, so the sim build swaps in a lumped thermal model
// driven by the real heater output. That exercises the PID, the preheat
// transition, the countdown, and both fault latches with no hardware.
//
// The potentiometer on PIN_SIM_POT injects faults:
//   full CCW  -> open thermocouple
//   full CW   -> temperature above the safety trip
//   anywhere else -> model runs normally
class SimSource : public TempSource {
public:
    void begin() override;
    TempReading read(bool heaterOn) override;

    float modelTempC() const { return tempC_; }

private:
    float    tempC_    = 30.0f;   // starts at ambient
    uint32_t lastMs_   = 0;
    bool     hasLast_  = false;
};

namespace {
// Lumped model of tray + heating pad. Retune against a real ramp log.
constexpr float AMBIENT_C = 30.0f;   // Philippines indoor
constexpr float C_EFF_J_K = 300.0f;  // effective heat capacity, tray + plate
constexpr float P_HEAT_W  = 300.0f;  // heating pad at full duty
constexpr float LOSS_W_K  = 1.2f;    // conduction + convection to the chamber

constexpr int POT_OPEN_BELOW  = 200;
constexpr int POT_TRIP_ABOVE  = 3900;
}

void SimSource::begin() {
    pinMode(PIN_SIM_POT, INPUT);
    analogReadResolution(12);
    tempC_ = AMBIENT_C;
}

TempReading SimSource::read(bool heaterOn) {
    const uint32_t now = millis();
    const float dtSec = hasLast_ ? ((now - lastMs_) / 1000.0f) : 0.0f;
    lastMs_  = now;
    hasLast_ = true;

    // Integrate the thermal model regardless of the fault knob, so releasing
    // the knob returns a physically sensible temperature rather than a jump.
    if (dtSec > 0.0f) {
        const float pIn  = heaterOn ? P_HEAT_W : 0.0f;
        const float pOut = LOSS_W_K * (tempC_ - AMBIENT_C);
        tempC_ += ((pIn - pOut) / C_EFF_J_K) * dtSec;
        if (tempC_ < AMBIENT_C) tempC_ = AMBIENT_C;
    }

    const int pot = analogRead(PIN_SIM_POT);

    TempReading r;
    if (pot < POT_OPEN_BELOW) {
        r.valid = false;
        r.openCircuit = true;
        return r;
    }
    if (pot > POT_TRIP_ABOVE) {
        r.celsius = SAFETY_MAX_C + 5.0f;
        r.valid = true;
        return r;
    }

    // Match MAX6675 resolution: 0.25 C per LSB. Keeps PID tuning honest.
    r.celsius = static_cast<float>(static_cast<int>(tempC_ * 4.0f)) / 4.0f;
    r.valid = true;
    return r;
}

static SimSource tempSource;

#else

// MAX6675 K-type thermocouple amplifier, hardware SPI (read-only device).
//
// Frame is 16 bits, MSB first:
//   D15      dummy sign bit, always 0
//   D14..D3  temperature, 12 bits, 0.25 C per LSB, 0..1023.75 C
//   D2       thermocouple input open (1 = probe disconnected)
//   D1       device ID, always 0
//   D0       tri-state
//
// A frame of all-zeros or all-ones means the bus is dead (no chip, shorted
// MISO, bad wiring) -- treated as invalid, not as 0 C.
class Max6675Source : public TempSource {
public:
    void begin() override;
    TempReading read(bool heaterOn) override;

private:
    uint16_t readRaw();
};

namespace {
// MAX6675 tolerates up to 4.3 MHz. Mode 0, MSB first.
const SPISettings kTcSpi(4300000, MSBFIRST, SPI_MODE0);
}

void Max6675Source::begin() {
    pinMode(PIN_TC_CS, OUTPUT);
    digitalWrite(PIN_TC_CS, HIGH);
    // MOSI unused: pass -1 so the pin stays free.
    SPI.begin(PIN_TC_SCK, PIN_TC_MISO, -1, PIN_TC_CS);
}

uint16_t Max6675Source::readRaw() {
    SPI.beginTransaction(kTcSpi);
    digitalWrite(PIN_TC_CS, LOW);
    delayMicroseconds(1);            // CS low to first clock
    uint16_t raw = SPI.transfer16(0x0000);
    digitalWrite(PIN_TC_CS, HIGH);
    SPI.endTransaction();
    return raw;
}

TempReading Max6675Source::read(bool /*heaterOn*/) {
    TempReading r;
    const uint16_t raw = readRaw();

    // Dead bus: nothing driving MISO either way.
    if (raw == 0x0000 || raw == 0xFFFF) {
        r.valid = false;
        r.openCircuit = true;
        return r;
    }
    // D2 set means the probe is open.
    if (raw & 0x0004) {
        r.valid = false;
        r.openCircuit = true;
        return r;
    }
    // D15 must be 0 and D1 (device ID) must be 0 on a real MAX6675.
    if ((raw & 0x8002) != 0x0000) {
        r.valid = false;
        return r;
    }

    r.celsius = static_cast<float>((raw >> 3) & 0x0FFF) * 0.25f;
    r.valid = true;
    return r;
}

static Max6675Source tempSource;

#endif

// ============================================================
// Display
// ============================================================

// 128x64 OLED renderer. One screen per controller state, with small animated
// icons; the layout matches the "CFC OLED Screens" mock pixel for pixel.
// In text, '^' draws a degree sign (the 5x7 font has none in plain ASCII).
class Ui {
public:
    bool begin();                       // false if the panel does not answer on I2C
    // `saved` flashes a confirmation on the setup screen after a SEL tap.
    void render(const Controller& c, bool heaterOn, bool saved);
    void splash(float progress);        // power-on screen, 0..1 fills the bar

private:
    static constexpr uint16_t ON  = SSD1306_WHITE;
    static constexpr uint16_t OFF = SSD1306_BLACK;

    void drawSetup(const Controller& c, uint32_t f, bool saved);
    void drawHeating(const Controller& c, uint32_t f, bool heaterOn);
    void drawComplete(const Controller& c, uint32_t f);
    void drawFault(const Controller& c, uint32_t f);
    void drawTrip(const Controller& c, uint32_t f);

    int  text(int x, int y, const char* s, uint8_t size = 1, uint16_t color = ON);
    int  textWidth(const char* s, uint8_t size = 1) const;
    void centerText(int y, const char* s, uint16_t color = ON);
    void rightText(int y, const char* s);
    void rrect(int x, int y, int w, int h, uint16_t color = ON);
    void rfill(int x, int y, int w, int h, uint16_t color = ON);
    void bitmap(int x, int y, const char* const* rows, int n, uint16_t color = ON,
                int scale = 1, bool dim = false);
    void thermo(int x, int y, float level, uint16_t color = ON);
    void hourglass(int x, int y, int k, uint16_t color = ON);
    void fanIcon(int x, int y, int frame, bool enabled, uint16_t color = ON);
    void chevrons(int x, int y, uint32_t f);
    void chip(const char* label);
    void fingerprint(int x, int y);

    Adafruit_SSD1306 d_{128, 64, &Wire, -1};
    uint16_t fanRows_[4][12] = {};      // 4 rotation frames, built once in begin()
};

namespace {
void mmss(uint32_t ms, char* out, size_t n) {
    const uint32_t total = ms / 1000UL;
    snprintf(out, n, "%02lu:%02lu",
             static_cast<unsigned long>(total / 60UL),
             static_cast<unsigned long>(total % 60UL));
}

// Thermometer fill for a reading: empty at room temperature, full at the trip.
float thermoLevel(float t) {
    const float lvl = (t - 25.0f) / (SAFETY_MAX_C - 25.0f);
    return lvl < 0.0f ? 0.0f : (lvl > 1.0f ? 1.0f : lvl);
}

const char* const FLAME[2][12] = {{
    "....#.....", "...##.....", "...###....", "..####.#..", "..######..", ".########.",
    ".###..###.", "###....###", "##......##", "##..##..##", ".##.##.##.", "..######..",
}, {
    ".....#....", "....##....", "...####...", ".#.#####..", "..######..", ".########.",
    ".###..###.", "###....###", "##......##", "##.##...##", ".##.##.##.", "..######..",
}};
const char* const CHECK[9] = {
    "..........##", ".........###", "........###.", ".......###..", "......###...",
    "##...###....", "###.###.....", ".#####......", "..###.......",
};
const char* const WARN[12] = {
    "......#......", ".....###.....", ".....#.#.....", "....##.##....", "....#.#.#....",
    "...##.#.##...", "...#..#..#...", "..##..#..##..", "..#.......#..", ".##...#...##.",
    ".#.........#.", "#############",
};
}  // namespace

bool Ui::begin() {
    Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
    // Adafruit's begin() only fails on a memory error, never on a missing
    // panel, so ask the bus directly whether anything answers.
    Wire.beginTransmission(OLED_ADDR);
    if (Wire.endTransmission() != 0) return false;
    if (!d_.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) return false;

    // Fan blades: three curved blades and a rim, rotated 30 degrees per frame.
    const float third = 2.0f * PI / 3.0f;
    for (int k = 0; k < 4; ++k) {
        const float a = k * PI / 6.0f;
        for (int j = 0; j < 12; ++j) {
            uint16_t row = 0;
            for (int i = 0; i < 12; ++i) {
                const float x = i + 0.5f - 6.0f, y = j + 0.5f - 6.0f;
                const float d = sqrtf(x * x + y * y);
                float t = fmodf(atan2f(y, x) - a - d * 0.28f, third);
                if (t < 0) t += third;
                if (d < 1.6f || (d < 6.0f && t < 0.95f) || (d > 5.6f && d < 6.2f)) row |= 1u << i;
            }
            fanRows_[k][j] = row;
        }
    }
    d_.clearDisplay();
    d_.display();
    return true;
}

// ---------------- primitives ----------------

int Ui::text(int x, int y, const char* s, uint8_t size, uint16_t color) {
    for (; *s; ++s) {
        if (*s == '^') {   // degree sign: a 3x3 ring
            const int p[4][2] = {{1, 0}, {0, 1}, {2, 1}, {1, 2}};
            for (auto& q : p) d_.fillRect(x + q[0] * size, y + q[1] * size, size, size, color);
            x += 4 * size;
        } else {
            d_.drawChar(x, y, *s, color, color, size);   // bg == fg: transparent
            x += 6 * size;
        }
    }
    return x;
}

int Ui::textWidth(const char* s, uint8_t size) const {
    int w = 0;
    for (; *s; ++s) w += (*s == '^' ? 4 : 6) * size;
    return w - size;
}

void Ui::centerText(int y, const char* s, uint16_t color) { text((128 - textWidth(s)) / 2, y, s, 1, color); }
void Ui::rightText(int y, const char* s) { text(128 - textWidth(s), y, s); }

void Ui::rrect(int x, int y, int w, int h, uint16_t color) {
    d_.drawFastHLine(x + 1, y, w - 2, color);
    d_.drawFastHLine(x + 1, y + h - 1, w - 2, color);
    d_.drawFastVLine(x, y + 1, h - 2, color);
    d_.drawFastVLine(x + w - 1, y + 1, h - 2, color);
}

void Ui::rfill(int x, int y, int w, int h, uint16_t color) {
    d_.fillRect(x + 1, y, w - 2, h, color);
    d_.drawFastVLine(x, y + 1, h - 2, color);
    d_.drawFastVLine(x + w - 1, y + 1, h - 2, color);
}

void Ui::bitmap(int x, int y, const char* const* rows, int n, uint16_t color, int scale, bool dim) {
    for (int j = 0; j < n; ++j)
        for (int i = 0; rows[j][i]; ++i)
            if (rows[j][i] == '#' && !(dim && ((i + j) & 1)))
                d_.fillRect(x + i * scale, y + j * scale, scale, scale, color);
}

void Ui::thermo(int x, int y, float level, uint16_t c) {
    const uint16_t bg = (c == ON) ? OFF : ON;
    rrect(x + 1, y, 5, 10, c);
    d_.fillRect(x, y + 9, 7, 4, c);
    d_.drawPixel(x, y + 9, bg);      d_.drawPixel(x + 6, y + 9, bg);
    d_.drawPixel(x, y + 12, bg);     d_.drawPixel(x + 6, y + 12, bg);
    const int h = static_cast<int>(level * 7.0f + 0.5f);
    if (h > 0) d_.fillRect(x + 3, y + 9 - h, 1, h, c);
}

void Ui::hourglass(int x, int y, int k, uint16_t c) {
    d_.drawFastHLine(x, y, 9, c);
    d_.drawFastHLine(x, y + 11, 9, c);
    for (int j = 1; j <= 4; ++j) { d_.drawPixel(x + j, y + j, c); d_.drawPixel(x + 8 - j, y + j, c); }
    d_.drawPixel(x + 4, y + 5, c);
    d_.drawPixel(x + 4, y + 6, c);
    for (int j = 1; j <= 4; ++j) { d_.drawPixel(x + 4 - j, y + 6 + j, c); d_.drawPixel(x + 4 + j, y + 6 + j, c); }
    const int top = 3 - k, bot = k;
    for (int j = 0; j < top; ++j) {
        const int w = 5 - 2 * j > 0 ? 5 - 2 * j : 1;
        d_.drawFastHLine(x + 2 + j, y + 2 + j + (3 - top), w, c);
    }
    for (int j = 0; j < bot; ++j) d_.drawFastHLine(x + 4 - j, y + 10 - j, 2 * (j + 1) - 1, c);
    if (k < 3) d_.drawPixel(x + 4, y + 7 + (k % 2), c);   // falling grain
}

void Ui::fanIcon(int x, int y, int frame, bool enabled, uint16_t c) {
    for (int j = 0; j < 12; ++j)
        for (int i = 0; i < 12; ++i)
            if (fanRows_[frame & 3][j] & (1u << i)) d_.drawPixel(x + i, y + j, c);
    if (!enabled) {   // slash: background-colored edge so it reads over the blades
        const uint16_t bg = (c == ON) ? OFF : ON;
        for (int i = 0; i < 13; ++i) {
            d_.drawPixel(x - 1 + i, y + 12 - i, bg);
            d_.drawPixel(x + i, y + 12 - i, c);
        }
    }
}

void Ui::chevrons(int x, int y, uint32_t f) {
    for (int k = 0; k < 3; ++k) {
        if ((f + k) % 3 == 0) continue;
        const int yy = y + k * 5;
        for (int i = 0; i < 4; ++i) { d_.drawPixel(x + 3 - i, yy + i, ON); d_.drawPixel(x + 3 + i, yy + i, ON); }
    }
}

void Ui::chip(const char* label) {
    const int w = textWidth(label) + 6;
    rfill(128 - w, 0, w, 9);
    text(128 - w + 3, 1, label, 1, OFF);
}

void Ui::fingerprint(int x, int y) {
    // Loop pattern: ridges arch over a high core and run down the sides.
    for (int j = 0; j < 30; ++j)
        for (int i = 0; i < 26; ++i) {
            const float ex = (i - 12.5f) / 13.0f, ey = (j - 15.0f) / 15.0f;
            if (ex * ex + ey * ey > 1.0f) continue;
            const float dx = (i - 12.5f) / 0.78f, dy = j - 11.0f;
            const float d = dy < 0 ? sqrtf(dx * dx + dy * dy) : fabsf(dx) + dy * 0.18f;
            const int ring = static_cast<int>(floorf(d / 2.0f));
            if ((ring & 1) && sinf(i * 0.9f + j * 0.55f + ring) < 0.78f) d_.drawPixel(x + i, y + j, ON);
        }
}

// ---------------- screens ----------------

void Ui::splash(float progress) {
    d_.clearDisplay();
    fingerprint(4, 6);
    text(40, 4, "CFC", 3);
    text(40, 30, "cyanoacrylate");
    text(40, 40, "fuming chamber");
    rrect(0, 54, 128, 10);
    const int w = static_cast<int>((128 - 4) * (progress > 1.0f ? 1.0f : progress));
    if (w > 0) d_.fillRect(2, 56, w, 6, ON);
    d_.display();
}

void Ui::drawSetup(const Controller& c, uint32_t f, bool saved) {
    char buf[16];
    if (saved) { rfill(0, 0, textWidth("SAVED") + 6, 9); text(3, 1, "SAVED", 1, OFF); }
    else       text(0, 1, "SETUP");
    thermo(82, 0, thermoLevel(c.tempC()));
    if (c.tempValid()) snprintf(buf, sizeof(buf), "%.1f^C", c.tempC());
    else               snprintf(buf, sizeof(buf), "--.-^C");
    rightText(1, buf);
    d_.drawFastHLine(0, 13, 128, ON);

    // Three tiles, TEMP | TIME | FAN: icon on top, value below.
    for (int i = 0; i < 3; ++i) {
        const int x0 = i * 43, cx = x0 + 21;
        const bool sel = static_cast<int>(c.field()) == i;
        const uint16_t col = sel ? OFF : ON;
        if (sel) rfill(x0, 15, 42, 38); else rrect(x0, 15, 42, 38);
        if (i == 0) {
            thermo(cx - 3, 17, thermoLevel(c.targetC()), col);
            snprintf(buf, sizeof(buf), "%d", static_cast<int>(c.targetC()));
            const int w = textWidth(buf, 2) + 2 + textWidth("^C");
            const int x = text(cx - w / 2, 34, buf, 2, col);
            text(x, 41, "^C", 1, col);
        } else if (i == 1) {
            hourglass(cx - 4, 17, sel ? static_cast<int>((f / 2) % 4) : 0, col);
            snprintf(buf, sizeof(buf), "%u", static_cast<unsigned>(c.durationMin()));
            const int w = textWidth(buf, 2) + 2 + textWidth("m");
            const int x = text(cx - w / 2, 34, buf, 2, col);
            text(x, 41, "m", 1, col);
        } else {
            fanIcon(cx - 6, 17, (sel && c.fanEnabled()) ? static_cast<int>(f % 4) : 0, c.fanEnabled(), col);
            const char* v = c.fanEnabled() ? "ON" : "OFF";
            text(cx - textWidth(v, 2) / 2, 34, v, 2, col);
        }
    }
    text(0, 56, "SEL:save hold:start");
}

void Ui::drawHeating(const Controller& c, uint32_t f, bool heaterOn) {
    const bool pre = c.state() == State::Preheat;
    char buf[16];
    // Preheat: the mercury climbs on a loop to show warming; Running: real level.
    thermo(0, 1, pre ? (f % 8) / 8.0f * 0.6f + 0.3f : thermoLevel(c.tempC()));
    snprintf(buf, sizeof(buf), "%.1f", c.tempC());
    int x = text(10, 0, buf, 2);
    x = text(x + 1, 0, "^");
    text(x, 0, "C");
    thermo(11, 16, thermoLevel(c.targetC()));
    snprintf(buf, sizeof(buf), "set %d^C", static_cast<int>(c.targetC()));
    text(22, 19, buf);
    chip(pre ? "HEAT" : "RUN");
    // Flame flickers while the SSR is conducting, dims between pulses.
    bitmap(98, 13, FLAME[f % 2], 12, ON, 1, !heaterOn);
    fanIcon(114, 13, c.fanEnabled() ? static_cast<int>(f % 4) : 0, c.fanEnabled());

    if (pre) {
        chevrons(0, 31, f);
        mmss(c.preheatElapsedMs(), buf, sizeof(buf));
        x = text(12, 31, buf, 2);
        text(x + 3, 39, "warm");
    } else {
        hourglass(0, 32, static_cast<int>((f / 2) % 4));
        mmss(c.remainingMs(), buf, sizeof(buf));
        x = text(12, 31, buf, 2);
        text(x + 3, 39, "left");
    }
    const int pct = cycleProgressPct(c);
    rrect(0, 54, 98, 10);
    const int w = 94 * pct / 100;
    if (w > 0) d_.fillRect(2, 56, w, 6, ON);
    snprintf(buf, sizeof(buf), "%d%%", pct);
    rightText(55, buf);
}

void Ui::drawComplete(const Controller& c, uint32_t f) {
    char buf[20];
    bitmap(4, 14, CHECK, 9, ON, 3);
    text(48, 8, "DONE", 2);
    text(48, 28, "heater off");
    snprintf(buf, sizeof(buf), "%u min cycle", static_cast<unsigned>(c.durationMin()));
    text(48, 38, buf);
    const int sx = (f % 2) ? 42 : 2, sy = (f % 2) ? 10 : 44;   // sparkle hops
    d_.drawPixel(sx, sy, ON); d_.drawPixel(sx - 1, sy + 1, ON);
    d_.drawPixel(sx + 1, sy + 1, ON); d_.drawPixel(sx, sy + 2, ON);
    d_.drawFastHLine(0, 52, 128, ON);
    centerText(56, "any key: setup");
}

void Ui::drawFault(const Controller& c, uint32_t f) {
    if (f % 4 != 3) bitmap(2, 8, WARN, 12, ON, 3);   // blinks
    text(46, 6, "FAULT", 2);
    text(46, 26, c.faultText());
    text(46, 36, "heater off");
    rfill(0, 54, 128, 10);
    centerText(55, "SEL: clear", OFF);
}

void Ui::drawTrip(const Controller& c, uint32_t f) {
    char buf[24];
    thermo(6, 8, 1.0f);
    if (f % 2 == 0) {   // blinking up arrow
        for (int i = 0; i < 4; ++i) { d_.drawPixel(21 - i, 12 + i, ON); d_.drawPixel(21 + i, 12 + i, ON); }
        d_.drawFastVLine(21, 12, 9, ON);
    }
    snprintf(buf, sizeof(buf), "%.1f", c.tempC());
    int x = text(34, 4, buf, 2);
    x = text(x + 1, 4, "^");
    text(x, 4, "C");
    snprintf(buf, sizeof(buf), "OVERTEMP > %d^C", static_cast<int>(SAFETY_MAX_C));
    text(34, 24, buf);
    text(34, 34, "heater off");
    rfill(0, 54, 128, 10);
    snprintf(buf, sizeof(buf), "cool <%d^C, SEL", static_cast<int>(SAFETY_REARM_C));
    centerText(55, buf, OFF);
}

void Ui::render(const Controller& c, bool heaterOn, bool saved) {
    const uint32_t f = millis() / 250;   // icon animation frame, 4 per second
    d_.clearDisplay();
    switch (c.state()) {
    case State::Idle:       drawSetup(c, f, saved);                 break;
    case State::Preheat:
    case State::Running:    drawHeating(c, f, heaterOn);            break;
    case State::Complete:   drawComplete(c, f);                     break;
    case State::Fault:      drawFault(c, f);                        break;
    case State::SafetyTrip: drawTrip(c, f);                         break;
    }
    d_.display();
}

// ============================================================
// App
// ============================================================

static Controller  ctrl;
static Panel       panel;
static HeaterOut   heater;
static Buzzer      buzzer;
static Ui          ui;
static Preferences prefs;

static bool        uiOk = false;
static TempReading lastReading;
static uint32_t    lastTcMs = 0;
static uint32_t    lastUiMs = 0;
static uint32_t    lastLogMs = 0;
static State       lastState = State::Idle;
static bool        savedFlash = false;
static uint32_t    savedAtMs = 0;

static void startWatchdog() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    esp_task_wdt_config_t cfg = {};
    cfg.timeout_ms     = WDT_TIMEOUT_S * 1000;
    cfg.idle_core_mask = 0;
    cfg.trigger_panic  = true;
    esp_task_wdt_init(&cfg);
#else
    esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
    esp_task_wdt_add(nullptr);
}

// ---------------- update safety: trial boot and automatic rollback ----------------
// A fresh over-the-air firmware boots "on trial". The bootloader rolls back to
// the previous firmware if this one resets (crash, watchdog, power loss) before
// loop() approves it, which happens only after OTA_TRIAL_MS of clean running.
// Corrupt or truncated uploads never get this far: Update/ArduinoOTA verify
// the image checksum and refuse to switch partitions.
extern "C" bool verifyRollbackLater() { return true; }   // stop initArduino() approving at boot

static bool otaTrial = false;
static const char FW_BUILD[] = __DATE__ " " __TIME__;

static void checkTrialBoot() {
    esp_ota_img_states_t st;
    otaTrial = esp_ota_get_state_partition(esp_ota_get_running_partition(), &st) == ESP_OK &&
               st == ESP_OTA_IMG_PENDING_VERIFY;
    if (!otaTrial) return;
    Serial.println(F("New firmware on trial: approved after 60 s of clean running."));
    if (!uiOk) {   // the previous firmware drove this display; this one cannot
        Serial.println(F("Display not found on new firmware: rolling back."));
        esp_ota_mark_app_invalid_rollback_and_reboot();
    }
}
// ============================================================
// Web page and over-the-air updates (own hotspot, 192.168.4.1)
// ============================================================

static WebServer web(80);
static bool otaActive      = false;   // heater held off while new firmware is written
static bool webStopRequest = false;   // STOP pressed on the web page
static bool uploadRefused  = false;
static char ghMessage[64]  = "";      // last GitHub update result, shown on the page

static const char PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CFC Chamber</title>
<style>
:root{--bg:#f3f5f7;--card:#fff;--ink:#1a2028;--mute:#5d6976;--line:#d9dfe5;--accent:#1f6fd1;--hot:#c0392b;--ok:#2e7d32}
@media (prefers-color-scheme:dark){:root{--bg:#13161b;--card:#1c2027;--ink:#e6eaef;--mute:#8f99a6;--line:#2c323b;--accent:#6db3ff;--hot:#ff7b6b;--ok:#6fcf74}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:520px;margin:0 auto;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;display:grid;gap:10px}
h1{font-size:18px;margin:0}h2{font-size:15px;margin:0}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.chip{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:13px}
.chip.hot{border-color:var(--hot);color:var(--hot)}.chip.ok{border-color:var(--ok);color:var(--ok)}
.temp{font-size:44px;font-weight:600;font-variant-numeric:tabular-nums}
.mute{color:var(--mute);font-size:13px}
.bar{height:10px;border-radius:5px;background:var(--line);overflow:hidden}
.bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .4s}
label{display:grid;gap:4px;font-size:13px;color:var(--mute)}
input[type=number]{font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
button{font:inherit;padding:10px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.stop{background:var(--hot);border-color:var(--hot)}
button:disabled{opacity:.5;cursor:not-allowed}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
a{color:var(--accent)}
</style></head><body><main>
<div class="card">
  <div class="row"><h1>Fuming chamber</h1><span class="chip" id="state">-</span></div>
  <div class="row"><span class="temp" id="temp">--.-&deg;C</span><span class="mute" id="target"></span></div>
  <div class="row"><span id="phase" class="mute">Progress</span><span id="pct" class="mute">0%</span></div>
  <div class="bar"><i id="bar"></i></div>
  <div class="row mute"><span id="time"></span><span id="io"></span></div>
  <div class="mute" id="fault"></div>
  <button class="stop" id="stop" hidden>Stop cycle</button>
</div>
<form class="card" id="set">
  <h2>Settings</h2>
  <div class="grid2">
    <label for="t">Target (&deg;C, 30-60)<input id="t" type="number" min="30" max="60" step="1" required></label>
    <label for="m">Time (min, 1-240)<input id="m" type="number" min="1" max="240" step="1" required></label>
  </div>
  <label for="f" style="display:flex;gap:8px;align-items:center"><input id="f" type="checkbox"> Fan on during the cycle</label>
  <button id="save" type="submit">Save settings</button>
  <div class="mute" id="msg">Start a cycle by holding SEL on the chamber.</div>
</form>
<div class="card">
  <h2>Internet</h2>
  <div class="mute" id="net">-</div>
  <form id="wifi" class="grid2">
    <label for="ws">Wi-Fi name<input id="ws" type="text" maxlength="32" required style="font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)"></label>
    <label for="wp">Password<input id="wp" type="password" maxlength="63" style="font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)"></label>
    <button type="submit">Connect</button>
  </form>
</div>
<div class="card">
  <h2>Firmware</h2>
  <div class="mute">Version <span id="ver">-</span>, build <span id="fw"></span></div>
  <div class="grid2"><button id="chk" type="button">Check for update</button><button id="ins" type="button" hidden>Install</button></div>
  <div class="mute" id="ghmsg"></div>
  <div class="mute"><a href="/update">Upload a firmware file instead</a></div>
</div>
</main>
<script>
const $=id=>document.getElementById(id);
const mmss=s=>String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
let filled=false;
async function tick(){
  try{
    const s=await (await fetch('/status')).json();
    $('state').textContent=s.state;
    $('state').className='chip'+(s.state==='Fault'||s.state==='Overtemp'?' hot':s.state==='Running'||s.state==='Preheat'?' ok':'');
    $('temp').innerHTML=s.valid?s.temp.toFixed(1)+'&deg;C':'--.-&deg;C';
    $('target').innerHTML='set '+s.target+'&deg;C';
    $('phase').textContent=s.state==='Preheat'?'Warming up':'Fuming progress';
    $('pct').textContent=s.progress+'%';$('bar').style.width=s.progress+'%';
    $('time').textContent=s.state==='Running'?mmss(s.remaining)+' left':s.state==='Preheat'?'timer starts at temperature':'';
    $('io').textContent='heater '+(s.heater?'on':'off')+' · fan '+(s.fan?'on':'off');
    $('fault').textContent=s.fault?('Fault: '+s.fault):'';
    $('fw').textContent=s.fw+(s.trial?' (on trial)':'');
    const busy=s.state==='Preheat'||s.state==='Running';
    $('stop').hidden=!busy;
    const idle=s.state==='Idle';
    ['t','m','f','save'].forEach(k=>$(k).disabled=!idle);
    $('ver').textContent=s.ver;
    $('net').textContent=s.sta?('Online via '+s.ssid+' ('+s.ip+')'):'Not online. Enter a Wi-Fi network with internet below.';
    $('chk').disabled=!(idle&&s.sta);
    if(s.ghmsg)$('ghmsg').textContent=s.ghmsg;
    if(!idle){$('msg').textContent='Settings can be changed on the setup screen only.'}
    else if(!filled){$('t').value=s.target;$('m').value=s.minutes;$('f').checked=s.fan_enabled;filled=true;$('msg').textContent='Start a cycle by holding SEL on the chamber.'}
  }catch(e){$('state').textContent='No connection'}
}
$('set').addEventListener('submit',async e=>{
  e.preventDefault();
  const b=new URLSearchParams({target:$('t').value,minutes:$('m').value,fan:$('f').checked?'1':'0'});
  const r=await fetch('/settings',{method:'POST',body:b});
  $('msg').textContent=await r.text();
});
$('stop').addEventListener('click',async()=>{await fetch('/stop',{method:'POST'});tick()});
$('wifi').addEventListener('submit',async e=>{
  e.preventDefault();
  const r=await fetch('/wifi',{method:'POST',body:new URLSearchParams({ssid:$('ws').value,pass:$('wp').value})});
  $('net').textContent=await r.text();
});
$('chk').addEventListener('click',async()=>{
  $('ghmsg').textContent='Checking GitHub...';
  const r=await fetch('/gh/check');const t=await r.text();$('ghmsg').textContent=t;
  $('ins').hidden=!(r.ok&&t.startsWith('Version'));
});
$('ins').addEventListener('click',async()=>{
  $('ins').disabled=true;
  $('ghmsg').textContent=await (await fetch('/gh/install',{method:'POST'})).text();
});
tick();setInterval(tick,1000);
</script></body></html>)HTML";

static const char UPDATE_PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Firmware update</title>
<style>body{font:15px/1.5 system-ui,sans-serif;padding:16px;max-width:520px;margin:0 auto}
button{font:inherit;padding:10px 16px}</style></head><body>
<h1>Firmware update</h1>
<p>Choose the <b>firmware.bin</b> file built by PlatformIO (.pio/build/esp32dev/firmware.bin). The heater stays off while it installs, then the chamber restarts.</p>
<form method="POST" action="/update" enctype="multipart/form-data">
<input type="file" name="firmware" accept=".bin" required> <button type="submit">Install</button></form>
<p><a href="/">Back</a></p></body></html>)HTML";

static const char* stateName(State s) {
    switch (s) {
    case State::Idle:       return "Idle";
    case State::Preheat:    return "Preheat";
    case State::Running:    return "Running";
    case State::Complete:   return "Complete";
    case State::Fault:      return "Fault";
    case State::SafetyTrip: return "Overtemp";
    }
    return "?";
}

static void handleStatus() {
    char buf[560];
    const bool sta = WiFi.status() == WL_CONNECTED;
    const State st = ctrl.state();
    snprintf(buf, sizeof(buf),
             "{\"state\":\"%s\",\"temp\":%.2f,\"valid\":%s,\"target\":%d,\"minutes\":%u,"
             "\"fan_enabled\":%s,\"fan\":%s,\"heater\":%s,\"remaining\":%lu,\"progress\":%d,"
             "\"fault\":\"%s\",\"fw\":\"%s\",\"trial\":%s,\"heap\":%u,\"minheap\":%u,"
             "\"ver\":\"%s\",\"sta\":%s,\"ssid\":\"%s\",\"ip\":\"%s\",\"ghmsg\":\"%s\"}",
             stateName(st), ctrl.tempC(), ctrl.tempValid() ? "true" : "false",
             static_cast<int>(ctrl.targetC()), static_cast<unsigned>(ctrl.durationMin()),
             ctrl.fanEnabled() ? "true" : "false", fanOn ? "true" : "false",
             heater.isOn() ? "true" : "false",
             static_cast<unsigned long>(ctrl.remainingMs() / 1000UL),
             cycleProgressPct(ctrl),
             st == State::Fault ? ctrl.faultText() : (st == State::SafetyTrip ? "OVERTEMP" : ""),
             FW_BUILD, otaTrial ? "true" : "false",
             static_cast<unsigned>(ESP.getFreeHeap()), static_cast<unsigned>(ESP.getMinFreeHeap()),
             FW_VERSION, sta ? "true" : "false", sta ? WiFi.SSID().c_str() : "",
             sta ? WiFi.localIP().toString().c_str() : "", ghMessage);
    web.send(200, "application/json", buf);
}

static void handleSettings() {
    if (ctrl.state() != State::Idle) {
        web.send(409, "text/plain", "Settings can be changed on the setup screen only.");
        return;
    }
    const float t = web.arg("target").toFloat();
    const long  m = web.arg("minutes").toInt();
    if (t < TARGET_MIN_C || t > TARGET_MAX_C || m < DURATION_MIN_MIN || m > DURATION_MAX_MIN) {
        web.send(400, "text/plain", "Target must be 30-60 C and time 1-240 min.");
        return;
    }
    ctrl.setSettings(t, static_cast<uint16_t>(m), web.arg("fan") == "1");
    prefs.putFloat("target", ctrl.targetC());
    prefs.putUShort("mins", ctrl.durationMin());
    prefs.putBool("fan", ctrl.fanEnabled());
    savedFlash = true;
    savedAtMs  = millis();
    web.send(200, "text/plain", "Saved. Hold SEL on the chamber to start.");
}

// ---------------- internet: join a Wi-Fi network, update from GitHub ----------------
// The hotspot stays on (AP+STA), so the page is always reachable at 192.168.4.1.
// Updates come from the newest GitHub Release asset "firmware.bin" and go
// through the same trial boot and automatic rollback as the other paths.

static bool ghInstallRequest = false;
static char ghLatest[16]     = "";   // newest release tag seen by "Check for update"

// "v1.2.3" or "1.2.3" -> one comparable number; anything unparseable -> 0.
static uint32_t versionNumber(const char* v) {
    if (*v == 'v' || *v == 'V') ++v;
    unsigned a = 0, b = 0, c = 0;
    sscanf(v, "%u.%u.%u", &a, &b, &c);
    return a * 1000000u + b * 1000u + c;
}

static void handleWifi() {
    const String ssid = web.arg("ssid");
    const String pass = web.arg("pass");
    if (ssid.length() == 0 || ssid.length() > 32 || pass.length() > 63) {
        web.send(400, "text/plain", "Network name must be 1-32 characters, password up to 63.");
        return;
    }
    prefs.putString("wssid", ssid);
    prefs.putString("wpass", pass);
    WiFi.begin(ssid.c_str(), pass.c_str());
    web.send(200, "text/plain", "Saved. Connecting... the status line shows when it is online.");
}

static void handleGhCheck() {
    if (ctrl.state() != State::Idle) {
        web.send(409, "text/plain", "Updates are only checked from the setup screen.");
        return;
    }
    if (WiFi.status() != WL_CONNECTED) {
        web.send(409, "text/plain", "Not online. Join a Wi-Fi network with internet first.");
        return;
    }
    // TLS handshake and download block the loop for a few seconds; the heater
    // is off in Idle, so the watchdog can safely look away meanwhile.
    esp_task_wdt_delete(nullptr);
    WiFiClientSecure tls;
    tls.setInsecure();   // ponytail: no certificate pinning; firmware is still checksum-verified
    HTTPClient http;
    http.setUserAgent("cfc-chamber");
    http.setTimeout(10000);
    char url[96];
    snprintf(url, sizeof(url), "https://api.github.com/repos/%s/releases/latest", GH_REPO);
    int code = -1;
    if (http.begin(tls, url)) {
        code = http.GET();
        if (code == 200) {
            const String body = http.getString();
            const int i = body.indexOf("\"tag_name\":\"");
            ghLatest[0] = '\0';
            if (i >= 0) {
                const int s = i + 12, e = body.indexOf('"', s);
                if (e > s && e - s < static_cast<int>(sizeof(ghLatest)))
                    body.substring(s, e).toCharArray(ghLatest, sizeof(ghLatest));
            }
        }
        http.end();
    }
    esp_task_wdt_add(nullptr);

    if (code != 200 || ghLatest[0] == '\0') {
        snprintf(ghMessage, sizeof(ghMessage), code == 404 ? "No release on GitHub yet."
                                                            : "GitHub could not be reached (%d).", code);
        web.send(502, "text/plain", ghMessage);
        return;
    }
    const bool newer = versionNumber(ghLatest) > versionNumber(FW_VERSION);
    snprintf(ghMessage, sizeof(ghMessage), newer ? "Version %s is available." : "Up to date (%s).", ghLatest);
    web.send(200, "text/plain", ghMessage);
}

static void handleGhInstall() {
    if (ctrl.state() != State::Idle || WiFi.status() != WL_CONNECTED) {
        web.send(409, "text/plain", "Install only from the setup screen while online.");
        return;
    }
    ghInstallRequest = true;   // done in loop(), after this reply has been sent
    web.send(200, "text/plain", "Downloading. The chamber restarts when it is done.");
}

// Blocking download + install. Progress shows on the OLED splash bar.
static void runGhInstall() {
    otaActive = true;
    heater.forceOff();
    fanSet(false);
    esp_task_wdt_delete(nullptr);
    WiFiClientSecure tls;
    tls.setInsecure();
    httpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);   // GitHub redirects to its file host
    httpUpdate.rebootOnUpdate(false);
    httpUpdate.onProgress([](int done, int total) {
        static int lastPct = -1;
        const int pct = total > 0 ? static_cast<int>(100LL * done / total) : 0;
        if (uiOk && pct / 5 != lastPct / 5) { ui.splash(pct / 100.0f); lastPct = pct; }   // ~20 redraws
    });
    char url[112];
    snprintf(url, sizeof(url), "https://github.com/%s/releases/latest/download/firmware.bin", GH_REPO);
    const t_httpUpdate_return r = httpUpdate.update(tls, url);
    if (r == HTTP_UPDATE_OK) {
        Serial.println(F("GitHub update installed, restarting on trial."));
        delay(300);
        ESP.restart();
    }
    snprintf(ghMessage, sizeof(ghMessage), "Update failed: %s", httpUpdate.getLastErrorString().c_str());
    Serial.println(ghMessage);
    esp_task_wdt_add(nullptr);
    otaActive = false;
}


static void startNetwork() {
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(AP_SSID, AP_PASS);
    const String ssid = prefs.getString("wssid", "");
    if (ssid.length()) WiFi.begin(ssid.c_str(), prefs.getString("wpass", "").c_str());
    Serial.printf("Wi-Fi hotspot \"%s\" at http://%s\n", AP_SSID, WiFi.softAPIP().toString().c_str());

    web.on("/", HTTP_GET, [] { web.send_P(200, "text/html", PAGE); });
    web.on("/status", HTTP_GET, handleStatus);
    web.on("/settings", HTTP_POST, handleSettings);
    web.on("/wifi", HTTP_POST, handleWifi);
    web.on("/gh/check", HTTP_GET, handleGhCheck);
    web.on("/gh/install", HTTP_POST, handleGhInstall);
    web.on("/stop", HTTP_POST, [] { webStopRequest = true; web.send(200, "text/plain", "Stopping"); });

    // Browser upload: refused mid-cycle, heater forced off while it installs.
    web.on("/update", HTTP_GET, [] {
        web.send_P(200, "text/html", UPDATE_PAGE);
    });
    web.on("/update", HTTP_POST, [] {
        if (uploadRefused) {
            uploadRefused = false;
            web.send(409, "text/plain", "Stop the cycle first, then upload again.");
            return;
        }
        const bool ok = !Update.hasError();
        web.send(200, "text/plain", ok ? "Update installed. Restarting..."
                                       : "Update failed. The old firmware is still installed.");
        if (ok) { delay(500); ESP.restart(); }
        otaActive = false;
    }, [] {
        HTTPUpload& up = web.upload();
        esp_task_wdt_reset();
        if (up.status == UPLOAD_FILE_START) {
            uploadRefused = false;
            const State st = ctrl.state();
            if (st == State::Preheat || st == State::Running) { uploadRefused = true; return; }
            otaActive = true;
            heater.forceOff();
            Update.begin(UPDATE_SIZE_UNKNOWN);
        } else if (up.status == UPLOAD_FILE_WRITE) {
            if (Update.isRunning()) Update.write(up.buf, up.currentSize);
        } else if (up.status == UPLOAD_FILE_END) {
            if (Update.isRunning()) Update.end(true);
        } else if (up.status == UPLOAD_FILE_ABORTED) {
            Update.abort();
            otaActive = false;
        }
    });
    web.begin();

    // Wireless upload from PlatformIO (env:esp32dev_ota).
    ArduinoOTA.setHostname(OTA_HOST);
    ArduinoOTA.onStart([] { otaActive = true; heater.forceOff(); fanSet(false); });
    ArduinoOTA.onProgress([](unsigned int, unsigned int) { esp_task_wdt_reset(); });
    ArduinoOTA.onError([](ota_error_t) { otaActive = false; });
    ArduinoOTA.begin();
}


void setup() {
    // Heater first, before anything can fail: the SSR must be released before
    // the display, the sensor, or the watchdog get a chance to throw.
    heater.begin();
    heater.forceOff();
    fanBegin();
    buzzer.begin();

    Serial.begin(115200);
    delay(50);
    Serial.println();
    Serial.println(F("Smart CFC boot"));

    // Power-on settings are whatever a SEL tap last saved.
    prefs.begin("cfc", false);
    ctrl.setSettings(prefs.getFloat("target", TARGET_DEFAULT_C),
                     prefs.getUShort("mins", DURATION_DEFAULT_MIN),
                     prefs.getBool("fan", true));
    Serial.printf("target %.0fC  time %umin  trip %.0fC\n",
                  ctrl.targetC(), static_cast<unsigned>(ctrl.durationMin()),
                  SAFETY_MAX_C);

    uiOk = ui.begin();
    if (!uiOk) {
        // No display means a blind operator on a mains heater. Refuse to heat.
        Serial.println(F("FATAL: OLED not responding on I2C. Heater locked out."));
    } else {
        ui.splash(0.0f);
    }
    buzzer.bootBeeps();
    // Let the splash bar fill (about 1 s) so the screen can be read.
    if (uiOk) for (int i = 1; i <= 8; ++i) { ui.splash(i / 8.0f); delay(120); }
    checkTrialBoot();
    Serial.printf("firmware build %s\n", FW_BUILD);
    startNetwork();

    tempSource.begin();
    panel.begin();
    ctrl.begin(millis());
    startWatchdog();
    lastTcMs = millis();
}

void loop() {
    esp_task_wdt_reset();
    const uint32_t now = millis();

    ArduinoOTA.handle();
    web.handleClient();
    if (otaTrial && now >= OTA_TRIAL_MS) {
        esp_ota_mark_app_valid_cancel_rollback();
        otaTrial = false;
        Serial.println(F("New firmware approved."));
    }

    ButtonEvents ev = panel.poll(now);
    if (ghInstallRequest) {   // only ever accepted from Idle
        ghInstallRequest = false;
        if (ctrl.state() == State::Idle) runGhInstall();
    }
    // STOP on the web page acts like a SEL tap, but only on a running cycle.
    if (webStopRequest) {
        webStopRequest = false;
        if (ctrl.state() == State::Preheat || ctrl.state() == State::Running) ev.selTap = true;
    }
    if (panel.takeClick()) buzzer.beep(now, BEEP_KEY_MS);

    // SEL tap on the setup screen saves; a hold starts the cycle instead.
    // Checked before update(), so a tap that clears a fault never saves.
    if (ev.selTap && ctrl.state() == State::Idle) {
        prefs.putFloat("target", ctrl.targetC());
        prefs.putUShort("mins", ctrl.durationMin());
        prefs.putBool("fan", ctrl.fanEnabled());
        savedFlash = true;
        savedAtMs  = now;
    }

    // MAX6675 needs up to 220 ms per conversion: never poll it faster.
    bool fresh = false;
    if ((now - lastTcMs) >= TC_READ_INTERVAL_MS) {
        lastTcMs    = now;
        lastReading = tempSource.read(heater.isOn());
        fresh       = true;
    }

    ctrl.update(now, lastReading, ev, fresh);

    // Heater is commanded only from the two heating states, and only with a
    // working display. Every other path is an explicit off.
    const State st = ctrl.state();
    const bool heating = (st == State::Preheat || st == State::Running);
    if (uiOk && heating && !otaActive) {
        heater.setDuty(ctrl.dutyPct());
    } else {
        heater.forceOff();
    }
    heater.service(now);

    // Fan stirs the chamber for the whole cycle, and keeps moving air across
    // the plate after an over-temperature trip.
    fanSet(ctrl.fanEnabled() && (heating || st == State::SafetyTrip));

    if (st == State::Complete && lastState != State::Complete) {
        buzzer.beep(now, BEEP_DONE_MS);
    }
    lastState = st;
    buzzer.service(now);

    if (savedFlash && (now - savedAtMs) >= SAVED_FLASH_MS) savedFlash = false;

    if (uiOk && (now - lastUiMs) >= UI_REFRESH_MS) {
        lastUiMs = now;
        ui.render(ctrl, heater.isOn(), savedFlash);
    }

    // Ramp log: this is how you get your chamber's real warm-up curve and
    // retune PID_KP/KI/KD against it instead of my estimates.
    if ((now - lastLogMs) >= 1000) {
        lastLogMs = now;
        Serial.printf("t=%lus state=%d temp=%.2f valid=%d target=%.0f duty=%.1f htr=%d fan=%d rem=%lus heap=%u minheap=%u\n",
                      static_cast<unsigned long>(now / 1000),
                      static_cast<int>(st),
                      ctrl.tempC(), ctrl.tempValid() ? 1 : 0,
                      ctrl.targetC(), ctrl.dutyPct(), heater.isOn() ? 1 : 0,
                      fanOn ? 1 : 0,
                      static_cast<unsigned long>(ctrl.remainingMs() / 1000),
                      // Free heap now and its lowest point since boot: a steady
                      // minheap over hours means no leak.
                      static_cast<unsigned>(ESP.getFreeHeap()),
                      static_cast<unsigned>(ESP.getMinFreeHeap()));
    }
}

#endif  // !CFC_NATIVE
