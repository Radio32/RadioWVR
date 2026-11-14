# WVR Radio32

New firmware and a manager for the [WVR](https://github.com/marchingband/wvr) audio board
(ESP32-WROVER, 8 GB eMMC, I2S DAC), written from scratch for theatre work: a few sounds per
device, triggered over WiFi, MIDI or pins, set up from a web page that anyone can use.

It does not read the original firmware's storage. The first start formats the eMMC.

**Try the manager without a WVR:** https://radio32.github.io/Wvr_Radio32/ (a demo: the sounds
play in the browser and nothing leaves it).

**Status: 0.1.0, the cue player. It compiles and the manager is tested against a pretend
device, but it has not yet run on a WVR.** See [First run](#first-run-on-hardware) for what to check.

## What it does

- **16 slots**, each one sound with its own level, pan, pitch, loop, hold, fades, choke group
  and what happens when it is triggered again. **8 sounds** can play at once.
- **No waiting for storage:** the first 93 ms of every sound is kept in RAM, so a trigger starts
  at once and the eMMC catches up behind it. Sounds are ordinary WAV files on a FAT volume.
- **Triggers:** OSC over WiFi (QLab), MIDI (the DIN input and the USB host backpack), pins to ground.
- **Manager** at `http://192.168.4.1` (or `http://<name>.local`): drop sounds on slots, drag to
  swap, ⌥-drag to copy, cut/copy/paste, undo. Sliders are heard while they move. Every change is
  saved on the device as it is made; there is no sync step.
- Pitch is real time (4-point interpolation), so it can be changed after upload.

Not yet: filter, delay and reverb; the 2 × 6 voice instrument mode; backup and restore of a
whole device; loop points inside a sound.

## Using it

1. Power the WVR and join its WiFi network, `WVR-xxxx`, password `12345678`.
2. Open `http://192.168.4.1`.
3. Drop sound files on the slots (WAV, AIFF, and whatever else the browser can read). They are
   converted to 16-bit, 44.1 kHz in the browser and sent to the device.
4. Select a slot to set it up. ▶ plays it on the device.

**Device…** sets the name, the WiFi password, an existing network to join as well, the OSC
port and the MIDI channel, and installs new firmware.

Keys: Space plays the selected slot, Esc stops everything, arrows move, ⌘C/X/V, Delete, ⌘Z/⇧⌘Z.

### QLab and other OSC senders

Send to the device's address, port 8000 (UDP). Slots count from 1.

| Message | Does |
|---|---|
| `/wvr/play 3` | plays slot 3 (`/wvr/play/3` also works) |
| `/wvr/play 3 100` | with velocity 1–127, for slots where velocity sets the level |
| `/wvr/stop 3` | stops slot 3 with its fade out |
| `/wvr/stop` or `/wvr/stopall` | stops everything |
| `/wvr/gain 3 -6` | level in dB, heard at once, not saved |
| `/wvr/pan 3 -0.5`, `/wvr/pitch 3 2` | pan −1…1, pitch in semitones |
| `/wvr/master -10` | master level in dB |

For a show, let the WVR join the theatre's network (**Device… → Also join network**) so the
QLab computer needn't switch WiFi. Its address is shown in the Device dialog.

### MIDI

Note on plays every slot set to that note; note off stops slots set to *play only while held*.
CC 7 is the master level; CC 120 and 123 stop everything. New slots get notes 36, 37, 38…

### Pins

A slot can be given one of the pins D3–D13. Taking the pin to ground plays the slot.
D7–D10 have no internal pull-up and need a resistor (10 kΩ to 3.3 V). D2 belongs to the USB
backpack, D0/D1 to the serial port.

## Building and flashing

Needs [arduino-cli](https://arduino.github.io/arduino-cli/) with the `esp32:esp32` core (3.3.x)
and Python 3. No other libraries.

```sh
./build.sh                          # build/WvrRadio32.ino.bin
./build.sh /dev/cu.usbserial-XXXX   # and flash over an FTDI adapter
```

### The first time, from the original firmware (no cable)

The WVR's USB jack only carries power; there is no USB-serial chip on the board. But the
original firmware can install another one over WiFi:

1. Power the WVR, join its network (`WVR`, password `12345678`).
2. Send the new firmware (the address is `192.168.5.18` on original firmware older than 3.9.0):

   ```sh
   curl --data-binary @build/WvrRadio32.ino.bin -H "content-type:text/plain" http://192.168.4.1/update
   ```

   The original manager does the same under **WVR → select firmware → force upload**.
3. The WVR restarts as `WVR-xxxx`. Join that network and open `http://192.168.4.1`.

This erases the unit's sounds. The original firmware stays in the other half of the flash: if
the new one crashes three times in a row while starting, the WVR goes back to it by itself.
That does not cover a firmware that hangs without crashing, or never starts at all; for those
only a serial adapter helps. Try one unit before doing the rest.

### Over serial

Any 3.3 V USB-serial adapter (FTDI): adapter TX to D0, RX to D1, GND to GND (swap D0 and D1 if
nothing answers). Hold D6 and the small "boot" pad next to the eMMC to ground, press reset, let
go, then run `./build.sh /dev/cu.usbserial-XXXX`. D0 and D1 are pads on the WVR's edge even
where no header is fitted.

### Later versions

Install `build/WvrRadio32.ino.bin` from the manager: **Device… → Firmware**. The version that
was running stays as the fallback.

## First run on hardware

Watch the serial port at 115200 baud. Things this version assumes and has not yet been shown:

- the eMMC mounts and formats (it falls back from 52 MHz to 20 MHz);
- the DAC plays with left and right the right way round;
- no clicks at `DMA_BLOCKS 2` in [config.h](firmware/WvrRadio32/config.h) (raise it to 3 if there are);
- the USB backpack sends ordinary MIDI bytes at 31250 baud on D2, as it did for the original firmware;
- the manager's footer shows "waited for storage" only rarely, if ever.

## How it is put together

```
firmware/WvrRadio32/
  config.h       pins and sizes
  storage.*      the eMMC as FAT, WAV headers, safe saving
  engine.*       slots, voices, the mixer, the streamer
  project.*      the project and device settings (JSON on the eMMC)
  net.*          WiFi and the HTTP API
  control.*      OSC, MIDI, pins
  web_bundle.h   the manager, packed by tools/embed.py
docs/            the manager: plain HTML, CSS and JavaScript, no build step
                 (docs/js/demo.js is the pretend device of the online demo)
tools/mock.py    a pretend WVR for working on the manager: http://localhost:8032
test/run.sh      the manager's tests (macOS's built-in JavaScript engine)
```

On the eMMC: `project.json`, `device.json` and the sounds in `snd/`.

The HTTP API is listed at the top of [net.cpp](firmware/WvrRadio32/net.cpp). There is no login:
anyone on the device's network can change it, so give it a WiFi password of its own.

## License

Not chosen yet. The pin numbers and the eMMC and DAC setup come from the WVR project
(GPL v3); no code was taken from it. `docs/js/audio.js` is shared with the Performer Library Manager.
