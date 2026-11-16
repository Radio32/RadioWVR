// RadioWVR: a cue player for the WVR board, or a synth. See README.md.
#include "config.h"
#include "storage.h"
#include "engine.h"
#include "project.h"
#include "net.h"
#include "control.h"
#include "synth.h"
#include <esp_ota_ops.h>
#include <esp_system.h>

/*
 * A way back without a serial cable. The flash holds two firmwares: this one and the one
 * that was running before it was installed. If this one crashes three times in a row before
 * it has run for 20 seconds, the device starts the previous one again.
 * Only crashes count: switching the power off and on never triggers it.
 */
RTC_NOINIT_ATTR static uint32_t crashMagic;
RTC_NOINIT_ATTR static uint32_t crashCount;
#define CRASH_MAGIC 0x57565232
static bool settled = false;

static void crash_guard() {
  esp_reset_reason_t why = esp_reset_reason();
  bool crashed = why == ESP_RST_PANIC || why == ESP_RST_INT_WDT || why == ESP_RST_TASK_WDT || why == ESP_RST_WDT;
  if (crashMagic != CRASH_MAGIC || !crashed) { crashMagic = CRASH_MAGIC; crashCount = 0; return; }
  if (++crashCount < 3) return;
  crashCount = 0;
  const esp_partition_t* other = esp_ota_get_next_update_partition(nullptr);
  esp_app_desc_t desc;
  if (other && esp_ota_get_partition_description(other, &desc) == ESP_OK && esp_ota_set_boot_partition(other) == ESP_OK) {
    Serial.println("Three crashes at startup: going back to the previous firmware.");
    delay(100);
    ESP.restart();
  }
}

void setup() {
  Serial.begin(115200);
  Serial.printf("\nRadioWVR %s\n", FW_VERSION);
  crash_guard();
  if (!storage_begin()) Serial.println("The eMMC could not be mounted: no sounds, settings are not kept.");
  device_load();
  // Theatre mode (the player) and synth mode never run together: the one not chosen isn't
  // started at all, so it can't take memory or time from the other.
  if (g_device.mode == MODE_SYNTH) {
    Serial.println("Synth mode");
    if (!synth_begin()) Serial.println("The synth could not start.");
  } else {
    engine_begin();
    project_begin();
  }
  net_begin();
  control_begin();
  Serial.printf("WiFi \"%s\"  http://192.168.5.18  http://%s.local  OSC port %d\n", g_device.name, g_device.name, g_device.oscPort);
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));
  if (!settled && millis() > 20000) { settled = true; crashCount = 0; }
}
