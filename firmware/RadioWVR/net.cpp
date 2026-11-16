#include "net.h"
#include "config.h"
#include "engine.h"
#include "project.h"
#include "storage.h"
#include "web_bundle.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Update.h>
#include <esp_http_server.h>
#include <esp_heap_caps.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

/*
 *  GET    /                      the manager
 *  GET    /api/state             device, files and the project
 *  GET    /api/status            what is playing, levels, errors (polled)
 *  PUT    /api/project           the whole project as JSON: applied live and saved
 *  PUT    /api/device            device settings as JSON (WiFi changes take a restart)
 *  GET|PUT|DELETE /api/file?name=x.wav
 *  POST   /api/play?slot=N[&vel=V]     POST /api/stop[?slot=N]
 *  POST   /api/live?slot=N&k=gain&v=-6   heard at once, not saved (k=master needs no slot)
 *  POST   /api/update            a firmware .bin; restarts
 *  POST   /api/restart
 */

static uint8_t* ioBuf;     // DMA-capable, for file transfers
#define IO_BYTES 8192

static void cors(httpd_req_t* r) {
  httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(r, "Cache-Control", "no-store");
}
static esp_err_t reply(httpd_req_t* r, const char* status, const char* json) {
  cors(r);
  httpd_resp_set_status(r, status);
  httpd_resp_set_type(r, "application/json");
  return httpd_resp_sendstr(r, json);
}
static esp_err_t ok(httpd_req_t* r) { return reply(r, "200 OK", "{\"ok\":true}"); }
static esp_err_t fail(httpd_req_t* r, const char* status, const char* msg) {
  char b[160];
  snprintf(b, sizeof b, "{\"ok\":false,\"error\":\"%s\"}", msg);
  return reply(r, status, b);
}

static bool query(httpd_req_t* r, const char* key, char* out, size_t n) {
  char q[160];
  out[0] = 0;
  return httpd_req_get_url_query_str(r, q, sizeof q) == ESP_OK && httpd_query_key_value(q, key, out, n) == ESP_OK;
}
static int query_int(httpd_req_t* r, const char* key, int def) {
  char v[16];
  return query(r, key, v, sizeof v) ? atoi(v) : def;
}

static char* body(httpd_req_t* r, size_t max) {
  size_t n = r->content_len;
  if (!n || n > max) return nullptr;
  char* s = (char*)malloc(n + 1);
  if (!s) return nullptr;
  size_t got = 0;
  while (got < n) {
    int k = httpd_req_recv(r, s + got, n - got);
    if (k <= 0) { if (k == HTTPD_SOCK_ERR_TIMEOUT) continue; free(s); return nullptr; }
    got += k;
  }
  s[n] = 0;
  return s;
}

// ------------------------------------------------------------------ pages and state

static esp_err_t h_index(httpd_req_t* r) {
  httpd_resp_set_type(r, "text/html; charset=utf-8");
  httpd_resp_set_hdr(r, "Content-Encoding", "gzip");
  httpd_resp_set_hdr(r, "Cache-Control", "no-cache");
  return httpd_resp_send(r, (const char*)WEB_BUNDLE, WEB_BUNDLE_LEN);
}

