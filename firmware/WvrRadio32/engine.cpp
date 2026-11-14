#include "engine.h"
#include "storage.h"
#include <atomic>
#include <math.h>
#include <fcntl.h>
#include <unistd.h>
#include <driver/i2s_std.h>
#include <esp_heap_caps.h>

Slot g_slots[NUM_SLOTS];

#define RING_MASK (RING_FRAMES - 1)

/*
 * A voice reads its sound as one endless run of frames ("unrolled": a loop simply goes on).
 * Frames below the slot's headFrames come from the slot's RAM copy; later ones from the
 * voice's ring, which the streamer task keeps filled from the eMMC. A sound no longer than
 * the head never touches the eMMC while it plays.
 *
 * The audio task owns everything in a voice except the stream fields; the streamer owns
 * those. `gen` counts the voice's incarnations: the ring is only valid for the audio task
 * once the streamer has restarted it for the current one (streamGen == gen).
 */
struct Voice {
  volatile bool active;
  int slot;
  std::atomic<uint32_t> gen;
  uint32_t age;
  // reading
  uint32_t next;            // unrolled index of the next frame to pull
  bool wrapped;             // `next` has passed 2^32 (a loop running for over a day)
  uint8_t ended;            // frames pulled past the end of a one-shot
  uint16_t starved;         // blocks in a row spent waiting for the eMMC
  float xl[4], xr[4];       // the four frames around the playback point
  float frac;               // position between x[1] and x[2]; >= 1 means frames are owed
  // level
  float vel, env, envStep, gl, gr;
  bool releasing, snap;
  // stream (streamer task)
  int16_t* ring;                     // RING_FRAMES stereo frames
  std::atomic<uint32_t> w;           // frames written, counted from headFrames
  std::atomic<uint32_t> rd;          // frames the audio task has finished with
  std::atomic<uint32_t> streamGen;
  uint32_t fileFrame;                // next frame to read from the file
  bool eof;
};

enum { CMD_PLAY, CMD_RELEASE, CMD_STOP, CMD_KILL };
struct Cmd { uint8_t type; int8_t slot; uint8_t vel; };

static Voice V[NUM_VOICES];
static QueueHandle_t cmdQ;
static SemaphoreHandle_t streamMux;      // held while the streamer touches a slot's file
static TaskHandle_t streamTask;
static i2s_chan_handle_t tx;
static uint8_t* readBuf;                 // DMA-capable: the SD/MMC driver reads straight into it
static uint32_t ageCounter;
static volatile float masterDb = 0, masterGain = 1;
static std::atomic<uint32_t> underruns{0};
static volatile float peakL, peakR;
static volatile uint32_t playingMask;
static volatile uint8_t voiceCount;

// ------------------------------------------------------------------ voices (audio task)

static void release(Voice& v, float ms) {
  if (ms < 3) ms = 3;
  v.releasing = true;
  v.envStep = -1.0f / (ms * 0.001f * SAMPLE_RATE);
}

static void start_voice(int slot, uint8_t vel) {
  Slot& s = g_slots[slot];
  if (!s.loaded) return;
  bool sounding = false;
  for (auto& v : V) if (v.active && v.slot == slot && !v.releasing) sounding = true;
  if (sounding && s.p.retrig == RETRIG_TOGGLE) {
    for (auto& v : V) if (v.active && v.slot == slot && !v.releasing) release(v, s.p.fadeOutMs);
    return;
  }
  if (sounding && s.p.retrig == RETRIG_RESTART)
    for (auto& v : V) if (v.active && v.slot == slot && !v.releasing) release(v, 5);
  if (s.p.group)
    for (auto& v : V)
      if (v.active && v.slot != slot && !v.releasing && g_slots[v.slot].p.group == s.p.group)
        release(v, g_slots[v.slot].p.fadeOutMs);

  // a free voice, or else the oldest one already fading, or else the oldest
  Voice* pick = nullptr;
  for (auto& v : V) if (!v.active) { pick = &v; break; }
  if (!pick) for (auto& v : V) if (v.releasing && (!pick || v.age < pick->age)) pick = &v;
  if (!pick) for (auto& v : V) if (!pick || v.age < pick->age) pick = &v;

  Voice& v = *pick;
  v.active = false;
  v.slot = slot;
  v.age = ++ageCounter;
  v.next = 0; v.wrapped = false; v.ended = 0; v.starved = 0;
  for (int i = 0; i < 4; i++) v.xl[i] = v.xr[i] = 0;
  v.frac = 3;                               // pull three frames: x[1] becomes the first one
  v.vel = s.p.velSens ? (vel / 127.0f) * (vel / 127.0f) : 1.0f;
  uint16_t fin = s.p.fadeInMs;
  v.env = fin ? 0 : 1;
  v.envStep = fin ? 1.0f / (fin * 0.001f * SAMPLE_RATE) : 0;
  v.releasing = false;
  v.snap = true;
  v.rd.store(0);
  v.gen.fetch_add(1);
  v.active = true;
  xTaskNotifyGive(streamTask);
}

