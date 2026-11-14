/*
 * The WVR manager. The device holds the project; this page shows it, changes it
 * and saves every change back at once. There is no separate "sync".
 *
 * Model (pure functions, also run by the tests) first, then the page.
 */
"use strict";

var WVR = (function () {

  // What belongs to the sound and travels with it when a slot is moved or copied...
  var SOUND_KEYS = ["name", "file", "gain", "pan", "pitch", "loop", "hold", "retrig", "group", "fadeIn", "fadeOut", "vel", "src", "dur", "ch", "peaks"];
  // ...and what belongs to the slot's position: its triggers stay where they are.
  var NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  function emptySound() {
    return { name: "", file: "", gain: 0, pan: 0, pitch: 0, loop: false, hold: false, retrig: "overlap", group: 0,
             fadeIn: 0, fadeOut: 20, vel: false, src: "", dur: 0, ch: 0, peaks: "" };
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

  // 96 peak values as hex: the waveform is drawn without fetching the audio.
  var PEAKS = 96;
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
           peaksOf: peaksOf, peaksFrom: peaksFrom, noteName: noteName, fmtDur: fmtDur, fmtDb: fmtDb };
})();

if (typeof module !== "undefined") module.exports = WVR;

// ---------------------------------------------------------------------- the page

if (typeof document !== "undefined") (function () {
  // ?host=192.168.4.1 lets a copy of this page on a computer talk to a device.
  var params = new URLSearchParams(location.search), host = params.get("host");
  var BASE = host ? "http://" + host : "";
  // Without a device (on GitHub Pages, from a file, or with ?demo) a pretend one in the browser answers.
  var DEMO = !host && typeof WVRDemo !== "undefined" && (/github\.io$/.test(location.hostname) || location.protocol === "file:" || params.has("demo"));
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var device = null;        // /api/state
  var project = null;
  var sel = 0;
  var undo = [], redo = [];
  var clip = null;
  var status = { playing: [], errors: {} };
  var rev = -1;             // the device's count of saved changes, as we last knew it
  var saveTimer = 0, saving = false, saveAgain = false;
  var busy = {};            // slot -> upload progress 0..1

  function api(method, path, body) {
    if (DEMO) return WVRDemo.request(method, path, body);
    return fetch(BASE + path, { method: method, body: body }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.error || r.statusText);
        return j;
      });
    });
  }

  // ------------------------------------------------------------ loading and saving

  function load() {
    return api("GET", "/api/state").then(function (st) {
      device = st; rev = st.rev;
      project = WVR.normalise(st.project, st.slots);
      undo = []; redo = [];
      // files no slot uses any more (cleared in an earlier session) are removed here
      var used = WVR.usedFiles(project);
      st.files.forEach(function (f) { if (!used[f.name]) api("DELETE", "/api/file?name=" + f.name).catch(function () {}); });
      $("banner").hidden = true;
      renderAll();
    });
  }

  function setSave(text, err) { var e = $("saveState"); e.textContent = text; e.className = "save" + (err ? " err" : ""); }

  function save() {
    clearTimeout(saveTimer);
    setSave("Saving…");
    saveTimer = setTimeout(doSave, 250);
  }
  function doSave() {
    if (saving) { saveAgain = true; return; }
    saving = true;
    api("PUT", "/api/project", WVR.serialise(project)).then(function (j) { rev = j.rev; setSave("Saved"); },
      function (e) { setSave("Not saved: " + e.message, true); })
      .then(function () { saving = false; if (saveAgain) { saveAgain = false; doSave(); } });
  }

  // Every change goes through here: remembered for undo, drawn, saved.
  function change(fn) {
    undo.push(WVR.serialise(project)); if (undo.length > 100) undo.shift();
    redo = [];
    fn();
    renderAll(); save();
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(WVR.serialise(project));
    project = WVR.normalise(JSON.parse(from.pop()), device.slots);
    renderAll(); save();
  }

  // A slider being dragged: heard at once, saved when let go. Only the latest value is sent.
  var live = {}, liveBusy = false;
  function sendLive(key, slot, value) {
    live[key + ":" + slot] = { k: key, slot: slot, v: value };
    if (liveBusy) return;
    var id = Object.keys(live)[0];
    if (!id) return;
    var m = live[id]; delete live[id];
    liveBusy = true;
    var done = function () { liveBusy = false; if (Object.keys(live).length) sendLive.apply(null, firstLive()); };
    api("POST", "/api/live?k=" + m.k + "&v=" + m.v + (m.slot ? "&slot=" + m.slot : "")).then(done, done);
  }
  function firstLive() { var id = Object.keys(live)[0], m = live[id]; return [m.k, m.slot, m.v]; }

  // ------------------------------------------------------------ status

  function poll() {
    api("GET", "/api/status").then(function (st) {
      status = st;
      $("banner").hidden = true;
      if (st.rev !== rev && !saving && !saveTimerPending()) return load();   // changed from another browser
      drawStatus();
    }, function () {
      $("banner").hidden = false;
      $("banner").textContent = "No answer from the WVR. Check that it has power and that this computer is on its WiFi network.";
    }).catch(function () {}).then(function () { setTimeout(poll, 200); });
  }
  function saveTimerPending() { return $("saveState").textContent === "Saving…"; }

  function drawStatus() {
    var playing = {};
    status.playing.forEach(function (n) { playing[n] = true; });
    Array.prototype.forEach.call($("slots").children, function (el, i) {
      el.classList.toggle("playing", !!playing[i + 1]);
      var go = el.querySelector(".go"); if (go) go.textContent = playing[i + 1] ? "■" : "▶";
      var bad = el.querySelector(".bad"); if (bad) bad.textContent = status.errors[i + 1] || "";
    });
    [["mL", 0], ["mR", 1]].forEach(function (m) {
      var p = status.peak[m[1]], db = p > 0 ? 20 * Math.log10(p) : -90, e = $(m[0]);
      e.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + "%";
      e.classList.toggle("hot", p >= 0.999);
    });
    var play = $("dPlay"); if (play) play.textContent = playing[sel + 1] ? "Stop" : "Play";
    $("foot").textContent = "Firmware " + device.fw + " · " + status.voices + " of " + device.voices + " voices" +
      (status.under ? " · waited for storage " + status.under + "×" : "") + " · " + gb(device.space.free) + " free of " + gb(device.space.total);
  }
  function gb(b) { return (b / 1073741824).toFixed(1) + " GB"; }

  // ------------------------------------------------------------ drawing

  function drawWave(canvas, hex) {
    var r = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * r; canvas.height = h * r;
    var g = canvas.getContext("2d");
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!hex) return;
    var peaks = WVR.peaksFrom(hex), bw = canvas.width / peaks.length;
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--wave");
    peaks.forEach(function (p, i) {
      var bh = Math.max(r, Math.sqrt(p) * canvas.height * 0.92);
      g.fillRect(i * bw, (canvas.height - bh) / 2, Math.max(1, bw - r), bh);
    });
  }

  function tagsOf(s) {
    var t = [];
    if (s.file) t.push(WVR.fmtDur(s.dur));
    if (s.loop) t.push("loop");
    if (s.hold) t.push("hold");
    if (s.group) t.push("grp " + s.group);
    if (s.pin) t.push("D" + s.pin);
    return t;
  }

  function renderSlots() {
    $("slots").innerHTML = project.slots.map(function (s, i) {
      var up = busy[i] !== undefined;
      return '<div class="slot' + (s.file ? "" : " empty") + (i === sel ? " sel" : "") + '" data-i="' + i + '" draggable="' + (s.file ? "true" : "false") + '" tabindex="0">' +
        '<div class="slot-head"><span class="num">' + (i + 1) + '</span><span class="sname">' + esc(up ? "Uploading…" : s.name || (s.file ? s.src : "Empty")) + "</span></div>" +
        (s.file ? '<button class="go" title="Play or stop on the device" aria-label="Play slot ' + (i + 1) + '">▶</button>' : "") +
        "<canvas></canvas>" +
        (up ? '<div class="progress"><i style="width:' + Math.round(busy[i] * 100) + '%"></i></div>'
            : '<div class="tags">' + tagsOf(s).map(function (t) { return "<span>" + esc(t) + "</span>"; }).join("") + '<span class="bad"></span></div>') +
        "</div>";
    }).join("");
    Array.prototype.forEach.call($("slots").children, function (el, i) { drawWave(el.querySelector("canvas"), project.slots[i].peaks); });
  }

  function slider(key, label, min, max, step, value, fmt) {
    return '<label class="field"><span>' + label + ' <output id="o_' + key + '">' + fmt(value) + '</output></span>' +
      '<input type="range" data-live="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '"></label>';
  }
  var fmtPan = function (v) { v = Number(v); return v === 0 ? "centre" : (v < 0 ? "L " : "R ") + Math.round(Math.abs(v) * 100); };
  var fmtPitch = function (v) { v = Number(v); return (v > 0 ? "+" : "") + v.toFixed(1) + " st"; };
  var FMT = { gain: WVR.fmtDb, pan: fmtPan, pitch: fmtPitch };

  function options(list, value) {
    return list.map(function (o) { return '<option value="' + o[0] + '"' + (String(o[0]) === String(value) ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("");
  }

  function renderDetail() {
    var s = project.slots[sel], n = sel + 1;
    var notes = [[-1, "none"]]; for (var k = 0; k < 128; k++) notes.push([k, k + " · " + WVR.noteName(k)]);
    var pins = [[0, "none"]]; for (var d = 3; d <= 13; d++) pins.push([d, "D" + d + (d >= 7 && d <= 10 ? " (needs a pull-up resistor)" : d === 6 ? " (not held low at power-on)" : "")]);
    var groups = [[0, "none"]]; for (var g = 1; g <= 8; g++) groups.push([g, "group " + g]);
    $("detail").innerHTML =
      '<div class="detail-head"><span class="num">' + n + '</span><input type="text" data-set="name" maxlength="40" placeholder="Name" value="' + esc(s.name) + '" aria-label="Slot name"></div>' +
      "<canvas></canvas>" +
      '<p class="help">' + (s.file ? esc(s.src) + " · " + WVR.fmtDur(s.dur) + " · " + (s.ch === 1 ? "mono" : "stereo") : "Empty. Drop a sound here or choose one.") + "</p>" +
      '<div class="row">' +
        (s.file ? '<button class="btn primary" id="dPlay">Play</button>' : "") +
        '<button class="btn" id="dPick">' + (s.file ? "Replace…" : "Choose sound…") + "</button>" +
        (s.file ? '<a class="btn" id="dDown" href="' + BASE + "/api/file?name=" + s.file + '" download="' + esc(s.src || s.file) + '">Download</a><button class="btn danger" id="dClear">Clear</button>' : "") +
      "</div>" +
      (s.file ?
        slider("gain", "Level", -60, 12, 0.5, s.gain, WVR.fmtDb) + slider("pan", "Pan", -1, 1, 0.01, s.pan, fmtPan) + slider("pitch", "Pitch", -24, 24, 0.1, s.pitch, fmtPitch) +
        '<div class="checks"><label><input type="checkbox" data-set="loop"' + (s.loop ? " checked" : "") + "> Loop until stopped</label>" +
        '<label><input type="checkbox" data-set="hold"' + (s.hold ? " checked" : "") + "> Play only while the key or pin is held</label></div>" +
        '<div class="grid2">' +
          '<label>Triggered again<select data-set="retrig">' + options([["overlap", "plays on top"], ["restart", "starts over"], ["toggle", "stops"]], s.retrig) + "</select></label>" +
          '<label>Choke group<select data-set="group" data-num>' + options(groups, s.group) + "</select></label>" +
          '<label>Fade in (ms)<input type="number" data-set="fadeIn" min="0" max="60000" step="10" value="' + s.fadeIn + '"></label>' +
          '<label>Fade out (ms)<input type="number" data-set="fadeOut" min="0" max="60000" step="10" value="' + s.fadeOut + '"></label>' +
        "</div>" : "") +
      "<h3>Triggers</h3>" +
      '<div class="field"><span>OSC, port ' + device.device.oscPort + '</span><div class="osc">/wvr/play ' + n + "</div></div>" +
      '<div class="grid2">' +
        '<label>MIDI note<select data-set="note" data-num>' + options(notes, s.note) + "</select></label>" +
        '<label>Pin to ground<select id="dPin">' + options(pins, s.pin) + "</select></label>" +
      "</div>" +
      '<div class="checks"><label><input type="checkbox" data-set="vel"' + (s.vel ? " checked" : "") + "> MIDI velocity sets the level</label></div>";
    drawWave($("detail").querySelector("canvas"), s.peaks);
  }

  function renderAll() {
    if (!project) return;
    $("devName").textContent = device.device.name;
    if (document.activeElement !== $("projName")) $("projName").value = project.name;
    $("master").value = project.master; $("masterOut").textContent = WVR.fmtDb(project.master);
    renderSlots(); renderDetail(); drawStatus();
  }

  // ------------------------------------------------------------ sounds in

  function opt(id) { return $(id).checked; }

  function upload(name, bytes, onProgress) {
    if (DEMO) return WVRDemo.request("PUT", "/api/file?name=" + name, bytes);
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open("PUT", BASE + "/api/file?name=" + name);
      x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = function () {
        var j = {}; try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status === 200 && j.ok) resolve(j); else reject(new Error(j.error || "upload failed (" + x.status + ")"));
      };
      x.onerror = function () { reject(new Error("the connection was lost")); };
      x.send(bytes);
    });
  }

  // Files go to the slot they were dropped on and the ones after it.
  function addFiles(files, at) {
    var list = Array.prototype.slice.call(files).sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    var chain = Promise.resolve();
    list.forEach(function (file, k) {
      var i = at + k;
      if (i >= project.slots.length) return;
      chain = chain.then(function () {
        busy[i] = 0; renderSlots();
        return file.arrayBuffer().then(PDAudio.decode).then(function (snd) {
          var prep = PDAudio.prepare(snd, { rate: 44100, trim: opt("optTrim"), mono: true, normalise: opt("optNorm") }).sound;
          var name = WVR.fileName(file.name), bytes = PDAudio.encodeWav16(prep, i + 1);
          return upload(name, bytes, function (p) { busy[i] = p; var bar = $("slots").children[i].querySelector(".progress i"); if (bar) bar.style.width = Math.round(p * 100) + "%"; })
            .then(function () {
              delete busy[i];
              change(function () {
                var s = project.slots[i], keep = s.file ? WVR.sound(s) : null;
                if (!keep) WVR.clear(project, i);         // a new sound in an empty slot starts from the defaults
                s.file = name; s.src = file.name; s.dur = prep.channels[0].length / prep.rate; s.ch = prep.channels.length; s.peaks = WVR.peaksOf(prep);
                if (!keep || !keep.name || keep.name === WVR.displayName(keep.src)) s.name = WVR.displayName(file.name);
              });
            });
        }).catch(function (e) {
          delete busy[i]; renderSlots();
          alert("“" + file.name + "” wasn't added: " + e.message);
        });
      });
    });
    return chain;
  }

  // ------------------------------------------------------------ events

  function slotOf(target) { var el = target.closest && target.closest(".slot"); return el ? Number(el.dataset.i) : -1; }
  function select(i) { if (i === sel) return; sel = i; renderSlots(); renderDetail(); drawStatus(); }
  function togglePlay(i) {
    var on = status.playing.indexOf(i + 1) >= 0;
    api("POST", (on ? "/api/stop" : "/api/play") + "?slot=" + (i + 1)).catch(function () {});
  }

  var slots = $("slots");
  slots.addEventListener("click", function (e) {
    var i = slotOf(e.target); if (i < 0) return;
    if (e.target.classList.contains("go")) { togglePlay(i); e.stopPropagation(); }
    select(i);
  });
  slots.addEventListener("dblclick", function (e) { var i = slotOf(e.target); if (i >= 0 && !project.slots[i].file) { sel = i; $("pick").click(); } });
  slots.addEventListener("focusin", function (e) { var i = slotOf(e.target); if (i >= 0 && e.target.classList.contains("slot")) select(i); });

  var dragFrom = -1;
  slots.addEventListener("dragstart", function (e) { dragFrom = slotOf(e.target); e.dataTransfer.effectAllowed = "copyMove"; e.dataTransfer.setData("text/plain", String(dragFrom + 1)); });
  slots.addEventListener("dragend", function () { dragFrom = -1; });
  function over(e, on) { var el = e.target.closest && e.target.closest(".slot"); if (el) el.classList.toggle("over", on); }
  slots.addEventListener("dragover", function (e) { if (slotOf(e.target) < 0) return; e.preventDefault(); e.dataTransfer.dropEffect = dragFrom >= 0 ? (e.altKey ? "copy" : "move") : "copy"; over(e, true); });
  slots.addEventListener("dragleave", function (e) { over(e, false); });
  slots.addEventListener("drop", function (e) {
    var to = slotOf(e.target); if (to < 0) return;
    e.preventDefault(); over(e, false);
    if (e.dataTransfer.files && e.dataTransfer.files.length) { sel = to; addFiles(e.dataTransfer.files, to); return; }
    var from = dragFrom; if (from < 0 || from === to) return;
    var alt = e.altKey;
    change(function () { if (alt) WVR.copy(project, from, to); else WVR.swap(project, from, to); sel = to; });
  });
  // a sound dropped beside the slots must not replace the page
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });

  $("pick").addEventListener("change", function () { if (this.files.length) addFiles(this.files, sel); this.value = ""; });

  var detail = $("detail");
  detail.addEventListener("click", function (e) {
    if (e.target.id === "dPlay") togglePlay(sel);
    else if (e.target.id === "dPick") $("pick").click();
    else if (e.target.id === "dClear") change(function () { WVR.clear(project, sel); });
    else if (e.target.id === "dDown" && DEMO && !e.target.dataset.ready) {      // the demo has no address to download from
      var a = e.target; e.preventDefault();
      api("GET", "/api/file?name=" + project.slots[sel].file).then(function (bytes) {
        a.href = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })); a.dataset.ready = "1"; a.click();
      });
    }
  });
  detail.addEventListener("input", function (e) {
    var key = e.target.dataset.live; if (!key) return;
    $("o_" + key).textContent = FMT[key](e.target.value);
    sendLive(key, sel + 1, e.target.value);
  });
  detail.addEventListener("change", function (e) {
    var t = e.target, key = t.dataset.live || t.dataset.set;
    if (t.id === "dPin") { change(function () { WVR.setPin(project, sel, Number(t.value)); }); return; }
    if (!key) return;
    var v = t.type === "checkbox" ? t.checked : t.type === "range" || t.type === "number" || "num" in t.dataset ? Number(t.value) : t.value;
    if (t.type === "number") v = Math.max(Number(t.min), Math.min(Number(t.max), Math.round(v) || 0));
    change(function () { project.slots[sel][key] = v; });
  });

  $("projName").addEventListener("change", function () { var v = this.value.trim() || "New project"; change(function () { project.name = v; }); });
  $("master").addEventListener("input", function () { $("masterOut").textContent = WVR.fmtDb(this.value); sendLive("master", 0, this.value); });
  $("master").addEventListener("change", function () { var v = Number(this.value); change(function () { project.master = v; }); });
  $("stopAll").addEventListener("click", function () { api("POST", "/api/stop").catch(function () {}); });

  document.addEventListener("keydown", function (e) {
    var t = e.target, typing = /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.type !== "range" && t.type !== "checkbox";
    if (e.key === "Escape" && !$("settings").open) { api("POST", "/api/stop").catch(function () {}); return; }
    if (typing || $("settings").open || !project) return;
    var mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase(), s = project.slots[sel], cols = getComputedStyle(slots).gridTemplateColumns.split(" ").length;
    if (mod && k === "z") { if (e.shiftKey) restore(redo, undo); else restore(undo, redo); }
    else if (mod && k === "y") restore(redo, undo);
    else if (mod && k === "c" && s.file) clip = WVR.sound(s);
    else if (mod && k === "x" && s.file) { clip = WVR.sound(s); change(function () { WVR.clear(project, sel); }); }
    else if (mod && k === "v" && clip) change(function () { WVR.setSound(project.slots[sel], clip); });
    else if ((k === "delete" || k === "backspace") && s.file) change(function () { WVR.clear(project, sel); });
    else if (k === " " && s.file) togglePlay(sel);
    else if (k === "arrowright") select(Math.min(project.slots.length - 1, sel + 1));
    else if (k === "arrowleft") select(Math.max(0, sel - 1));
    else if (k === "arrowdown") select(Math.min(project.slots.length - 1, sel + cols));
    else if (k === "arrowup") select(Math.max(0, sel - cols));
    else return;
    e.preventDefault();
  });

  // import options are remembered on this computer
  ["optTrim", "optNorm"].forEach(function (id) {
    try { $(id).checked = localStorage.getItem(id) === "1"; } catch (e) {}
    $(id).addEventListener("change", function () { try { localStorage.setItem(id, this.checked ? "1" : "0"); } catch (e) {} });
  });

  // ------------------------------------------------------------ device dialog

  $("openSettings").addEventListener("click", function () {
    var d = device.device;
    $("dName").value = d.name; $("dPass").value = d.apPass; $("dSsid").value = d.staSsid; $("dSpass").value = d.staPass; $("dOsc").value = d.oscPort;
    var ch = [[0, "all"]]; for (var i = 1; i <= 16; i++) ch.push([i, String(i)]);
    $("dMidi").innerHTML = options(ch, d.midiChannel);
    $("devInfo").textContent = "Firmware " + device.fw + " · own network at " + device.ip.ap + (device.ip.sta ? " · joined network at " + device.ip.sta : "") +
      (device.storage ? "" : " · THE STORAGE DID NOT START");
    $("dMsg").textContent = "";
    $("settings").showModal();
  });
  $("dSave").addEventListener("click", function () {
    var body = JSON.stringify({ name: $("dName").value.trim(), apPass: $("dPass").value, staSsid: $("dSsid").value.trim(), staPass: $("dSpass").value,
                                oscPort: Number($("dOsc").value), midiChannel: Number($("dMidi").value) });
    api("PUT", "/api/device", body).then(function () { return api("POST", "/api/restart"); })
      .then(function () { $("dMsg").textContent = "Restarting. Join the network “" + $("dName").value.trim() + "” again and reload this page."; },
            function (e) { $("dMsg").textContent = "Not saved: " + e.message; });
  });
  $("fwGo").addEventListener("click", function () {
    var f = $("fwFile").files[0]; if (!f) return;
    $("fwMsg").textContent = "Installing… don't switch the WVR off.";
    api("POST", "/api/update", f).then(function () { $("fwMsg").textContent = "Installed. The WVR is restarting; reload this page in a few seconds."; },
      function (e) { $("fwMsg").textContent = "Not installed: " + e.message; });
  });

  $("demoNote").hidden = !DEMO;
  load().catch(function (e) {
    $("banner").hidden = false;
    $("banner").textContent = "Couldn't reach the WVR (" + e.message + "). Check that this computer is on its WiFi network.";
  }).then(poll);
})();
