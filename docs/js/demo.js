/*
 * A pretend WVR inside the browser, for trying the manager without a device
 * (on GitHub Pages, or with ?demo). It answers the same requests as the firmware
 * and plays the sounds on this computer, following the firmware's rules for
 * retrigger, hold, choke groups and fades. Not included in the firmware.
 */
"use strict";

var WVRDemo = (function () {
  var SLOTS = 16;
  var project = { name: "Demo project", master: 0, slots: [], pins: [] }, rev = 1, files = {};
  var device = { name: "WVR-DEMO", apPass: "12345678", staSsid: "", staPass: "", oscPort: 8000, midiChannel: 0 };
  var db = null, ready = null;

  // ---------------------------------------------------------------- keeping things (this browser only)

  // The browser's storage may be slow, refused or missing: the demo then runs without it.
  function openDb() {
    return new Promise(function (done) {
      setTimeout(done, 1500);
      try {
        var r = indexedDB.open("wvr-demo", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("files"); };
        r.onsuccess = function () { db = r.result; done(); };
        r.onerror = function () { done(); };
      } catch (e) { done(); }
    });
  }
  function dbAll() {
    return new Promise(function (done) {
      if (!db) return done();
      setTimeout(done, 1500);
      try {
        var st = db.transaction("files").objectStore("files"), keys = st.getAllKeys(), vals = st.getAll();
        vals.onsuccess = function () { keys.result.forEach(function (k, i) { files[k] = new Uint8Array(vals.result[i]); }); done(); };
        vals.onerror = function () { done(); };
      } catch (e) { done(); }
    });
  }
  function dbPut(name, bytes) { try { if (db) db.transaction("files", "readwrite").objectStore("files").put(bytes, name); } catch (e) {} }
  function dbDelete(name) { try { if (db) db.transaction("files", "readwrite").objectStore("files").delete(name); } catch (e) {} }
  function keepProject() { try { localStorage.setItem("wvr-demo-project", JSON.stringify(project)); } catch (e) {} }

  // Sounds made here, so the demo has something to play.
  var R = 44100, seedN = 1;
  function noise() { seedN = (seedN * 1664525 + 1013904223) >>> 0; return seedN / 2147483648 - 1; }
  function synth(secs, fn) {
    var n = Math.round(secs * R), x = new Float32Array(n);
    for (var i = 0; i < n; i++) x[i] = fn(i / R, i / n);
    return { rate: R, channels: [x], sourceBits: 16 };
  }
  function bell(f) { return function (t) { return 0.5 * Math.exp(-t * 2.2) * (Math.sin(6.2832 * f * t) + 0.5 * Math.sin(6.2832 * f * 2.5 * t) + 0.25 * Math.sin(6.2832 * f * 4.2 * t)) / 1.75; }; }
  function knock(t) { return 0.8 * Math.exp(-t * 28) * Math.sin(6.2832 * (140 - 200 * t) * t); }
  function wind() { var y = 0; return function (t, p) { y = y * 0.985 + noise() * 0.015; return y * 6 * (0.35 + 0.65 * (0.5 - 0.5 * Math.cos(6.2832 * p))); }; }
  function rain() { var y = 0, drop = 0; return function () { y = y * 0.6 + noise() * 0.4; if (noise() > 0.9993) drop = 1; drop *= 0.996; return 0.25 * y + 0.5 * drop * noise(); }; }
  var SOUNDS = {
    "Bell": function () { return synth(2.5, bell(660)); },
    "Bell low": function () { return synth(3.5, bell(330)); },
    "Knock": function () { return synth(0.25, knock); },
    "Knock twice": function () { return synth(0.6, function (t) { return knock(t) + (t > 0.28 ? knock(t - 0.28) : 0); }); },
    "Wind": function () { return synth(6, wind()); },
    "Rain": function () { return synth(5, rain()); }
  };

  function seed() {
    function make(name, extra) {
      var snd = SOUNDS[name](), file = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-demo0.wav";
      files[file] = PDAudio.encodeWav16(snd, 1); dbPut(file, files[file]);
      var s = { name: name, file: file, src: name + ".wav", dur: snd.channels[0].length / R, ch: 1, peaks: WVR.peaksOf(snd) };
      for (var k in extra) s[k] = extra[k];
      return s;
    }
    project.slots = [make("Bell", {}), make("Wind", { loop: true, fadeIn: 800, fadeOut: 1500, retrig: "toggle" }), make("Knock", {})];
    keepProject();
  }

  // A small library to try the left-hand pane with: [{ cat, name, blob }]
  function examples() {
    var list = [["Bells", "Bell"], ["Bells", "Bell low"], ["Doors", "Knock"], ["Doors", "Knock twice"], ["Weather", "Wind"], ["Weather", "Rain"]];
    return Promise.resolve(list.map(function (e) {
      return { cat: e[0], name: e[1], blob: new Blob([PDAudio.encodeWav16(SOUNDS[e[1]](), 2)], { type: "audio/wav" }) };
    }));
  }

  function init() {
    if (ready) return ready;
    ready = openDb().then(dbAll).then(function () {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem("wvr-demo-project")); } catch (e) {}
      var missing = saved && saved.slots && saved.slots.some(function (x) { return x && x.file && !files[x.file]; });
      if (saved && saved.slots && !missing) project = saved; else seed();
    });
    return ready;
  }

  // ---------------------------------------------------------------- sound

  var ctx = null, master = null, anL = null, anR = null, buffers = {}, voices = [], meterBuf = null;

  function audio() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = dbGain(project.master || 0);
    var split = ctx.createChannelSplitter(2);
    anL = ctx.createAnalyser(); anR = ctx.createAnalyser(); anL.fftSize = anR.fftSize = 1024;
    meterBuf = new Float32Array(1024);
    master.connect(ctx.destination); master.connect(split); split.connect(anL, 0); split.connect(anR, 1);
    return ctx;
  }
  function dbGain(db) { return db <= -90 ? 0 : Math.pow(10, db / 20); }
  function slotAt(n) { return project.slots[n - 1] || {}; }
  function bufferOf(name) {
    if (buffers[name]) return buffers[name];
    var snd = PDAudio.read(files[name]); if (!snd) return null;
    var b = audio().createBuffer(snd.channels.length, snd.channels[0].length, snd.rate);
    snd.channels.forEach(function (c, i) { b.getChannelData(i).set(c); });
    return (buffers[name] = b);
  }
  function level(s, v) { return dbGain(s.gain || 0) * v.vel; }

  function release(v, ms) {
    if (v.releasing) return;
    v.releasing = true;
    var t = ctx.currentTime, d = Math.max(3, ms || 0) / 1000;
    v.gain.gain.cancelScheduledValues(t); v.gain.gain.setValueAtTime(v.gain.gain.value, t); v.gain.gain.linearRampToValueAtTime(0, t + d);
    try { v.src.stop(t + d + 0.01); } catch (e) {}
  }
  function sounding(n) { return voices.filter(function (v) { return v.slot === n && !v.releasing; }); }

  function play(n, vel) {
    var s = slotAt(n);
    if (!s.file || !files[s.file]) return;
    var buf = bufferOf(s.file); if (!buf) return;
    audio(); if (ctx.state === "suspended") ctx.resume();
    var on = sounding(n);
    if (on.length && s.retrig === "toggle") { on.forEach(function (v) { release(v, s.fadeOut); }); return; }
    if (on.length && s.retrig === "restart") on.forEach(function (v) { release(v, 5); });
    if (s.group) voices.forEach(function (v) { if (v.slot !== n && slotAt(v.slot).group === s.group) release(v, slotAt(v.slot).fadeOut); });
    var v = { slot: n, vel: s.vel ? Math.pow((vel || 127) / 127, 2) : 1, releasing: false };
    v.src = ctx.createBufferSource(); v.src.buffer = buf; v.src.loop = !!s.loop; v.src.playbackRate.value = Math.pow(2, (s.pitch || 0) / 12);
    v.gain = ctx.createGain(); v.pan = ctx.createStereoPanner(); v.pan.pan.value = s.pan || 0;
    var t = ctx.currentTime, g = level(s, v);
    if (s.fadeIn) { v.gain.gain.setValueAtTime(0, t); v.gain.gain.linearRampToValueAtTime(g, t + s.fadeIn / 1000); } else v.gain.gain.value = g;
    v.src.connect(v.gain); v.gain.connect(v.pan); v.pan.connect(master);
    v.src.onended = function () { voices = voices.filter(function (x) { return x !== v; }); };
    v.src.start();
    voices.push(v);
    while (voices.length > 8) { var old = voices.shift(); try { old.src.stop(); } catch (e) {} }   // the WVR plays 8 at once
  }
  function stop(n) { voices.forEach(function (v) { if (!n || v.slot === n) release(v, slotAt(v.slot).fadeOut); }); }

  // settings reach the sounds already playing, as on the device
  function refresh() {
    if (!ctx) return;
    master.gain.setTargetAtTime(dbGain(project.master || 0), ctx.currentTime, 0.01);
    voices.forEach(function (v) {
      var s = slotAt(v.slot);
      if (!v.releasing) v.gain.gain.setTargetAtTime(level(s, v), ctx.currentTime, 0.01);
      v.pan.pan.setTargetAtTime(s.pan || 0, ctx.currentTime, 0.01);
      v.src.playbackRate.setTargetAtTime(Math.pow(2, (s.pitch || 0) / 12), ctx.currentTime, 0.01);
      v.src.loop = !!s.loop;
    });
  }
  function peak(an) { if (!an) return 0; an.getFloatTimeDomainData(meterBuf); var p = 0; for (var i = 0; i < meterBuf.length; i++) { var a = Math.abs(meterBuf[i]); if (a > p) p = a; } return p; }

  // ---------------------------------------------------------------- the firmware's API

  function handle(method, path, body) {
    var u = new URL(path, "http://wvr"), q = u.searchParams, p = u.pathname, name = q.get("name"), slot = Number(q.get("slot") || 0);
    if (p === "/api/state") {
      var used = 0; Object.keys(files).forEach(function (k) { used += files[k].length; });
      return { fw: "demo", slots: SLOTS, voices: 8, storage: true, space: { total: 7.8e9, free: 7.8e9 - used }, ip: { ap: "192.168.4.1", sta: "" }, device: device,
               files: Object.keys(files).map(function (k) { return { name: k, size: files[k].length }; }), rev: rev, project: JSON.parse(JSON.stringify(project)) };
    }
    if (p === "/api/status") {
      var on = {}; voices.forEach(function (v) { on[v.slot] = true; });
      return { rev: rev, playing: Object.keys(on).map(Number).sort(function (a, b) { return a - b; }), peak: [peak(anL), peak(anR)], voices: voices.length, under: 0, master: project.master, heap: 0, errors: {} };
    }
    if (p === "/api/project") { project = JSON.parse(body); rev++; keepProject(); refresh(); return { ok: true, rev: rev }; }
    if (p === "/api/device") { var d = JSON.parse(body); for (var k in d) device[k] = d[k]; return { ok: true }; }
    if (p === "/api/file") {
      if (method === "PUT") { files[name] = new Uint8Array(body); delete buffers[name]; dbPut(name, files[name]); return { ok: true }; }
      if (method === "DELETE") { delete files[name]; delete buffers[name]; dbDelete(name); return { ok: true }; }
      if (!files[name]) throw new Error("no such file");
      return files[name];
    }
    if (p === "/api/play") { play(slot, Number(q.get("vel") || 127)); return { ok: true }; }
    if (p === "/api/stop") { stop(slot); return { ok: true }; }
    if (p === "/api/live") {
      var key = q.get("k"), val = Number(q.get("v"));
      if (key === "master") project.master = val; else if (project.slots[slot - 1]) project.slots[slot - 1][key] = val;
      refresh(); return { ok: true };
    }
    throw new Error("there is no device in the demo");
  }

  function request(method, path, body) { return init().then(function () { return handle(method, path, body); }); }

  return { request: request, examples: examples };
})();
