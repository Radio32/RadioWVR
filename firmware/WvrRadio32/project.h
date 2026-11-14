// The project (the sounds, their settings and the pin triggers) and the device's own settings.
// Both are JSON files on the eMMC; the manager reads and writes them whole.
#pragma once
#include <Arduino.h>
#include "config.h"

struct DeviceCfg {
  char name[24];        // WiFi network name and http://<name>.local
  char apPass[40];      // at least 8 characters
  char staSsid[33];     // an existing network to join as well ("" = none)
  char staPass[64];
  int oscPort;
  uint8_t midiChannel;  // 0 = all
};
extern DeviceCfg g_device;
extern volatile int8_t g_pinSlot[14];   // D-pin -> slot (0-based), -1 = unused

void device_load();
bool device_apply(const char* json, char* err, size_t errn);   // saves; WiFi changes need a restart
char* device_json();                                           // malloc'd

void project_begin();                                          // loads the saved project
bool project_apply(const char* json, char* err, size_t errn);  // validates, applies live, saves
char* project_json();                                          // malloc'd copy of the saved text
uint32_t project_rev();                                        // counts saved changes

// A change that is heard at once but not saved (a slider being dragged, OSC, MIDI).
// slot is 0-based; key is one of gain, pan, pitch, loop, hold, fadeIn, fadeOut.
bool project_live(int slot, const char* key, float value);
