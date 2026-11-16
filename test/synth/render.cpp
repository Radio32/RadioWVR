// Runs the WVR's synth (firmware/RadioWVR/synth_dsp.h) on this computer: checks that it stays
// bounded and in tune, renders example patches to WAV, and times it. Run: test/synth/run.sh
#define SDSP_RENDER
#include "../../firmware/RadioWVR/synth_dsp.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

using namespace sdsp;

static int failures = 0;
static void check(bool ok, const std::string& what) {
  printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str());
  if (!ok) failures++;
}

static int16_t echoL[kEchoLen], echoR[kEchoLen];
static float tanhT[2 * TanhTable::N];

struct Render {
  std::vector<float> l, r;
  float peak = 0;
  bool finite = true;
  void add(const float* L, const float* R) {
    for (int i = 0; i < kBlock; i++) {
      if (!std::isfinite(L[i]) || !std::isfinite(R[i])) finite = false;
      peak = std::max(peak, std::max(std::fabs(L[i]), std::fabs(R[i])));
      l.push_back(L[i]); r.push_back(R[i]);
    }
  }
  float rms(size_t from, size_t to) const {
    double s = 0; to = std::min(to, l.size());
    for (size_t i = from; i < to; i++) s += l[i] * l[i] + r[i] * r[i];
    return to > from ? (float)sqrt(s / (2.0 * (to - from))) : 0;
  }
  void wav(const std::string& path) const {
    FILE* f = fopen(path.c_str(), "wb");
    if (!f) return;
    uint32_t n = l.size(), bytes = n * 4, rate = 44100, brate = rate * 4, fmt = 16;
    uint16_t pcm = 1, ch = 2, align = 4, bits = 16;
    fwrite("RIFF", 1, 4, f); uint32_t riff = 36 + bytes; fwrite(&riff, 4, 1, f); fwrite("WAVEfmt ", 1, 8, f);
    fwrite(&fmt, 4, 1, f); fwrite(&pcm, 2, 1, f); fwrite(&ch, 2, 1, f); fwrite(&rate, 4, 1, f);
    fwrite(&brate, 4, 1, f); fwrite(&align, 2, 1, f); fwrite(&bits, 2, 1, f);
    fwrite("data", 1, 4, f); fwrite(&bytes, 4, 1, f);
    for (uint32_t i = 0; i < n; i++) {
      int16_t a = (int16_t)lrintf(clampf(l[i], -1, 1) * 32767), b = (int16_t)lrintf(clampf(r[i], -1, 1) * 32767);
      fwrite(&a, 2, 1, f); fwrite(&b, 2, 1, f);
    }
    fclose(f);
  }
};

static int idx(const char* key) {
  for (int i = 0; i < SP_COUNT; i++) if (!strcmp(SYNTH_PARAMS[i].key, key)) return i;
  fprintf(stderr, "no parameter %s\n", key); exit(1);
}

using Set = std::vector<std::pair<const char*, float>>;
static Synth* fresh(const Set& set) {
  static Synth s;
  s = Synth();
  s.init(tanhT, echoL, echoR);
  for (auto& kv : set) s.P[idx(kv.first)] = kv.second;
  return &s;
}

// Plays events (time in seconds, note, velocity; velocity 0 = off) for `seconds`.
struct Ev { float t; int note, vel; };
static Render play(Synth* s, std::vector<Ev> evs, float seconds) {
  Render out;
  float L[kBlock], R[kBlock];
  size_t e = 0;
  int blocks = (int)(seconds * kRate / kBlock);
  for (int b = 0; b < blocks; b++) {
    float t = (float)b * kBlock / kRate;
    while (e < evs.size() && evs[e].t <= t) { s->note_on(evs[e].note, evs[e].vel); e++; }
    s->render(L, R);
    out.add(L, R);
  }
  return out;
}

static std::vector<Ev> chord(std::vector<int> notes, float on, float off, int vel = 100) {
  std::vector<Ev> v;
  for (int n : notes) v.push_back({on, n, vel});
  for (int n : notes) v.push_back({off, n, 0});
  return v;
}