static esp_err_t h_options(httpd_req_t* r) {
  cors(r);
  httpd_resp_set_hdr(r, "Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  httpd_resp_set_hdr(r, "Access-Control-Allow-Headers", "Content-Type");
  httpd_resp_set_status(r, "204 No Content");
  return httpd_resp_send(r, nullptr, 0);
}

static esp_err_t h_state(httpd_req_t* r) {
  uint64_t total, free_;
  storage_space(&total, &free_);
  String s;
  s.reserve(4096);
  s += "{\"fw\":\"" FW_VERSION "\",\"slots\":" + String(NUM_SLOTS) + ",\"voices\":" + String(NUM_VOICES);
  s += ",\"storage\":" + String(storage_ok() ? "true" : "false");
  s += ",\"space\":{\"total\":" + String(total) + ",\"free\":" + String(free_) + "}";
  s += ",\"ip\":{\"ap\":\"" + WiFi.softAPIP().toString() + "\",\"sta\":\"" + (WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("")) + "\"}";
  char* d = device_json();
  s += ",\"device\":"; s += d ? d : "{}"; free(d);
  s += ",\"files\":[";
  DIR* dir = opendir(SND_DIR);
  bool first = true;
  if (dir) {
    while (dirent* e = readdir(dir)) {
      if (!safe_name(e->d_name)) continue;
      char path[96]; struct stat st;
      snd_path(path, sizeof path, e->d_name);
      if (stat(path, &st)) continue;
      if (!first) s += ",";
      first = false;
      s += "{\"name\":\""; s += e->d_name; s += "\",\"size\":" + String((uint32_t)st.st_size) + "}";
    }
    closedir(dir);
  }
  s += "],\"rev\":" + String(project_rev());
  char* p = project_json();
  s += ",\"project\":"; s += p; free(p);
  s += "}";
  cors(r);
  httpd_resp_set_type(r, "application/json");
  return httpd_resp_send(r, s.c_str(), s.length());
}

static esp_err_t h_status(httpd_req_t* r) {
  EngineStatus st;
  engine_status(&st);
  String s;
  s.reserve(512);
  s += "{\"rev\":" + String(project_rev()) + ",\"playing\":[";
  bool first = true;
  for (int i = 0; i < NUM_SLOTS; i++) if (st.playingMask & (1u << i)) { if (!first) s += ","; first = false; s += String(i + 1); }
  s += "],\"peak\":[" + String(st.peakL, 4) + "," + String(st.peakR, 4) + "]";
  s += ",\"voices\":" + String(st.voices) + ",\"under\":" + String(st.underruns);
  s += ",\"master\":" + String(engine_master_db(), 1);
  s += ",\"heap\":" + String(heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
  s += ",\"errors\":{";
  first = true;
  for (int i = 0; i < NUM_SLOTS; i++) if (g_slots[i].err[0]) {
    if (!first) s += ",";
    first = false;
    s += "\"" + String(i + 1) + "\":\"" + g_slots[i].err + "\"";
  }
  s += "}}";
  cors(r);
  httpd_resp_set_type(r, "application/json");
  return httpd_resp_send(r, s.c_str(), s.length());
}

// ------------------------------------------------------------------ project and device

static esp_err_t h_project(httpd_req_t* r) {
  char* b = body(r, 128 * 1024);
  if (!b) return fail(r, "400 Bad Request", "no project, or too large");
  char err[64] = "";
  bool good = project_apply(b, err, sizeof err);
  free(b);
  if (!good) return fail(r, "400 Bad Request", err);
  char out[48];
  snprintf(out, sizeof out, "{\"ok\":true,\"rev\":%u}", (unsigned)project_rev());
  return reply(r, "200 OK", out);
}

static esp_err_t h_device(httpd_req_t* r) {
  char* b = body(r, 2048);
  if (!b) return fail(r, "400 Bad Request", "no settings");
  char err[64] = "";
  bool good = device_apply(b, err, sizeof err);
  free(b);
  return good ? ok(r) : fail(r, "400 Bad Request", err);
}

// ------------------------------------------------------------------ files

static bool in_use(const char* name) {
  for (auto& s : g_slots) if (!strcmp(s.file, name)) return true;
  return false;
}

static esp_err_t h_file_put(httpd_req_t* r) {
  char name[FILE_NAME_MAX], path[96];
  if (!query(r, "name", name, sizeof name) || !safe_name(name)) return fail(r, "400 Bad Request", "bad file name");
  if (in_use(name)) return fail(r, "409 Conflict", "a slot is using this file");
  uint64_t total, free_;
  storage_space(&total, &free_);
  if ((uint64_t)r->content_len + (1 << 20) > free_) return fail(r, "507 Insufficient Storage", "the eMMC is full");
  const char* tmp = SND_DIR "/_upload.tmp";
  FILE* f = fopen(tmp, "wb");
  if (!f) return fail(r, "500 Internal Server Error", "can't write to the eMMC");
  setvbuf(f, nullptr, _IONBF, 0);
  size_t left = r->content_len;
  bool good = true;
  while (left && good) {
    size_t fill = 0, want = left < IO_BYTES ? left : IO_BYTES;
    while (fill < want) {                       // whole sectors per write
      int k = httpd_req_recv(r, (char*)ioBuf + fill, want - fill);
      if (k == HTTPD_SOCK_ERR_TIMEOUT) continue;
      if (k <= 0) { good = false; break; }
      fill += k;
    }
    if (good && fwrite(ioBuf, 1, fill, f) != fill) good = false;
    left -= fill;
  }
  fclose(f);
  snd_path(path, sizeof path, name);
  WavInfo w; const char* err = "upload interrupted";
  if (good) good = wav_probe(tmp, &w, &err);
  if (good) { unlink(path); good = rename(tmp, path) == 0; err = "can't write to the eMMC"; }
  if (!good) { unlink(tmp); return fail(r, "400 Bad Request", err); }
  char out[128];
  snprintf(out, sizeof out, "{\"ok\":true,\"frames\":%u,\"rate\":%u,\"channels\":%u}", (unsigned)w.frames, (unsigned)w.rate, (unsigned)w.channels);
  return reply(r, "200 OK", out);
}

static esp_err_t h_file_get(httpd_req_t* r) {
  char name[FILE_NAME_MAX], path[96];
  if (!query(r, "name", name, sizeof name) || !safe_name(name)) return fail(r, "400 Bad Request", "bad file name");
  snd_path(path, sizeof path, name);
  FILE* f = fopen(path, "rb");
  if (!f) return fail(r, "404 Not Found", "no such file");
  cors(r);
  httpd_resp_set_type(r, "audio/wav");
  size_t n;
  esp_err_t e = ESP_OK;
  while (e == ESP_OK && (n = fread(ioBuf, 1, IO_BYTES, f)) > 0) e = httpd_resp_send_chunk(r, (const char*)ioBuf, n);
  fclose(f);
  if (e == ESP_OK) httpd_resp_send_chunk(r, nullptr, 0);
  return e;
}

static esp_err_t h_file_delete(httpd_req_t* r) {
  char name[FILE_NAME_MAX], path[96];
  if (!query(r, "name", name, sizeof name) || !safe_name(name)) return fail(r, "400 Bad Request", "bad file name");
  if (in_use(name)) return fail(r, "409 Conflict", "a slot is using this file");
  snd_path(path, sizeof path, name);
  unlink(path);
  return ok(r);
}

// ------------------------------------------------------------------ playing

static esp_err_t h_play(httpd_req_t* r) {
  int slot = query_int(r, "slot", 0), vel = query_int(r, "vel", 127);
  if (slot < 1 || slot > NUM_SLOTS) return fail(r, "400 Bad Request", "no such slot");
  engine_play(slot - 1, vel < 1 ? 1 : vel > 127 ? 127 : vel);
  return ok(r);
}
static esp_err_t h_stop(httpd_req_t* r) {
  engine_stop(query_int(r, "slot", 0) - 1);
  return ok(r);
}
static esp_err_t h_live(httpd_req_t* r) {
  char k[16], v[24];
  if (!query(r, "k", k, sizeof k) || !query(r, "v", v, sizeof v)) return fail(r, "400 Bad Request", "k and v are needed");
  if (!strcmp(k, "master")) { engine_set_master_db(atof(v)); return ok(r); }
  return project_live(query_int(r, "slot", 0) - 1, k, atof(v)) ? ok(r) : fail(r, "400 Bad Request", "unknown slot or setting");
}

// ------------------------------------------------------------------ firmware

static void restart_task(void*) { vTaskDelay(pdMS_TO_TICKS(500)); ESP.restart(); }
static void restart_soon() { xTaskCreate(restart_task, "restart", 2048, nullptr, 5, nullptr); }

static esp_err_t h_restart(httpd_req_t* r) { ok(r); restart_soon(); return ESP_OK; }

static esp_err_t h_update(httpd_req_t* r) {
  size_t left = r->content_len;
  if (left < 100000) return fail(r, "400 Bad Request", "that is not a firmware file");
  engine_stop(-1);
  if (!Update.begin(left)) return fail(r, "400 Bad Request", "the firmware doesn't fit");
  bool good = true, first = true;
  while (left && good) {
    int k = httpd_req_recv(r, (char*)ioBuf, left < IO_BYTES ? left : IO_BYTES);
    if (k == HTTPD_SOCK_ERR_TIMEOUT) continue;
    if (k <= 0) { good = false; break; }
    if (first && ioBuf[0] != 0xE9) { good = false; break; }   // every ESP32 image starts with 0xE9
    first = false;
    if (Update.write(ioBuf, k) != (size_t)k) good = false;
    left -= k;
  }
  if (!good || !Update.end(true)) { Update.abort(); return fail(r, "400 Bad Request", "the update failed; the old firmware is kept"); }
  ok(r);
  restart_soon();
  return ESP_OK;
}

// ------------------------------------------------------------------ start

static void route(httpd_handle_t srv, const char* uri, httpd_method_t m, esp_err_t (*fn)(httpd_req_t*)) {
  httpd_uri_t u = {};
  u.uri = uri; u.method = m; u.handler = fn;
  httpd_register_uri_handler(srv, &u);
}

void net_begin() {
  ioBuf = (uint8_t*)heap_caps_malloc(IO_BYTES, MALLOC_CAP_DMA);

  String host = g_device.name;
  host.toLowerCase();
  bool sta = g_device.staSsid[0] != 0;
  WiFi.persistent(false);
  // say on the serial port whether the other network was joined, and if not, why
  WiFi.onEvent([](arduino_event_id_t e, arduino_event_info_t info) {
    if (e == ARDUINO_EVENT_WIFI_STA_GOT_IP)
      Serial.printf("Joined \"%s\" as http://%s\n", g_device.staSsid, WiFi.localIP().toString().c_str());
    else if (e == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      static uint8_t last = 0;
      uint8_t why = info.wifi_sta_disconnected.reason;
      if (why != last)        // it retries every few seconds; say each reason once
        Serial.printf("Can't join \"%s\": %s (%u)\n", g_device.staSsid,
          why == WIFI_REASON_NO_AP_FOUND ? "network not found (it must be 2.4 GHz)" :
          why == WIFI_REASON_AUTH_FAIL || why == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT || why == WIFI_REASON_HANDSHAKE_TIMEOUT ? "wrong password?" :
          "refused", why);
      last = why;
    }
  });
  WiFi.setHostname(host.c_str());
  WiFi.mode(sta ? WIFI_AP_STA : WIFI_AP);
  WiFi.softAP(g_device.name, g_device.apPass);
  if (sta) WiFi.begin(g_device.staSsid, g_device.staPass);
  WiFi.setSleep(false);                       // no power saving: it delays incoming triggers
  if (MDNS.begin(host.c_str())) MDNS.addService("http", "tcp", 80);

  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.uri_match_fn = httpd_uri_match_wildcard;
  cfg.max_uri_handlers = 20;
  cfg.stack_size = 10240;
  cfg.lru_purge_enable = true;
  cfg.recv_wait_timeout = 15;
  cfg.send_wait_timeout = 15;
  cfg.core_id = 0;
  httpd_handle_t srv = nullptr;
  if (httpd_start(&srv, &cfg) != ESP_OK) { log_e("the web server didn't start"); return; }
  route(srv, "/", HTTP_GET, h_index);
  route(srv, "/api/state", HTTP_GET, h_state);
  route(srv, "/api/status", HTTP_GET, h_status);
  route(srv, "/api/project", HTTP_PUT, h_project);
  route(srv, "/api/device", HTTP_PUT, h_device);
  route(srv, "/api/file", HTTP_GET, h_file_get);
  route(srv, "/api/file", HTTP_PUT, h_file_put);
  route(srv, "/api/file", HTTP_DELETE, h_file_delete);
  route(srv, "/api/play", HTTP_POST, h_play);
  route(srv, "/api/stop", HTTP_POST, h_stop);
  route(srv, "/api/live", HTTP_POST, h_live);
  route(srv, "/api/update", HTTP_POST, h_update);
  route(srv, "/api/restart", HTTP_POST, h_restart);
  route(srv, "/api/*", HTTP_OPTIONS, h_options);
}
