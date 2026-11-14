#include "storage.h"
#include "config.h"
#include <esp_vfs_fat.h>
#include <sdmmc_cmd.h>
#include <driver/sdmmc_host.h>
#include <sys/stat.h>
#include <unistd.h>

static bool mounted = false;
static sdmmc_card_t* card = nullptr;

static esp_err_t mount_at(int khz) {
  sdmmc_host_t host = SDMMC_HOST_DEFAULT();
  host.flags = SDMMC_HOST_FLAG_4BIT;
  host.max_freq_khz = khz;
  sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
  slot.width = 4;
  slot.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
  esp_vfs_fat_sdmmc_mount_config_t mc = {};
  mc.format_if_mount_failed = true;      // a WVR with the original firmware has no file system
  mc.max_files = NUM_SLOTS + 8;
  mc.allocation_unit_size = 64 * 1024;   // large clusters: long contiguous runs, few FAT reads
  return esp_vfs_fat_sdmmc_mount(MOUNT, &host, &slot, &mc, &card);
}

bool storage_begin() {
  esp_err_t e = mount_at(SDMMC_FREQ_52M);
  if (e != ESP_OK) {
    log_w("eMMC at 52 MHz: %s; trying 20 MHz", esp_err_to_name(e));
    e = mount_at(SDMMC_FREQ_DEFAULT);
  }
  if (e != ESP_OK) { log_e("eMMC mount failed: %s", esp_err_to_name(e)); return false; }
  mounted = true;
  mkdir(SND_DIR, 0777);
  return true;
}

bool storage_ok() { return mounted; }

void storage_space(uint64_t* total, uint64_t* free) {
  *total = *free = 0;
  if (mounted) esp_vfs_fat_info(MOUNT, total, free);
}

static uint32_t le32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint16_t le16(const uint8_t* p) { return p[0] | (p[1] << 8); }

bool wav_probe(const char* path, WavInfo* out, const char** err) {
  static const char* dummy; if (!err) err = &dummy;
  FILE* f = fopen(path, "rb");
  if (!f) { *err = "file not found"; return false; }
  uint8_t b[40];
  bool haveFmt = false, ok = false;
  uint16_t format = 0, bits = 0;
  *err = "not a WAV file";
  if (fread(b, 1, 12, f) == 12 && !memcmp(b, "RIFF", 4) && !memcmp(b + 8, "WAVE", 4)) {
    long pos = 12;
    *err = "no audio data";
    while (fseek(f, pos, SEEK_SET) == 0 && fread(b, 1, 8, f) == 8) {
      uint32_t len = le32(b + 4);
      if (!memcmp(b, "fmt ", 4) && len >= 16) {
        size_t n = len < 40 ? len : 40;
        if (fread(b, 1, n, f) != n) break;
        format = le16(b); out->channels = le16(b + 2); out->rate = le32(b + 4); bits = le16(b + 14);
        if (format == 0xFFFE && n >= 26) format = le16(b + 24);
        haveFmt = true;
      } else if (!memcmp(b, "data", 4)) {
        if (!haveFmt) break;
        if (format != 1 || bits != 16) { *err = "must be 16-bit PCM"; break; }
        if (out->channels < 1 || out->channels > 2) { *err = "must be mono or stereo"; break; }
        if (out->rate < 8000 || out->rate > 96000) { *err = "unsupported sample rate"; break; }
        fseek(f, 0, SEEK_END);
        long size = ftell(f);
        long avail = size - (pos + 8);
        if ((long)len > avail) len = avail > 0 ? avail : 0;
        out->dataOff = pos + 8;
        out->frames = len / (2 * out->channels);
        if (!out->frames) { *err = "empty file"; break; }
        ok = true;
        break;
      }
      pos += 8 + len + (len & 1);
    }
  }
  fclose(f);
  return ok;
}

bool safe_name(const char* s) {
  size_t n = strlen(s);
  if (n < 5 || n >= FILE_NAME_MAX || s[0] == '.') return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!(isalnum((unsigned char)c) || c == '.' || c == '_' || c == '-')) return false;
  }
  return !strcasecmp(s + n - 4, ".wav");
}

void snd_path(char* out, size_t n, const char* name) { snprintf(out, n, SND_DIR "/%s", name); }

char* read_text(const char* path) {
  FILE* f = fopen(path, "rb");
  if (!f) return nullptr;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char* s = (n >= 0 && n < 256 * 1024) ? (char*)malloc(n + 1) : nullptr;
  if (s) { size_t got = fread(s, 1, n, f); s[got] = 0; }
  fclose(f);
  return s;
}

// Writes beside the file, then swaps: a power cut leaves the old or the new text, never half.
bool write_text_atomic(const char* path, const char* text) {
  char tmp[80];
  snprintf(tmp, sizeof tmp, "%s.new", path);
  FILE* f = fopen(tmp, "wb");
  if (!f) return false;
  size_t n = strlen(text);
  bool ok = fwrite(text, 1, n, f) == n;
  ok = fflush(f) == 0 && ok;
  fsync(fileno(f));
  fclose(f);
  if (!ok) { unlink(tmp); return false; }
  unlink(path);
  return rename(tmp, path) == 0;
}
