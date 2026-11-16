/*
 * The manager's page: the library on the left, the WVR on the right, the selected
 * sound below. The model (WVR, Lib) is in model.js.
 */
"use strict";

(function () {
  // ?host=192.168.4.1 lets a copy of this page on a computer talk to a device.
  var params = new URLSearchParams(location.search), host = params.get("host");
  var BASE = host ? "http://" + host : "";
  // Without a device (on GitHub Pages, from a file, or with ?demo) a pretend one in the browser answers.
  var DEMO = !host && typeof WVRDemo !== "undefined" && (/github\.io$/.test(location.hostname) || location.protocol === "file:" || params.has("demo"));
  // Writing into a folder needs Chrome or Edge, and a page from https (the WVR's own page is http).
  var CAN_WRITE = !!window.showDirectoryPicker && window.isSecureContext;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }

  // ================================================================ state

  var device = null, project = null, rev = -1;
  var wvrUndo = [], wvrRedo = [];
  var status = { playing: [], errors: {}, peak: [0, 0], voices: 0, under: 0 };
  var busy = {};                       // slot -> upload progress 0..1

  var lib = { items: [], removed: [], name: "", dir: null, dirty: false, undo: [], redo: [] };
  var info = {};                       // item id -> { dur, ch, rate, peaks, size, err } (kept apart from undo)

  var panes = {
    lib: { sel: [], cursor: null, anchor: null },
    wvr: { sel: [0], cursor: 0, anchor: 0 }
  };
  var active = "wvr";
  var clip = null;                     // { from: "lib", items } or { from: "wvr", sounds }

  // ================================================================ the device

  function api(method, path, body) {
    if (DEMO) return WVRDemo.request(method, path, body);
    return fetch(BASE + path, { method: method, body: body }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.error || r.statusText);
        return j;
      });
    });
  }
  function getDeviceFile(name) {
    if (DEMO) return WVRDemo.request("GET", "/api/file?name=" + name);
    return fetch(BASE + "/api/file?name=" + name).then(function (r) {
      if (!r.ok) throw new Error("couldn't read the sound from the WVR");
      return r.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    });
  }
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

  function load() {
    return api("GET", "/api/state").then(function (st) {
      device = st; rev = st.rev;
      project = WVR.normalise(st.project, st.slots);
      wvrUndo = []; wvrRedo = [];
      // sounds no slot uses any more (cleared in an earlier session) are removed from the WVR
      var used = WVR.usedFiles(project);
      st.files.forEach(function (f) { if (!used[f.name]) api("DELETE", "/api/file?name=" + f.name).catch(function () {}); });
      $("banner").hidden = true;
      renderAll();
    });
  }

  function setSave(text, err) { var e = $("saveState"); e.textContent = text; e.className = "save" + (err ? " err" : ""); }
  var saveTimer = 0, saving = false, saveAgain = false, savePending = false;
  function save() { clearTimeout(saveTimer); savePending = true; setSave("Saving…"); saveTimer = setTimeout(doSave, 250); }
  function doSave() {
    if (saving) { saveAgain = true; return; }
    saving = true; savePending = false;
    api("PUT", "/api/project", WVR.serialise(project)).then(function (j) { rev = j.rev; setSave("Saved on the WVR"); },
      function (e) { setSave("Not saved: " + e.message, true); })
      .then(function () { saving = false; if (saveAgain) { saveAgain = false; doSave(); } });
  }

  // Every change to the WVR goes through here: remembered for undo, drawn, saved.
  function changeWvr(fn) {
    wvrUndo.push(WVR.serialise(project)); if (wvrUndo.length > 100) wvrUndo.shift();
    wvrRedo = [];
    fn();
    renderWvr(); renderSlotEdit(); save();
  }
  function restoreWvr(from, to) {
    if (!from.length) return;
    to.push(WVR.serialise(project));
    project = WVR.normalise(JSON.parse(from.pop()), device.slots);
    renderWvr(); renderSlotEdit(); save();
  }

  // A slider being dragged: heard at once, saved when let go. Only the latest value is sent.
  var live = {}, liveBusy = false;
  function sendLive(key, slot, value) {
    live[key + ":" + slot] = { k: key, slot: slot, v: value };
    pumpLive();
  }
  function pumpLive() {
    var id = Object.keys(live)[0];
    if (liveBusy || !id) return;
    var m = live[id]; delete live[id];
    liveBusy = true;
    var done = function () { liveBusy = false; pumpLive(); };
    api("POST", "/api/live?k=" + m.k + "&v=" + m.v + (m.slot ? "&slot=" + m.slot : "")).then(done, done);
  }

  function poll() {
    api("GET", "/api/status").then(function (st) {
      status = st;
      $("banner").hidden = true;
      if (st.rev !== rev && !saving && !savePending) return load();   // changed from another browser
      drawStatus();
    }, function () {
      $("banner").hidden = false;
      $("banner").textContent = "No answer from the WVR. Check that it has power and that this computer is on its WiFi network.";
    }).catch(function () {}).then(function () { setTimeout(poll, 200); });
  }

  // ================================================================ the library

  function libSnapshot() { return { items: lib.items.map(function (it) { return Object.assign({}, it); }), removed: lib.removed.slice() }; }
  function changeLib(fn) {
    lib.undo.push(libSnapshot()); if (lib.undo.length > 100) lib.undo.shift();
    lib.redo = [];
    fn();
    lib.dirty = true;
    renderLib(); renderLibDetail();
  }
  function restoreLib(from, to) {
    if (!from.length) return;
    to.push(libSnapshot());
    var s = from.pop();
    lib.items = s.items; lib.removed = s.removed; lib.dirty = true;
    renderLib(); renderLibDetail();
  }
  function byId(id) { for (var i = 0; i < lib.items.length; i++) if (lib.items[i].id === id) return lib.items[i]; return null; }
  function itemFile(it) { return it.file ? Promise.resolve(it.file) : it.handle ? it.handle.getFile() : Promise.reject(new Error("the file is gone")); }
  function libStatus(text, kind) { var e = $("libStatus"); e.textContent = text || ""; e.className = "lstatus" + (kind ? " " + kind : ""); }
  function wvrStatus(text, kind) { var e = $("wvrStatus"); e.textContent = text || ""; e.className = "lstatus" + (kind ? " " + kind : ""); }

  // Durations and waveforms, worked out one file at a time in the background.
  var queue = [], analysing = false;
  function analyse(items) { items.forEach(function (it) { if (!info[it.id]) queue.push(it.id); }); pumpAnalysis(); }
  function pumpAnalysis() {
    if (analysing) return;
    var id = queue.shift();
    if (id === undefined) return;
    var it = byId(id);
    if (!it || info[id]) return pumpAnalysis();
    analysing = true;
    itemFile(it).then(function (f) {
      if (f.size > 300 * 1048576) throw new Error("too large to read here");
      return f.arrayBuffer().then(PDAudio.decode).then(function (snd) {
        info[id] = { dur: snd.channels[0].length / snd.rate, ch: snd.channels.length, rate: snd.rate, peaks: WVR.peaksOf(snd), size: f.size, bits: snd.sourceBits };
      });
    }).catch(function (e) { info[id] = { err: e.message || "can't be read" }; })
      .then(function () { analysing = false; updateLibRow(id); if (panes.lib.cursor === id) renderLibDetail(); setTimeout(pumpAnalysis, 0); });
  }

  function confirmDiscard() {
    if (!lib.dirty || !lib.items.length) return Promise.resolve(true);
    return ask("The library has changes that aren't saved. Open another folder and lose them?", null, "Lose them");
  }

  function setLibrary(name, dir, items) {
    lib = { items: items, removed: [], name: name, dir: dir, dirty: false, undo: [], redo: [] };
    panes.lib = { sel: [], cursor: null, anchor: null };
    active = "lib";
    var sorted = Lib.sorted(items);
    if (sorted.length) { panes.lib.sel = [sorted[0].id]; panes.lib.cursor = panes.lib.anchor = sorted[0].id; }
    renderLib(); renderDetail(); renderActive();
    analyse(Lib.sorted(items));
    libStatus(plural(items.length, "sound") + " in " + (name || "the library") + ".", "ok");
  }

  // A folder from Chrome or Edge: kept open, so Save writes into it.
  function walk(dir, prefix, depth, out) {
    var it = dir.values();
    function next() {
      return it.next().then(function (r) {
        if (r.done) return out;
        var h = r.value, name = h.name;
        if (name.charAt(0) === ".") return next();
        if (h.kind === "directory") return depth < 5 ? walk(h, prefix ? prefix + "/" + name : name, depth + 1, out).then(next) : next();
        if (Lib.isAudio(name)) out.push(Lib.item(prefix, name, { src: (prefix ? prefix + "/" : "") + name, handle: h }));
        return next();
      });
    }
    return next();
  }

  function openFolder() {
    confirmDiscard().then(function (go) {
      if (!go) return;
      if (!CAN_WRITE) { $("pickFolder").click(); return; }
      window.showDirectoryPicker({ id: "wvr-library", mode: "readwrite" }).then(function (dir) {
        libStatus("Reading " + dir.name + "…");
        return walk(dir, "", 0, []).then(function (items) { setLibrary(dir.name, dir, items); });
      }).catch(function (e) { if (e.name !== "AbortError") libStatus("Couldn't open the folder: " + e.message, "err"); });
    });
  }
  // Other browsers, and the WVR's own (http) page: the folder is read, Save makes a zip.
  $("pickFolder").addEventListener("change", function () {
    var files = Array.prototype.slice.call(this.files), root = "", items = [];
    files.forEach(function (f) {
      var parts = (f.webkitRelativePath || f.name).split("/");
      if (parts.length > 1) root = parts[0];
      var rel = parts.slice(1);
      if (rel.some(function (p) { return p.charAt(0) === "."; }) || !Lib.isAudio(f.name)) return;
      var cat = rel.slice(0, -1).join("/");
      items.push(Lib.item(cat, f.name, { src: rel.join("/"), file: f }));
    });
    this.value = "";
    setLibrary(root, null, items);
  });

  function saveLibrary() {
    if (!lib.items.length && !lib.removed.length) { libStatus("The library is empty: nothing to save."); return; }
    if (lib.dir) return saveToFolder(lib.dir);
    if (CAN_WRITE) {
      return window.showDirectoryPicker({ id: "wvr-library", mode: "readwrite" }).then(function (dir) {
        return countEntries(dir).then(function (n) {
          return n ? ask("“" + dir.name + "” already has things in it. Sounds with the same names are replaced. Save into it?", null, "Save into it") : true;
        }).then(function (go) {
          if (!go) return;
          lib.items.forEach(function (it) { if (it.src && !it.file && !it.handle) it.src = null; });
          lib.removed = lib.removed.filter(function (it) { return false; });
          lib.items.forEach(function (it) { it.src = null; });   // a new folder: everything is new there
          lib.dir = dir; lib.name = dir.name;
          return saveToFolder(dir);
        });
      }).catch(function (e) { if (e.name !== "AbortError") libStatus("Not saved: " + e.message, "err"); });
    }
    return saveZip();
  }
  function countEntries(dir) {
    var it = dir.values(), n = 0;
    return it.next().then(function (r) { return r.done ? 0 : 1; });
  }
  function dirAt(root, cat, create) {
    var parts = cat ? cat.split("/") : [], d = Promise.resolve(root);
    parts.forEach(function (p) { d = d.then(function (h) { return h.getDirectoryHandle(p, { create: create }); }); });
    return d;
  }
  function saveToFolder(dir) {
    var plan = Lib.savePlan(lib.items, lib.removed), done = 0, total = plan.writes.length + plan.deletes.length;
    if (!total) { lib.dirty = false; renderLibHead(); libStatus("Nothing to save: the folder is up to date.", "ok"); return Promise.resolve(); }
    libStatus("Saving…");
    // sounds whose place gets written over are read first
    var chain = Promise.all(plan.preload.map(function (it) {
      return itemFile(it).then(function (f) { return f.arrayBuffer(); }).then(function (b) { it.file = new Blob([b], { type: "audio/wav" }); });
    }));
    plan.writes.forEach(function (w) {
      chain = chain.then(function () {
        return itemFile(w.item).then(function (file) {
          var name = w.item.base + w.item.ext;
          return dirAt(dir, w.item.cat, true).then(function (d) { return d.getFileHandle(name, { create: true }); }).then(function (fh) {
            return fh.createWritable().then(function (out) { return out.write(file).then(function () { return out.close(); }); }).then(function () {
              w.item.handle = fh; w.item.file = null; w.item.src = w.to;
              libStatus("Saving… " + (++done) + " of " + total);
            });
          });
        });
      });
    });
    plan.deletes.forEach(function (p) {
      chain = chain.then(function () {
        var slash = p.lastIndexOf("/"), cat = slash < 0 ? "" : p.slice(0, slash), name = p.slice(slash + 1);
        return dirAt(dir, cat, false).then(function (d) { return d.removeEntry(name); })
          .catch(function (e) { if (e.name !== "NotFoundError") throw e; })
          .then(function () { libStatus("Saving… " + (++done) + " of " + total); });
      });
    });
    return chain.then(function () {
      lib.removed = []; lib.dirty = false;
      renderLibHead();
      libStatus("Saved in " + dir.name + ": " + plural(plan.writes.length, "sound") + " written, " + plural(plan.deletes.length, "file") + " removed. Empty folders are left as they are.", "ok");
    }, function (e) { libStatus("Saving stopped: " + e.message + ". Some changes may already be in the folder; Save again to finish.", "err"); });
  }
  function saveZip() {
    var root = Lib.cleanBase(lib.name || "Library"), entries = [], items = Lib.sorted(lib.items), chain = Promise.resolve();
    libStatus("Making the zip…");
    items.forEach(function (it) {
      chain = chain.then(function () { return itemFile(it).then(function (f) { return f.arrayBuffer(); }).then(function (b) { entries.push({ name: root + "/" + Lib.path(it), data: new Uint8Array(b) }); }); });
    });
    return chain.then(function () {
      var blob = new Blob(Zip.build(entries), { type: "application/zip" }), a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = root + ".zip";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      lib.dirty = false; renderLibHead();
      libStatus("Downloaded " + root + ".zip with " + plural(items.length, "sound") + ". Unzip it and put the folder in place of the old one." +
        (CAN_WRITE || window.showDirectoryPicker ? "" : " (Chrome or Edge can save straight into the folder.)"), "ok");
    }, function (e) { libStatus("Couldn't make the zip: " + e.message, "err"); });
  }

  function addToLibrary(files, cat) {
    var add = [];
    Array.prototype.forEach.call(files, function (f) {
      if (!Lib.isAudio(f.name) && !/^audio\//.test(f.type)) return;
      var it = Lib.item(cat, f.name, { file: f });
      it.base = Lib.uniqueBase(lib.items.concat(add), it, Lib.cleanBase(it.base));
      add.push(it);
    });
    if (!add.length) { libStatus("Those weren't sounds.", "err"); return; }
    changeLib(function () { lib.items = lib.items.concat(add); selectIds("lib", add.map(function (it) { return it.id; })); });
    analyse(add);
    libStatus(plural(add.length, "sound") + " added" + (cat ? " to " + cat : "") + ". Save to keep them in the folder.");
  }

  // ================================================================ between the two

  function prepareFor(bytes) {
    return PDAudio.decode(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes).then(function (snd) {
      return PDAudio.prepare(snd, { rate: 44100, trim: $("optTrim").checked, mono: true, normalise: $("optNorm").checked }).sound;
    });
  }

  // Sounds into slots: [{ name, src, read() -> Promise<ArrayBuffer> }], into the given slots in order.
  var sending = Promise.resolve();
  function sendToSlots(sounds, slots) {
    sounds = sounds.slice(0, slots.length);
    if (!sounds.length) return sending;
    sounds.forEach(function (s, k) { busy[slots[k]] = 0; });
    renderWvr();
    sounds.forEach(function (snd, k) {
      var i = slots[k];
      sending = sending.then(function () {
        wvrStatus("Sending “" + snd.name + "” to slot " + (i + 1) + "…");
        return snd.read().then(prepareFor).then(function (prep) {
          var name = WVR.fileName(snd.src || snd.name), bytes = PDAudio.encodeWav16(prep, i + 1);
          return upload(name, bytes, function (p) { busy[i] = p; var bar = document.querySelector('#wvrList [data-i="' + i + '"] .lprog i'); if (bar) bar.style.width = Math.round(p * 100) + "%"; })
            .then(function () {
              delete busy[i];
              changeWvr(function () {
                var s = project.slots[i], keep = s.file ? WVR.sound(s) : null;
                if (!keep) WVR.clear(project, i);         // a new sound in an empty slot starts from the defaults
                s.file = name; s.src = snd.src || snd.name; s.dur = prep.channels[0].length / prep.rate; s.ch = prep.channels.length; s.peaks = WVR.peaksOf(prep);
                s.name = snd.name; s.start = 0; s.end = 0;      // a new sound plays whole
              });
            });
        }).catch(function (e) {
          delete busy[i]; renderWvr();
          wvrStatus("“" + snd.name + "” wasn't sent: " + e.message, "err");
          throw e;
        });
      }).catch(function () {});
    });
    return sending.then(function () { if (!$("wvrStatus").classList.contains("err")) wvrStatus(plural(sounds.length, "sound") + " on the WVR.", "ok"); });
  }
  function libSounds(ids) {
    return Lib.sorted(ids.map(byId).filter(Boolean)).map(function (it) {
      return { name: it.base, src: it.base + it.ext, read: function () { return itemFile(it).then(function (f) { return f.arrayBuffer(); }); } };
    });
  }
  function fileSounds(files) {
    return Array.prototype.slice.call(files).sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); })
      .map(function (f) { return { name: WVR.displayName(f.name), src: f.name, read: function () { return f.arrayBuffer(); } }; });
  }
  function slotsFrom(start, n) { var out = []; for (var i = start; i < project.slots.length && out.length < n; i++) out.push(i); return out; }
  function emptySlotsFrom(start, n) {
    var out = [];
    for (var k = 0; k < project.slots.length && out.length < n; k++) { var i = (start + k) % project.slots.length; if (!project.slots[i].file && busy[i] === undefined) out.push(i); }
    return out;
  }
  function sendLibToWvr(ids, start, onlyEmpty) {
    var sounds = libSounds(ids);
    if (!sounds.length) { libStatus("Select sounds in the library first."); return; }
    var slots = onlyEmpty ? emptySlotsFrom(start, sounds.length) : slotsFrom(start, sounds.length);
    if (!slots.length) { wvrStatus(onlyEmpty ? "The WVR has no empty slots. Drop the sounds on a slot to replace it." : "No slots left after this one.", "err"); return; }
    if (slots.length < sounds.length) wvrStatus("Only " + plural(slots.length, "slot") + " free: the first " + plural(slots.length, "sound") + " go.", "err");
    selectIds("wvr", slots);
    sendToSlots(sounds, slots);
  }

  // Slots' sounds into the library, as WAV files.
  function wvrToLibrary(slots, cat) {
    var list = slots.filter(function (i) { return project.slots[i].file; });
    if (!list.length) { wvrStatus("Select slots with sounds first."); return; }
    wvrStatus("Copying " + plural(list.length, "sound") + " into the library…");
    Promise.all(list.map(function (i) {
      var s = project.slots[i];
      return getDeviceFile(s.file).then(function (bytes) { return { slot: s, bytes: bytes }; });
    })).then(function (got) {
      var add = [];
      got.forEach(function (g) {
        var it = Lib.item(cat, Lib.cleanBase(g.slot.name || WVR.displayName(g.slot.src) || "Sound") + ".wav", { file: new Blob([g.bytes], { type: "audio/wav" }) });
        it.base = Lib.uniqueBase(lib.items.concat(add), it, it.base);
        info[it.id] = { dur: g.slot.dur, ch: g.slot.ch, rate: 44100, peaks: g.slot.peaks, size: g.bytes.length, bits: 16 };
        add.push(it);
      });
      changeLib(function () { lib.items = lib.items.concat(add); selectIds("lib", add.map(function (it) { return it.id; })); });
      setActive("lib");
      wvrStatus("");
      libStatus(plural(add.length, "sound") + " copied from the WVR into " + (cat || "the library") + ". Save to keep them in the folder.");
    }).catch(function (e) { wvrStatus("Couldn't copy: " + e.message, "err"); });
  }
  function targetCat() {
    var cur = byId(panes.lib.cursor);
    return cur ? cur.cat : "From WVR";
  }

  // ================================================================ playing on this computer (library)

  var ctx = null, preview = null, decoded = {};
  function previewStop() {
    if (preview) { try { preview.src.stop(); } catch (e) {} preview = null; }
    markLibPlaying();
  }
  function previewPlay(it) {
    if (preview && preview.id === it.id) { previewStop(); return; }
    previewStop();
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    var got = decoded[it.id] ? Promise.resolve(decoded[it.id]) : itemFile(it).then(function (f) { return f.arrayBuffer(); }).then(PDAudio.decode).then(function (snd) {
      var b = ctx.createBuffer(snd.channels.length, snd.channels[0].length, snd.rate);
      snd.channels.forEach(function (c, i) { b.getChannelData(i).set(c); });
      var keys = Object.keys(decoded); if (keys.length > 8) delete decoded[keys[0]];
      return (decoded[it.id] = b);
    });
    got.then(function (buf) {
      var src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
      var me = { id: it.id, src: src };
      src.onended = function () { if (preview === me) { preview = null; markLibPlaying(); } };
      src.start(); preview = me; markLibPlaying();
    }, function (e) { libStatus("Can't play “" + it.base + "”: " + e.message, "err"); });
  }
  function markLibPlaying() {
    Array.prototype.forEach.call($("libList").querySelectorAll(".lrow"), function (li) { li.classList.toggle("playing", !!preview && Number(li.dataset.id) === preview.id); });
    var b = $("lPlay"); if (b) b.textContent = preview && preview.id === panes.lib.cursor ? "■ Stop" : "▶ Play";
  }

  // ================================================================ drawing

  function drawWave(canvas, hex) {
    if (!canvas) return;
    var r = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * r; canvas.height = h * r;
    var g = canvas.getContext("2d");
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!hex) return;
    var peaks = WVR.peaksFrom(hex), bw = canvas.width / peaks.length;
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--wave");
    peaks.forEach(function (p, i) {
      var bh = Math.max(r, Math.sqrt(p) * canvas.height * 0.9);
      g.fillRect(i * bw, (canvas.height - bh) / 2, Math.max(1, bw - r), bh);
    });
  }

  function libMeta(it) {
    var n = info[it.id];
    if (!n) return "…";
    if (n.err) return '<span class="bad">' + esc(n.err) + "</span>";
    return WVR.fmtDur(n.dur) + " · " + (n.ch === 1 ? "mono" : n.ch === 2 ? "stereo" : n.ch + " ch") + " · " + (n.rate / 1000) + "k";
  }
  function libRowHtml(it, n) {
    var p = panes.lib;
    return '<li class="lrow' + (p.sel.indexOf(it.id) >= 0 ? " on" : "") + (it.id === p.cursor ? " cursor" : "") + (preview && preview.id === it.id ? " playing" : "") +
      '" data-id="' + it.id + '" draggable="true"><span class="lno">' + n + '</span><span class="lname" title="' + esc(Lib.path(it)) + '">' + esc(it.base) +
      '</span><span class="lmeta">' + libMeta(it) + '</span><canvas class="lmini"></canvas></li>';
  }
  function visibleLib() {
    var q = $("libFind").value.trim();
    return Lib.sorted(lib.items).filter(function (it) { return Lib.matches(it, q); });
  }
  function renderLibHead() {
    var e = $("libName");
    e.textContent = (lib.name || (lib.items.length ? "Not saved yet" : "No folder open")) + (lib.dirty ? " · changed" : "") + (lib.name && !lib.dir ? " · read only" : "");
    e.className = "lpane-file" + (lib.dirty ? " dirty" : "");
    $("libSave").textContent = lib.dir || CAN_WRITE ? "Save" : "Save zip";
    $("libSave").disabled = !lib.dirty && !!lib.name;
    $("catList").innerHTML = Lib.categories(lib.items).filter(Boolean).concat(["From WVR"]).filter(function (c, i, a) { return a.indexOf(c) === i; })
      .map(function (c) { return '<option value="' + esc(c) + '">'; }).join("");
    tools();
  }
  function renderLib() {
    renderLibHead();
    var list = $("libList"), items = visibleLib(), html = "", cat = null, n = 0;
    if (!lib.items.length) {
      list.innerHTML = '<li class="lempty"><span>Open a folder of sounds on this computer, or drop sounds here. Its folders become categories.</span>' +
        (DEMO ? '<button class="btn" data-act="examples">Try with example sounds</button>' : "") + "</li>";
    } else if (!items.length) {
      list.innerHTML = '<li class="lempty">Nothing matches “' + esc($("libFind").value) + "”.</li>";
    } else {
      items.forEach(function (it) {
        if (it.cat !== cat) {
          cat = it.cat;
          var count = items.filter(function (o) { return o.cat === cat; }).length;
          html += '<li class="lstyle" data-cat="' + esc(cat) + '"><button class="lstyle-name" type="button" title="Select all of it">' + esc(cat || lib.name || "Library") +
            '</button><span class="help">' + count + "</span></li>";
        }
        html += libRowHtml(it, ++n);
      });
      list.innerHTML = html;
      Array.prototype.forEach.call(list.querySelectorAll(".lrow"), function (li) { var n2 = info[li.dataset.id]; if (n2) drawWave(li.querySelector("canvas"), n2.peaks); });
    }
    var cats = Lib.categories(lib.items).length;
    $("libCount").textContent = lib.items.length ? plural(lib.items.length, "sound") + " · " + plural(cats, "category", "categories") : "";
  }
  function updateLibRow(id) {
    var li = $("libList").querySelector('.lrow[data-id="' + id + '"]'), it = byId(id);
    if (!li || !it) return;
    li.querySelector(".lmeta").innerHTML = libMeta(it);
    if (info[id]) drawWave(li.querySelector("canvas"), info[id].peaks);
  }

  function wvrTags(s) {
    var t = [];
    if (s.file) t.push(WVR.fmtDur(WVR.part(s).len) + (WVR.part(s).len < s.dur - 0.0005 ? " ✂" : ""));
    if (s.file && s.gain) t.push(WVR.fmtDb(s.gain));
    if (s.loop) t.push("loop");
    if (s.hold) t.push("hold");
    if (s.group) t.push("grp " + s.group);
    if (s.pin) t.push("D" + s.pin);
    if (s.note >= 0 && s.file) t.push(WVR.noteName(s.note));
    return t.join(" · ");
  }
  function renderWvr() {
    if (!project) return;
    var p = panes.wvr, playing = {};
    status.playing.forEach(function (n) { playing[n - 1] = true; });
    $("wvrList").innerHTML = project.slots.map(function (s, i) {
      var up = busy[i] !== undefined, err = status.errors[i + 1];
      return '<li class="lrow' + (s.file ? "" : " empty") + (p.sel.indexOf(i) >= 0 ? " on" : "") + (i === p.cursor ? " cursor" : "") + (playing[i] ? " playing" : "") +
        '" data-i="' + i + '" draggable="' + (s.file ? "true" : "false") + '"><span class="lno">' + (i + 1) + '</span><span class="lname">' +
        esc(up ? "Sending…" : s.name || (s.file ? s.src : "Empty")) + '</span><span class="lmeta">' + (err ? '<span class="bad">' + esc(err) + "</span>" : esc(wvrTags(s))) + "</span>" +
        (up ? '<div class="lprog"><i style="width:' + Math.round(busy[i] * 100) + '%"></i></div>' : '<canvas class="lmini"></canvas>') +
        (s.file ? '<button class="go" type="button" title="Play or stop on the WVR" aria-label="Play slot ' + (i + 1) + '">' + (playing[i] ? "■" : "▶") + "</button>" : "<span></span>") + "</li>";
    }).join("");
    Array.prototype.forEach.call($("wvrList").querySelectorAll(".lrow"), function (li) { drawWave(li.querySelector("canvas"), project.slots[li.dataset.i].peaks); });
    if (document.activeElement !== $("projName")) $("projName").value = project.name;
    $("master").value = project.master; $("masterOut").textContent = WVR.fmtDb(project.master);
    $("devName").textContent = device.device.name;
    tools();
  }

  function drawStatus() {
    if (!project) return;
    var playing = {};
    status.playing.forEach(function (n) { playing[n - 1] = true; });
    Array.prototype.forEach.call($("wvrList").querySelectorAll(".lrow"), function (li) {
      var i = Number(li.dataset.i), err = status.errors[i + 1];
      li.classList.toggle("playing", !!playing[i]);
      var go = li.querySelector(".go"); if (go) go.textContent = playing[i] ? "■" : "▶";
      if (err && busy[i] === undefined) li.querySelector(".lmeta").innerHTML = '<span class="bad">' + esc(err) + "</span>";
    });
    [["mL", 0], ["mR", 1]].forEach(function (m) {
      var pk = status.peak[m[1]], db = pk > 0 ? 20 * Math.log10(pk) : -90, e = $(m[0]);
      e.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + "%";
      e.classList.toggle("hot", pk >= 0.999);
    });
    var b = $("wPlay"); if (b) b.textContent = playing[panes.wvr.cursor] ? "■ Stop" : "▶ Play";
    $("foot").innerHTML = "Firmware " + esc(device.fw) + " · " + status.voices + " of " + device.voices + " voices playing" +
      (status.under ? " · waited for storage " + status.under + "×" : "") + " · " + gb(device.space.free) + " free of " + gb(device.space.total) +
      ' · <a href="https://github.com/Radio32/RadioWVR">Source</a>';
  }
  function gb(b) { return (b / 1073741824).toFixed(1) + " GB"; }

  // ---------------------------------------------------------------- the detail below the panes

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

  // Under the library list: the selected sound. Beside the WVR's slots: the selected slot.
  function renderDetail() { renderLibDetail(); renderSlotEdit(); }

  function renderLibDetail() {
    var d = $("libDetail"), it = byId(panes.lib.cursor);
    if (!it) { d.hidden = true; return; }
    d.hidden = false;
    var n = info[it.id] || {};
    d.innerHTML =
      '<div class="dhead"><input type="text" id="libRename" maxlength="120" value="' + esc(it.base) + '" aria-label="Name"></div>' +
      '<canvas class="lbig"></canvas>' +
      '<p class="help"><code>' + esc(Lib.path(it)) + "</code>" + (it.src ? "" : " · not saved yet") +
      (n.err ? " · " + esc(n.err) : n.dur ? " · " + WVR.fmtDur(n.dur) + " · " + (n.ch === 1 ? "mono" : n.ch + " ch") + " · " + n.rate + " Hz · " +
        (n.bits === "float" ? "float" : n.bits === "compressed" ? "compressed" : n.bits + "-bit") + " · " + (n.size / 1048576).toFixed(1) + " MB" : " · reading…") + "</p>" +
      '<div class="row"><button class="btn primary" id="lPlay">' + (preview && preview.id === it.id ? "■ Stop" : "▶ Play") + "</button>" +
      '<button class="btn" data-dact="send">To WVR →</button>' +
      '<label class="field" style="flex:1;min-width:160px"><input type="text" id="libCat" list="catList" value="' + esc(it.cat) + '" placeholder="Category (none)" aria-label="Category"></label></div>';
    drawWave(d.querySelector(".lbig"), n.peaks);
  }

  function renderSlotEdit() {
    if (!project) return;
    var d = $("slotEdit"), i = panes.wvr.cursor, s = project.slots[i], num = i + 1;
    var notes = [[-1, "none"]]; for (var k = 0; k < 128; k++) notes.push([k, k + " · " + WVR.noteName(k)]);
    var pins = [[0, "none"]]; for (var dd = 3; dd <= 13; dd++) pins.push([dd, "D" + dd + (dd >= 7 && dd <= 10 ? " (needs a pull-up resistor)" : dd === 6 ? " (not held low at power-on)" : "")]);
    var groups = [[0, "none"]]; for (var g = 1; g <= 8; g++) groups.push([g, "group " + g]);
    d.innerHTML =
      '<div class="dhead"><span class="dno">' + num + '</span><input type="text" data-set="name" maxlength="40" placeholder="Name" value="' + esc(s.name) + '" aria-label="Slot name"></div>' +
      (s.file ? trimHtml(s) : '<canvas class="lbig"></canvas>') +
      '<p class="help">' + (s.file ? esc(s.src) + " · " + WVR.fmtDur(s.dur) + " · " + (s.ch === 1 ? "mono" : "stereo") : "Empty. Drag a sound here from the library, or add one from this computer.") + "</p>" +
      '<div class="btnrow">' + (s.file ? '<button class="btn primary" id="wPlay">▶ Play</button>' : "") +
        '<button class="btn" data-dact="pick">' + (s.file ? "Replace…" : "Add a sound…") + "</button>" +
        (s.file ? '<button class="btn" data-dact="tolib">← To library</button><button class="btn" data-dact="download">Download</button><button class="btn danger" data-dact="clear">Clear</button>' : "") +
      "</div>" +
      (s.file ?
        "<h3>Sound</h3>" + slider("gain", "Level", -60, 12, 0.5, s.gain, WVR.fmtDb) + slider("pan", "Pan", -1, 1, 0.01, s.pan, fmtPan) + slider("pitch", "Pitch", -24, 24, 0.1, s.pitch, fmtPitch) +
        '<div class="checks"><label><input type="checkbox" data-set="loop"' + (s.loop ? " checked" : "") + "> Loop until stopped</label>" +
        '<label><input type="checkbox" data-set="hold"' + (s.hold ? " checked" : "") + "> Play only while the key or pin is held</label></div>" +
        '<div class="grid2">' +
          '<label>Triggered again<select data-set="retrig">' + options([["overlap", "plays on top"], ["restart", "starts over"], ["toggle", "stops"]], s.retrig) + "</select></label>" +
          '<label>Choke group<select data-set="group" data-num>' + options(groups, s.group) + "</select></label>" +
          '<label>Fade in (ms)<input type="number" data-set="fadeIn" min="0" max="60000" step="10" value="' + s.fadeIn + '"></label>' +
          '<label>Fade out (ms)<input type="number" data-set="fadeOut" min="0" max="60000" step="10" value="' + s.fadeOut + '"></label>' +
        "</div>" : "") +
      "<h3>Triggers</h3>" +
      '<div class="field"><span>OSC, port ' + device.device.oscPort + '</span><div class="osc">/wvr/play ' + num + "</div></div>" +
      '<div class="grid2">' +
        '<label>MIDI note<select data-set="note" data-num>' + options(notes, s.note) + "</select></label>" +
        '<label>Pin to ground<select id="dPin">' + options(pins, s.pin) + "</select></label>" +
      "</div>" +
      '<div class="checks"><label><input type="checkbox" data-set="vel"' + (s.vel ? " checked" : "") + "> MIDI velocity sets the level</label></div>" +
      '<p class="help">The triggers belong to the slot number: a sound moved to another slot gets that slot\'s triggers.</p>';
    drawWave(d.querySelector(".lbig"), s.peaks);
    if (s.file) { var pt = WVR.part(s); placeTrim(pt.a, pt.b); }
    drawStatus();
  }

  // ---------------------------------------------------------------- start and end points

  // The slot's waveform with a handle at each end of the part that plays. Dragging one is
  // shown at once and sent to the WVR when let go; the file itself is never changed.
  function trimHtml(s) {
    var pt = WVR.part(s), whole = pt.len >= s.dur - 0.0005;
    return '<div class="trim" id="trim">' +
        '<canvas class="lbig"></canvas><div class="tshade" id="tshL"></div><div class="tshade" id="tshR"></div>' +
        '<div class="thandle" data-h="start" tabindex="0" role="slider" aria-label="Start point"><i></i></div>' +
        '<div class="thandle" data-h="end" tabindex="0" role="slider" aria-label="End point"><i></i></div>' +
      "</div>" +
      '<div class="trimrow">' +
        '<label>Start <input type="number" data-trim="start" min="0" max="' + s.dur.toFixed(3) + '" step="0.001" value="' + pt.a.toFixed(3) + '"> s</label>' +
        '<label>End <input type="number" data-trim="end" min="0" max="' + s.dur.toFixed(3) + '" step="0.001" value="' + pt.b.toFixed(3) + '"> s</label>' +
        '<span class="help" id="trimLen">' + WVR.fmtDur(pt.len) + (whole ? "" : " of " + WVR.fmtDur(s.dur)) + "</span>" +
        (whole ? "" : '<button class="btn small" data-dact="whole">Whole file</button>') +
      "</div>";
  }
  function placeTrim(a, b) {
    var s = project.slots[panes.wvr.cursor], box = $("trim"); if (!box || !s.dur) return;
    var pa = a / s.dur * 100, pb = b / s.dur * 100;
    $("tshL").style.width = pa + "%";
    $("tshR").style.left = pb + "%"; $("tshR").style.width = (100 - pb) + "%";
    var hs = box.querySelector('[data-h="start"]'), he = box.querySelector('[data-h="end"]');
    hs.style.left = pa + "%"; he.style.left = pb + "%";
    hs.setAttribute("aria-valuenow", a.toFixed(3)); he.setAttribute("aria-valuenow", b.toFixed(3));
    hs.setAttribute("aria-valuetext", a.toFixed(3) + " s"); he.setAttribute("aria-valuetext", b.toFixed(3) + " s");
    var ia = document.querySelector('[data-trim="start"]'), ib = document.querySelector('[data-trim="end"]');
    if (ia && document.activeElement !== ia) ia.value = a.toFixed(3);
    if (ib && document.activeElement !== ib) ib.value = b.toFixed(3);
    var len = $("trimLen"); if (len) len.textContent = WVR.fmtDur(b - a) + (b - a >= s.dur - 0.0005 ? "" : " of " + WVR.fmtDur(s.dur));
  }
  var MIN_PART = 0.01;   // seconds
  // Keeps a and b inside the file and apart; `moving` is the one that gives way.
  function fitTrim(dur, a, b, moving) {
    a = Math.max(0, Math.min(dur, a)); b = Math.max(0, Math.min(dur, b));
    if (b - a < MIN_PART) { if (moving === "start") a = Math.max(0, b - MIN_PART); else b = Math.min(dur, a + MIN_PART); }
    return { a: Math.round(a * 1000) / 1000, b: Math.round(b * 1000) / 1000 };
  }
  function commitTrim(i, a, b) {
    var s = project.slots[i];
    var start = a <= 0.0005 ? 0 : a, end = b >= s.dur - 0.0005 ? 0 : b;
    if (start === (s.start || 0) && end === (s.end || 0)) return placeTrim(WVR.part(s).a, WVR.part(s).b);
    changeWvr(function () { s.start = start; s.end = end; });
  }
  var trimDrag = null;
  function trimDown(e) {
    var box = e.target.closest(".trim"); if (!box || e.button) return;
    var s = project.slots[panes.wvr.cursor], pt = WVR.part(s), r = box.getBoundingClientRect();
    var t = (e.clientX - r.left) / r.width * s.dur, h = e.target.closest(".thandle");
    // a handle, or else whichever handle is nearer to where the waveform was pressed
    var which = h ? h.dataset.h : Math.abs(t - pt.a) <= Math.abs(t - pt.b) ? "start" : "end";
    trimDrag = { i: panes.wvr.cursor, which: which, a: pt.a, b: pt.b, box: box, dur: s.dur };
    box.setPointerCapture(e.pointerId);
    box.classList.add("dragging");
    e.preventDefault();
    trimMove(e);
  }
  function trimMove(e) {
    if (!trimDrag) return;
    var d = trimDrag, r = d.box.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * d.dur;
    var f = d.which === "start" ? fitTrim(d.dur, t, d.b, "start") : fitTrim(d.dur, d.a, t, "end");
    d.a = f.a; d.b = f.b;
    placeTrim(d.a, d.b);
  }
  function trimUp() {
    if (!trimDrag) return;
    var d = trimDrag; trimDrag = null;
    d.box.classList.remove("dragging");
    commitTrim(d.i, d.a, d.b);
  }
  function trimKey(e) {
    var h = e.target.closest(".thandle"); if (!h) return;
    var dir = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    var i = panes.wvr.cursor, s = project.slots[i], pt = WVR.part(s), by = dir * (e.shiftKey ? 0.1 : 0.01);
    var f = h.dataset.h === "start" ? fitTrim(s.dur, pt.a + by, pt.b, "start") : fitTrim(s.dur, pt.a, pt.b + by, "end");
    commitTrim(i, f.a, f.b);
    var again = document.querySelector('.thandle[data-h="' + h.dataset.h + '"]'); if (again) again.focus();
  }

  function renderActive() {
    $("paneLib").classList.toggle("active", active === "lib");
    $("paneWvr").classList.toggle("active", active === "wvr");
  }
  function tools() {
    var L = panes.lib.sel.length, W = panes.wvr.sel.filter(function (i) { return project && project.slots[i] && project.slots[i].file; }).length;
    var lb = function (a) { return $("paneLib").querySelector('[data-act="' + a + '"]'); }, wb = function (a) { return $("paneWvr").querySelector('[data-act="' + a + '"]'); };
    ["play", "copy", "cut", "dup", "rename", "move", "delete", "send"].forEach(function (a) { lb(a).disabled = !L; });
    lb("rename").disabled = L !== 1;
    lb("paste").disabled = !clip;
    lb("undo").disabled = !lib.undo.length; lb("redo").disabled = !lib.redo.length;
    ["play", "copy", "cut", "delete", "send"].forEach(function (a) { wb(a).disabled = !W; });
    wb("rename").disabled = !(project && project.slots[panes.wvr.cursor] && project.slots[panes.wvr.cursor].file);
    wb("paste").disabled = !clip;
    wb("undo").disabled = !wvrUndo.length; wb("redo").disabled = !wvrRedo.length;
  }
  function renderAll() { renderLib(); renderWvr(); renderDetail(); renderActive(); }

  // ================================================================ selection

  function order(pane) {
    if (pane === "lib") return visibleLib().map(function (it) { return it.id; });
    return project.slots.map(function (_, i) { return i; });
  }
  function selectIds(pane, ids) {
    var p = panes[pane];
    p.sel = ids.slice(); p.cursor = ids.length ? ids[ids.length - 1] : null; p.anchor = ids.length ? ids[0] : null;
  }
  function setActive(pane) {
    if (active === pane) return;
    active = pane; renderActive(); renderDetail();
  }
  function clickRow(pane, id, e) {
    var p = panes[pane], ord = order(pane);
    if (e.shiftKey && p.anchor !== null && ord.indexOf(p.anchor) >= 0) {
      var a = ord.indexOf(p.anchor), b = ord.indexOf(id);
      p.sel = ord.slice(Math.min(a, b), Math.max(a, b) + 1); p.cursor = id;
    } else if (e.metaKey || e.ctrlKey) {
      var k = p.sel.indexOf(id);
      if (k >= 0) p.sel.splice(k, 1); else p.sel.push(id);
      p.cursor = id; p.anchor = id;
    } else { p.sel = [id]; p.cursor = id; p.anchor = id; }
    active = pane;
    redrawSelection(pane); renderActive(); renderDetail();
  }
  function redrawSelection(pane) {
    var p = panes[pane], list = pane === "lib" ? $("libList") : $("wvrList");
    Array.prototype.forEach.call(list.querySelectorAll(".lrow"), function (li) {
      var id = pane === "lib" ? Number(li.dataset.id) : Number(li.dataset.i);
      li.classList.toggle("on", p.sel.indexOf(id) >= 0);
      li.classList.toggle("cursor", id === p.cursor);
      if (id === p.cursor && li.scrollIntoView) li.scrollIntoView({ block: "nearest" });
    });
    tools();
  }
  function step(pane, dir, extend) {
    var p = panes[pane], ord = order(pane);
    if (!ord.length) return;
    var at = ord.indexOf(p.cursor), next = ord[Math.max(0, Math.min(ord.length - 1, at < 0 ? 0 : at + dir))];
    if (extend) {
      var a = ord.indexOf(p.anchor === null ? next : p.anchor), b = ord.indexOf(next);
      p.sel = ord.slice(Math.min(a, b), Math.max(a, b) + 1); p.cursor = next;
    } else { p.sel = [next]; p.cursor = next; p.anchor = next; }
    redrawSelection(pane); renderDetail();
  }

  // ================================================================ asking

  // A bar at the bottom of the page. With a value it asks for text; resolves to the text, true, or null.
  function ask(text, value, okLabel, list) {
    var bar = $("ask");
    return new Promise(function (resolve) {
      bar.innerHTML = "<span>" + esc(text) + "</span>" + (value !== null && value !== undefined ? '<input type="text" id="askIn"' + (list ? ' list="' + list + '"' : "") + ">" : "") +
        '<button class="btn primary" id="askOk">' + esc(okLabel || "OK") + '</button><button class="btn" id="askNo">Cancel</button>';
      bar.hidden = false;
      var input = $("askIn");
      if (input) { input.value = value; input.focus(); input.select(); } else $("askOk").focus();
      function done(v) { bar.hidden = true; bar.innerHTML = ""; document.removeEventListener("keydown", key, true); resolve(v); }
      function key(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(input ? input.value : true); }
      }
      document.addEventListener("keydown", key, true);
      $("askOk").onclick = function () { done(input ? input.value : true); };
      $("askNo").onclick = function () { done(null); };
    });
  }

  // ================================================================ actions

  function libAct(a) {
    var p = panes.lib, sel = p.sel.map(byId).filter(Boolean), cur = byId(p.cursor);
    switch (a) {
      case "open": return openFolder();
      case "save": return saveLibrary();
      case "undo": return restoreLib(lib.undo, lib.redo);
      case "redo": return restoreLib(lib.redo, lib.undo);
      case "add": $("pickFiles").dataset.to = "lib"; return $("pickFiles").click();
      case "examples":
        return WVRDemo.examples().then(function (ex) {
          var items = ex.map(function (e) { return Lib.item(e.cat, e.name + ".wav", { file: e.blob }); });
          setLibrary("", null, items);
          lib.dirty = true; renderLibHead();
          libStatus("Example sounds made in this browser. Drag them to the WVR, or rename and sort them to try the library.", "ok");
        });
      case "play": if (cur) previewPlay(cur); return;
      case "copy": if (sel.length) { clip = { from: "lib", items: sel.map(function (it) { return Object.assign({}, it); }) }; libStatus(plural(sel.length, "sound") + " copied."); tools(); } return;
      case "cut":
        if (!sel.length) return;
        clip = { from: "lib", items: sel.map(function (it) { return Object.assign({}, it); }) };
        return libDelete(sel, plural(sel.length, "sound") + " cut. Paste them where they should go.");
      case "delete": return libDelete(sel);
      case "dup":
        if (!sel.length) return;
        var dups = [];
        changeLib(function () {
          Lib.sorted(sel).forEach(function (it) {
            var d = Lib.item(it.cat, it.base + it.ext, { file: it.file, handle: it.handle });
            d.base = Lib.uniqueBase(lib.items.concat(dups), d, it.base);
            if (info[it.id]) info[d.id] = info[it.id];
            dups.push(d);
          });
          lib.items = lib.items.concat(dups);
          selectIds("lib", dups.map(function (d) { return d.id; }));
        });
        return;
      case "paste":
        if (!clip) return;
        if (clip.from === "wvr") return wvrToLibrary(clip.slots, targetCat());
        var cat = cur ? cur.cat : null, add = [];
        changeLib(function () {
          clip.items.forEach(function (it) {
            var c = Lib.item(cat === null ? it.cat : cat, it.base + it.ext, { file: it.file, handle: it.handle });
            c.base = Lib.uniqueBase(lib.items.concat(add), c, it.base);
            if (info[it.id]) info[c.id] = info[it.id];
            add.push(c);
          });
          lib.items = lib.items.concat(add);
          selectIds("lib", add.map(function (c) { return c.id; }));
        });
        return;
      case "rename":
        if (!cur) return;
        return ask("New name for “" + cur.base + "”:", cur.base, "Rename").then(function (v) { if (v !== null) renameItem(cur, v); });
      case "move":
        if (!sel.length) return;
        return ask("Move " + plural(sel.length, "sound") + " to the category:", sel[0].cat, "Move", "catList").then(function (v) { if (v !== null) moveItems(sel, v); });
      case "send": return sendLibToWvr(p.sel, panes.wvr.cursor || 0, true);
    }
  }
  function libDelete(sel, msg) {
    if (!sel.length) return;
    var ord = order("lib"), after = ord[ord.indexOf(sel[sel.length - 1].id) + 1];
    changeLib(function () {
      lib.items = lib.items.filter(function (it) { return sel.indexOf(it) < 0; });
      lib.removed = lib.removed.concat(sel.filter(function (it) { return it.src; }));
      var next = byId(after) ? after : null;
      selectIds("lib", next ? [next] : []);
    });
    if (preview && sel.some(function (it) { return it.id === preview.id; })) previewStop();
    libStatus(msg || plural(sel.length, "sound") + " deleted. They leave the folder when you save; ⌘Z brings them back.");
  }
  function renameItem(it, v) {
    var base = Lib.cleanBase(v);
    if (base === it.base) return;
    changeLib(function () { it.base = Lib.uniqueBase(lib.items, it, base); });
  }
  function moveItems(sel, v) {
    var cat = Lib.cleanCat(v);
    changeLib(function () {
      Lib.sorted(sel).forEach(function (it) { if (it.cat === cat) return; it.cat = cat; it.base = Lib.uniqueBase(lib.items, it, it.base); });
    });
    libStatus(plural(sel.length, "sound") + " moved to " + (cat || "the library folder itself") + ".");
  }

  function wvrAct(a) {
    var p = panes.wvr, sel = p.sel.slice().sort(function (x, y) { return x - y; }), filled = sel.filter(function (i) { return project.slots[i].file; });
    switch (a) {
      case "undo": return restoreWvr(wvrUndo, wvrRedo);
      case "redo": return restoreWvr(wvrRedo, wvrUndo);
      case "add": $("pickFiles").dataset.to = "wvr"; return $("pickFiles").click();
      case "play":
        var on = status.playing.indexOf(p.cursor + 1) >= 0;
        return api("POST", (on ? "/api/stop" : "/api/play") + "?slot=" + (p.cursor + 1)).catch(function () {});
      case "copy": if (filled.length) { clip = { from: "wvr", slots: filled, sounds: filled.map(function (i) { return WVR.sound(project.slots[i]); }) }; wvrStatus(plural(filled.length, "sound") + " copied."); tools(); } return;
      case "cut":
        if (!filled.length) return;
        clip = { from: "wvr", slots: filled, sounds: filled.map(function (i) { return WVR.sound(project.slots[i]); }) };
        changeWvr(function () { filled.forEach(function (i) { WVR.clear(project, i); }); });
        wvrStatus(plural(filled.length, "sound") + " cut. Paste them into another slot.");
        return;
      case "delete":
        if (!filled.length) return;
        changeWvr(function () { filled.forEach(function (i) { WVR.clear(project, i); }); });
        wvrStatus(plural(filled.length, "slot") + " cleared. ⌘Z brings them back.");
        return;
      case "paste":
        if (!clip) return;
        if (clip.from === "lib") {
          var ids = clip.items.map(function (it) { return it.id; }).filter(byId);
          var sounds = clip.items.map(function (it) { return { name: it.base, src: it.base + it.ext, read: function () { return itemFile(it).then(function (f) { return f.arrayBuffer(); }); } }; });
          var slots = slotsFrom(p.cursor, sounds.length);
          selectIds("wvr", slots); return sendToSlots(sounds, slots);
        }
        var to = slotsFrom(p.cursor, clip.sounds.length);
        changeWvr(function () { to.forEach(function (i, k) { WVR.setSound(project.slots[i], clip.sounds[k]); }); selectIds("wvr", to); });
        return;
      case "up": case "down":
        var moved;
        changeWvr(function () { moved = WVR.moveSlots(project, sel, a === "up" ? -1 : 1); if (moved) selectIds("wvr", moved); });
        if (!moved) wvrUndo.pop();
        return;
      case "rename":
        var s = project.slots[p.cursor];
        if (!s.file) return;
        return ask("Name for slot " + (p.cursor + 1) + ":", s.name, "Rename").then(function (v) { if (v !== null) changeWvr(function () { s.name = v.trim().slice(0, 40); }); });
      case "send": return wvrToLibrary(filled, targetCat());
    }
  }

  // ================================================================ events

  // the two panes' buttons
  ["paneLib", "paneWvr"].forEach(function (id) {
    var pane = id === "paneLib" ? "lib" : "wvr";
    $(id).addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (!b || b.disabled) return;
      if (pane !== active && b.dataset.act !== "open" && b.dataset.act !== "save") setActive(pane);
      (pane === "lib" ? libAct : wvrAct)(b.dataset.act);
    });
    $(id).addEventListener("mousedown", function (e) { if (!e.target.closest("input, select")) setActive(pane); });
  });

  // rows
  $("libList").addEventListener("click", function (e) {
    var cat = e.target.closest(".lstyle-name");
    if (cat) {
      var c = cat.parentNode.dataset.cat, ids = visibleLib().filter(function (it) { return it.cat === c; }).map(function (it) { return it.id; });
      selectIds("lib", ids); active = "lib"; redrawSelection("lib"); renderActive(); renderDetail(); return;
    }
    var li = e.target.closest(".lrow"); if (li) clickRow("lib", Number(li.dataset.id), e);
  });
  $("libList").addEventListener("dblclick", function (e) { var li = e.target.closest(".lrow"); if (li) libAct("rename"); });
  $("wvrList").addEventListener("click", function (e) {
    var li = e.target.closest(".lrow"); if (!li) return;
    var i = Number(li.dataset.i);
    if (e.target.closest(".go")) {
      var on = status.playing.indexOf(i + 1) >= 0;
      api("POST", (on ? "/api/stop" : "/api/play") + "?slot=" + (i + 1)).catch(function () {});
      if (panes.wvr.cursor === i) return;
    }
    clickRow("wvr", i, e);
  });
  $("wvrList").addEventListener("dblclick", function (e) {
    var li = e.target.closest(".lrow"); if (!li) return;
    if (project.slots[li.dataset.i].file) wvrAct("rename"); else wvrAct("add");
  });

  // dragging: rows within and between the panes, and files from the computer
  var drag = null;
  function dragStart(pane, e) {
    var li = e.target.closest(".lrow"); if (!li) return;
    var id = pane === "lib" ? Number(li.dataset.id) : Number(li.dataset.i), p = panes[pane];
    if (p.sel.indexOf(id) < 0) { selectIds(pane, [id]); redrawSelection(pane); }
    active = pane; renderActive(); renderDetail();
    drag = { from: pane, ids: p.sel.slice() };
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", pane + ":" + drag.ids.join(","));
  }
  $("libList").addEventListener("dragstart", function (e) { dragStart("lib", e); });
  $("wvrList").addEventListener("dragstart", function (e) { dragStart("wvr", e); });
  document.addEventListener("dragend", function () { drag = null; clearOver(); });
  function clearOver() { Array.prototype.forEach.call(document.querySelectorAll(".over, .over-list"), function (el) { el.classList.remove("over", "over-list"); }); }
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0; }

  $("wvrList").addEventListener("dragover", function (e) {
    var li = e.target.closest(".lrow");
    if (!li || (!drag && !hasFiles(e))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = drag && drag.from === "wvr" && !e.altKey ? "move" : "copy";
    clearOver(); li.classList.add("over");
  });
  $("wvrList").addEventListener("drop", function (e) {
    var li = e.target.closest(".lrow"); if (!li) return;
    e.preventDefault(); clearOver();
    var to = Number(li.dataset.i), d = drag; drag = null;
    setActive("wvr");
    if (!d && e.dataTransfer.files.length) { var sounds = fileSounds(e.dataTransfer.files), slots = slotsFrom(to, sounds.length); selectIds("wvr", slots); sendToSlots(sounds, slots); return; }
    if (!d) return;
    if (d.from === "lib") return sendLibToWvr(d.ids, to, false);
    var from = d.ids.slice().sort(function (a, b) { return a - b; }).filter(function (i) { return project.slots[i].file; });
    if (!from.length || (from.length === 1 && from[0] === to)) return;
    var alt = e.altKey, dest = slotsFrom(to, from.length);
    changeWvr(function () {
      if (alt) { var snap = from.map(function (i) { return WVR.sound(project.slots[i]); }); dest.forEach(function (i, k) { WVR.setSound(project.slots[i], snap[k]); }); }
      else dest.forEach(function (i, k) { if (from[k] !== i) WVR.swap(project, from[k], i); });
      selectIds("wvr", dest);
    });
  });

  $("libList").addEventListener("dragover", function (e) {
    if (!drag && !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = drag && drag.from === "lib" && !e.altKey ? "move" : "copy";
    clearOver();
    var li = e.target.closest(".lrow, .lstyle");
    if (li) li.classList.add("over"); else $("libList").classList.add("over-list");
  });
  $("libList").addEventListener("drop", function (e) {
    e.preventDefault(); clearOver();
    var li = e.target.closest(".lrow, .lstyle"), d = drag; drag = null;
    var cat = li ? (li.classList.contains("lstyle") ? li.dataset.cat : byId(Number(li.dataset.id)).cat) : null;
    setActive("lib");
    if (!d && e.dataTransfer.files.length) return addToLibrary(e.dataTransfer.files, cat === null ? "" : cat);
    if (!d) return;
    if (d.from === "wvr") return wvrToLibrary(d.ids, cat === null ? "From WVR" : cat);
    if (cat === null) return;
    var sel = d.ids.map(byId).filter(Boolean);
    if (e.altKey) { clip = { from: "lib", items: sel.map(function (it) { return Object.assign({}, it); }) }; var cur = sel[0]; panes.lib.cursor = cur.id; var keep = cur.cat; cur.cat = cat; libAct("paste"); cur.cat = keep; return; }
    if (sel.every(function (it) { return it.cat === cat; })) return;
    moveItems(sel, cat);
  });
  // a sound dropped beside the lists must not replace the page
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });

  $("pickFiles").addEventListener("change", function () {
    var files = this.files, to = this.dataset.to;
    if (files.length) {
      if (to === "lib") addToLibrary(files, targetCat() === "From WVR" ? "" : targetCat());
      else { var sounds = fileSounds(files), slots = slotsFrom(panes.wvr.cursor, sounds.length); selectIds("wvr", slots); sendToSlots(sounds, slots); }
    }
    this.value = "";
  });

  $("libFind").addEventListener("input", function () { renderLib(); });

  // the library's selected sound
  var libDetail = $("libDetail");
  libDetail.addEventListener("click", function (e) {
    if (e.target.id === "lPlay") return libAct("play");
    var b = e.target.closest("[data-dact]"); if (b && b.dataset.dact === "send") libAct("send");
  });
  libDetail.addEventListener("change", function (e) {
    var t = e.target, it = byId(panes.lib.cursor); if (!it) return;
    if (t.id === "libRename") renameItem(it, t.value);
    else if (t.id === "libCat") moveItems([it], t.value);
  });

  // the WVR's selected slot
  var slotEdit = $("slotEdit");
  slotEdit.addEventListener("click", function (e) {
    if (e.target.id === "wPlay") return wvrAct("play");
    var b = e.target.closest("[data-dact]"); if (!b) return;
    var a = b.dataset.dact, s = project.slots[panes.wvr.cursor];
    if (a === "pick") wvrAct("add");
    else if (a === "clear") changeWvr(function () { WVR.clear(project, panes.wvr.cursor); });
    else if (a === "whole") changeWvr(function () { s.start = 0; s.end = 0; });
    else if (a === "tolib") wvrToLibrary([panes.wvr.cursor], targetCat());
    else if (a === "download") getDeviceFile(s.file).then(function (bytes) {
      var link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })); link.download = Lib.cleanBase(s.name || "Sound") + ".wav";
      document.body.appendChild(link); link.click(); link.remove();
    }, function (err) { wvrStatus(err.message, "err"); });
  });
  slotEdit.addEventListener("pointerdown", trimDown);
  slotEdit.addEventListener("pointermove", trimMove);
  slotEdit.addEventListener("pointerup", trimUp);
  slotEdit.addEventListener("pointercancel", trimUp);
  slotEdit.addEventListener("keydown", trimKey);
  slotEdit.addEventListener("input", function (e) {
    var key = e.target.dataset.live; if (!key) return;
    $("o_" + key).textContent = FMT[key](e.target.value);
    sendLive(key, panes.wvr.cursor + 1, e.target.value);
  });
  slotEdit.addEventListener("change", function (e) {
    var t = e.target, i = panes.wvr.cursor;
    if (t.id === "dPin") { changeWvr(function () { WVR.setPin(project, i, Number(t.value)); }); return; }
    if (t.dataset.trim) {
      var s = project.slots[i], pt = WVR.part(s), v0 = Number(t.value);
      if (!isFinite(v0)) return placeTrim(pt.a, pt.b);
      var f = t.dataset.trim === "start" ? fitTrim(s.dur, v0, pt.b, "start") : fitTrim(s.dur, pt.a, v0, "end");
      return commitTrim(i, f.a, f.b);
    }
    var key = t.dataset.live || t.dataset.set; if (!key) return;
    var v = t.type === "checkbox" ? t.checked : t.type === "range" || t.type === "number" || "num" in t.dataset ? Number(t.value) : t.value;
    if (t.type === "number") v = Math.max(Number(t.min), Math.min(Number(t.max), Math.round(v) || 0));
    if (key === "name") v = String(v).trim().slice(0, 40);
    changeWvr(function () { project.slots[i][key] = v; });
  });

  $("projName").addEventListener("change", function () { var v = this.value.trim() || "New project"; changeWvr(function () { project.name = v; }); });
  $("master").addEventListener("input", function () { $("masterOut").textContent = WVR.fmtDb(this.value); sendLive("master", 0, this.value); });
  $("master").addEventListener("change", function () { var v = Number(this.value); changeWvr(function () { project.master = v; }); });
  $("stopAll").addEventListener("click", function () { api("POST", "/api/stop").catch(function () {}); previewStop(); });

  document.addEventListener("keydown", function (e) {
    if (!$("ask").hidden || $("settings").open || !project) return;
    var t = e.target, typing = /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.type !== "range" && t.type !== "checkbox";
    if (e.key === "Escape") { api("POST", "/api/stop").catch(function () {}); previewStop(); return; }
    if (typing) return;
    var mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase(), act = active === "lib" ? libAct : wvrAct;
    if (mod && k === "z") act(e.shiftKey ? "redo" : "undo");
    else if (mod && k === "y") act("redo");
    else if (mod && k === "c") act("copy");
    else if (mod && k === "x") act("cut");
    else if (mod && k === "v") act("paste");
    else if (mod && k === "d" && active === "lib") act("dup");
    else if (mod && k === "a") { selectIds(active, order(active)); redrawSelection(active); renderDetail(); }
    else if (k === "delete" || k === "backspace") act("delete");
    else if (k === "enter") act("rename");
    else if (k === " ") act("play");
    else if (e.altKey && active === "wvr" && (k === "arrowup" || k === "arrowdown")) act(k === "arrowup" ? "up" : "down");
    else if (k === "arrowdown" || k === "arrowup") step(active, k === "arrowdown" ? 1 : -1, e.shiftKey);
    else if (k === "arrowleft") setActive("lib");
    else if (k === "arrowright") setActive("wvr");
    else return;
    e.preventDefault();
  });

  window.addEventListener("beforeunload", function (e) { if (lib.dirty && lib.items.length) { e.preventDefault(); e.returnValue = ""; } });

  // import options are remembered on this computer
  ["optTrim", "optNorm"].forEach(function (id) {
    try { $(id).checked = localStorage.getItem(id) === "1"; } catch (e) {}
    $(id).addEventListener("change", function () { try { localStorage.setItem(id, this.checked ? "1" : "0"); } catch (e) {} });
  });

  // ================================================================ device dialog

  $("openSettings").addEventListener("click", function () {
    var d = device.device;
    $("dName").value = d.name; $("dPass").value = d.apPass; $("dSsid").value = d.staSsid; $("dSpass").value = d.staPass; $("dOsc").value = d.oscPort;
    var ch = [[0, "all"]]; for (var i = 1; i <= 16; i++) ch.push([i, String(i)]);
    $("dMidi").innerHTML = options(ch, d.midiChannel);
    $("devInfo").textContent = "Firmware " + device.fw + " · own network at " + device.ip.ap + (device.ip.sta ? " · joined " + device.device.staSsid + " at " + device.ip.sta :
      device.device.staSsid ? " · can't join " + device.device.staSsid + (device.ip.staError ? ": " + device.ip.staError : " yet") : "") +
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

  // ================================================================ start

  $("demoNote").hidden = !DEMO;
  renderLib(); renderActive();
  load().catch(function (e) {
    $("banner").hidden = false;
    $("banner").textContent = "Couldn't reach the WVR (" + e.message + "). Check that this computer is on its WiFi network.";
  }).then(poll);
})();