static float pitch_of(const Render& r, size_t from, size_t to) {   // from upward zero crossings
  int crossings = 0; size_t first = 0, last = 0;
  to = std::min(to, r.l.size());
  for (size_t i = from + 1; i < to; i++) if (r.l[i - 1] < 0 && r.l[i] >= 0) { if (!crossings) first = i; last = i; crossings++; }
  return crossings > 1 ? (crossings - 1) * kRate / (float)(last - first) : 0;
}

int main(int argc, char** argv) {
  std::string out = argc > 1 ? argv[1] : ".";

  // 1. in tune: a sine, filter wide open
  {
    Synth* s = fresh({{"o1w", W_SINE}, {"o2l", 0}, {"fc", 16000}, {"fq", 0}, {"fe", 0}, {"fk", 0}, {"fv", 0}, {"ch", 0}, {"sp", 0}});
    Render r = play(s, {{0, 69, 127}}, 1.0f);
    float hz = pitch_of(r, 11025, 44100);
    check(fabsf(1200 * log2f(hz / 440)) < 3, "A4 plays at 440 Hz: " + std::to_string(hz));
  }
  // 2. six-note chord with everything that adds level: bounded, and silent after the release
  {
    Synth* s = fresh({{"fq", 0.6f}, {"fd", 1}, {"emx", 0.5f}, {"efb", 0.6f}, {"vol", 6}});
    Render r = play(s, chord({48, 55, 60, 64, 67, 72}, 0, 2), 6);
    check(r.finite, "chord: no NaN or infinity");
    check(r.peak <= 1.0f, "chord at +6 dB stays within full scale: peak " + std::to_string(r.peak));
    Synth* q = fresh({});
    Render r2 = play(q, chord({48, 55, 60, 64, 67, 72}, 0, 1), 3);
    check(r2.rms(44100 * 2.5, 44100 * 3) < 1e-4f, "silent after the release: rms " + std::to_string(r2.rms(44100 * 2.5, 44100 * 3)));
  }
  // 3. both filters at full resonance and drive stay bounded, from deep bass to the top
  for (int mode = 0; mode < 2; mode++) {
    for (float fc : {40.0f, 440.0f, 4000.0f, 16000.0f}) {
      Synth* s = fresh({{"fm", (float)mode}, {"fq", 1}, {"fd", 1}, {"fc", fc}, {"fe", 1}, {"ch", 0}});
      Render r = play(s, chord({36, 60, 84}, 0, 1.5f, 127), 2);
      check(r.finite && r.peak <= 1.0f, std::string(mode ? "Gritty" : "Fat") + " at full resonance and drive, cutoff " +
            std::to_string((int)fc) + " Hz: peak " + std::to_string(r.peak));
    }
  }
  // 4. echo at full feedback, ping-pong, for 20 s
  {
    Synth* s = fresh({{"emx", 1}, {"efb", 0.95f}, {"epp", 1}, {"et", 120}});
    Render r = play(s, chord({60, 64, 67}, 0, 0.3f, 127), 20);
    check(r.finite && r.peak <= 1.0f, "echo at 95 % feedback for 20 s: peak " + std::to_string(r.peak));
  }
  // 5. mono and legato: one voice, returns to the held note
  {
    Synth* s = fresh({{"vm", 2}, {"gl", 200}});
    play(s, {{0, 60, 100}, {0.2f, 67, 100}, {0.5f, 67, 0}}, 1);
    check(s->voices_sounding() == 1 && s->v[0].note == 60, "legato: back to the held note after letting go");
  }

  // 6. example patches to listen to
  struct Demo { const char* name; Set p; std::vector<Ev> ev; float len; };
  std::vector<Demo> demos = {
    {"fat_pad", {{"o2f", 9}, {"fc", 900}, {"fq", 0.25f}, {"fe", 0.25f}, {"fa", 800}, {"fdc", 2000}, {"aa", 600}, {"ar", 1500}, {"ch", 2}, {"sp", 0.6f}},
      chord({48, 55, 60, 63, 67}, 0, 3), 6},
    {"fat_bass", {{"o1w", W_SAW}, {"o2w", W_PULSE}, {"o2o", -1}, {"fc", 220}, {"fq", 0.55f}, {"fe", 0.6f}, {"fdc", 250}, {"fs", 0}, {"fd", 0.6f}, {"vm", 1}, {"ch", 0}},
      {{0, 36, 120}, {0.25f, 36, 0}, {0.3f, 36, 90}, {0.5f, 36, 0}, {0.55f, 43, 110}, {0.8f, 43, 0}, {0.9f, 41, 127}, {1.4f, 41, 0}}, 2.5f},
    {"gritty_bass", {{"o1w", W_SAW}, {"o2w", W_PULSE}, {"o2o", -1}, {"fm", 1}, {"fc", 300}, {"fq", 0.75f}, {"fe", 0.5f}, {"fdc", 300}, {"fs", 0.1f}, {"fd", 0.8f}, {"vm", 1}, {"ch", 0}},
      {{0, 36, 120}, {0.25f, 36, 0}, {0.3f, 36, 90}, {0.5f, 36, 0}, {0.55f, 43, 110}, {0.8f, 43, 0}, {0.9f, 41, 127}, {1.4f, 41, 0}}, 2.5f},
    {"gritty_scream", {{"o1w", W_SAW}, {"o2w", W_SAW}, {"o2f", 12}, {"fm", 1}, {"fc", 600}, {"fq", 0.95f}, {"fd", 1}, {"lc", 0.6f}, {"lr", 0.4f}, {"ch", 0}},
      chord({48, 60}, 0, 3), 4},
    {"brass_echo", {{"o2f", 6}, {"fc", 700}, {"fq", 0.15f}, {"fe", 0.5f}, {"fa", 80}, {"fdc", 600}, {"fs", 0.5f}, {"aa", 30}, {"emx", 0.35f}, {"et", 330}, {"efb", 0.45f}, {"epp", 1}, {"ch", 1}},
      {{0, 60, 110}, {0, 64, 110}, {0, 67, 110}, {0.6f, 60, 0}, {0.6f, 64, 0}, {0.6f, 67, 0}, {1.0f, 62, 100}, {1.0f, 65, 100}, {1.0f, 69, 100}, {1.6f, 62, 0}, {1.6f, 65, 0}, {1.6f, 69, 0}}, 5},
    {"chorus_I_II_strings", {{"o1w", W_PULSE}, {"o1pw", 0.3f}, {"lpw", 0.4f}, {"lr", 0.7f}, {"o2l", 0.5f}, {"fc", 2500}, {"aa", 300}, {"ar", 900}, {"ch", 3}},
      chord({55, 62, 67, 71}, 0, 2.5f), 4},
  };
  for (auto& d : demos) {
    Synth* s = fresh(d.p);
    Render r = play(s, d.ev, d.len);
    check(r.finite && r.peak <= 1.0f, std::string("demo ") + d.name + ": peak " + std::to_string(r.peak));
    r.wav(out + "/" + d.name + ".wav");
  }

  // 7. how long six voices with everything on take here (the ESP32 is far slower: a rough guide)
  {
    Synth* s = fresh({{"emx", 0.3f}, {"ch", 2}, {"lc", 0.3f}});
    for (int n : {48, 52, 55, 60, 64, 67}) s->note_on(n, 100);
    float L[kBlock], R[kBlock];
    const int blocks = 44100 * 10 / kBlock;
    auto t0 = std::chrono::steady_clock::now();
    for (int b = 0; b < blocks; b++) s->render(L, R);
    double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    printf("time  10 s of six voices, Fat filter, chorus, echo: %.1f ms here (%.2f %% of real time)\n", sec * 1000, sec * 10);
  }
  printf(failures ? "%d FAILED\n" : "all passed\n", failures);
  return failures ? 1 : 0;
}
