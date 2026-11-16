// The I2S output to the WVR's DAC, shared by the player and the synth (only one of them runs).
#pragma once
#include <driver/i2s_std.h>

// Opens the DAC at SAMPLE_RATE, 16-bit stereo, with `blocks` DMA buffers of `frames` frames.
i2s_chan_handle_t audio_out_begin(int frames, int blocks);
