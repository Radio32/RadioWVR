#include "project.h"
#include "engine.h"
#include "storage.h"
#include <cJSON.h>
#include <esp_mac.h>

DeviceCfg g_device;
volatile int8_t g_pinSlot[14];

static SemaphoreHandle_t mux;
static char* text;                 // the project as saved
static volatile uint32_t rev;

static double num(const cJSON* o, const char* k, double def) {
  const cJSON* v = cJSON_GetObjectItemCaseSensitive(o, k);
  return cJSON_IsNumber(v) ? v->valuedouble : cJSON_IsBool(v) ? (cJSON_IsTrue(v) ? 1 : 0) : def;
}
static const char* str(const cJSON* o, const char* k, const char* def) {
  const cJSON* v = cJSON_GetObjectItemCaseSensitive(o, k);
  return cJSON_IsString(v) ? v->valuestring : def;
}
static float clampf(double v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : (float)v; }

// ------------------------------------------------------------------ device

static void device_defaults() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(g_device.name, sizeof g_device.name, "RadioWVR-%02X%02X", mac[4], mac[5]);
  strcpy(g_device.apPass, "12345678");
  g_device.staSsid[0] = g_device.staPass[0] = 0;
  g_device.oscPort = 8000;
  g_device.midiChannel = 0;
}

static bool device_parse(const char* json, char* err, size_t errn) {
  cJSON* o = cJSON_Parse(json);
  if (!o) { snprintf(err, errn, "not valid JSON"); return false; }
  const char* name = str(o, "name", g_device.name);
  const char* pass = str(o, "apPass", g_device.apPass);
  bool ok = true;
  size_t nl = strlen(name);
  if (nl < 1 || nl >= sizeof g_device.name) { snprintf(err, errn, "the name must be 1-23 characters"); ok = false; }
  for (size_t i = 0; ok && i < nl; i++)
    if (!(isalnum((unsigned char)name[i]) || name[i] == '-')) { snprintf(err, errn, "the name can use letters, digits and -"); ok = false; }
  if (ok && (strlen(pass) < 8 || strlen(pass) >= sizeof g_device.apPass)) { snprintf(err, errn, "the password must be 8-39 characters"); ok = false; }
  if (ok) {
    strlcpy(g_device.name, name, sizeof g_device.name);
    strlcpy(g_device.apPass, pass, sizeof g_device.apPass);
    strlcpy(g_device.staSsid, str(o, "staSsid", g_device.staSsid), sizeof g_device.staSsid);
    strlcpy(g_device.staPass, str(o, "staPass", g_device.staPass), sizeof g_device.staPass);
    g_device.oscPort = (int)clampf(num(o, "oscPort", g_device.oscPort), 1024, 65535);
    g_device.midiChannel = (uint8_t)clampf(num(o, "midiChannel", g_device.midiChannel), 0, 16);
  }
  cJSON_Delete(o);
  return ok;
}

char* device_json() {
  cJSON* o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "name", g_device.name);
  cJSON_AddStringToObject(o, "apPass", g_device.apPass);
  cJSON_AddStringToObject(o, "staSsid", g_device.staSsid);
  cJSON_AddStringToObject(o, "staPass", g_device.staPass);
  cJSON_AddNumberToObject(o, "oscPort", g_device.oscPort);
  cJSON_AddNumberToObject(o, "midiChannel", g_device.midiChannel);
  char* s = cJSON_PrintUnformatted(o);
  cJSON_Delete(o);
  return s;
}

void device_load() {
  device_defaults();
  char* s = read_text(DEVICE_FILE);
  if (!s) s = read_text(DEVICE_FILE ".new");
  char err[64];
  if (s) { device_parse(s, err, sizeof err); free(s); }
}

bool device_apply(const char* json, char* err, size_t errn) {
  if (!device_parse(json, err, errn)) return false;
  char* s = device_json();
  bool ok = s && write_text_atomic(DEVICE_FILE, s);
  free(s);
  if (!ok) snprintf(err, errn, "couldn't save to the eMMC");
  return ok;
}

// ------------------------------------------------------------------ project

