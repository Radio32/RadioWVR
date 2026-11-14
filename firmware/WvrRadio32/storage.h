// The eMMC as a FAT volume, WAV headers, and small files written safely.
#pragma once
#include <Arduino.h>

struct WavInfo {
  uint32_t rate;
  uint16_t channels;
  uint32_t dataOff;   // byte offset of the first sample
  uint32_t frames;
};

bool storage_begin();                          // mounts (formats a blank or foreign eMMC)
bool storage_ok();
void storage_space(uint64_t* total, uint64_t* free);

// Reads a WAV header. Only 16-bit PCM, mono or stereo, is accepted.
bool wav_probe(const char* path, WavInfo* out, const char** err);

// A sound's name on the device: letters, digits, . _ - and ending in .wav
bool safe_name(const char* name);
void snd_path(char* out, size_t n, const char* name);

char* read_text(const char* path);                     // malloc'd, or NULL
bool  write_text_atomic(const char* path, const char* text);
