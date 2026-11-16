// Arduino builds for size (-Os); the synth's sound needs speed.
#pragma GCC optimize ("O2")
#include "synth.h"
#include "config.h"
#include "audio_out.h"
#include "storage.h"
#define SDSP_RENDER
#include "synth_dsp.h"
#include <cJSON.h>
#include <esp_heap_caps.h>
#include <esp_cpu.h>
#include <new>

using namespace sdsp;

/*
 * The audio task (core 1, as the player's) owns the Synth object: notes, pedal and bend reach
 * it through a queue. Parameters are plain floats that any task may write; the audio task reads
 * them once per block. A sample used as an oscillator is swapped by clearing its pointer first,
 * waiting a few blocks, and only then freeing the old one.
 */

static Synth* S;
static QueueHandle_t q;
static i2s_chan_handle_t tx;
static SemaphoreHandle_t mux;            // the patch's name, files and MIDI map
static char patchName[41] = "New patch";
static char files[2][FILE_NAME_MAX];
static int8_t ccMap[128];                // controller -> parameter, -1: none
static volatile int learning = -1;       // parameter waiting for a controller
static volatile uint32_t rev;
static volatile bool dirty;
static volatile uint32_t changedAt;
static volatile float loadPeak, peakL, peakR;

enum { C_NOTE, C_ALLOFF, C_SUSTAIN };
struct Cmd { uint8_t type, a, b; };

static int param_index(const char* key) {
  for (int i = 0; i < SP_COUNT; i++) if (!strcmp(SYNTH_PARAMS[i].key, key)) return i;
  return -1;
}
static float clamp_param(int i, float v) {
  const SynthParamDef& d = SYNTH_PARAMS[i];
  if (!(v == v)) v = d.def;                                   // NaN
  v = clampf(v, d.min, d.max);
  if (d.curve == SC_INT || d.curve == SC_LIST) v = roundf(v);
  return v;
}

bool synth_running() { return S != nullptr; }

// ------------------------------------------------------------------ audio

static void audio_task(void*) {
  static float L[kBlock], R[kBlock];
  static int16_t out[kBlock * 2];
  const float cyclesPerBlock = (float)ESP.getCpuFreqMHz() * 1e6f * kBlock / kRate;
  for (;;) {
    Cmd c;
    while (xQueueReceive(q, &c, 0)) {
      if (c.type == C_NOTE) S->note_on(c.a, c.b);
      else if (c.type == C_ALLOFF) S->all_off();
      else if (c.type == C_SUSTAIN) S->set_sustain(c.a);
    }
    uint32_t t0 = esp_cpu_get_cycle_count();
    S->render(L, R);
    float pl = 0, pr = 0;
    for (int i = 0; i < kBlock; i++) {
      float l = L[i], r = R[i];
      float al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
      out[2 * i] = (int16_t)(clampf(l, -1.0f, 1.0f) * 32767.0f);
      out[2 * i + 1] = (int16_t)(clampf(r, -1.0f, 1.0f) * 32767.0f);
    }
    float load = (esp_cpu_get_cycle_count() - t0) / cyclesPerBlock;
    if (load > loadPeak) loadPeak = load;
    if (pl > peakL) peakL = pl;
    if (pr > peakR) peakR = pr;
    size_t done;
    i2s_channel_write(tx, out, sizeof out, &done, portMAX_DELAY);
  }
}

// ------------------------------------------------------------------ samples as oscillators

// Reads a WAV into PSRAM as mono 16-bit. Long sounds are cut at SYNTH_SAMPLE_MAX frames.
static bool load_sample(int which, const char* name) {
  Sample& s = S->smp[which];
  int16_t* old = (int16_t*)s.data;
  s.data = nullptr; s.len = 0;                                 // the audio task stops reading it
  __sync_synchronize();
  if (old) { vTaskDelay(pdMS_TO_TICKS(10)); heap_caps_free(old); }
  if (!name || !name[0] || !safe_name(name)) return true;
  char path[96]; WavInfo w; const char* err;
  snd_path(path, sizeof path, name);
  if (!wav_probe(path, &w, &err)) { log_e("synth sample %s: %s", name, err); return false; }
  uint32_t frames = w.frames < SYNTH_SAMPLE_MAX ? w.frames : SYNTH_SAMPLE_MAX;
  int16_t* d = (int16_t*)heap_caps_malloc(frames * 2, MALLOC_CAP_SPIRAM);
  FILE* f = fopen(path, "rb");
  if (!d || !f) { if (d) heap_caps_free(d); if (f) fclose(f); return false; }
  fseek(f, w.dataOff, SEEK_SET);
  static int16_t buf[1024];
  uint32_t got = 0;
  while (got < frames) {
    uint32_t want = frames - got; if (want > 1024 / w.channels) want = 1024 / w.channels;
    size_t n = fread(buf, 2 * w.channels, want, f);
    if (!n) break;
    for (size_t i = 0; i < n; i++) d[got + i] = w.channels == 2 ? (int16_t)(((int32_t)buf[2 * i] + buf[2 * i + 1]) / 2) : buf[i];
    got += n;
  }
  fclose(f);
  s.rate = w.rate; s.len = got;
  __sync_synchronize();
  s.data = d;
  return true;
}

