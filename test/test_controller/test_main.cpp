// Desktop unit tests for the control logic and every safety path.
// Runs with: pio test -e native
#include <math.h>
#include <unity.h>
// Single-file firmware: CFC_NATIVE strips everything that needs Arduino.
#include "../../src/main.cpp"

static Controller c;
static uint32_t   nowMs;

static TempReading good(float t) {
    TempReading r; r.celsius = t; r.valid = true; return r;
}
static TempReading openProbe() {
    TempReading r; r.valid = false; r.openCircuit = true; return r;
}

// One controller tick with a fresh sample.
static void tick(const TempReading& r, uint32_t dtMs, ButtonEvents ev = ButtonEvents{}) {
    nowMs += dtMs;
    c.update(nowMs, r, ev, true);
}
static void tickT(float tempC, uint32_t dtMs, ButtonEvents ev = ButtonEvents{}) {
    tick(good(tempC), dtMs, ev);
}

void setUp() {
    c = Controller();
    nowMs = 10000;
    c.begin(nowMs);
}
void tearDown() {}

// ---- setup screen ----

static void test_starts_idle_with_defaults() {
    TEST_ASSERT_EQUAL(static_cast<int>(State::Idle), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL_FLOAT(TARGET_DEFAULT_C, c.targetC());
    TEST_ASSERT_EQUAL_UINT16(DURATION_DEFAULT_MIN, c.durationMin());
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());
}

static void test_next_cycles_field_and_inc_dec_adjust_it() {
    ButtonEvents up;   up.incStep  = true;
    ButtonEvents tap;  tap.nextTap = true;

    tickT(30.0f, 250, up);
    TEST_ASSERT_EQUAL_FLOAT(TARGET_DEFAULT_C + TARGET_STEP_C, c.targetC());

    tickT(30.0f, 250, tap);
    TEST_ASSERT_EQUAL(static_cast<int>(Field::Duration), static_cast<int>(c.field()));

    tickT(30.0f, 250, up);
    TEST_ASSERT_EQUAL_UINT16(DURATION_DEFAULT_MIN + DURATION_STEP_MIN, c.durationMin());
    // Target must not have moved while Duration was selected.
    TEST_ASSERT_EQUAL_FLOAT(TARGET_DEFAULT_C + TARGET_STEP_C, c.targetC());

    // BEFORE goes back to the previous field.
    ButtonEvents back; back.prevTap = true;
    tickT(30.0f, 250, back);
    TEST_ASSERT_EQUAL(static_cast<int>(Field::Target), static_cast<int>(c.field()));

    // BEFORE from Target wraps to Fan; INC toggles the fan, DEC toggles it back.
    tickT(30.0f, 250, back);
    TEST_ASSERT_EQUAL(static_cast<int>(Field::Fan), static_cast<int>(c.field()));
    TEST_ASSERT_TRUE(c.fanEnabled());
    tickT(30.0f, 250, up);
    TEST_ASSERT_FALSE(c.fanEnabled());
    ButtonEvents down; down.decStep = true;
    tickT(30.0f, 250, down);
    TEST_ASSERT_TRUE(c.fanEnabled());
    // NEXT from Fan wraps to Target.
    tickT(30.0f, 250, tap);
    TEST_ASSERT_EQUAL(static_cast<int>(Field::Target), static_cast<int>(c.field()));
}

static void test_adjust_clamps_at_limits() {
    ButtonEvents down; down.decStep = true;
    for (int i = 0; i < 100; ++i) tickT(30.0f, 10, down);
    TEST_ASSERT_EQUAL_FLOAT(TARGET_MIN_C, c.targetC());

    ButtonEvents up; up.incStep = true;
    for (int i = 0; i < 200; ++i) tickT(30.0f, 10, up);
    TEST_ASSERT_EQUAL_FLOAT(TARGET_MAX_C, c.targetC());
}