// Pulls the next frame into the voice's window. False: the eMMC hasn't delivered it yet.
static inline bool pull(Voice& v, const Slot& s) {
  float l = 0, r = 0;
  bool loop = s.p.loop;
  if (s.frames <= s.headFrames) {                       // the whole sound is in RAM
    if (v.next >= s.frames) { if (loop) v.next = 0; else v.ended++; }
    if (v.next < s.frames) { l = s.head[v.next * 2]; r = s.head[v.next * 2 + 1]; v.next++; }
  } else if (!loop && !v.wrapped && v.next >= s.frames) {
    v.ended++;
  } else {
    if (!v.wrapped && v.next < s.headFrames) {
      l = s.head[v.next * 2]; r = s.head[v.next * 2 + 1];
    } else {
      uint32_t k = v.next - s.headFrames;
      if (v.streamGen.load() != v.gen.load() || (int32_t)(v.w.load() - k) <= 0) return false;
      const int16_t* p = v.ring + (k & RING_MASK) * 2;
      l = p[0]; r = p[1];
      v.rd.store(k);
    }
    if (++v.next == 0) v.wrapped = true;
  }
  v.xl[0] = v.xl[1]; v.xl[1] = v.xl[2]; v.xl[2] = v.xl[3]; v.xl[3] = l;
  v.xr[0] = v.xr[1]; v.xr[1] = v.xr[2]; v.xr[2] = v.xr[3]; v.xr[3] = r;
  return true;
}

static inline float hermite(const float* x, float t) {
  float c1 = 0.5f * (x[2] - x[0]);
  float c2 = x[0] - 2.5f * x[1] + 2.0f * x[2] - 0.5f * x[3];
  float c3 = 0.5f * (x[3] - x[0]) + 1.5f * (x[1] - x[2]);
  return ((c3 * t + c2) * t + c1) * t + x[1];
}

static void render(Voice& v, float* outL, float* outR) {
  const Slot& s = g_slots[v.slot];
  float step = exp2f(s.p.pitch / 12.0f) * ((float)s.rate / SAMPLE_RATE);
  if (step > 16) step = 16;
  bool unity = fabsf(step - 1.0f) < 1e-6f;

  // level at the end of this block; the block ramps to it
  float env = v.env + v.envStep * BLOCK_FRAMES;
  if (env >= 1) { env = 1; if (!v.releasing) v.envStep = 0; }
  if (env < 0) env = 0;
  float g = powf(10.0f, s.p.gainDb / 20.0f) * v.vel * env;
  float pan = s.p.pan;
  float tl = g * (pan > 0 ? cosf(pan * 1.5707963f) : 1.0f);
  float tr = g * (pan < 0 ? cosf(-pan * 1.5707963f) : 1.0f);
  if (v.snap) { v.gl = tl; v.gr = tr; v.snap = false; }
  float dl = (tl - v.gl) / BLOCK_FRAMES, dr = (tr - v.gr) / BLOCK_FRAMES;
  float gl = v.gl, gr = v.gr;

  for (int i = 0; i < BLOCK_FRAMES; i++) {
    bool starved = false;
    while (v.frac >= 1.0f) {
      if (!pull(v, s)) { starved = true; break; }
      v.frac -= 1.0f;
    }
    if (starved) {                                    // silent until the data arrives
      underruns.fetch_add(1);
      if (++v.starved > 700) v.active = false;        // two seconds: the file can't be read
      break;
    }
    v.starved = 0;
    float l, r;
    if (unity) { l = v.xl[1]; r = v.xr[1]; v.frac = 1.0f; }
    else { l = hermite(v.xl, v.frac); r = hermite(v.xr, v.frac); v.frac += step; }
    outL[i] += l * gl; outR[i] += r * gr;
    gl += dl; gr += dr;
  }
  v.gl = tl; v.gr = tr; v.env = env;
  if (v.ended >= 3 || (v.releasing && env <= 0)) v.active = false;
}

