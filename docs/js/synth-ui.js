/*
 * The WVR pane in synth mode: the patch's controls, MIDI learn, a keyboard to play it, presets,
 * and sounds from the library as oscillators. The parameters come from synth-params.js, the
 * same list the firmware is built from. app.js hands over what it shares through init().
 */
"use strict";

var SynthUI = (function () {
  var ctx = null;                       // from app.js: api, sendLive, upload, esc, status, librarySound
  var patch = null, rev = -1, undo = [], redo = [];
  var learnMode = false, learning = "", base = 48, held = {}, editingUntil = 0;
  var saveTimer = 0, saving = false, saveAgain = false;
  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- presets

  function preset(over) { var p = SynthParam.defaults(); for (var k in over) p[k] = over[k]; return p; }
  var PRESETS = [
    ["Init", {}],
    ["Fat pad", { o2f: 9, fc: 900, fq: 0.25, fe: 0.25, fa: 800, fdc: 2000, aa: 600, ar: 1500, ch: 2, sp: 0.6 }],
    ["Juno strings", { o1w: 1, o1pw: 0.3, lpw: 0.4, lr: 0.7, o2l: 0.5, fc: 2500, aa: 300, ar: 900, ch: 3 }],
    ["Brass with echo", { o2f: 6, fc: 700, fq: 0.15, fe: 0.5, fa: 80, fdc: 600, fs: 0.5, aa: 30, emx: 0.35, et: 330, efb: 0.45, epp: 1, ch: 1 }],
    ["Fat bass", { o2w: 1, o2o: -1, fc: 220, fq: 0.55, fe: 0.6, fdc: 250, fs: 0, fd: 0.6, vm: 1, ch: 0 }],
    ["Gritty bass", { o2w: 1, o2o: -1, fm: 1, fc: 300, fq: 0.75, fe: 0.5, fdc: 300, fs: 0.1, fd: 0.8, vm: 1, ch: 0 }],
    ["Gritty lead", { o2f: 12, fm: 1, fc: 600, fq: 0.85, fd: 1, lc: 0.4, lr: 0.4, vm: 2, gl: 120, ch: 0, emx: 0.25, et: 250 }],
    ["Soft keys", { o1w: 2, o2w: 3, o2o: 1, o2l: 0.3, fc: 3000, fe: 0.2, fdc: 900, ad: 1200, as: 0.3, ar: 600, ch: 1 }]
  ];

  // ---------------------------------------------------------------- the patch

  function normalise(src) {
    src = src && typeof src === "object" ? src : {};
    var p = SynthParam.defaults(), sp = src.p || {};
    SYNTH_PARAMS.forEach(function (d) { if (typeof sp[d.k] === "number") p[d.k] = Math.max(d.min, Math.min(d.max, sp[d.k])); });
    var files = Array.isArray(src.files) ? src.files.slice(0, 2) : [];
    while (files.length < 2) files.push("");
    return { name: typeof src.name === "string" ? src.name : "New patch", p: p, files: files.map(function (f) { return typeof f === "string" ? f : ""; }), map: src.map && typeof src.map === "object" ? src.map : {} };
  }
  function snapshot() { return JSON.stringify(patch); }

  function save() { clearTimeout(saveTimer); ctx.setSave("Saving…"); saveTimer = setTimeout(doSave, 300); }
  function doSave() {
    if (saving) { saveAgain = true; return; }
    saving = true;
    ctx.api("PUT", "/api/synth", JSON.stringify(patch)).then(function (j) { rev = j.rev; ctx.setSave("Saved on the WVR"); },
      function (e) { ctx.setSave("Not saved: " + e.message, true); })
      .then(function () { saving = false; if (saveAgain) { saveAgain = false; doSave(); } });
  }
  // every change to the patch: remembered for undo, drawn, saved
  function change(fn, redraw) {
    undo.push(snapshot()); if (undo.length > 100) undo.shift();
    redo = [];
    fn();
    if (redraw !== false) render();
    save();
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(snapshot());
    patch = normalise(JSON.parse(from.pop()));
    render(); save();
  }

  // ---------------------------------------------------------------- drawing

  function ccOf(k) { for (var cc in patch.map) if (patch.map[cc] === k) return cc; return null; }

  function control(d) {
    var v = patch.p[d.k], cc = ccOf(d.k), esc = ctx.esc;
    var chip = cc !== null || learnMode
      ? '<button class="sp-cc' + (learning === d.k ? " armed" : "") + (cc !== null ? " mapped" : "") + '" data-learn="' + d.k + '" type="button" title="' +
        (learnMode ? "Click, then move a knob on your MIDI controller" : "MIDI controller " + cc) + '">' +
        (learning === d.k ? "move a knob…" : cc !== null ? "CC " + cc : "learn") + "</button>" +
        (learnMode && cc !== null && learning !== d.k ? '<button class="sp-forget" data-forget="' + d.k + '" type="button" title="Forget this controller" aria-label="Forget">×</button>' : "")
      : "";
    var body;
    if (d.c === "list") {
      body = '<div class="seg" role="group" aria-label="' + esc(d.l) + '">' + d.o.map(function (o, i) {
        var val = i + d.min;
        return '<button type="button" data-k="' + d.k + '" data-v="' + val + '" class="' + (Math.round(v) === val ? "on" : "") + '">' + esc(o) + "</button>";
      }).join("") + "</div>";
    } else {
      body = '<input type="range" min="0" max="1000" step="1" data-k="' + d.k + '" value="' + Math.round(SynthParam.toUnit(d, v) * 1000) + '" aria-label="' + esc(d.g + " " + d.l) + '">';
    }
    return '<div class="sp' + (learning === d.k ? " learning" : "") + '" data-row="' + d.k + '"><div class="sp-top"><span class="sp-l">' + esc(d.l) +
      '</span><span class="sp-v" id="sv_' + d.k + '">' + esc(SynthParam.format(d, v)) + "</span>" + chip + "</div>" + body + "</div>";
  }

  function sampleRow(k) {
    var f = patch.files[k], name = f ? f.replace(/^syn-/, "").replace(/-[0-9a-f]{5}\.wav$/, "").replace(/-/g, " ") : "";
    return '<div class="sp sp-file"><div class="sp-top"><span class="sp-l">Sample</span><span class="sp-v">' + (name ? ctx.esc(name) : "none yet") + "</span></div>" +
      '<div class="btnrow"><button class="btn small" type="button" data-sact="lib" data-osc="' + k + '">Use the library\'s selected sound</button>' +
      '<button class="btn small" type="button" data-sact="file" data-osc="' + k + '">Choose a file…</button></div>' +
      '<p class="help">Plays at its own pitch on C3 (MIDI note 60).</p></div>';
  }

  var GROUP_ORDER = ["Oscillator 1", "Oscillator 2", "Filter", "Filter envelope", "Amp envelope", "LFO", "Voices", "Chorus", "Echo", "Output"];
  function render() {
    var pane = $("synthPane"); if (!pane || !patch) return;
    var groups = {};
    SYNTH_PARAMS.forEach(function (d) { (groups[d.g] = groups[d.g] || []).push(d); });
    var cards = GROUP_ORDER.map(function (g) {
      var rows = groups[g].filter(function (d) {
        if (d.k === "o1lp") return patch.p.o1w === 5;
        if (d.k === "o2lp") return patch.p.o2w === 5;
        if (d.k === "o1pw") return patch.p.o1w === 1;
        if (d.k === "o2pw") return patch.p.o2w === 1;
        return true;
      }).map(control).join("");
      if (g === "Oscillator 1" && patch.p.o1w === 5) rows += sampleRow(0);
      if (g === "Oscillator 2" && patch.p.o2w === 5) rows += sampleRow(1);
      return '<section class="scard" data-group="' + g + '"><h3>' + ctx.esc(g) + "</h3>" + rows + "</section>";
    }).join("");
    if (document.activeElement !== $("patchName")) $("patchName").value = patch.name;
    $("synthCards").innerHTML = cards;
    $("learnBtn").classList.toggle("on", learnMode);
    $("learnBtn").textContent = learnMode ? "MIDI learn: on" : "MIDI learn";
    $("learnHelp").hidden = !learnMode;
    renderKeys();
    ctx.tools();
  }

  function renderKeys() {
    var kb = $("synthKeys"), html = "", white = 0;
    for (var n = base; n <= base + 24; n++) {
      var black = [1, 3, 6, 8, 10].indexOf(n % 12) >= 0;
      html += '<div class="key ' + (black ? "black" : "white") + (held[n] ? " down" : "") + '" data-note="' + n + '"' +
        (black ? ' style="left:calc(' + white + ' * var(--kw) - var(--kw) * 0.3)"' : "") + ">" + (n % 12 === 0 ? "<span>" + WVR.noteName(n) + "</span>" : "") + "</div>";
      if (!black) white++;
    }
    kb.innerHTML = html;
    kb.style.setProperty("--whites", white);
  }

  // ---------------------------------------------------------------- playing

  function noteOn(n, v) { if (held[n] || n < 0 || n > 127) return; held[n] = true; ctx.api("POST", "/api/note?n=" + n + "&v=" + (v || 100)).catch(function () {}); markKey(n); }
  function noteOff(n) { if (!held[n]) return; delete held[n]; ctx.api("POST", "/api/note?n=" + n + "&v=0").catch(function () {}); markKey(n); }
  function allOff() { Object.keys(held).forEach(function (n) { noteOff(Number(n)); }); }
  function markKey(n) { var k = document.querySelector('#synthKeys [data-note="' + n + '"]'); if (k) k.classList.toggle("down", !!held[n]); }

  // A, W, S, E, D… play the keyboard from its lowest C; Z and X move it an octave.
  var KEYS = "awsedftgyhujkolp;'";
  function key(e, down) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    var k = e.key.toLowerCase();
    if (down && (k === "z" || k === "x")) { allOff(); base = Math.max(12, Math.min(96, base + (k === "z" ? -12 : 12))); renderKeys(); return true; }
    var i = KEYS.indexOf(k);
    if (i < 0) return false;
    if (down) { if (!e.repeat) noteOn(base + i, 100); } else noteOff(base + i);
    return true;
  }

  // ---------------------------------------------------------------- samples as oscillators

  function useSample(k, getBytes, label) {
    ctx.status("Preparing “" + label + "” for oscillator " + (k + 1) + "…");
    var name;
    getBytes().then(function (bytes) {
      return PDAudio.decode(bytes);
    }).then(function (snd) {
      // mono (the synth plays samples in mono), silence trimmed so it starts at once, normalised
      var n = snd.channels[0].length, m = new Float32Array(n);
      snd.channels.forEach(function (c) { for (var i = 0; i < n; i++) m[i] += c[i] / snd.channels.length; });
      var prep = PDAudio.prepare({ rate: snd.rate, channels: [m], sourceBits: snd.sourceBits }, { rate: 44100, trim: true, normalise: true }).sound;
      name = "syn-" + WVR.fileName(label);
      return ctx.upload(name, PDAudio.encodeWav16(prep, 1));
    }).then(function () {
      var old = patch.files[k];
      change(function () { patch.files[k] = name; });
      ctx.status("“" + label + "” is oscillator " + (k + 1) + "’s sound.", "ok");
      if (old && patch.files.indexOf(old) < 0) setTimeout(function () { ctx.api("DELETE", "/api/file?name=" + old).catch(function () {}); }, 1500);
    }).catch(function (e) { ctx.status("Couldn't use “" + label + "”: " + e.message, "err"); });
  }

  // ---------------------------------------------------------------- events

  function bind() {
    var pane = $("synthPane");
    pane.addEventListener("input", function (e) {
      var t = e.target, k = t.dataset.k; if (!k || t.type !== "range") return;
      var d = SynthParam.byKey[k], v = SynthParam.fromUnit(d, t.value / 1000);
      editingUntil = Date.now() + 1500;
      $("sv_" + k).textContent = SynthParam.format(d, v);
      ctx.sendLive(k, 0, v);
    });
    pane.addEventListener("change", function (e) {
      var t = e.target;
      if (t.id === "patchName") { var nm = t.value.trim().slice(0, 40) || "New patch"; change(function () { patch.name = nm; }, false); return; }
      var k = t.dataset.k; if (!k || t.type !== "range") return;
      var d = SynthParam.byKey[k], v = SynthParam.fromUnit(d, t.value / 1000);
      change(function () { patch.p[k] = v; }, false);
    });
    pane.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.dataset.k && b.dataset.v !== undefined) {
        var k = b.dataset.k, v = Number(b.dataset.v);
        ctx.sendLive(k, 0, v);
        change(function () { patch.p[k] = v; });
      } else if (b.dataset.learn) {
        if (!learnMode) { learnMode = true; }
        var lk = b.dataset.learn;
        learning = learning === lk ? "" : lk;
        ctx.api("POST", "/api/learn?k=" + learning).catch(function () {});
        render();
      } else if (b.dataset.forget) {
        var fk = b.dataset.forget;
        ctx.api("POST", "/api/learn?k=" + fk + "&forget=1").catch(function () {});
        change(function () { var cc = ccOf(fk); if (cc !== null) delete patch.map[cc]; });
      } else if (b.id === "learnBtn") {
        learnMode = !learnMode;
        if (!learnMode && learning) { learning = ""; ctx.api("POST", "/api/learn?k=").catch(function () {}); }
        render();
      } else if (b.dataset.sact) {
        var osc = Number(b.dataset.osc);
        if (b.dataset.sact === "lib") {
          var s = ctx.librarySound();
          if (!s) return ctx.status("Select a sound in the library first.", "err");
          useSample(osc, s.read, s.name);
        } else {
          var input = $("synthFile");
          input.dataset.osc = osc; input.value = ""; input.click();
        }
      } else if (b.id === "octDown" || b.id === "octUp") {
        allOff(); base = Math.max(12, Math.min(96, base + (b.id === "octDown" ? -12 : 12))); renderKeys();
      } else if (b.id === "patchDownload") {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([JSON.stringify(patch, null, 1)], { type: "application/json" }));
        a.download = (patch.name || "patch").replace(/[\\/:*?"<>|]+/g, "-") + ".wvrpatch.json";
        document.body.appendChild(a); a.click(); a.remove();
      } else if (b.id === "patchOpen") {
        var pi = $("patchFile"); pi.value = ""; pi.click();
      }
    });
    $("presetSel").addEventListener("change", function () {
      var pr = PRESETS[Number(this.value)]; this.value = "";
      if (!pr) return;
      change(function () { patch.p = preset(pr[1]); patch.name = pr[0]; });
      ctx.api("POST", "/api/stop").catch(function () {});
    });
    $("synthFile").addEventListener("change", function () {
      var f = this.files[0], k = Number(this.dataset.osc || 0); if (!f) return;
      useSample(k, function () { return f.arrayBuffer(); }, f.name.replace(/\.[^.]*$/, ""));
    });
    $("patchFile").addEventListener("change", function () {
      var f = this.files[0]; if (!f) return;
      f.text().then(function (txt) {
        var p = normalise(JSON.parse(txt));
        p.files = patch.files;       // the samples belong to this WVR, not to the file
        change(function () { patch = p; });
        ctx.status("Opened “" + p.name + "”.", "ok");
      }).catch(function () { ctx.status("That isn't a patch file.", "err"); });
    });
    // the on-screen keyboard: press, slide across keys, let go
    var kb = $("synthKeys"), dragging = false;
    kb.addEventListener("pointerdown", function (e) { var k = e.target.closest(".key"); if (!k) return; dragging = true; kb.setPointerCapture(e.pointerId); noteOn(Number(k.dataset.note), 100); e.preventDefault(); });
    kb.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var el = document.elementFromPoint(e.clientX, e.clientY), k = el && el.closest && el.closest("#synthKeys .key");
      if (!k) return;
      var n = Number(k.dataset.note);
      if (!held[n]) { allOff(); noteOn(n, 100); }
    });
    var up = function () { if (dragging) { dragging = false; allOff(); } };
    kb.addEventListener("pointerup", up); kb.addEventListener("pointercancel", up);
    window.addEventListener("blur", allOff);
    var sel = $("presetSel");
    sel.innerHTML = '<option value="">Presets…</option>' + PRESETS.map(function (p, i) { return '<option value="' + i + '">' + ctx.esc(p[0]) + "</option>"; }).join("");
  }

  // ---------------------------------------------------------------- from app.js

  return {
    init: function (c) { ctx = c; bind(); },
    show: function (src, r) { patch = normalise(src); rev = r; undo = []; redo = []; render(); },
    // the polled status: patch changed on the WVR (MIDI knobs, learn), and the learn state
    status: function (st) {
      if (!st || !patch) return;
      var wasLearning = learning;
      if (learning && !st.learn) learning = "";
      if (st.rev !== rev && !saving && Date.now() > editingUntil) {
        rev = st.rev;
        ctx.api("GET", "/api/synth").then(function (s) { if (!saving) { patch = normalise(s); render(); } }).catch(function () {});
      } else if (wasLearning !== learning) render();
    },
    undo: function () { restore(undo, redo); },
    redo: function () { restore(redo, undo); },
    canUndo: function () { return undo.length > 0; },
    canRedo: function () { return redo.length > 0; },
    key: key,
    allOff: allOff,
    usedFiles: function () { return patch ? patch.files.filter(Boolean) : []; },
    presets: PRESETS
  };
})();