static void test_saved_settings_are_restored_only_when_in_range() {
    c.setSettings(55.0f, 45);
    TEST_ASSERT_EQUAL_FLOAT(55.0f, c.targetC());
    TEST_ASSERT_EQUAL_UINT16(45, c.durationMin());

    // Corrupt storage must never move a setting outside its limits.
    c.setSettings(TARGET_MAX_C + 40.0f, 0);
    TEST_ASSERT_EQUAL_FLOAT(55.0f, c.targetC());
    TEST_ASSERT_EQUAL_UINT16(45, c.durationMin());

    c.setSettings(NAN, DURATION_MAX_MIN + 1);
    TEST_ASSERT_EQUAL_FLOAT(55.0f, c.targetC());
    TEST_ASSERT_EQUAL_UINT16(45, c.durationMin());
}

// ---- starting a cycle ----

static void test_sel_tap_alone_never_starts_a_cycle() {
    ButtonEvents sel;  sel.selTap = true;
    tickT(30.0f, 250, sel);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Idle), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());
}

static void test_hold_starts_cycle() {
    ButtonEvents hold; hold.selHold = true;
    tickT(30.0f, 250, hold);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Preheat), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL_UINT32(DURATION_DEFAULT_MIN * 60UL * 1000UL, c.remainingMs());
}

static void test_hold_refused_without_a_valid_reading() {
    ButtonEvents hold; hold.selHold = true;
    // Three bad reads latch a fault; a hold must not start anything.
    for (int i = 0; i < FAULT_STRIKES; ++i) tick(openProbe(), 250);
    tick(openProbe(), 250, hold);
    TEST_ASSERT_NOT_EQUAL(static_cast<int>(State::Preheat), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());
}

static void test_preheat_heats_then_hands_over_to_running() {
    ButtonEvents hold; hold.selHold = true;
    tickT(30.0f, 250, hold);

    tickT(32.0f, 250);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Preheat), static_cast<int>(c.state()));
    TEST_ASSERT_TRUE(c.dutyPct() > 0.0f);            // heater demanded while cold
    TEST_ASSERT_EQUAL_UINT32(DURATION_DEFAULT_MIN * 60UL * 1000UL, c.remainingMs());

    // Reaching target minus hysteresis starts the dwell.
    tickT(TARGET_DEFAULT_C - HYSTERESIS_C, 250);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Running), static_cast<int>(c.state()));
}

static void test_countdown_runs_out_and_turns_the_heater_off() {
    ButtonEvents hold; hold.selHold = true;
    tickT(30.0f, 250, hold);
    tickT(TARGET_DEFAULT_C, 250);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Running), static_cast<int>(c.state()));

    // Exactly the cycle length: one tick more and the Complete screen's
    // 5 s auto-return would already have taken us back to Idle.
    for (int i = 0; i < DURATION_DEFAULT_MIN; ++i) tickT(TARGET_DEFAULT_C, 60000);

    TEST_ASSERT_EQUAL(static_cast<int>(State::Complete), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL_UINT32(0, c.remainingMs());
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());
}

static void test_complete_screen_returns_to_idle() {
    ButtonEvents hold; hold.selHold = true;
    tickT(30.0f, 250, hold);
    tickT(TARGET_DEFAULT_C, 250);
    // Exactly the cycle length: one tick more and the Complete screen's
    // 5 s auto-return would already have taken us back to Idle.
    for (int i = 0; i < DURATION_DEFAULT_MIN; ++i) tickT(TARGET_DEFAULT_C, 60000);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Complete), static_cast<int>(c.state()));

    tickT(TARGET_DEFAULT_C, COMPLETE_SCREEN_MS + 100);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Idle), static_cast<int>(c.state()));
}

// ---- stop ----