static void handle(const Cmd& c) {
  switch (c.type) {
    case CMD_PLAY: start_voice(c.slot, c.vel); break;
    case CMD_RELEASE:
      if (g_slots[c.slot].p.hold)
        for (auto& v : V) if (v.active && v.slot == c.slot && !v.releasing) release(v, g_slots[c.slot].p.fadeOutMs);
      break;
    case CMD_STOP:
      for (auto& v : V) if (v.active && (c.slot < 0 || v.slot == c.slot) && !v.releasing) release(v, g_slots[v.slot].p.fadeOutMs);
      break;
    case CMD_KILL:
      for (auto& v : V) if (v.active && v.slot == c.slot) v.active = false;
      break;
  }
}

static void audio_task(void*) {
  static float L[BLOCK_FRAMES], R[BLOCK_FRAMES];
  static int16_t out[BLOCK_FRAMES * 2];
  float mg = masterGain;
  for (;;) {
    Cmd c;
    while (xQueueReceive(cmdQ, &c, 0)) handle(c);
    memset(L, 0, sizeof L); memset(R, 0, sizeof R);
    uint32_t mask = 0; uint8_t n = 0;
    for (auto& v : V) if (v.active) { mask |= 1u << v.slot; n++; render(v, L, R); }
    playingMask = mask; voiceCount = n;

    float target = masterGain, dm = (target - mg) / BLOCK_FRAMES, pl = 0, pr = 0;
    for (int i = 0; i < BLOCK_FRAMES; i++) {
      float l = L[i] * mg, r = R[i] * mg;
      mg += dm;
      float al = fabsf(l), ar = fabsf(r);
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
      out[i * 2]     = l > 32767 ? 32767 : l < -32768 ? -32768 : (int16_t)l;
      out[i * 2 + 1] = r > 32767 ? 32767 : r < -32768 ? -32768 : (int16_t)r;
    }
    mg = target;
    pl /= 32768.0f; pr /= 32768.0f;
    if (pl > peakL) peakL = pl;
    if (pr > peakR) peakR = pr;
    size_t done;
    i2s_channel_write(tx, out, sizeof out, &done, portMAX_DELAY);   // paces the loop
    if (n) xTaskNotifyGive(streamTask);
  }
}

// ------------------------------------------------------------------ streamer

// Reads `frames` frames at the file's frame `at` into `dst` as stereo. Returns frames read.
static uint32_t read_frames(const Slot& s, uint32_t at, uint32_t frames, int16_t* dst, uint32_t dstAt, uint32_t dstMask) {
  uint32_t bpf = 2 * s.channels, done = 0;
  while (done < frames) {
    uint32_t off = s.dataOff + (at + done) * bpf;
    uint32_t bytes = (frames - done) * bpf;
    if (bytes > READ_BYTES) bytes = READ_BYTES;
    // end on a sector boundary when that leaves whole frames, so the next read starts aligned
    uint32_t alignedEnd = (off + bytes) & ~511u;
    if (alignedEnd > off && (alignedEnd - off) % bpf == 0 && off + bytes < s.dataOff + s.frames * bpf) bytes = alignedEnd - off;
    if (lseek(s.fd, off, SEEK_SET) < 0) break;
    int got = read(s.fd, readBuf, bytes);
    if (got <= 0) break;
    uint32_t n = got / bpf;
    const int16_t* src = (const int16_t*)readBuf;
    for (uint32_t i = 0; i < n; i++) {
      int16_t* d = dst + ((dstAt + done + i) & dstMask) * 2;
      if (s.channels == 2) { d[0] = src[i * 2]; d[1] = src[i * 2 + 1]; }
      else d[0] = d[1] = src[i];
    }
    done += n;
    if ((uint32_t)got < bytes) break;
  }
  return done;
}

