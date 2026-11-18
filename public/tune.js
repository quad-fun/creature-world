// Plays a creature's tune with WebAudio. First-party, static, it makes no requests and writes no HTML.
// It reads only data-* attributes our server rendered from whitelisted values and re-checks them against its own
// whitelists below, so nothing a creature wrote can ever reach this code.
(function () {
  "use strict";
  var FREQ = { C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77 };
  var TEMPOS = [80, 110, 140];
  var INSTR = ["sine", "square", "triangle"];
  var ctx = null;
  var stopper = null;
  function stop() {
    if (stopper) stopper();
    stopper = null;
  }
  function play(btn) {
    var steps = String(btn.getAttribute("data-steps") || "").split(",").slice(0, 16);
    var tempo = Number(btn.getAttribute("data-tempo"));
    var inst = String(btn.getAttribute("data-inst") || "");
    if (TEMPOS.indexOf(tempo) < 0 || INSTR.indexOf(inst) < 0 || steps.length < 1) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    stop();
    ctx = ctx || new AC();
    var beat = 60 / tempo / 2; // each step is an eighth note
    var t0 = ctx.currentTime + 0.05;
    var master = ctx.createGain();
    master.gain.value = 0.12;
    master.connect(ctx.destination);
    var nodes = [];
    steps.forEach(function (s, i) {
      if (!Object.prototype.hasOwnProperty.call(FREQ, s)) return; // rest or anything unknown is silence
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = inst;
      o.frequency.value = FREQ[s];
      var a = t0 + i * beat;
      g.gain.setValueAtTime(0.0001, a);
      g.gain.exponentialRampToValueAtTime(1, a + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, a + beat * 0.95);
      o.connect(g);
      g.connect(master);
      o.start(a);
      o.stop(a + beat);
      nodes.push(o);
    });
    btn.textContent = "Stop";
    var timer = setTimeout(function () {
      btn.textContent = "Play";
      btn.removeAttribute("data-playing");
      stopper = null;
    }, steps.length * beat * 1000 + 200);
    stopper = function () {
      clearTimeout(timer);
      nodes.forEach(function (o) {
        try { o.stop(); } catch (e) { /* already stopped */ }
      });
      master.disconnect();
      btn.textContent = "Play";
    };
    btn.setAttribute("data-playing", "1");
  }
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute || t.getAttribute("data-tune") !== "1") return;
    if (t.getAttribute("data-playing") === "1" && stopper) {
      stop();
      t.removeAttribute("data-playing");
      return;
    }
    play(t);
  });
})();
