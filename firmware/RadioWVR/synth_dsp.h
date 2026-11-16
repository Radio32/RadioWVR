// The synth's sound: plain C++ with no Arduino in it, so test/synth/ can render it on a computer.
//
//   2 oscillators per voice (anti-aliased saw and pulse, triangle, sine, noise, or a sample)
//   -> filter: Fat (a 4-pole transistor ladder with a tanh in every stage, as in Radio32 Rings)
//              or Gritty (a 2-pole state-variable filter whose resonance clips, driven hard)
//   -> amp envelope -> 6 voices, spread across the stereo field
//   -> chorus (the Juno's I, II and I+II) -> echo (up to 500 ms, optionally ping-pong) -> level
//
// Everything is float. The ESP32 has a single-precision FPU but divides slowly and has no
// fast exp, so divisions and exp2f happen once per block (64 samples, 1.45 ms), not per sample.
#pragma once
#include <math.h>
#include <stdint.h>
#include <string.h>
#include "synth_params.h"

// On the ESP32 the per-block render runs from internal RAM instead of the flash cache.
#ifdef ARDUINO
#include <esp_attr.h>
#define SDSP_HOT IRAM_ATTR
#else
#define SDSP_HOT
#endif

namespace sdsp {

static constexpr float kPi = 3.14159265358979f;
static constexpr float kRate = 44100.0f;
static constexpr int kBlock = 64;
static constexpr int kVoices = 6;
static constexpr int kEchoLen = 11100;         // the echo's line: 500 ms at half rate, and a little

inline float clampf(float x, float lo, float hi) { return x < lo ? lo : (x > hi ? hi : x); }

// ------------------------------------------------------------------ tanh

// A 1024-point table with linear interpolation, flat beyond +-4.
struct TanhTable {
  static constexpr int N = 1024;
  static constexpr float R = 4.0f;
  float* t = nullptr;            // 2 N floats, given by whoever starts the synth (fast RAM on the ESP32)
  void init(float* storage) {
    t = storage;
    const float step = 2.0f * R / N;
    for (int i = 0; i < N; i++) {
      float a = tanhf(-R + i * step), b = tanhf(-R + (i + 1) * step);
      t[2 * i] = a; t[2 * i + 1] = b - a;
    }
  }
  inline float operator()(float x) const {
    float f = (x + R) * (N / (2.0f * R));
    if (f <= 0.0f) return t[0];
    if (f >= N - 1) return t[2 * (N - 1)] + t[2 * (N - 1) + 1];
    int i = (int)f;
    return t[2 * i] + t[2 * i + 1] * (f - i);
  }
};
inline TanhTable tanh_table;
inline float T(float x) { return tanh_table(x); }

inline uint32_t xorshift(uint32_t& s) { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
inline float noise(uint32_t& s) { return (int32_t)xorshift(s) * (1.0f / 2147483648.0f); }

// sin(2 pi ph) for ph in 0..1, within 0.1 %
inline float fast_sin(float ph) {
  float u = 2.0f * ph - 1.0f, a = u < 0 ? -u : u;
  float y = 4.0f * u * (1.0f - a);
  return -(0.225f * (y * (y < 0 ? -y : y) - y) + y);
}

// ------------------------------------------------------------------ oscillators

enum Wave { W_SAW, W_PULSE, W_TRI, W_SINE, W_NOISE, W_SAMPLE };

struct Osc {
  float ph = 0;
  uint32_t rng = 22222;

  static inline float blep(float t, float dt, float idt) {
    if (t < dt) { t *= idt; return t + t - t * t - 1.0f; }
    if (t > 1.0f - dt) { t = (t - 1.0f) * idt; return t * t + t + t + 1.0f; }
    return 0.0f;
  }

  // Adds the oscillator to dst, its level going from g0 to g1 and its pulse width from pw0 to pw1.
  void render(int wave, float dt, float pw0, float pw1, float g0, float g1, float* dst, int n) {
    dt = clampf(dt, 1e-6f, 0.45f);
    const float idt = 1.0f / dt, dg = (g1 - g0) / n, dpw = (pw1 - pw0) / n;
    float p = ph, g = g0, pw = pw0;
    switch (wave) {
      case W_SAW:
        for (int i = 0; i < n; i++) {
          dst[i] += g * (2.0f * p - 1.0f - blep(p, dt, idt));
          p += dt; if (p >= 1.0f) p -= 1.0f; g += dg;
        }
        break;
      case W_PULSE:
        for (int i = 0; i < n; i++) {
          float q = p - pw; if (q < 0) q += 1.0f;
          float v = (p < pw ? 1.0f : -1.0f) + blep(p, dt, idt) - blep(q, dt, idt);
          dst[i] += g * (v - (2.0f * pw - 1.0f));           // without its DC offset
          p += dt; if (p >= 1.0f) p -= 1.0f; g += dg; pw += dpw;
        }
        break;
      case W_TRI:
        for (int i = 0; i < n; i++) {
          dst[i] += g * (p < 0.5f ? 4.0f * p - 1.0f : 3.0f - 4.0f * p);
          p += dt; if (p >= 1.0f) p -= 1.0f; g += dg;
        }
        break;
      case W_SINE:
        for (int i = 0; i < n; i++) {
          dst[i] += g * fast_sin(p);
          p += dt; if (p >= 1.0f) p -= 1.0f; g += dg;
        }
        break;
      case W_NOISE:
        for (int i = 0; i < n; i++) { dst[i] += g * noise(rng); g += dg; }
        break;
    }
    ph = p;
  }
};

// A sound from the eMMC as an oscillator: played at its own pitch for note 60 (C3).
struct Sample {
  const int16_t* data = nullptr;
  uint32_t len = 0;
  float rate = kRate;
};

struct SampleOsc {
  uint32_t ip = 0;
  float fr = 0;
  bool done = false;
  void reset() { ip = 0; fr = 0; done = false; }
  void render(const Sample& s, bool loop, float step, float g0, float g1, float* dst, int n) {
    if (!s.data || s.len < 2 || done) return;
    const float dg = (g1 - g0) / n, k = 1.0f / 32768.0f;
    float g = g0;
    for (int i = 0; i < n; i++) {
      if (ip >= s.len - 1) {
        if (!loop) { done = true; return; }
        ip -= s.len - 1;
      }
      float a = s.data[ip], b = s.data[ip + 1];
      dst[i] += g * k * (a + (b - a) * fr);
      fr += step;
      int whole = (int)fr; ip += whole; fr -= whole;
      g += dg;
    }
  }
};

// ------------------------------------------------------------------ filters

// Fat: the transistor ladder, after Huovilainen (DAFx-04), as in Radio32 Rings: a tanh in every
// stage, the feedback half a sample late, tuning and resonance corrections, and the level kept
// up as the resonance rises. It runs at 44.1 kHz here (Rings runs it at 96 kHz), so the cutoff
// stops at 13 kHz.
struct Ladder {
  float s[4] = {0, 0, 0, 0}, t[4] = {0, 0, 0, 0}, fb = 0, fbs = 0, g = 0, k = 0;

  static void coefficients(float hz, float res, float* g, float* k) {
    float fc = clampf(hz / kRate, 0.0f, 0.3f), c = fc < 0.225f ? fc : 0.225f, c2 = c * c;
    float fcr = 1.8730f * c2 * c + 0.4955f * c2 - 0.6490f * c + 0.9988f;
    float acr = -3.9364f * c2 + 1.8409f * c + 0.9968f;
    *g = 1.0f - expf(-2.0f * kPi * fc * fcr);
    *k = 5.0f * res * acr;                    // self-oscillation from about 0.8
  }

  void process(float g1, float k1, float drive, float* x, int n) {
    const float dg = (g1 - g) / n, dk = (k1 - k) / n, makeup = 1.0f / sqrtf(drive);
    float s0 = s[0], s1 = s[1], s2 = s[2], s3 = s[3], t0 = t[0], t1 = t[1], t2 = t[2], t3 = t[3];
    float gi = g, ki = k, f = fb, fs = fbs;
    for (int i = 0; i < n; i++) {
      gi += dg; ki += dk;
      float in = T(x[i] * drive - ki * f);
      s0 += gi * (in - t0); t0 = T(s0);
      s1 += gi * (t0 - t1); t1 = T(s1);
      s2 += gi * (t1 - t2); t2 = T(s2);
      s3 += gi * (t2 - t3); t3 = T(s3);
      f = 0.5f * (s3 + fs); fs = s3;
      x[i] = s3 * makeup * (1.0f + 0.6f * ki);
    }
    s[0] = s0; s[1] = s1; s[2] = s2; s[3] = s3; t[0] = t0; t[1] = t1; t[2] = t2; t[3] = t3;
    g = g1; k = k1; fb = f; fbs = fs;
  }
};

// Gritty: a 2-pole state-variable filter (Zavalishin's topology-preserving form) whose band-pass
// state goes through a clipper, after an asymmetric drive stage. The resonance tears and screams
// instead of ringing politely, in the spirit of small Japanese monosynths' filters.
struct Gritty {
  float s1 = 0, s2 = 0, g = 0, r = 1, h = 1;

  static void coefficients(float hz, float res, float* g, float* r, float* h) {
    float fc = clampf(hz / kRate, 0.0f, 0.3f);
    *g = tanf(kPi * fc);
    *r = 1.0f - 1.06f * res;                  // below 0 near the top: it oscillates, the clipper holds it
    *h = 1.0f / (1.0f + 2.0f * *r * *g + *g * *g);
  }

  void process(float g1, float r1, float h1, float drive, float* x, int n) {
    const float dg = (g1 - g) / n, dr = (r1 - r) / n, dh = (h1 - h) / n;
    // the drive stage already holds the input within +-1, so no make-down: this matches Fat's level
    const float makeup = 1.5f;
    float a = s1, b = s2, gi = g, ri = r, hi = h;
    for (int i = 0; i < n; i++) {
      gi += dg; ri += dr; hi += dh;
      float in = x[i] * drive;
      in = in > 0 ? T(in) : 0.6f * T(1.6667f * in);        // clips harder below than above
      float hp = (in - (2.0f * ri + gi) * a - b) * hi;
      float v1 = gi * hp;
      float bp = 1.25f * T(0.8f * (v1 + a));                // the resonance clips here
      a = bp + v1;
      float v2 = gi * bp;
      float lp = v2 + b;
      b = lp + v2;
      x[i] = lp * makeup;
    }
    s1 = a; s2 = b; g = g1; r = r1; h = h1;
  }
};

// ------------------------------------------------------------------ envelopes and LFO

// ADSR with exponential segments, like an analog one. Attack aims past 1 so it rises nearly
// straight; decay and release reach -60 dB in their set time.
struct Env {
  enum { IDLE, ATTACK, DECAY, RELEASE };
  uint8_t st = IDLE;
  float v = 0;
  static float attack_coef(float ms) { return 1.0f - expf(-1.79f / (ms * 0.001f * kRate)); }
  static float fall_coef(float ms) { return 1.0f - expf(-6.9f / (ms * 0.001f * kRate)); }
  inline float tick(float ac, float dc, float sus, float rc) {
    switch (st) {
      case ATTACK: v += (1.2f - v) * ac; if (v >= 1.0f) { v = 1.0f; st = DECAY; } break;
      case DECAY: v += (sus - v) * dc; break;
      case RELEASE: v -= v * rc; if (v < 1e-4f) { v = 0; st = IDLE; } break;
    }
    return v;
  }
  void gate(bool on) { st = on ? ATTACK : (st == IDLE ? IDLE : RELEASE); }
  // n samples in one step, given (1 - coef)^n for each segment (close enough for a filter sweep)
  inline float jump(float ak, float dk, float sus, float rk) {
    switch (st) {
      case ATTACK: v = 1.2f + (v - 1.2f) * ak; if (v >= 1.0f) { v = 1.0f; st = DECAY; } break;
      case DECAY: v = sus + (v - sus) * dk; break;
      case RELEASE: v *= rk; if (v < 1e-4f) { v = 0; st = IDLE; } break;
    }
    return v;
  }
};

struct Lfo {
  float ph = 0, held = 0, out = 0;
  uint32_t rng = 777;
  // Advances one block and returns -1..1.
  float block(int wave, float hz) {
    ph += hz * kBlock / kRate;
    if (ph >= 1.0f) { ph -= (int)ph; held = noise(rng); }
    switch (wave) {
      case 1: out = fast_sin(ph); break;
      case 2: out = ph < 0.5f ? 1.0f : -1.0f; break;
      case 3: out += (held - out) * 0.3f; break;               // random, slightly smoothed
      default: out = ph < 0.5f ? 4.0f * ph - 1.0f : 3.0f - 4.0f * ph;
    }
    return out;
  }
};

// ------------------------------------------------------------------ effects

// The Juno chorus, as in Radio32 Rings (after Andy Harman's Juno-60 measurements): one
// bucket-brigade line read by two taps whose triangle LFOs run in opposite directions.
//   I 0.513 Hz, II 0.863 Hz, both 1.66-5.35 ms, stereo; I+II 9.75 Hz, 3.3-3.7 ms, mono.
struct Chorus {
  static constexpr int N = 512;
  float line[N];
  int w = 0;
  float ph = 0, lp1 = 0, lp2 = 0, lpc = 0, wet = 0;
  void init() { memset(line, 0, sizeof line); lpc = 1.0f - expf(-2.0f * kPi * 9000.0f / kRate); }
  inline float read(float d) const {
    int di = (int)d; float f = d - di;
    float a = line[(w - di) & (N - 1)], b = line[(w - di - 1) & (N - 1)];
    return a + (b - a) * f;
  }
  static inline float sat(float x) { x = clampf(x, -3.0f, 3.0f); return x - 0.0370370f * x * x * x; }
  void process(int mode, float* L, float* R, int n) {
    static const float rate[4] = {0.513f, 0.513f, 0.863f, 9.75f};
    static const float lo[4] = {0.00166f, 0.00166f, 0.00166f, 0.0033f};
    static const float hi[4] = {0.00535f, 0.00535f, 0.00535f, 0.0037f};
    const float target = mode ? 1.0f : 0.0f, dw = (target - wet) / n;
    if (!mode && wet == 0.0f) {                               // off: keep the line filled
      for (int i = 0; i < n; i++) {
        lp1 += lpc * (0.5f * (L[i] + R[i]) - lp1); lp2 += lpc * (lp1 - lp2);
        w = (w + 1) & (N - 1); line[w] = lp2;
      }
      return;
    }
    const int m = mode ? mode : 1;
    const float centre = 0.5f * (lo[m] + hi[m]) * kRate, depth = 0.5f * (hi[m] - lo[m]) * kRate;
    const float inc = rate[m] / kRate, stereo = m == 3 ? 1.0f : -1.0f;
    for (int i = 0; i < n; i++) {
      ph += inc; if (ph >= 1.0f) ph -= 1.0f;
      float tri = ph < 0.5f ? 4.0f * ph - 1.0f : 3.0f - 4.0f * ph;
      lp1 += lpc * (0.5f * (L[i] + R[i]) - lp1); lp2 += lpc * (lp1 - lp2);
      w = (w + 1) & (N - 1); line[w] = lp2;
      wet += dw;
      float bl = sat(read(centre + depth * tri)), br = sat(read(centre + stereo * depth * tri));
      L[i] = (L[i] + wet * bl) * (1.0f - 0.3f * wet);
      R[i] = (R[i] + wet * br) * (1.0f - 0.3f * wet);
    }
  }
};

// Echo up to 500 ms. The repeats darken (Tone) and saturate gently, so high feedback stays
// musical; ping-pong sends the repeats from side to side. Changing the time bends the pitch of
// what is in the line, like a tape echo, instead of clicking.
// The line runs at half the sample rate in 16 bits, which fits the ESP32's fast internal RAM
// (44 KB for both sides); the repeats are darkened anyway. Off, it costs nothing.
struct Echo {
  int16_t* bl = nullptr;
  int16_t* br = nullptr;
  int w = 0;
  bool clean = true;                    // the line is all zeros
  float time = 0, lpl = 0, lpr = 0, mix = 0, pl = 0, pr = 0;
  void init(int16_t* l, int16_t* r) { bl = l; br = r; memset(l, 0, kEchoLen * 2); memset(r, 0, kEchoLen * 2); }
  inline float read(const int16_t* b, float d) const {
    int di = (int)d; float f = d - di;
    int a = w - di; if (a < 0) a += kEchoLen;
    int c = a - 1; if (c < 0) c += kEchoLen;
    return (b[a] + (b[c] - b[a]) * f) * (1.0f / 16384.0f);
  }
  static inline int16_t store(float x) { x *= 16384.0f; return (int16_t)(x > 32767.0f ? 32767.0f : (x < -32768.0f ? -32768.0f : x)); }
  void process(float mixTarget, float ms, float feedback, float tone, bool pingpong, float* L, float* R, int n) {
    if (!bl) return;
    if (mixTarget == 0.0f && mix == 0.0f) {                     // off: forget what was in the line
      if (!clean) { memset(bl, 0, kEchoLen * 2); memset(br, 0, kEchoLen * 2); clean = true; lpl = lpr = pl = pr = 0; time = 0; }
      return;
    }
    clean = false;
    const float half = 0.5f * kRate;
    const float target = clampf(ms * 0.001f * half, 2.0f, kEchoLen - 2.0f);
    if (time == 0.0f) time = target;
    const float tc = 1.0f - expf(-1.0f / (0.05f * half));      // time glides over about 50 ms
    const float lpc = 1.0f - expf(-2.0f * kPi * (800.0f * powf(12.0f, tone)) / half);   // 0.8-9.6 kHz
    const float dmix = (mixTarget - mix) / n * 2.0f;
    for (int i = 0; i + 1 < n; i += 2) {
      time += (target - time) * tc;
      float dl = read(bl, time), dr = read(br, time);
      lpl += lpc * (dl - lpl); lpr += lpc * (dr - lpr);
      float fl = 1.25f * T(0.8f * feedback * lpl), fr = 1.25f * T(0.8f * feedback * lpr);
      float il = 0.5f * (L[i] + L[i + 1]), ir = 0.5f * (R[i] + R[i + 1]);
      w = w + 1 == kEchoLen ? 0 : w + 1;
      if (pingpong) { bl[w] = store(0.5f * (il + ir) + fr); br[w] = store(fl); }
      else { bl[w] = store(il + fl); br[w] = store(ir + fr); }
      mix += dmix;
      L[i] += mix * 0.5f * (pl + dl); R[i] += mix * 0.5f * (pr + dr);    // back up to the full rate
      L[i + 1] += mix * dl; R[i + 1] += mix * dr;
      pl = dl; pr = dr;
    }
  }
};

// ------------------------------------------------------------------ the synth

struct Voice {
  int note = -1;
  float vel = 0, pitch = 60, target = 60, pan = 0;
  bool gate = false, held = false;      // held: released while the sustain pedal is down
  uint32_t age = 0;
  Osc o1, o2;
  SampleOsc s1, s2;
  uint32_t rng = 1;
  Ladder ladder;
  Gritty gritty;
  Env amp, filt;
  float dc_x = 0, dc_y = 0;             // DC blocker after the filter
  bool active() const { return amp.st != Env::IDLE; }
};

struct Synth {
  float P[SP_COUNT];
  Sample smp[2];
  Voice v[kVoices];
  Chorus chorus;
  Echo echo;
  Lfo lfo;
  float bend = 0, modwheel = 0, last_pitch = 60;
  bool sustain = false;
  int stack[16], depth = 0;              // notes held, for mono and legato
  uint32_t ages = 0;
  float vol = 0.5f;

  // tanh: 2048 floats; echoL, echoR: kEchoLen each.
  void init(float* tanh, int16_t* echoL, int16_t* echoR) {
    tanh_table.init(tanh);
    for (int i = 0; i < SP_COUNT; i++) P[i] = SYNTH_PARAMS[i].def;
    static const float pans[kVoices] = {-1.0f, 1.0f, -0.5f, 0.5f, -0.25f, 0.25f};
    for (int i = 0; i < kVoices; i++) {
      v[i].pan = pans[i];
      v[i].o1.rng = 1234 + i * 777; v[i].o2.rng = 98765 + i * 333; v[i].rng = 4321 + i;
      v[i].o1.ph = 0.13f * i; v[i].o2.ph = 0.37f * i;
    }
    chorus.init();
    echo.init(echoL, echoR);
  }

  int mode() const { return (int)P[SP_VM]; }

  void start(Voice& x, int note, int vel, bool retrigger) {
    x.note = note; x.vel = vel / 127.0f; x.target = note;
    if (retrigger || !x.active()) {
      x.pitch = P[SP_GL] > 0 ? last_pitch : note;
      x.amp.gate(true); x.filt.gate(true);
      x.s1.reset(); x.s2.reset();
    }
    x.gate = true; x.held = false; x.age = ++ages;
    last_pitch = note;
  }

  void note_on(int note, int vel) {
    if (vel <= 0) { note_off(note); return; }
    if (mode() != 0) {                                // mono and legato: voice 0, last note wins
      for (int i = 0; i < depth; i++) if (stack[i] == note) { memmove(&stack[i], &stack[i + 1], (depth - i - 1) * sizeof(int)); depth--; break; }
      if (depth < 16) stack[depth++] = note;
      Voice& x = v[0];
      bool legato = mode() == 2 && x.gate;
      start(x, note, vel, !legato);
      return;
    }
    Voice* pick = nullptr;
    for (auto& x : v) if (x.note == note && x.active()) { pick = &x; break; }
    if (!pick) for (auto& x : v) if (!x.active()) { pick = &x; break; }
    if (!pick) for (auto& x : v) if (!x.gate && (!pick || x.age < pick->age)) pick = &x;
    if (!pick) for (auto& x : v) if (!pick || x.age < pick->age) pick = &x;
    start(*pick, note, vel, true);
  }

  void note_off(int note) {
    if (mode() != 0) {
      for (int i = 0; i < depth; i++) if (stack[i] == note) { memmove(&stack[i], &stack[i + 1], (depth - i - 1) * sizeof(int)); depth--; break; }
      Voice& x = v[0];
      if (x.note != note) return;
      if (depth > 0) { x.note = stack[depth - 1]; x.target = x.note; last_pitch = x.note; return; }   // back to the note still held
      if (sustain) x.held = true; else { x.gate = false; x.amp.gate(false); x.filt.gate(false); }
      return;
    }
    for (auto& x : v) if (x.note == note && x.gate) {
      if (sustain) x.held = true;
      else { x.gate = false; x.amp.gate(false); x.filt.gate(false); }
    }
  }

  void set_sustain(bool on) {
    sustain = on;
    if (!on) for (auto& x : v) if (x.held && x.gate) { x.held = false; x.gate = false; x.amp.gate(false); x.filt.gate(false); }
  }

  void all_off() {
    depth = 0; sustain = false;
    for (auto& x : v) { x.held = false; if (x.gate) { x.gate = false; x.amp.gate(false); x.filt.gate(false); } }
  }

  int voices_sounding() const { int n = 0; for (auto& x : v) if (x.active()) n++; return n; }

  // One block of kBlock frames into L and R.
  void render(float* L, float* R);
};

// A parameter's value for a knob or MIDI CC position x (0..1), as SynthParam.fromUnit in the manager.
inline float param_from_unit(int i, float x) {
  const SynthParamDef& d = SYNTH_PARAMS[i];
  x = clampf(x, 0.0f, 1.0f);
  switch (d.curve) {
    case SC_LIST: { float v = floorf(x * (d.max - d.min + 1)) + d.min; return v > d.max ? d.max : v; }
    case SC_INT: return roundf(d.min + x * (d.max - d.min));
    case SC_LOG: return d.min * powf(d.max / d.min, x);
    case SC_SQ: return d.min + (d.max - d.min) * x * x;
    default: return d.min + (d.max - d.min) * x;
  }
}

// The render loop. Exactly one file defines SDSP_RENDER before including this header
// (synth.cpp on the WVR, render.cpp on a computer), so it is compiled once, in internal RAM.
#ifdef SDSP_RENDER
SDSP_HOT __attribute__((flatten)) void Synth::render(float* L, float* R) {
  memset(L, 0, kBlock * 4); memset(R, 0, kBlock * 4);
  // what all voices share, worked out once per block
  const float lfo_v = lfo.block((int)P[SP_LW], P[SP_LR]);
  const float bend_st = bend * P[SP_PB];
  const float vib = lfo_v * (P[SP_LP] * 2.0f + modwheel);           // semitones
  const float aac = Env::attack_coef(P[SP_AA]), adc = Env::fall_coef(P[SP_AD]), arc = Env::fall_coef(P[SP_AR]);
  const float fak = powf(1.0f - Env::attack_coef(P[SP_FA]), kBlock), fdk = powf(1.0f - Env::fall_coef(P[SP_FDC]), kBlock),
              frk = powf(1.0f - Env::fall_coef(P[SP_FR]), kBlock);
  const float glide = P[SP_GL] > 0 ? 1.0f - expf(-3.0f * kBlock / (P[SP_GL] * 0.001f * kRate)) : 1.0f;
  const int w1 = (int)P[SP_O1W], w2 = (int)P[SP_O2W];
  const float off1 = P[SP_O1O] * 12 + P[SP_O1S] + P[SP_O1F] * 0.01f, off2 = P[SP_O2O] * 12 + P[SP_O2S] + P[SP_O2F] * 0.01f;
  const float pw1 = clampf(P[SP_O1PW] + 0.45f * P[SP_LPW] * lfo_v, 0.03f, 0.97f);
  const float pw2 = clampf(P[SP_O2PW] + 0.45f * P[SP_LPW] * lfo_v, 0.03f, 0.97f);
  const bool gritty = P[SP_FM] >= 0.5f;
  const float drive = gritty ? 1.0f + 7.0f * P[SP_FD] : 1.0f + 3.0f * P[SP_FD];
  const float base_oct = log2f(P[SP_FC]) + P[SP_LC] * 2.0f * lfo_v;
  const float spread = P[SP_SP];
  const float dc = 1.0f - 2.0f * kPi * 20.0f / kRate;               // DC blocker, 20 Hz

  float buf[kBlock];
  for (auto& x : v) {
    if (!x.active()) continue;
    x.pitch += (x.target - x.pitch) * glide;
    const float semis = x.pitch + bend_st + vib;
    memset(buf, 0, sizeof buf);
    // oscillators: level ramps from the last block's to this one's (none: levels are params)
    const float l1 = P[SP_O1L], l2 = P[SP_O2L];
    float f1 = 440.0f * exp2f((semis + off1 - 69.0f) * (1.0f / 12.0f));
    float f2 = 440.0f * exp2f((semis + off2 - 69.0f) * (1.0f / 12.0f));
    if (w1 == W_SAMPLE) x.s1.render(smp[0], P[SP_O1LP] >= 0.5f, f1 / 261.6256f * smp[0].rate / kRate, l1, l1, buf, kBlock);
    else x.o1.render(w1, f1 / kRate, pw1, pw1, l1, l1, buf, kBlock);
    if (w2 == W_SAMPLE) x.s2.render(smp[1], P[SP_O2LP] >= 0.5f, f2 / 261.6256f * smp[1].rate / kRate, l2, l2, buf, kBlock);
    else x.o2.render(w2, f2 / kRate, pw2, pw2, l2, l2, buf, kBlock);
    if (P[SP_NZ] > 0) for (int i = 0; i < kBlock; i++) buf[i] += P[SP_NZ] * noise(x.rng);

    // filter envelope for this block, then the cutoff
    const float fe = x.filt.jump(fak, fdk, P[SP_FS], frk);
    float oct = base_oct + P[SP_FE] * 6.0f * fe + P[SP_FK] * (x.pitch - 60.0f) * (1.0f / 12.0f) + P[SP_FV] * 2.0f * (x.vel - 0.5f);
    float hz = clampf(exp2f(oct), 20.0f, 0.3f * kRate);
    if (gritty) {
      float g, r, h; Gritty::coefficients(hz, P[SP_FQ], &g, &r, &h);
      x.gritty.process(g, r, h, drive, buf, kBlock);
    } else {
      float g, k; Ladder::coefficients(hz, P[SP_FQ], &g, &k);
      x.ladder.process(g, k, drive, buf, kBlock);
    }

    // amp envelope, velocity, DC blocker and place in the stereo field
    const float vg = 0.3f * ((1.0f - P[SP_AV]) + P[SP_AV] * x.vel * x.vel);
    const float p = x.pan * spread, gl = vg * (p > 0 ? 1.0f - p : 1.0f), gr = vg * (p < 0 ? 1.0f + p : 1.0f);
    for (int i = 0; i < kBlock; i++) {
      float a = x.amp.tick(aac, adc, P[SP_AS], arc);
      float y = buf[i] - x.dc_x + dc * x.dc_y;
      x.dc_x = buf[i]; x.dc_y = y;
      y *= a;
      L[i] += y * gl; R[i] += y * gr;
    }
    if (!x.active()) { x.note = -1; x.gate = false; }
  }

  chorus.process((int)P[SP_CH], L, R, kBlock);
  echo.process(P[SP_EMX], P[SP_ET], P[SP_EFB], P[SP_ETO], P[SP_EPP] >= 0.5f, L, R, kBlock);

  // level, then a soft knee above 0.7 so loud chords round off instead of clipping
  const float target = powf(10.0f, P[SP_VOL] / 20.0f), dv = (target - vol) / kBlock;
  for (int i = 0; i < kBlock; i++) {
    vol += dv;
    float l = L[i] * vol, r = R[i] * vol, al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
    if (al > 0.7f) l = (l < 0 ? -1.0f : 1.0f) * (0.7f + 0.3f * T((al - 0.7f) * 3.3333f));
    if (ar > 0.7f) r = (r < 0 ? -1.0f : 1.0f) * (0.7f + 0.3f * T((ar - 0.7f) * 3.3333f));
    L[i] = l; R[i] = r;
  }
}

#endif

}  // namespace sdsp
