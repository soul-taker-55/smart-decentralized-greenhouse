// Simulated greenhouse environment.
//
// Stage 1: ambient drift only — no actuator effects yet. Values wander
// realistically so charts, downsampling, and the bridge behave as they will in
// production, but nothing is causally linked to actuators until Stage 2.
//
// Each variable is a bounded random walk pulled gently toward a baseline. That
// gives believable movement without trends running away.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// A single step of a mean-reverting random walk.
//   pull  — how strongly the value returns to baseline (0..1)
//   noise — maximum random deviation per step
const drift = (current, baseline, pull, noise, min, max) => {
  const toward = (baseline - current) * pull;
  const random = (Math.random() - 0.5) * 2 * noise;
  return clamp(current + toward + random, min, max);
};

export class Environment {
  constructor() {
    // Starting values. Deliberately unremarkable — these are simulation
    // starting points, not agronomic setpoints.
    this.state = {
      tempIn: 22.0,
      tempOut: 18.0,
      pressIn: 1013.0,
      pressOut: 1013.0,
      humIn: 60,
      humOut: 70,
      aq: 140,
      lightIn: 800,
      lightOut: 2000,
      soil: 45,
      water: 80,
    };
  }

  // Advance the simulation by one tick.
  step() {
    const s = this.state;

    // Outside conditions drive inside conditions loosely. Inside is more
    // stable because the enclosure is sealed.
    s.tempOut = drift(s.tempOut, 18.0, 0.02, 0.35, -5, 45);
    s.tempIn = drift(s.tempIn, s.tempOut + 4.0, 0.05, 0.15, -5, 60);

    s.pressOut = drift(s.pressOut, 1013.0, 0.01, 0.15, 950, 1060);
    s.pressIn = drift(s.pressIn, s.pressOut, 0.20, 0.05, 950, 1060);

    s.humOut = drift(s.humOut, 70, 0.02, 1.2, 0, 100);
    s.humIn = drift(s.humIn, 60, 0.03, 0.8, 0, 100);

    // Air quality: raw ADC, relative trend only.
    s.aq = drift(s.aq, 140, 0.02, 6, 0, 4095);

    // Light: outside varies more than inside.
    s.lightOut = drift(s.lightOut, 2000, 0.02, 90, 0, 4095);
    s.lightIn = drift(s.lightIn, s.lightOut * 0.4, 0.10, 40, 0, 4095);

    // Soil dries slowly. No pump yet, so it only falls — Stage 2 adds
    // irrigation and this starts to recover.
    s.soil = clamp(s.soil - 0.02 - Math.random() * 0.03, 0, 100);

    // Water reservoir is static until the pump exists.
    s.water = clamp(s.water, 0, 100);
  }

  // Produce the `r` block of an up/telemetry payload, matching the contract:
  // every reading is {val, q}, floats to one decimal, humidity and raw ADC
  // values as integers.
  readings() {
    const s = this.state;
    const ok = (val) => ({ val, q: 'ok' });
    const d1 = (v) => Math.round(v * 10) / 10;

    return {
      temp_in: ok(d1(s.tempIn)),
      temp_out: ok(d1(s.tempOut)),
      press_in: ok(d1(s.pressIn)),
      press_out: ok(d1(s.pressOut)),
      hum_in: ok(Math.round(s.humIn)),
      hum_out: ok(Math.round(s.humOut)),
      aq: ok(Math.round(s.aq)),
      light_in: ok(Math.round(s.lightIn)),
      light_out: ok(Math.round(s.lightOut)),
      soil: ok(Math.round(s.soil)),
      water: ok(Math.round(s.water)),
    };
  }
}