static bool feed(Voice& v) {
  if (!v.active) return false;
  int slot = v.slot;
  if (slot < 0 || slot >= NUM_SLOTS) return false;
  const Slot& s = g_slots[slot];
  if (!s.loaded || s.frames <= s.headFrames) return false;
  uint32_t g = v.gen.load();
  if (v.streamGen.load() != g) {            // a new incarnation: start after the head
    v.w.store(0);
    v.fileFrame = s.headFrames;
    v.eof = false;
    v.streamGen.store(g);
  }
  if (v.eof) { if (!s.p.loop) return false; v.eof = false; v.fileFrame = 0; }
  uint32_t space = RING_FRAMES - (v.w.load() - v.rd.load());
  if (space > RING_FRAMES || space < RING_FRAMES / 4) return false;
  uint32_t n = s.frames - v.fileFrame;
  if (n > space) n = space;
  if (n > READ_BYTES / (2u * s.channels)) n = READ_BYTES / (2u * s.channels);
  uint32_t got = read_frames(s, v.fileFrame, n, v.ring, v.w.load(), RING_MASK);
  if (v.gen.load() != g) return true;       // retriggered meanwhile: this data is stale
  v.fileFrame += got;
  v.w.fetch_add(got);
  if (got < n || v.fileFrame >= s.frames) {
    if (s.p.loop && got) v.fileFrame = 0; else v.eof = true;
  }
  return got > 0;
}

static void stream_task(void*) {
  for (;;) {
    bool worked = false;
    xSemaphoreTake(streamMux, portMAX_DELAY);
    // the emptiest ring first
    Voice* pick = nullptr; uint32_t most = 0;
    for (auto& v : V) {
      if (!v.active) continue;
      uint32_t space = v.streamGen.load() != v.gen.load() ? RING_FRAMES : RING_FRAMES - (v.w.load() - v.rd.load());
      if (space <= RING_FRAMES && space >= most) { most = space; pick = &v; }
    }
    if (pick && feed(*pick)) worked = true;
    else for (auto& v : V) if (&v != pick && feed(v)) { worked = true; break; }
    xSemaphoreGive(streamMux);
    if (!worked) ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(5));
  }
}

// ------------------------------------------------------------------ public

void engine_play(int slot, uint8_t vel) {
  if (slot < 0 || slot >= NUM_SLOTS) return;
  Cmd c = { CMD_PLAY, (int8_t)slot, vel };
  xQueueSend(cmdQ, &c, 0);
}
void engine_release(int slot) {
  if (slot < 0 || slot >= NUM_SLOTS) return;
  Cmd c = { CMD_RELEASE, (int8_t)slot, 0 };
  xQueueSend(cmdQ, &c, 0);
}
void engine_stop(int slot) {
  if (slot >= NUM_SLOTS) return;
  Cmd c = { CMD_STOP, (int8_t)(slot < 0 ? -1 : slot), 0 };
  xQueueSend(cmdQ, &c, 0);
}

void engine_set_master_db(float db) {
  if (db > 12) db = 12;
  if (db < -90) db = -90;
  masterDb = db;
  masterGain = db <= -90 ? 0 : powf(10.0f, db / 20.0f);
}
float engine_master_db() { return masterDb; }

void engine_status(EngineStatus* st) {
  st->playingMask = playingMask;
  st->voices = voiceCount;
  st->underruns = underruns.load();
  st->peakL = peakL; st->peakR = peakR;
  peakL = peakR = 0;
}

