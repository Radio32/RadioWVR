/*
 * The synth's parameters: the one list both the manager and the firmware use.
 * tools/embed.py turns the JSON between the markers into firmware/RadioWVR/synth_params.h,
 * so keep it strict JSON (double quotes, no comments, no trailing commas).
 *
 *   k    key, in patches, MIDI learn and /api/live      g  group      l  label
 *   min, max, def                                       u  unit shown after the value
 *   c    how a knob or a MIDI CC (0-127) moves through the range:
 *        lin  evenly    log  evenly in ratio (min > 0)    sq  slow at the bottom (min may be 0)
 *        int  whole numbers    list  one of o (the value is the index)
 */
var SYNTH_PARAMS = /*BEGIN*/[
  {"k":"o1w","g":"Oscillator 1","l":"Wave","min":0,"max":5,"def":0,"c":"list","o":["Saw","Pulse","Tri","Sine","Noise","Sample"]},
  {"k":"o1o","g":"Oscillator 1","l":"Octave","min":-3,"max":3,"def":0,"c":"int","u":""},
  {"k":"o1s","g":"Oscillator 1","l":"Semitones","min":-12,"max":12,"def":0,"c":"int","u":"st"},
  {"k":"o1f","g":"Oscillator 1","l":"Fine","min":-50,"max":50,"def":0,"c":"lin","u":"ct"},
  {"k":"o1pw","g":"Oscillator 1","l":"Pulse width","min":0.05,"max":0.95,"def":0.5,"c":"lin","u":"%"},
  {"k":"o1l","g":"Oscillator 1","l":"Level","min":0,"max":1,"def":0.8,"c":"lin","u":"%"},
  {"k":"o1lp","g":"Oscillator 1","l":"Sample","min":0,"max":1,"def":1,"c":"list","o":["Plays once","Loops"]},
  {"k":"o2w","g":"Oscillator 2","l":"Wave","min":0,"max":5,"def":0,"c":"list","o":["Saw","Pulse","Tri","Sine","Noise","Sample"]},
  {"k":"o2o","g":"Oscillator 2","l":"Octave","min":-3,"max":3,"def":0,"c":"int","u":""},
  {"k":"o2s","g":"Oscillator 2","l":"Semitones","min":-12,"max":12,"def":0,"c":"int","u":"st"},
  {"k":"o2f","g":"Oscillator 2","l":"Fine","min":-50,"max":50,"def":7,"c":"lin","u":"ct"},
  {"k":"o2pw","g":"Oscillator 2","l":"Pulse width","min":0.05,"max":0.95,"def":0.5,"c":"lin","u":"%"},
  {"k":"o2l","g":"Oscillator 2","l":"Level","min":0,"max":1,"def":0.8,"c":"lin","u":"%"},
  {"k":"o2lp","g":"Oscillator 2","l":"Sample","min":0,"max":1,"def":1,"c":"list","o":["Plays once","Loops"]},
  {"k":"nz","g":"Oscillator 2","l":"Noise","min":0,"max":1,"def":0,"c":"lin","u":"%"},
  {"k":"fm","g":"Filter","l":"Character","min":0,"max":1,"def":0,"c":"list","o":["Fat","Gritty"]},
  {"k":"fc","g":"Filter","l":"Cutoff","min":20,"max":16000,"def":1800,"c":"log","u":"Hz"},
  {"k":"fq","g":"Filter","l":"Resonance","min":0,"max":1,"def":0.2,"c":"lin","u":"%"},
  {"k":"fd","g":"Filter","l":"Drive","min":0,"max":1,"def":0.2,"c":"lin","u":"%"},
  {"k":"fe","g":"Filter","l":"Envelope","min":-1,"max":1,"def":0.4,"c":"lin","u":"%"},
  {"k":"fk","g":"Filter","l":"Key follow","min":0,"max":1,"def":0.5,"c":"lin","u":"%"},
  {"k":"fv","g":"Filter","l":"Velocity","min":0,"max":1,"def":0.3,"c":"lin","u":"%"},
  {"k":"fa","g":"Filter envelope","l":"Attack","min":1,"max":5000,"def":5,"c":"log","u":"ms"},
  {"k":"fdc","g":"Filter envelope","l":"Decay","min":5,"max":10000,"def":500,"c":"log","u":"ms"},
  {"k":"fs","g":"Filter envelope","l":"Sustain","min":0,"max":1,"def":0.3,"c":"lin","u":"%"},
  {"k":"fr","g":"Filter envelope","l":"Release","min":5,"max":10000,"def":400,"c":"log","u":"ms"},
  {"k":"aa","g":"Amp envelope","l":"Attack","min":1,"max":5000,"def":3,"c":"log","u":"ms"},
  {"k":"ad","g":"Amp envelope","l":"Decay","min":5,"max":10000,"def":400,"c":"log","u":"ms"},
  {"k":"as","g":"Amp envelope","l":"Sustain","min":0,"max":1,"def":0.8,"c":"lin","u":"%"},
  {"k":"ar","g":"Amp envelope","l":"Release","min":5,"max":10000,"def":300,"c":"log","u":"ms"},
  {"k":"av","g":"Amp envelope","l":"Velocity","min":0,"max":1,"def":0.5,"c":"lin","u":"%"},
  {"k":"lr","g":"LFO","l":"Rate","min":0.05,"max":20,"def":5,"c":"log","u":"Hz"},
  {"k":"lw","g":"LFO","l":"Wave","min":0,"max":3,"def":0,"c":"list","o":["Triangle","Sine","Square","Random"]},
  {"k":"lp","g":"LFO","l":"To pitch","min":0,"max":1,"def":0,"c":"sq","u":"%"},
  {"k":"lc","g":"LFO","l":"To cutoff","min":0,"max":1,"def":0,"c":"sq","u":"%"},
  {"k":"lpw","g":"LFO","l":"To pulse width","min":0,"max":1,"def":0,"c":"lin","u":"%"},
  {"k":"vm","g":"Voices","l":"Play","min":0,"max":2,"def":0,"c":"list","o":["Poly (6)","Mono","Legato"]},
  {"k":"gl","g":"Voices","l":"Glide","min":0,"max":2000,"def":0,"c":"sq","u":"ms"},
  {"k":"pb","g":"Voices","l":"Bend range","min":0,"max":12,"def":2,"c":"int","u":"st"},
  {"k":"sp","g":"Voices","l":"Stereo spread","min":0,"max":1,"def":0.3,"c":"lin","u":"%"},
  {"k":"ch","g":"Chorus","l":"Chorus","min":0,"max":3,"def":1,"c":"list","o":["Off","I","II","I + II"]},
  {"k":"emx","g":"Echo","l":"Mix","min":0,"max":1,"def":0,"c":"lin","u":"%"},
  {"k":"et","g":"Echo","l":"Time","min":20,"max":500,"def":330,"c":"log","u":"ms"},
  {"k":"efb","g":"Echo","l":"Feedback","min":0,"max":0.95,"def":0.35,"c":"lin","u":"%"},
  {"k":"eto","g":"Echo","l":"Tone","min":0,"max":1,"def":0.5,"c":"lin","u":"%"},
  {"k":"epp","g":"Echo","l":"Ping-pong","min":0,"max":1,"def":1,"c":"list","o":["Off","On"]},
  {"k":"vol","g":"Output","l":"Level","min":-30,"max":6,"def":-6,"c":"lin","u":"dB"}
]/*END*/;