// ------------------------------------------------------------------ the patch as JSON

static void apply_doc(const cJSON* o) {
  const cJSON* p = cJSON_GetObjectItemCaseSensitive(o, "p");
  for (int i = 0; i < SP_COUNT; i++) {
    const cJSON* v = cJSON_GetObjectItemCaseSensitive(p, SYNTH_PARAMS[i].key);
    S->P[i] = cJSON_IsNumber(v) ? clamp_param(i, v->valuedouble) : SYNTH_PARAMS[i].def;
  }
  const cJSON* name = cJSON_GetObjectItemCaseSensitive(o, "name");
  strlcpy(patchName, cJSON_IsString(name) ? name->valuestring : "New patch", sizeof patchName);
  const cJSON* fl = cJSON_GetObjectItemCaseSensitive(o, "files");
  for (int k = 0; k < 2; k++) {
    const cJSON* f = cJSON_GetArrayItem(fl, k);
    const char* want = cJSON_IsString(f) ? f->valuestring : "";
    if (strcmp(want, files[k])) { strlcpy(files[k], want, sizeof files[k]); load_sample(k, files[k]); }
  }
  const cJSON* map = cJSON_GetObjectItemCaseSensitive(o, "map");
  if (map) {
    memset(ccMap, -1, sizeof ccMap);
    const cJSON* it;
    cJSON_ArrayForEach(it, map) {
      int cc = atoi(it->string), i = cJSON_IsString(it) ? param_index(it->valuestring) : -1;
      if (cc >= 0 && cc < 128 && i >= 0) ccMap[cc] = i;
    }
  }
}

char* synth_json() {
  if (!S) return strdup("null");
  cJSON* o = cJSON_CreateObject();
  xSemaphoreTake(mux, portMAX_DELAY);
  cJSON_AddStringToObject(o, "name", patchName);
  cJSON* p = cJSON_AddObjectToObject(o, "p");
  for (int i = 0; i < SP_COUNT; i++) cJSON_AddNumberToObject(p, SYNTH_PARAMS[i].key, roundf(S->P[i] * 10000.0f) / 10000.0f);
  cJSON* fl = cJSON_AddArrayToObject(o, "files");
  for (int k = 0; k < 2; k++) cJSON_AddItemToArray(fl, cJSON_CreateString(files[k]));
  cJSON* map = cJSON_AddObjectToObject(o, "map");
  for (int cc = 0; cc < 128; cc++) if (ccMap[cc] >= 0) { char k[4]; snprintf(k, sizeof k, "%d", cc); cJSON_AddStringToObject(map, k, SYNTH_PARAMS[ccMap[cc]].key); }
  xSemaphoreGive(mux);
  char* s = cJSON_PrintUnformatted(o);
  cJSON_Delete(o);
  return s;
}

static bool save() {
  char* s = synth_json();
  bool good = s && write_text_atomic(SYNTH_FILE, s);
  free(s);
  if (good) dirty = false;
  return good;
}

// Changes made on the WVR itself (MIDI knobs, learn) are saved after two quiet seconds.
static void changed_here() { dirty = true; changedAt = millis(); rev = rev + 1; }
static void save_task(void*) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(500));
    if (dirty && millis() - changedAt > 2000) save();
  }
}

bool synth_apply(const char* json, char* err, size_t n) {
  if (!S) { snprintf(err, n, "the WVR is not in synth mode"); return false; }
  cJSON* o = cJSON_Parse(json);
  if (!cJSON_IsObject(o)) { cJSON_Delete(o); snprintf(err, n, "not valid JSON"); return false; }
  xSemaphoreTake(mux, portMAX_DELAY);
  apply_doc(o);
  xSemaphoreGive(mux);
  cJSON_Delete(o);
  if (!save()) { snprintf(err, n, "couldn't save to the eMMC"); return false; }
  return true;
}

