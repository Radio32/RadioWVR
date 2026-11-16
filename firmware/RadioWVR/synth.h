// Synth mode: a 6-voice synth with two oscillators per note, instead of the player.
// Only one of the two runs; which one is chosen at start-up (Device… > Mode).
#pragma once
#include <Arduino.h>

bool synth_begin();                       // starts the synth; false if it couldn't
bool synth_running();

// Playing. All of these can be called from any task.
void synth_note(int note, int vel);       // vel 0: note off
void synth_all_off();
void synth_midi(uint8_t kind, uint8_t d1, uint8_t d2);   // note on/off, CC, pitch bend (kind = status & 0xF0)

// The patch: parameters, the samples used as oscillators, and the MIDI learn map.
bool synth_set(const char* key, float value);            // heard at once; saved with the next save
bool synth_apply(const char* json, char* err, size_t n); // a whole patch: applied and saved
char* synth_json();                                      // malloc'd
uint32_t synth_rev();                                    // counts changes made on the WVR (MIDI knobs, learn)
bool synth_uses_file(const char* name);

// MIDI learn: the next controller moved is mapped to `key` ("" stops learning).
void synth_learn(const char* key);
void synth_forget(const char* key);
const char* synth_learning();

struct SynthStatus { float load, peakL, peakR; uint8_t voices; };
void synth_status(SynthStatus* st);
