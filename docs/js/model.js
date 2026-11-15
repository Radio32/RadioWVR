/*
 * The manager's model: pure functions, also run by the tests.
 *   WVR  the device's project: 16 slots, each a sound with its settings and triggers
 *   Lib  the library: sound files in a folder on the computer, its subfolders the categories
 */
"use strict";

var WVR = (function () {

  // What belongs to the sound and travels with it when a slot is moved or copied...
  var SOUND_KEYS = ["name", "file", "gain", "pan", "pitch", "loop", "hold", "retrig", "group", "fadeIn", "fadeOut", "vel", "start", "end", "src", "dur", "ch", "peaks"];
  // ...and what belongs to the slot's position: its triggers stay where they are.
  var NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  function emptySound() {
    return { name: "", file: "", gain: 0, pan: 0, pitch: 0, loop: false, hold: false, retrig: "overlap", group: 0,
             fadeIn: 0, fadeOut: 20, vel: false, start: 0, end: 0, src: "", dur: 0, ch: 0, peaks: "" };
  }
  function emptySlot(i) { var s = emptySound(); s.note = 36 + i; s.pin = 0; return s; }

  // Fills in whatever the device's project lacks, so the page can rely on every field.
  function normalise(project, slotCount) {
    var p = project && typeof project === "object" ? project : {};
    var out = { name: typeof p.name === "string" ? p.name : "New project", master: typeof p.master === "number" ? p.master : 0, slots: [] };
    for (var i = 0; i < slotCount; i++) {
      var s = emptySlot(i), src = p.slots && p.slots[i];
      if (src) for (var k in s) if (src[k] !== undefined && typeof src[k] === typeof s[k]) s[k] = src[k];
      s.pin = 0;
      out.slots.push(s);
    }
    (p.pins || []).forEach(function (pin) {
      if (pin && pin.slot >= 1 && pin.slot <= slotCount && pin.d >= 3 && pin.d <= 13) out.slots[pin.slot - 1].pin = pin.d;
    });
    return out;
  }

  // The JSON the device stores: the slots, plus the pin list the firmware reads.
  function serialise(project) {
    var pins = [];
    project.slots.forEach(function (s, i) { if (s.pin) pins.push({ d: s.pin, slot: i + 1 }); });
    return JSON.stringify({ name: project.name, master: project.master, slots: project.slots, pins: pins });
  }

  function sound(slot) { var o = {}; SOUND_KEYS.forEach(function (k) { o[k] = slot[k]; }); return o; }
  function setSound(slot, snd) { SOUND_KEYS.forEach(function (k) { slot[k] = snd[k]; }); }
  function swap(project, a, b) { var t = sound(project.slots[a]); setSound(project.slots[a], sound(project.slots[b])); setSound(project.slots[b], t); }
  function copy(project, from, to) { setSound(project.slots[to], sound(project.slots[from])); }
  function clear(project, i) { setSound(project.slots[i], emptySound()); }
  function setPin(project, i, d) {   // a pin triggers one slot
    project.slots.forEach(function (s) { if (d && s.pin === d) s.pin = 0; });
    project.slots[i].pin = d;
  }
  function usedFiles(project) { var u = {}; project.slots.forEach(function (s) { if (s.file) u[s.file] = true; }); return u; }

  // A name the device accepts: letters, digits, - and _, a random tail so two uploads never collide.
  function fileName(original, rnd) {
    var base = String(original).replace(/\.[^.]*$/, "").normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "sound";
    var tail = Math.floor((rnd === undefined ? Math.random() : rnd) * 0x100000).toString(16);
    return base + "-" + ("00000" + tail).slice(-5) + ".wav";
  }
  function displayName(original) { return String(original).replace(/\.[^.]*$/, "").slice(0, 40); }

  // The part of a slot's sound that plays, in seconds: start to end (end 0 = the end of the file).
  // Nonsense points play the whole file, as on the device.
  function part(s) {
    var dur = s.dur || 0, a = Math.max(0, s.start || 0), b = s.end > 0 ? Math.min(s.end, dur) : dur;
    if (!(a < b)) { a = 0; b = dur; }
    return { a: a, b: b, len: b - a };
  }

  // 400 peak values as hex: the waveform is drawn, and the start and end set, without fetching the audio.
  var PEAKS = 400;
  function peaksOf(sound) {
    var n = sound.channels[0].length, out = "";
    for (var i = 0; i < PEAKS; i++) {
      var a = Math.floor(i * n / PEAKS), b = Math.max(a + 1, Math.floor((i + 1) * n / PEAKS)), p = 0;
      for (var c = 0; c < sound.channels.length; c++) for (var j = a; j < b && j < n; j++) { var v = Math.abs(sound.channels[c][j]); if (v > p) p = v; }
      var q = Math.min(255, Math.round(Math.sqrt(p) * 255));
      out += (q < 16 ? "0" : "") + q.toString(16);
    }
    return out;
  }
  function peaksFrom(hex) { var a = []; for (var i = 0; i + 1 < hex.length; i += 2) { var q = parseInt(hex.substr(i, 2), 16) / 255; a.push(q * q); } return a; }

  function noteName(n) { return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 2); }   // 60 = C3
  function fmtDur(sec) { return sec < 10 ? sec.toFixed(2) + " s" : sec < 60 ? sec.toFixed(1) + " s" : Math.floor(sec / 60) + ":" + ("0" + Math.round(sec % 60)).slice(-2); }
  function fmtDb(v) { return (v > 0 ? "+" : "") + Number(v).toFixed(1) + " dB"; }

  return { emptySlot: emptySlot, normalise: normalise, serialise: serialise, swap: swap, copy: copy, clear: clear, setPin: setPin,
           sound: sound, setSound: setSound, usedFiles: usedFiles, fileName: fileName, displayName: displayName,
           peaksOf: peaksOf, peaksFrom: peaksFrom, part: part, noteName: noteName, fmtDur: fmtDur, fmtDb: fmtDb };
})();