static void test_sel_stops_from_preheat_and_running() {
    ButtonEvents hold; hold.selHold = true;
    ButtonEvents sel;  sel.selTap = true;

    tickT(30.0f, 250, hold);
    tickT(30.0f, 250, sel);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Idle), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());

    tickT(30.0f, 250, hold);
    tickT(TARGET_DEFAULT_C, 250);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Running), static_cast<int>(c.state()));
    tickT(TARGET_DEFAULT_C, 250, sel);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Idle), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());
    TEST_ASSERT_EQUAL_UINT32(0, c.remainingMs());

    // A hold stops too: stopping must never be harder than starting.
    tickT(30.0f, 250, hold);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Preheat), static_cast<int>(c.state()));
    tickT(30.0f, 250, hold);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Idle), static_cast<int>(c.state()));
}

// ---- safety ----

static void test_overtemp_latches_and_will_not_clear_while_hot() {
    ButtonEvents hold; hold.selHold = true;
    ButtonEvents sel;  sel.selTap = true;

    tickT(30.0f, 250, hold);
    tickT(SAFETY_MAX_C + 2.0f, 250);
    TEST_ASSERT_EQUAL(static_cast<int>(State::SafetyTrip), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());

    // Still above the rearm threshold: SEL must not release it.
    tickT(SAFETY_REARM_C + 5.0f, 250, sel);
    TEST_ASSERT_EQUAL(static_cast<int>(State::SafetyTrip), static_cast<int>(c.state()));

    tickT(SAFETY_REARM_C - 1.0f, 250, sel);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Idle), static_cast<int>(c.state()));
}

static void test_overtemp_trips_even_from_idle() {
    tickT(SAFETY_MAX_C + 1.0f, 250);
    TEST_ASSERT_EQUAL(static_cast<int>(State::SafetyTrip), static_cast<int>(c.state()));
}

static void test_overtemp_outranks_a_sensor_fault() {
    tickT(SAFETY_MAX_C + 1.0f, 250);
    for (int i = 0; i < FAULT_STRIKES + 2; ++i) tick(openProbe(), 250);
    // The latch must stay on the more dangerous condition.
    TEST_ASSERT_EQUAL(static_cast<int>(State::SafetyTrip), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());
}

static void test_sensor_fault_stops_heater_and_timer() {
    ButtonEvents hold; hold.selHold = true;
    tickT(30.0f, 250, hold);
    tickT(TARGET_DEFAULT_C, 250);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Running), static_cast<int>(c.state()));
    const uint32_t remaining = c.remainingMs();

    // A single bad read must not trip: noise happens.
    tick(openProbe(), 250);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Running), static_cast<int>(c.state()));

    for (int i = 1; i < FAULT_STRIKES; ++i) tick(openProbe(), 250);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Fault), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL(static_cast<int>(FaultCode::SensorOpen), static_cast<int>(c.faultCode()));
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());
    TEST_ASSERT_FALSE(c.tempValid());

    // Timer frozen: further ticks in Fault must not burn cycle time.
    const uint32_t frozen = c.remainingMs();
    tick(openProbe(), 60000);
    TEST_ASSERT_EQUAL_UINT32(frozen, c.remainingMs());
    TEST_ASSERT_TRUE(frozen <= remaining);
}

static void test_sensor_fault_clears_only_once_readings_return() {
    ButtonEvents sel;  sel.selTap = true;
    for (int i = 0; i < FAULT_STRIKES; ++i) tick(openProbe(), 250);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Fault), static_cast<int>(c.state()));

    tick(openProbe(), 250, sel);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Fault), static_cast<int>(c.state()));

    tickT(35.0f, 250, sel);
    TEST_ASSERT_EQUAL(static_cast<int>(State::Idle), static_cast<int>(c.state()));
}

