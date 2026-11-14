// Tests for the manager's model. Run with test/run.sh.
var failed = 0, count = 0;
function ok(cond, what) { count++; if (!cond) { failed++; print("FAIL: " + what); } }
function eq(a, b, what) { ok(JSON.stringify(a) === JSON.stringify(b), what + " (got " + JSON.stringify(a) + ", wanted " + JSON.stringify(b) + ")"); }

// an empty device project becomes a full one
var p = WVR.normalise({ name: "Show", master: -3, slots: [], pins: [] }, 16);
eq(p.slots.length, 16, "16 slots");
eq(p.slots[0].note, 36, "slot 1 defaults to note 36");
eq(p.slots[15].note, 51, "slot 16 defaults to note 51");
eq(p.master, -3, "master kept");
eq(WVR.normalise(null, 16).name, "New project", "nothing at all gives a new project");

// saving and loading gives the same project back
p.slots[2].file = "door-0a1b2.wav"; p.slots[2].name = "Door"; p.slots[2].gain = -6; p.slots[2].loop = true;
WVR.setPin(p, 2, 5);
var again = WVR.normalise(JSON.parse(WVR.serialise(p)), 16);
eq(again, p, "round trip");
eq(JSON.parse(WVR.serialise(p)).pins, [{ d: 5, slot: 3 }], "pins are listed for the firmware");

// wrong types from an old or hand-edited project fall back to defaults
var odd = WVR.normalise({ slots: [{ gain: "loud", loop: 1, file: "a.wav" }] }, 4);
eq([odd.slots[0].gain, odd.slots[0].loop, odd.slots[0].file], [0, false, "a.wav"], "wrong types ignored");

// moving a sound keeps the triggers where they are
WVR.swap(p, 2, 0);
eq([p.slots[0].name, p.slots[0].file, p.slots[0].gain, p.slots[0].loop], ["Door", "door-0a1b2.wav", -6, true], "sound moved to slot 1");
eq([p.slots[2].file, p.slots[2].pin, p.slots[2].note], ["", 5, 38], "slot 3 is empty, its pin and note stay");
eq(p.slots[0].note, 36, "slot 1 keeps its note");
WVR.copy(p, 0, 7);
eq(p.slots[7].file, p.slots[0].file, "a copy shares the file");
eq(Object.keys(WVR.usedFiles(p)), ["door-0a1b2.wav"], "one file in use");
WVR.clear(p, 0);
eq([p.slots[0].file, p.slots[0].gain, p.slots[7].file], ["", 0, "door-0a1b2.wav"], "clearing one leaves the copy");

// a pin triggers one slot only
WVR.setPin(p, 4, 5);
eq([p.slots[2].pin, p.slots[4].pin], [0, 5], "pin moved to the new slot");

// file names the firmware accepts: [A-Za-z0-9._-], ends in .wav, under 48 characters
["Dør smeller (take 3).aiff", "kick.wav", "…", "a".repeat(80) + ".mp3", "ÆØÅ æøå.flac"].forEach(function (n) {
  var f = WVR.fileName(n, 0.5);
  ok(/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.wav$/.test(f) && f.length < 48 && f.length >= 5, "safe file name for " + n + ": " + f);
});
ok(WVR.fileName("a.wav", 0.1) !== WVR.fileName("a.wav", 0.2), "two uploads of one file get two names");
eq(WVR.displayName("Door slam.aiff"), "Door slam", "display name");

// peaks
var snd = { rate: 44100, channels: [new Float32Array(44100)] };
for (var i = 0; i < 22050; i++) snd.channels[0][i] = 0.5;
var hex = WVR.peaksOf(snd), pk = WVR.peaksFrom(hex);
eq(hex.length, 192, "96 peaks");
ok(Math.abs(pk[0] - 0.5) < 0.01 && pk[95] === 0, "peaks follow the sound");

// what goes to the device: 16-bit WAV at 44.1 kHz, mono when both sides are the same
var st = { rate: 48000, channels: [new Float32Array(4800), new Float32Array(4800)], sourceBits: 24 };
for (i = 0; i < 4800; i++) st.channels[0][i] = st.channels[1][i] = Math.sin(i / 10) * 0.8;
var prep = PDAudio.prepare(st, { rate: 44100, mono: true }).sound;
var wav = PDAudio.encodeWav16(prep, 1), dv = new DataView(wav.buffer);
eq([dv.getUint16(22, true), dv.getUint32(24, true), dv.getUint16(34, true)], [1, 44100, 16], "mono, 44.1 kHz, 16-bit");
eq(prep.channels[0].length, 4410, "resampled length");

eq([WVR.noteName(60), WVR.noteName(36)], ["C3", "C1"], "note names");
eq([WVR.fmtDur(1.234), WVR.fmtDur(75)], ["1.23 s", "1:15"], "durations");

print(failed ? failed + " of " + count + " FAILED" : "all " + count + " passed");
if (failed) throw new Error("tests failed");