// Moves the slots in `idx` one place up (dir -1) or down (+1). The sounds move; the
// triggers stay with their slot numbers. Returns the new indices, or null if it can't.
WVR.moveSlots = function (project, idx, dir) {
  var sel = idx.slice().sort(function (a, b) { return a - b; }), n = project.slots.length;
  if (!sel.length || (dir < 0 && sel[0] === 0) || (dir > 0 && sel[sel.length - 1] === n - 1)) return null;
  if (dir > 0) sel.reverse();
  sel.forEach(function (i) { WVR.swap(project, i, i + dir); });
  return idx.map(function (i) { return i + dir; });
};

var Lib = (function () {
  var AUDIO = /\.(wav|wave|aif|aiff|aifc|mp3|flac|ogg|oga|opus|m4a|aac)$/i;
  var nextId = 1;

  function isAudio(name) { return name.charAt(0) !== "." && AUDIO.test(name); }
  function split(fileName) {
    var dot = fileName.lastIndexOf(".");
    return dot > 0 ? { base: fileName.slice(0, dot), ext: fileName.slice(dot) } : { base: fileName, ext: "" };
  }

  // A name a file can have on macOS, Windows and Linux.
  function cleanBase(s) {
    s = String(s).replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120).trim();
    return s || "Sound";
  }
  // Categories are folders; "Doors/Wood" is a folder inside a folder. "" is the library's own folder.
  function cleanCat(s) {
    return String(s).split("/").map(function (p) {
      return p.replace(/[\\:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 60).trim();
    }).filter(Boolean).join("/");
  }

  function path(it) { return (it.cat ? it.cat + "/" : "") + it.base + it.ext; }
  function key(p) { return p.toLowerCase(); }   // macOS and Windows don't tell A.wav from a.wav

  // `src` is where the file is on disk now (null for a sound not saved yet).
  function item(cat, fileName, extra) {
    var n = split(fileName), it = { id: nextId++, cat: cleanCat(cat), base: n.base, ext: n.ext, src: null, file: null, handle: null,
                                    size: 0, dur: 0, ch: 0, rate: 0, peaks: "", err: "" };
    for (var k in extra) it[k] = extra[k];
    return it;
  }

  // A base name nobody else in the category has: "Door", "Door 2", "Door 3"...
  function uniqueBase(items, it, base) {
    var taken = {};
    items.forEach(function (o) { if (o !== it && o.id !== it.id && o.cat === it.cat) taken[key(o.base + o.ext)] = true; });
    var b = base, n = 2, m = /^(.*) (\d+)$/.exec(base);
    if (m) { b = m[1]; n = Number(m[2]) + 1; }
    var name = base;
    while (taken[key(name + it.ext)]) name = b + " " + n++;
    return name;
  }

  var collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;
  function cmp(a, b) { return collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0; }
  // Category by category (the library's own folder first), each sorted by name, as in a file browser.
  function sorted(items) {
    return items.slice().sort(function (a, b) {
      if (a.cat !== b.cat) return !a.cat ? -1 : !b.cat ? 1 : cmp(a.cat, b.cat);
      return cmp(a.base, b.base) || cmp(a.ext, b.ext);
    });
  }
  function categories(items) {
    var seen = {}, out = [];
    sorted(items).forEach(function (it) { if (!seen[it.cat]) { seen[it.cat] = true; out.push(it.cat); } });
    return out;
  }
  function matches(it, q) {
    if (!q) return true;
    var hay = (it.cat + " " + it.base).toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  /*
   * What saving has to do to the folder: write every sound that is new or has a new path,
   * delete the old paths. A path can be both written and freed (two sounds swap names),
   * so the sounds whose old path gets written over are read first (`preload`), and a
   * path that gets written is never deleted.
   */
  function savePlan(items, removed) {
    var writes = [], targets = {}, deletes = [], preload = [];
    items.forEach(function (it) {
      var to = path(it);
      if (!it.src || key(it.src) !== key(to) || it.src !== to) { writes.push({ item: it, to: to }); targets[key(to)] = true; }
    });
    var bySrc = {};
    items.forEach(function (it) { if (it.src) bySrc[key(it.src)] = it; });
    writes.forEach(function (w) {
      var there = bySrc[key(w.to)];
      if (there && there !== w.item) preload.push(there);
    });
    items.concat(removed).forEach(function (it) {
      if (!it.src) return;
      var gone = removed.indexOf(it) >= 0, moved = key(it.src) !== key(path(it));
      if ((gone || moved) && !targets[key(it.src)]) deletes.push(it.src);
    });
    return { writes: writes, deletes: deletes, preload: preload };
  }

  return { isAudio: isAudio, split: split, cleanBase: cleanBase, cleanCat: cleanCat, path: path, item: item, uniqueBase: uniqueBase,
           sorted: sorted, categories: categories, matches: matches, savePlan: savePlan };
})();

if (typeof module !== "undefined") module.exports = { WVR: WVR, Lib: Lib };