static void test_preheat_timeout_faults_when_it_never_gets_hot() {
    ButtonEvents hold; hold.selHold = true;
    tickT(30.0f, 250, hold);
    for (int i = 0; i < 20; ++i) tickT(30.0f, 60000);   // 20 min, never rises
    TEST_ASSERT_EQUAL(static_cast<int>(State::Fault), static_cast<int>(c.state()));
    TEST_ASSERT_EQUAL(static_cast<int>(FaultCode::PreheatTimeout),
                      static_cast<int>(c.faultCode()));
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());
}

static void test_duty_is_capped_and_never_negative() {
    ButtonEvents hold; hold.selHold = true;
    tickT(30.0f, 250, hold);
    for (int i = 0; i < 50; ++i) {
        tickT(30.0f, 250);
        TEST_ASSERT_TRUE(c.dutyPct() >= 0.0f);
        TEST_ASSERT_TRUE(c.dutyPct() <= DUTY_MAX_PCT);
    }
    // Far above target the PID must back all the way off.
    for (int i = 0; i < 20; ++i) tickT(TARGET_DEFAULT_C + 5.0f, 250);
    TEST_ASSERT_EQUAL_FLOAT(0.0f, c.dutyPct());
}

// Real chamber: cutting power at 61 C still let the reading coast to 107 C for
// an 85 C target. Model fitted to that run: pad 40 J/K, loss 0.6 W/K, probe
// lag 66 s. Check the controller now arrives without coasting past.
static float simulatePeak(float target) {
    c.setSettings(target, 20);
    ButtonEvents hold; hold.selHold = true;
    float pad = 30.0f, probe = 30.0f, peak = 0.0f;
    tickT(probe, 250, hold);
    for (int i = 0; i < 4 * 900; ++i) {                  // 15 min in 250 ms steps
        const float watts = 300.0f * c.dutyPct() / 100.0f;
        pad   += (watts - 0.6f * (pad - 30.0f)) / 40.0f * 0.25f;
        probe += (pad - probe) / 66.0f * 0.25f;          // 66 s probe lag
        const float reading = floorf(probe * 4.0f) / 4.0f;   // MAX6675 0.25 C steps
        tickT(reading, 250);
        if (reading > peak) peak = reading;
    }
    return peak;
}

static void test_lagging_plate_does_not_coast_past_target() {
    const float peak = simulatePeak(85.0f);
    char msg[48]; snprintf(msg, sizeof(msg), "peak %.2f C for 85 C target", peak);
    TEST_MESSAGE(msg);
    TEST_ASSERT_TRUE(peak <= 85.0f + 3.0f);
    TEST_ASSERT_TRUE(peak >= 85.0f - 1.0f);   // still reaches temperature
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_starts_idle_with_defaults);
    RUN_TEST(test_next_cycles_field_and_inc_dec_adjust_it);
    RUN_TEST(test_adjust_clamps_at_limits);
    RUN_TEST(test_saved_settings_are_restored_only_when_in_range);
    RUN_TEST(test_sel_tap_alone_never_starts_a_cycle);
    RUN_TEST(test_hold_starts_cycle);
    RUN_TEST(test_hold_refused_without_a_valid_reading);
    RUN_TEST(test_preheat_heats_then_hands_over_to_running);
    RUN_TEST(test_countdown_runs_out_and_turns_the_heater_off);
    RUN_TEST(test_complete_screen_returns_to_idle);
    RUN_TEST(test_sel_stops_from_preheat_and_running);
    RUN_TEST(test_overtemp_latches_and_will_not_clear_while_hot);
    RUN_TEST(test_overtemp_trips_even_from_idle);
    RUN_TEST(test_overtemp_outranks_a_sensor_fault);
    RUN_TEST(test_sensor_fault_stops_heater_and_timer);
    RUN_TEST(test_sensor_fault_clears_only_once_readings_return);
    RUN_TEST(test_preheat_timeout_faults_when_it_never_gets_hot);
    RUN_TEST(test_duty_is_capped_and_never_negative);
    RUN_TEST(test_lagging_plate_does_not_coast_past_target);
    return UNITY_END();
}
