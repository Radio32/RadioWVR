// Board and engine constants for the WVR (ESP32-WROVER, 8 GB eMMC, I2S DAC).
#pragma once
#include <stdint.h>

#define FW_VERSION "0.2.0"

// ---- audio
#define SAMPLE_RATE   44100
#define BLOCK_FRAMES  128     // frames mixed per pass (2.9 ms)
#define DMA_BLOCKS    2       // I2S queue depth in blocks: output latency is 1-2 blocks
#define NUM_VOICES    8       // sounds playing at once
#define NUM_SLOTS     16      // sounds in a project
#define HEAD_FRAMES   4096    // start of every sound kept in RAM (93 ms): a trigger never waits for the eMMC
#define RING_FRAMES   8192    // per-voice stream buffer, a power of two (186 ms)
#define SYNTH_SAMPLE_MAX 1000000   // frames of a sample used as an oscillator (22 s, 2 MB of PSRAM)
#define EDGE_MS       2       // shortest fade in, fade at the end of a sound, cross-fade where a loop joins

// ---- WiFi
#define AP_IP         192, 168, 5, 18    // the WVR's own network: the address printed on the board
#define WIFI_TX_POWER WIFI_POWER_11dBm   // a room or a stage; full power resets the WVR as WiFi starts
#define READ_BYTES    8192    // eMMC read size, a multiple of 512

// ---- pins (ESP32 GPIO numbers)
#define PIN_I2S_BCLK  26
#define PIN_I2S_WS    25
#define PIN_I2S_DOUT  22
#define PIN_MIDI_RX   23      // the WVR's opto-isolated MIDI input

// The WVR's D0..D13 header as GPIO numbers. D0/D1 are the serial port (FTDI).
static const int8_t WVR_D[14] = { 3, 1, 21, 19, 18, 5, 0, 36, 39, 34, 35, 32, 33, 27 };
// D7..D10 are input-only and have no internal pull-up.
static inline bool wvr_has_pullup(int d) { return !(d >= 7 && d <= 10); }

// ---- storage
#define MOUNT         "/sd"
#define SND_DIR       MOUNT "/snd"
#define PROJECT_FILE  MOUNT "/project.json"
#define DEVICE_FILE   MOUNT "/device.json"
#define SYNTH_FILE    MOUNT "/synth.json"
#define FILE_NAME_MAX 48
