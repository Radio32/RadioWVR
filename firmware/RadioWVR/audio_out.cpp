#include "audio_out.h"
#include "config.h"
#include <Arduino.h>

i2s_chan_handle_t audio_out_begin(int frames, int blocks) {
  i2s_chan_handle_t tx;
  i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  cc.dma_desc_num = blocks;
  cc.dma_frame_num = frames;
  cc.auto_clear = true;
  ESP_ERROR_CHECK(i2s_new_channel(&cc, &tx, nullptr));
  i2s_std_config_t sc = {};
  sc.clk_cfg = (i2s_std_clk_config_t)I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE);
  sc.slot_cfg = (i2s_std_slot_config_t)I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
  sc.gpio_cfg.mclk = I2S_GPIO_UNUSED;
  sc.gpio_cfg.bclk = (gpio_num_t)PIN_I2S_BCLK;
  sc.gpio_cfg.ws = (gpio_num_t)PIN_I2S_WS;
  sc.gpio_cfg.dout = (gpio_num_t)PIN_I2S_DOUT;
  sc.gpio_cfg.din = I2S_GPIO_UNUSED;
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx, &sc));
  ESP_ERROR_CHECK(i2s_channel_enable(tx));
  return tx;
}