// A parameter's value from a knob or MIDI CC position x (0..1), and back.
var SynthParam = {
  byKey: (function () { var m = {}; SYNTH_PARAMS.forEach(function (p) { m[p.k] = p; }); return m; })(),
  fromUnit: function (p, x) {
    x = Math.max(0, Math.min(1, x));
    if (p.c === "list") return Math.min(p.max, Math.floor(x * (p.max - p.min + 1)) + p.min);
    if (p.c === "int") return Math.round(p.min + x * (p.max - p.min));
    if (p.c === "log") return p.min * Math.pow(p.max / p.min, x);
    if (p.c === "sq") return p.min + (p.max - p.min) * x * x;
    return p.min + (p.max - p.min) * x;
  },
  toUnit: function (p, v) {
    v = Math.max(p.min, Math.min(p.max, v));
    if (p.c === "list") return (v - p.min + 0.5) / (p.max - p.min + 1);
    if (p.c === "log") return Math.log(v / p.min) / Math.log(p.max / p.min);
    if (p.c === "sq") return Math.sqrt((v - p.min) / (p.max - p.min));
    return (v - p.min) / (p.max - p.min);
  },
  format: function (p, v) {
    if (p.o) return p.o[Math.round(v) - p.min] || "";
    if (p.u === "%") return p.min < 0 ? (v > 0 ? "+" : "") + Math.round(v * 100) + " %" : Math.round(v * 100) + " %";
    if (p.u === "Hz") return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + " kHz" : v >= 10 ? Math.round(v) + " Hz" : v.toFixed(2) + " Hz";
    if (p.u === "ms") return v >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms";
    if (p.u === "dB") return (v > 0 ? "+" : "") + v.toFixed(1) + " dB";
    if (p.u === "ct") return (v > 0 ? "+" : "") + Math.round(v) + " ct";
    if (p.c === "int") return (v > 0 && p.min < 0 ? "+" : "") + Math.round(v) + (p.u ? " " + p.u : "");
    return String(v);
  },
  defaults: function () { var o = {}; SYNTH_PARAMS.forEach(function (p) { o[p.k] = p.def; }); return o; }
};
