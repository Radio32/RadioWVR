// The sound engine: slots (the sounds of a project), voices (sounds playing now),
// the mixer and the streamer that feeds it from the eMMC.
#pragma once
#include <Arduino.h>
#include "config.h"

enum { RETRIG_OVERLAP = 0, RETRIG_RESTART = 1, RETRIG_TOGGLE = 2 };

// Everything here can be changed while the sound plays.
struct SlotParams {
  volatile float gainDb;       // -60..+12
  volatile float pan;          // -1..+1 (balance for stereo files)
  volatile float pitch;        // semitones
  volatile uint16_t fadeInMs, fadeOutMs;
  volatile uint8_t loop;       // repeat until stopped
  volatile uint8_t hold;       // stop when the key, pin or note is released
  volatile uint8_t retrig;     // what a trigger does while the slot already plays
  volatile uint8_t group;      // 1..8: starting one sound of a group stops the others
  volatile uint8_t velSens;    // MIDI velocity sets the level
  volatile uint8_t note;       // MIDI note that triggers the slot (255 = none)
};

struct Slot {
  volatile bool loaded;
  char file[FILE_NAME_MAX];    // name in /sd/snd, "" when empty
  char err[40];                // why the file couldn't be loaded
  int fd;
  float startSec, endSec;      // the part of the file that plays, as asked for (end 0: to the end)
  uint32_t startFrame;         // where that part begins in the file
  uint32_t dataOff, frames, rate;   // frames: the length of that part
  uint16_t channels;
  int16_t* head;               // the first headFrames frames, as stereo
  uint32_t headFrames;
  uint32_t edge;               // frames in EDGE_MS: the fade at the end, the cross-fade of a loop
  SlotParams p;
};

extern Slot g_slots[NUM_SLOTS];

struct EngineStatus {
  uint32_t playingMask;        // bit n: slot n is sounding
  float peakL, peakR;          // 0..1 since the last call
  uint32_t underruns;          // times a voice waited for the eMMC
  uint8_t voices;
};

void engine_begin();
void engine_play(int slot, uint8_t velocity);   // slots are 0-based here
void engine_release(int slot);                  // key/pin up: stops the slot if it is set to hold
void engine_stop(int slot);                     // -1: everything
// "" empties the slot. Plays the file from startSec to endSec (0: to the end).
bool engine_load_slot(int slot, const char* file, float startSec, float endSec);
void engine_set_master_db(float db);
float engine_master_db();
void engine_status(EngineStatus* st);
