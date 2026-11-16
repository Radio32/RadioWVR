/*
 * The demo's synth: the WVR's synth mode approximated with Web Audio, so it can be tried in a
 * browser. Same parameters and voice rules (6 voices, mono and legato, glide); the filters,
 * chorus and echo are Web Audio's own, so it sounds close to the WVR but not the same.
 * Not included in the firmware.
 */
"use strict";

var DemoSynth = (function () {
  var ctx = null, out = null, dry = null, chorusIn = null, echoIn = null, analysers = null;
  var chorus = null, echo = null, lfo = null, lfoGain = {};
  var P = null, voices = [], ages = 0, stack = [], bend = 0, modwheel = 0, sustain = false, lastNote = 60;
  var buffers = [null, null], noiseBuf = null;

  function now() { return ctx.currentTime; }
  function hz(note) { return 440 * Math.pow(2, (note - 69) / 12); }
  function dbGain(db) { return Math.pow(10, db / 20); }
  function tc(ms) { return Math.max(0.001, ms / 1000 / 4); }      // time constant reaching -35 dB in the set time

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    out = ctx.createGain();
    var split = ctx.createChannelSplitter(2);
    analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
    analysers.forEach(function (a) { a.fftSize = 512; });
    out.connect(ctx.destination); out.connect(split);
    split.connect(analysers[0], 0); split.connect(analysers[1], 1);
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6; comp.ratio.value = 6; comp.connect(out);
    // voices -> mix -> chorus (dry + two modulated delays) -> echo -> compressor
    dry = ctx.createGain();
    chorusIn = dry;
    chorus = { wet: ctx.createGain(), dL: ctx.createDelay(0.02), dR: ctx.createDelay(0.02), lfo: ctx.createOscillator(), depL: ctx.createGain(), depR: ctx.createGain(), mL: ctx.createStereoPanner(), mR: ctx.createStereoPanner() };
    chorus.lfo.type = "triangle"; chorus.lfo.start();
    chorus.lfo.connect(chorus.depL); chorus.lfo.connect(chorus.depR);
    chorus.depL.connect(chorus.dL.delayTime); chorus.depR.connect(chorus.dR.delayTime);
    chorus.mL.pan.value = -1; chorus.mR.pan.value = 1;
    dry.connect(chorus.dL); dry.connect(chorus.dR);
    chorus.dL.connect(chorus.mL); chorus.dR.connect(chorus.mR);
    chorus.mL.connect(chorus.wet); chorus.mR.connect(chorus.wet);
    echoIn = ctx.createGain();
    dry.connect(echoIn); chorus.wet.connect(echoIn);
    echoIn.connect(comp);
    echo = { send: ctx.createGain(), dL: ctx.createDelay(1), dR: ctx.createDelay(1), fb: ctx.createGain(), fbX: ctx.createGain(), lpL: ctx.createBiquadFilter(), lpR: ctx.createBiquadFilter(), mix: ctx.createGain(), pL: ctx.createStereoPanner(), pR: ctx.createStereoPanner(), fbL: ctx.createGain(), fbR: ctx.createGain(), xL: ctx.createGain(), xR: ctx.createGain() };
    echoIn.connect(echo.send);
    echo.send.connect(echo.dL);
    echo.dL.connect(echo.lpL); echo.dR.connect(echo.lpR);
    echo.lpL.connect(echo.fbL); echo.lpR.connect(echo.fbR); echo.fbL.connect(echo.dL); echo.fbR.connect(echo.dR);   // straight
    echo.lpL.connect(echo.xL); echo.lpR.connect(echo.xR); echo.xL.connect(echo.dR); echo.xR.connect(echo.dL);       // ping-pong
    echo.pL.pan.value = -1; echo.pR.pan.value = 1;
    echo.lpL.connect(echo.pL); echo.lpR.connect(echo.pR); echo.pL.connect(echo.mix); echo.pR.connect(echo.mix);
    echo.mix.connect(comp);
    lfo = ctx.createOscillator(); lfo.start();
    noiseBuf = ctx.createBuffer(1, 44100, 44100);
    var d = noiseBuf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // effects and shared settings follow the parameters at once
  function effects() {
    if (!ctx || !P) return;
    var t = now(), mode = Math.round(P.ch);
    var rate = [0.513, 0.513, 0.863, 9.75][mode], lo = mode === 3 ? 0.0033 : 0.00166, hi = mode === 3 ? 0.0037 : 0.00535;
    chorus.lfo.frequency.setTargetAtTime(rate, t, 0.02);
    chorus.dL.delayTime.setTargetAtTime((lo + hi) / 2, t, 0.02); chorus.dR.delayTime.setTargetAtTime((lo + hi) / 2, t, 0.02);
    chorus.depL.gain.setTargetAtTime((hi - lo) / 2, t, 0.02); chorus.depR.gain.setTargetAtTime((mode === 3 ? 1 : -1) * (hi - lo) / 2, t, 0.02);
    chorus.wet.gain.setTargetAtTime(mode ? 0.7 : 0, t, 0.02);
    dry.gain.setTargetAtTime(mode ? 0.7 : 1, t, 0.02);
    var pp = P.epp >= 0.5, fb = P.efb;
    echo.dL.delayTime.setTargetAtTime(P.et / 1000, t, 0.05); echo.dR.delayTime.setTargetAtTime(P.et / 1000, t, 0.05);
    echo.fbL.gain.setTargetAtTime(pp ? 0 : fb, t, 0.02); echo.fbR.gain.setTargetAtTime(pp ? 0 : fb, t, 0.02);
    echo.xL.gain.setTargetAtTime(pp ? fb : 0, t, 0.02); echo.xR.gain.setTargetAtTime(pp ? fb : 0, t, 0.02);
    var cut = 800 * Math.pow(12, P.eto);
    echo.lpL.frequency.setTargetAtTime(cut, t, 0.02); echo.lpR.frequency.setTargetAtTime(cut, t, 0.02);
    echo.mix.gain.setTargetAtTime(P.emx, t, 0.02);
    lfo.type = ["triangle", "sine", "square", "square"][Math.round(P.lw)];
    lfo.frequency.setTargetAtTime(P.lr, t, 0.02);
    out.gain.setTargetAtTime(dbGain(P.vol) * 0.9, t, 0.02);
    voices.forEach(function (v) { filterTo(v, t, false); v.o.forEach(function (o, k) { tune(o, v, k); }); });
  }

  function source(k, note, dest) {
    var w = Math.round(P[k ? "o2w" : "o1w"]), level = P[k ? "o2l" : "o1l"], g = ctx.createGain(), node;
    g.gain.value = level * 0.5;
    if (w === 5) {
      if (!buffers[k]) return null;
      node = ctx.createBufferSource(); node.buffer = buffers[k]; node.loop = P[k ? "o2lp" : "o1lp"] >= 0.5;
    } else if (w === 4) {
      node = ctx.createBufferSource(); node.buffer = noiseBuf; node.loop = true;
    } else {
      node = ctx.createOscillator();
      node.type = ["sawtooth", "square", "triangle", "sine"][w];
    }
    node.connect(g); g.connect(dest);
    return { node: node, gain: g, wave: w };
  }
  function tune(o, v, k) {
    if (!o) return;
    var cents = (P[k ? "o2o" : "o1o"] * 12 + P[k ? "o2s" : "o1s"]) * 100 + P[k ? "o2f" : "o1f"] + bend * P.pb * 100;
    var t = now(), glide = P.gl > 0 ? P.gl / 1000 / 3 : 0.002;
    if (o.wave === 5) o.node.playbackRate.setTargetAtTime(Math.pow(2, (v.note - 60 + cents / 100) / 12) * o.node.buffer.sampleRate / ctx.sampleRate, t, glide);
    else if (o.wave !== 4) { o.node.frequency.setTargetAtTime(hz(v.note), t, glide); o.node.detune.setTargetAtTime(cents, t, 0.005); }
  }
  function cutoff(v, env) {
    var oct = Math.log2(P.fc) + P.fe * 6 * env + P.fk * (v.note - 60) / 12 + P.fv * 2 * (v.vel - 0.5);
    return Math.max(20, Math.min(18000, Math.pow(2, oct)));
  }
  function filterTo(v, t, start) {
    var q = P.fm >= 0.5 ? 0.7 + P.fq * 24 : 0.5 + P.fq * 14;
    v.f.forEach(function (f) { f.Q.setTargetAtTime(q, t, 0.01); });
    if (start) return;
    var sus = cutoff(v, v.released ? 0 : P.fs);
    v.f.forEach(function (f) { f.frequency.setTargetAtTime(sus, t, 0.03); });
  }

  function startVoice(note, vel) {
    var t = now(), v = { note: note, vel: vel / 127, age: ++ages, released: false };
    v.amp = ctx.createGain(); v.amp.gain.value = 0;
    v.pan = ctx.createStereoPanner();
    var pans = [-1, 1, -0.5, 0.5, -0.25, 0.25]; v.pan.pan.value = pans[voices.length % 6] * P.sp;
    // Fat: two 12 dB low-passes after a soft drive. Gritty: one sharper low-pass after a harder, lopsided one.
    var gritty = P.fm >= 0.5;
    v.drive = ctx.createWaveShaper();
    var curve = new Float32Array(1024), k = 1 + (gritty ? 7 : 3) * P.fd;
    for (var i = 0; i < 1024; i++) { var x = (i / 511.5 - 1) * k; curve[i] = gritty && x < 0 ? 0.6 * Math.tanh(x / 0.6) : Math.tanh(x); }
    v.drive.curve = curve;
    v.f = gritty ? [ctx.createBiquadFilter()] : [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    v.f.forEach(function (f) { f.type = "lowpass"; });
    var mix = ctx.createGain(); mix.gain.value = 0.6;
    mix.connect(v.drive);
    var chain = v.drive; v.f.forEach(function (f) { chain.connect(f); chain = f; });
    chain.connect(v.amp); v.amp.connect(v.pan); v.pan.connect(chorusIn);
    v.o = [source(0, note, mix), source(1, note, mix)];
    if (P.nz > 0) { var nz = { node: ctx.createBufferSource(), gain: ctx.createGain(), wave: 4 }; nz.node.buffer = noiseBuf; nz.node.loop = true; nz.gain.gain.value = P.nz * 0.5; nz.node.connect(nz.gain); nz.gain.connect(mix); v.o.push(nz); }
    // LFO to pitch and cutoff
    var lp = ctx.createGain(); lp.gain.value = (P.lp * 2 + modwheel) * 100; lfo.connect(lp);
    v.o.forEach(function (o) { if (o && o.node.detune) lp.connect(o.node.detune); });
    var lc = ctx.createGain(); lc.gain.value = P.lc * 2400; lfo.connect(lc);
    v.f.forEach(function (f) { lc.connect(f.detune); });
    v.lfoGains = [lp, lc];
    var prev = P.gl > 0 ? lastNote : note;
    v.o.forEach(function (o, k2) {
      if (!o) return;
      if (o.wave !== 4 && o.wave !== 5) o.node.frequency.value = hz(prev);
      tune(o, v, k2); o.node.start(t);
    });
    filterTo(v, t, true);
    envOn(v, t);
    voices.push(v);
    lastNote = note;
    return v;
  }
  function envOn(v, t) {
    var a = v.amp.gain, peak = 0.35 * ((1 - P.av) + P.av * v.vel * v.vel);
    a.cancelScheduledValues(t); a.setValueAtTime(a.value, t);
    a.linearRampToValueAtTime(peak, t + P.aa / 1000);
    a.setTargetAtTime(peak * P.as, t + P.aa / 1000, tc(P.ad));
    var lo = cutoff(v, 0), hi = cutoff(v, 1), sus = cutoff(v, P.fs);
    v.f.forEach(function (f) {
      var p = f.frequency; p.cancelScheduledValues(t); p.setValueAtTime(lo, t);
      p.exponentialRampToValueAtTime(hi, t + P.fa / 1000);
      p.setTargetAtTime(sus, t + P.fa / 1000, tc(P.fdc));
    });
  }
  function release(v) {
    if (v.released) return;
    v.released = true;
    var t = now();
    v.amp.gain.cancelScheduledValues(t); v.amp.gain.setValueAtTime(v.amp.gain.value, t);
    v.amp.gain.setTargetAtTime(0, t, tc(P.ar));
    v.f.forEach(function (f) { f.frequency.cancelScheduledValues(t); f.frequency.setValueAtTime(f.frequency.value, t); f.frequency.setTargetAtTime(cutoff(v, 0), t, tc(P.fr)); });
    var end = t + P.ar / 1000 * 1.5 + 0.05;
    v.o.forEach(function (o) { if (o) try { o.node.stop(end); } catch (e) {} });
    v.o[0] && v.o[0].node.addEventListener("ended", function () { voices = voices.filter(function (x) { return x !== v; }); });
    setTimeout(function () { voices = voices.filter(function (x) { return x !== v; }); }, (end - t) * 1000 + 100);
  }
  function kill(v) { v.o.forEach(function (o) { if (o) try { o.node.stop(); } catch (e) {} }); voices = voices.filter(function (x) { return x !== v; }); }

  function noteOn(note, vel) {
    if (!ctx) build();
    if (ctx.state === "suspended") ctx.resume();
    if (!vel) return noteOff(note);
    if (P.vm >= 1) {                                          // mono and legato: one voice, last note wins
      stack = stack.filter(function (n) { return n !== note; }); stack.push(note);
      var cur = voices.filter(function (v) { return !v.released; })[0];
      if (cur && P.vm >= 2) { cur.note = note; lastNote = note; cur.o.forEach(function (o, k) { tune(o, cur, k); }); return; }
      voices.forEach(release);
      startVoice(note, vel);
      return;
    }
    voices.filter(function (v) { return v.note === note; }).forEach(release);
    var live = voices.filter(function (v) { return !v.released; });
    if (live.length >= 6) kill(live.sort(function (a, b) { return a.age - b.age; })[0]);
    startVoice(note, vel);
  }
  function noteOff(note) {
    if (!ctx) return;
    if (P.vm >= 1) {
      stack = stack.filter(function (n) { return n !== note; });
      var cur = voices.filter(function (v) { return !v.released; })[0];
      if (!cur || cur.note !== note) return;
      if (stack.length) { cur.note = stack[stack.length - 1]; cur.o.forEach(function (o, k) { tune(o, cur, k); }); return; }
    }
    voices.forEach(function (v) { if (v.note === note && !v.released) { if (sustain) v.held = true; else release(v); } });
  }
  function allOff() { stack = []; sustain = false; voices.slice().forEach(release); }
  function setSustain(on) { sustain = on; if (!on) voices.forEach(function (v) { if (v.held) release(v); }); }
  function setBend(b) { bend = b; voices.forEach(function (v) { v.o.forEach(function (o, k) { tune(o, v, k); }); }); }

  function peak(i) {
    if (!analysers) return 0;
    var buf = new Float32Array(512); analysers[i].getFloatTimeDomainData(buf);
    var p = 0; for (var k = 0; k < buf.length; k++) { var a = Math.abs(buf[k]); if (a > p) p = a; } return p;
  }

  return {
    setParams: function (p) { P = p; effects(); },
    setSample: function (k, bytes) {
      buffers[k] = null;
      if (!bytes) return;
      if (!ctx) build();
      ctx.decodeAudioData(bytes.slice(0).buffer).then(function (b) { buffers[k] = b; }).catch(function () {});
    },
    noteOn: noteOn, noteOff: noteOff, allOff: allOff, setSustain: setSustain, setBend: setBend,
    setModwheel: function (m) { modwheel = m; },
    voices: function () { return voices.filter(function (v) { return !v.released; }).length; },
    peaks: function () { return [peak(0), peak(1)]; }
  };
})();