bool synth_set(const char* key, float value) {
  int i = S ? param_index(key) : -1;
  if (i < 0) return false;
  S->P[i] = clamp_param(i, value);
  dirty = true; changedAt = millis();
  return true;
}

uint32_t synth_rev() { return rev; }

bool synth_uses_file(const char* name) {
  return S && name[0] && (!strcmp(files[0], name) || !strcmp(files[1], name));
}

// ------------------------------------------------------------------ playing and MIDI

void synth_note(int note, int vel) {
  if (!S || note < 0 || note > 127) return;
  Cmd c = { C_NOTE, (uint8_t)note, (uint8_t)(vel < 0 ? 0 : vel > 127 ? 127 : vel) };
  xQueueSend(q, &c, 0);
}
void synth_all_off() {
  if (!S) return;
  Cmd c = { C_ALLOFF, 0, 0 };
  xQueueSend(q, &c, 0);
}

void synth_midi(uint8_t kind, uint8_t d1, uint8_t d2) {
  if (!S) return;
  if (kind == 0x90) synth_note(d1, d2);
  else if (kind == 0x80) synth_note(d1, 0);
  else if (kind == 0xE0) S->bend = (((d2 << 7) | d1) - 8192) / 8192.0f;
  else if (kind == 0xB0) {
    if (learning >= 0 && d1 != 64 && d1 != 120 && d1 != 123) {
      xSemaphoreTake(mux, portMAX_DELAY);
      for (auto& m : ccMap) if (m == learning) m = -1;          // one controller per parameter
      ccMap[d1] = learning;
      learning = -1;
      xSemaphoreGive(mux);
      changed_here();
    }
    if (ccMap[d1] >= 0) {
      int i = ccMap[d1];
      S->P[i] = clamp_param(i, param_from_unit(i, d2 / 127.0f));
      changed_here();
    } else if (d1 == 1) S->modwheel = d2 / 127.0f;
    else if (d1 == 64) { Cmd c = { C_SUSTAIN, (uint8_t)(d2 >= 64), 0 }; xQueueSend(q, &c, 0); }
    else if (d1 == 120 || d1 == 123) synth_all_off();
  }
}

void synth_learn(const char* key) { learning = key && key[0] ? param_index(key) : -1; }
void synth_forget(const char* key) {
  int i = param_index(key);
  if (!S || i < 0) return;
  xSemaphoreTake(mux, portMAX_DELAY);
  for (auto& m : ccMap) if (m == i) m = -1;
  xSemaphoreGive(mux);
  changed_here();
}
const char* synth_learning() { int i = learning; return i >= 0 ? SYNTH_PARAMS[i].key : ""; }

void synth_status(SynthStatus* st) {
  st->load = loadPeak; st->peakL = peakL; st->peakR = peakR;
  st->voices = S ? S->voices_sounding() : 0;
  loadPeak = 0; peakL = peakR = 0;
}

// ------------------------------------------------------------------ start

bool synth_begin() {
  S = (Synth*)heap_caps_calloc(1, sizeof(Synth), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  float* tanhT = (float*)heap_caps_malloc(2 * TanhTable::N * sizeof(float), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  int16_t* el = (int16_t*)heap_caps_malloc(kEchoLen * 2, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  int16_t* er = (int16_t*)heap_caps_malloc(kEchoLen * 2, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!S || !tanhT || !el || !er) { log_e("synth: out of memory"); S = nullptr; return false; }
  new (S) Synth();
  S->init(tanhT, el, er);
  memset(ccMap, -1, sizeof ccMap);
  mux = xSemaphoreCreateMutex();
  q = xQueueCreate(64, sizeof(Cmd));
  char* s = read_text(SYNTH_FILE);
  if (!s) s = read_text(SYNTH_FILE ".new");
  if (s) {
    cJSON* o = cJSON_Parse(s);
    if (cJSON_IsObject(o)) apply_doc(o);
    cJSON_Delete(o);
    free(s);
  }
  tx = audio_out_begin(kBlock, 3);                    // 3 x 1.45 ms of buffering
  xTaskCreatePinnedToCore(audio_task, "synth", 6144, nullptr, 22, nullptr, 1);
  xTaskCreatePinnedToCore(save_task, "synthsave", 4096, nullptr, 3, nullptr, 0);
  return true;
}
