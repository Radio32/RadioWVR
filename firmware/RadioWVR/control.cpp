#include "control.h"
#include "config.h"
#include "engine.h"
#include "project.h"
#include "synth.h"
#include <driver/uart.h>
#include <lwip/sockets.h>
#include <math.h>

// ------------------------------------------------------------------ OSC
//
//   /wvr/play  <slot> [velocity]     velocity 1-127, or 0.0-1.0
//   /wvr/stop  [slot]                no slot: everything
//   /wvr/stopall
//   /wvr/gain  <slot> <dB>           heard at once, not saved
//   /wvr/pan   <slot> <-1..1>
//   /wvr/pitch <slot> <semitones>
//   /wvr/master <dB>
// In synth mode:
//   /wvr/note <note> [velocity]     velocity 0 (or /wvr/off <note>) lets go
//   /wvr/off <note>
//   /wvr/set <key> <value>          any synth parameter, e.g. /wvr/set fc 800 (a string key)
// The slot may also be part of the address: /wvr/play/3. Slots count from 1.

static void osc_message(const uint8_t* b, int n) {
  // the address must end inside the packet; arguments (an int's last byte) need not end in 0
  if (n < 8 || b[0] != '/' || !memchr(b, 0, n)) return;   // (bundles start with '#': not handled)
  const char* addr = (const char*)b;
  int pos = (strlen(addr) + 4) & ~3;
  float arg[3]; int argc = 0;
  if (pos < n && b[pos] == ',') {
    const char* types = (const char*)b + pos + 1;
    pos += (strlen(types) + 1 + 4) & ~3;
    for (const char* t = types; *t && argc < 3; t++) {
      if (*t == 'i' || *t == 'f') {
        if (pos + 4 > n) return;
        uint32_t u = ((uint32_t)b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
        if (*t == 'i') arg[argc++] = (int32_t)u; else { float f; memcpy(&f, &u, 4); arg[argc++] = f; }
        pos += 4;
      } else if (*t == 's') {
        if (pos >= n) return;
        const char* s = (const char*)b + pos;
        arg[argc++] = atof(s);
        pos += (strlen(s) + 4) & ~3;
      } else if (*t == 'T') arg[argc++] = 1;
      else if (*t == 'F') arg[argc++] = 0;
    }
  }
  if (strncmp(addr, "/wvr/", 5)) return;
  if (synth_running()) {
    if (!strncmp(addr, "/wvr/set", 8)) {             // the key is a string: read it again
      int p2 = (strlen(addr) + 4) & ~3;
      if (p2 < n && b[p2] == ',' && b[p2 + 1] == 's') {
        int a = p2 + ((strlen((const char*)b + p2) + 4) & ~3);
        const char* key = (const char*)b + a;
        if (argc >= 2) synth_set(key, arg[1]);
      }
      return;
    }
    if (!strcmp(addr, "/wvr/note") && argc >= 1) {
      float v = argc >= 2 ? arg[1] : 100;
      if (argc >= 2 && v > 0 && v <= 1.0f) v *= 127;
      synth_note((int)arg[0], (int)v);
    } else if (!strcmp(addr, "/wvr/off") && argc >= 1) synth_note((int)arg[0], 0);
    else if (!strcmp(addr, "/wvr/stopall") || !strcmp(addr, "/wvr/stop")) synth_all_off();
    return;
  }
  char cmd[12];
  const char* rest = addr + 5;
  const char* slash = strchr(rest, '/');
  size_t cl = slash ? (size_t)(slash - rest) : strlen(rest);
  if (cl >= sizeof cmd) return;
  memcpy(cmd, rest, cl); cmd[cl] = 0;
  if (slash && argc < 3) {                              // /wvr/play/3: the slot goes first
    for (int i = argc; i > 0; i--) arg[i] = arg[i - 1];
    arg[0] = atoi(slash + 1); argc++;
  }
  int slot = argc ? (int)arg[0] - 1 : -1;
  if (!strcmp(cmd, "play") && argc >= 1) {
    float v = argc >= 2 ? arg[1] : 127;
    if (argc >= 2 && v <= 1.0f) v *= 127;
    engine_play(slot, v < 1 ? 1 : v > 127 ? 127 : (uint8_t)v);
  } else if (!strcmp(cmd, "stop")) engine_stop(argc ? slot : -1);
  else if (!strcmp(cmd, "stopall")) engine_stop(-1);
  else if (!strcmp(cmd, "master") && argc >= 1) engine_set_master_db(arg[0]);
  else if (argc >= 2) project_live(slot, cmd, arg[1]);  // gain, pan, pitch...
}

static void osc_task(void*) {
  int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  sockaddr_in a = {};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_ANY);
  a.sin_port = htons(g_device.oscPort);
  if (sock < 0 || bind(sock, (sockaddr*)&a, sizeof a) < 0) { log_e("OSC: can't open port %d", g_device.oscPort); vTaskDelete(nullptr); }
  static uint8_t buf[512];
  for (;;) {
    int n = recv(sock, buf, sizeof buf - 1, 0);
    if (n > 0) { buf[n] = 0; osc_message(buf, n); }
  }
}