static void apply_params(SlotParams& p, const cJSON* o) {
  p.gainDb = clampf(num(o, "gain", 0), -60, 12);
  p.pan = clampf(num(o, "pan", 0), -1, 1);
  p.pitch = clampf(num(o, "pitch", 0), -36, 36);
  p.fadeInMs = (uint16_t)clampf(num(o, "fadeIn", 0), 0, 60000);
  p.fadeOutMs = (uint16_t)clampf(num(o, "fadeOut", 20), 0, 60000);
  p.loop = num(o, "loop", 0) != 0;
  p.hold = num(o, "hold", 0) != 0;
  const char* r = str(o, "retrig", "overlap");
  p.retrig = !strcmp(r, "restart") ? RETRIG_RESTART : !strcmp(r, "toggle") ? RETRIG_TOGGLE : RETRIG_OVERLAP;
  p.group = (uint8_t)clampf(num(o, "group", 0), 0, 8);
  p.velSens = num(o, "vel", 0) != 0;
  double note = num(o, "note", -1);
  p.note = note >= 0 && note <= 127 ? (uint8_t)note : 255;
}

static void apply_pins(const cJSON* root) {
  int8_t map[14];
  for (auto& m : map) m = -1;
  const cJSON* pins = cJSON_GetObjectItemCaseSensitive(root, "pins");
  const cJSON* it;
  cJSON_ArrayForEach(it, pins) {
    int d = (int)num(it, "d", -1), slot = (int)num(it, "slot", 0);
    if (d < 3 || d > 13 || slot < 1 || slot > NUM_SLOTS) continue;   // D0/D1 serial, D2 USB MIDI
    map[d] = slot - 1;
  }
  for (int d = 3; d < 14; d++) {
    if (map[d] >= 0) pinMode(WVR_D[d], wvr_has_pullup(d) ? INPUT_PULLUP : INPUT);
    g_pinSlot[d] = map[d];
  }
}

static bool apply(const char* json, bool save, char* err, size_t errn) {
  cJSON* root = cJSON_Parse(json);
  if (!cJSON_IsObject(root)) { cJSON_Delete(root); snprintf(err, errn, "not valid JSON"); return false; }
  xSemaphoreTake(mux, portMAX_DELAY);
  const cJSON* slots = cJSON_GetObjectItemCaseSensitive(root, "slots");
  for (int i = 0; i < NUM_SLOTS; i++) {
    const cJSON* o = cJSON_GetArrayItem(slots, i);     // NULL past the end: an empty slot
    const char* file = o ? str(o, "file", "") : "";
    Slot& s = g_slots[i];
    if (strcmp(file, s.file)) engine_load_slot(i, file);
    cJSON empty = {}; empty.type = cJSON_Object;
    apply_params(s.p, o ? o : &empty);
  }
  apply_pins(root);
  engine_set_master_db(clampf(num(root, "master", 0), -90, 12));
  bool ok = true;
  if (save) {
    ok = write_text_atomic(PROJECT_FILE, json);
    if (!ok) snprintf(err, errn, "couldn't save to the eMMC");
  }
  if (ok) { free(text); text = strdup(json); rev = rev + 1; }
  xSemaphoreGive(mux);
  cJSON_Delete(root);
  return ok;
}

bool project_apply(const char* json, char* err, size_t errn) { return apply(json, true, err, errn); }

void project_begin() {
  mux = xSemaphoreCreateMutex();
  for (auto& m : g_pinSlot) m = -1;
  char err[64];
  char* s = read_text(PROJECT_FILE);
  if (!s) s = read_text(PROJECT_FILE ".new");      // a power cut between the two steps of a save
  if (!s || !apply(s, false, err, sizeof err)) apply("{\"name\":\"New project\",\"master\":0,\"slots\":[],\"pins\":[]}", false, err, sizeof err);
  free(s);
}

char* project_json() {
  xSemaphoreTake(mux, portMAX_DELAY);
  char* s = strdup(text ? text : "{}");
  xSemaphoreGive(mux);
  return s;
}

uint32_t project_rev() { return rev; }

bool project_live(int slot, const char* key, float v) {
  if (slot < 0 || slot >= NUM_SLOTS) return false;
  SlotParams& p = g_slots[slot].p;
  if (!strcmp(key, "gain")) p.gainDb = clampf(v, -60, 12);
  else if (!strcmp(key, "pan")) p.pan = clampf(v, -1, 1);
  else if (!strcmp(key, "pitch")) p.pitch = clampf(v, -36, 36);
  else if (!strcmp(key, "loop")) p.loop = v != 0;
  else if (!strcmp(key, "hold")) p.hold = v != 0;
  else if (!strcmp(key, "fadeIn")) p.fadeInMs = (uint16_t)clampf(v, 0, 60000);
  else if (!strcmp(key, "fadeOut")) p.fadeOutMs = (uint16_t)clampf(v, 0, 60000);
  else return false;
  return true;
}
