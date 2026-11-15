#!/bin/sh
# Builds the firmware with the manager inside it.
#   ./build.sh                 compile only; the .bin for "Device… > Firmware" is in build/
#   ./build.sh /dev/cu.usbserial-XXXX    compile and flash over the FTDI adapter
cd "$(dirname "$0")" || exit 1
FQBN=esp32:esp32:esp32wrover:PartitionScheme=min_spiffs
python3 tools/embed.py || exit 1
arduino-cli compile --fqbn "$FQBN" --output-dir build firmware/RadioWVR || exit 1
echo "Firmware: build/RadioWVR.ino.bin"
if [ -n "$1" ]; then arduino-cli upload --fqbn "$FQBN" --port "$1" --input-dir build firmware/RadioWVR; fi