bool engine_load_slot(int i, const char* file) {
  Slot& s = g_slots[i];
  // silence the slot, wait for its voices and for the streamer to let go of the file
  s.loaded = false;
  Cmd c = { CMD_KILL, (int8_t)i, 0 };
  xQueueSend(cmdQ, &c, portMAX_DELAY);
  for (int tries = 0; tries < 100; tries++) {
    bool busy = false;
    for (auto& v : V) if (v.active && v.slot == i) busy = true;
    if (!busy) break;
    vTaskDelay(pdMS_TO_TICKS(2));
  }
  xSemaphoreTake(streamMux, portMAX_DELAY);
  if (s.fd >= 0) { close(s.fd); s.fd = -1; }
  if (s.head) { heap_caps_free(s.head); s.head = nullptr; }
  s.file[0] = 0; s.err[0] = 0; s.frames = 0;

  bool ok = true;
  if (file && file[0]) {
    strlcpy(s.file, file, sizeof s.file);
    char path[96];
    WavInfo w;
    const char* err = "bad file name";
    ok = safe_name(file);
    if (ok) { snd_path(path, sizeof path, file); ok = wav_probe(path, &w, &err); }
    if (ok) {
      s.fd = open(path, O_RDONLY);
      s.dataOff = w.dataOff; s.frames = w.frames; s.rate = w.rate; s.channels = w.channels;
      s.headFrames = w.frames < HEAD_FRAMES ? w.frames : HEAD_FRAMES;
      s.head = (int16_t*)heap_caps_malloc(s.headFrames * 4, MALLOC_CAP_SPIRAM);
      if (s.fd < 0) { ok = false; err = "can't open file"; }
      else if (!s.head) { ok = false; err = "out of memory"; }
      else if (read_frames(s, 0, s.headFrames, s.head, 0, 0xFFFFFFFFu) != s.headFrames) { ok = false; err = "read error"; }
    }
    if (ok) s.loaded = true;
    else {
      strlcpy(s.err, err, sizeof s.err);
      if (s.fd >= 0) { close(s.fd); s.fd = -1; }
      if (s.head) { heap_caps_free(s.head); s.head = nullptr; }
    }
  }
  xSemaphoreGive(streamMux);
  return ok;
}

void engine_begin() {
  for (auto& s : g_slots) { s.fd = -1; s.p.note = 255; s.p.fadeOutMs = 20; }
  cmdQ = xQueueCreate(32, sizeof(Cmd));
  streamMux = xSemaphoreCreateMutex();
  readBuf = (uint8_t*)heap_caps_malloc(READ_BYTES, MALLOC_CAP_DMA);
  for (auto& v : V) {
    v.ring = (int16_t*)heap_caps_malloc(RING_FRAMES * 4, MALLOC_CAP_SPIRAM);
    v.slot = 0;
    if (!v.ring) log_e("no memory for a voice");
  }

  i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  cc.dma_desc_num = DMA_BLOCKS;
  cc.dma_frame_num = BLOCK_FRAMES;
  cc.auto_clear = true;
  ESP_ERROR_CHECK(i2s_new_channel(&cc, &tx, nullptr));
  i2s_std_config_t sc = {};
  sc.clk_cfg = (i2s_std_clk_config_t)I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE);
  sc.slot_cfg = (i2s_std_slot_config_t)I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
  sc.gpio_cfg.mclk = I2S_GPIO_UNUSED;
  sc.gpio_cfg.bclk = (gpio_num_t)PIN_I2S_BCLK;
  sc.gpio_cfg.ws = (gpio_num_t)PIN_I2S_WS;
  sc.gpio_cfg.dout = (gpio_num_t)PIN_I2S_DOUT;
  sc.gpio_cfg.din = I2S_GPIO_UNUSED;
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx, &sc));
  ESP_ERROR_CHECK(i2s_channel_enable(tx));

  // Both on core 1, away from WiFi; the mixer always pre-empts the streamer.
  xTaskCreatePinnedToCore(stream_task, "stream", 4096, nullptr, 12, &streamTask, 1);
  xTaskCreatePinnedToCore(audio_task, "audio", 4096, nullptr, 22, nullptr, 1);
}