// ------------------------------------------------------------------ MIDI

struct MidiIn { uint8_t status, data[2], need, have; };

static void midi_message(uint8_t status, uint8_t d1, uint8_t d2) {
  uint8_t ch = (status & 0x0F) + 1, kind = status & 0xF0;
  if (g_device.midiChannel && ch != g_device.midiChannel) return;
  if (synth_running()) { synth_midi(kind, d1, d2); return; }
  if (kind == 0x90 && d2 > 0) {
    for (int i = 0; i < NUM_SLOTS; i++) if (g_slots[i].p.note == d1) engine_play(i, d2);
  } else if (kind == 0x80 || kind == 0x90) {
    for (int i = 0; i < NUM_SLOTS; i++) if (g_slots[i].p.note == d1) engine_release(i);
  } else if (kind == 0xB0) {
    if (d1 == 7) engine_set_master_db(d2 ? 40.0f * log10f(d2 / 127.0f) : -90);
    else if (d1 == 120 || d1 == 123) engine_stop(-1);
  }
}

static void midi_byte(MidiIn& m, uint8_t b) {
  if (b >= 0xF8) return;                       // clock and other real-time bytes
  if (b & 0x80) {
    m.have = 0;
    if (b >= 0xF0) { m.status = 0; return; }   // system messages: ignored
    m.status = b;
    m.need = ((b & 0xE0) == 0xC0) ? 1 : 2;
    return;
  }
  if (!m.status) return;
  m.data[m.have++] = b;
  if (m.have == m.need) { midi_message(m.status, m.data[0], m.need == 2 ? m.data[1] : 0); m.have = 0; }
}

static void midi_task(void* arg) {
  uart_port_t port = (uart_port_t)(intptr_t)arg;
  MidiIn m = {};
  uint8_t buf[64];
  for (;;) {
    int n = uart_read_bytes(port, buf, 1, portMAX_DELAY);
    size_t more = 0;
    uart_get_buffered_data_len(port, &more);
    if (more > sizeof buf - 1) more = sizeof buf - 1;
    if (n > 0 && more) n += uart_read_bytes(port, buf + 1, more, 0);
    for (int i = 0; i < n; i++) midi_byte(m, buf[i]);
  }
}

static void midi_open(uart_port_t port, int rxPin, bool pullup) {
  uart_config_t c = {};
  c.baud_rate = 31250;
  c.data_bits = UART_DATA_8_BITS;
  c.parity = UART_PARITY_DISABLE;
  c.stop_bits = UART_STOP_BITS_1;
  c.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
  c.source_clk = UART_SCLK_DEFAULT;
  uart_driver_install(port, 1024, 0, 0, nullptr, 0);
  uart_param_config(port, &c);
  uart_set_pin(port, UART_PIN_NO_CHANGE, rxPin, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
  if (pullup) gpio_set_pull_mode((gpio_num_t)rxPin, GPIO_PULLUP_ONLY);
  uart_set_rx_full_threshold(port, 1);        // hand over every byte at once
  uart_set_rx_timeout(port, 1);
  xTaskCreatePinnedToCore(midi_task, "midi", 3072, (void*)(intptr_t)port, 15, nullptr, 0);
}

// ------------------------------------------------------------------ pins
// A pin taken to ground plays its slot; letting go releases it (for slots set to hold).

static void pins_task(void*) {
  uint8_t stable[14], count[14];
  memset(stable, 1, sizeof stable); memset(count, 0, sizeof count);
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(2));
    for (int d = 3; d < 14; d++) {
      int slot = g_pinSlot[d];
      if (slot < 0) { stable[d] = 1; count[d] = 0; continue; }
      uint8_t raw = digitalRead(WVR_D[d]) ? 1 : 0;
      if (raw == stable[d]) { count[d] = 0; continue; }
      if (++count[d] < 10) continue;            // 20 ms of agreement
      stable[d] = raw; count[d] = 0;
      if (raw == 0) engine_play(slot, 127); else engine_release(slot);
    }
  }
}

void control_begin() {
  midi_open(UART_NUM_2, PIN_MIDI_RX, false);      // DIN MIDI in
  midi_open(UART_NUM_1, WVR_D[2], true);          // USB host backpack, on D2
  if (!synth_running()) xTaskCreatePinnedToCore(pins_task, "pins", 3072, nullptr, 5, nullptr, 0);
  xTaskCreatePinnedToCore(osc_task, "osc", 4096, nullptr, 15, nullptr, 0);
}
