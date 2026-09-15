/**
 * The two files the bridge serves to a browser source.
 *
 * Embedded as strings rather than shipped as resources so packaging cannot
 * drop them, and so a dev run and a packaged one serve the same bytes.
 */

/**
 * domino-audio.js - the client library.
 *
 * Usage in any page:
 *
 *   <script src="http://127.0.0.1:4477/domino-audio.js"></script>
 *   <script>
 *     const feed = DominoAudio.connect();         // same host the script came from
 *     feed.on(frame => { ... });                   // every frame, ~30 a second
 *     feed.latest                                  // or read it whenever you draw
 *   </script>
 *
 * Reconnects on its own, so the overlay survives Domino being restarted.
 */
export const BRIDGE_CLIENT_JS = `(function (global) {
  'use strict';

  function originOf() {
    var script = document.currentScript;
    if (script && script.src) {
      try { return new URL(script.src).origin; } catch (e) { /* fall through */ }
    }
    return 'http://127.0.0.1:4477';
  }

  var defaultOrigin = originOf();

  var SILENT = {
    t: 0, bass: 0, mid: 0, treb: 0, bassAtt: 0, midAtt: 0, trebAtt: 0,
    vol: 0, volAtt: 0, rms: 0, peak: 0, beat: false, beatPulse: 0,
    bpm: 0, bpmConfidence: 0, active: false,
    spectrum: new Array(64).fill(0), wave: new Array(64).fill(0)
  };

  function connect(url) {
    var wsUrl = (url || defaultOrigin).replace(/^http/, 'ws').replace(/\\/$/, '') + '/audio';
    var listeners = [];
    var socket = null;
    var closed = false;
    var delay = 500;
    var feed = { latest: SILENT, connected: false, url: wsUrl };

    function open() {
      if (closed) return;
      try { socket = new WebSocket(wsUrl); } catch (e) { return retry(); }
      socket.onopen = function () { feed.connected = true; delay = 500; };
      socket.onmessage = function (ev) {
        var frame;
        try { frame = JSON.parse(ev.data); } catch (e) { return; }
        feed.latest = frame;
        for (var i = 0; i < listeners.length; i++) listeners[i](frame);
      };
      socket.onclose = function () { feed.connected = false; feed.latest = SILENT; retry(); };
      socket.onerror = function () { /* onclose follows */ };
    }

    function retry() {
      if (closed) return;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 5000);
    }

    feed.on = function (cb) {
      listeners.push(cb);
      return function () { listeners = listeners.filter(function (l) { return l !== cb; }); };
    };
    feed.close = function () {
      closed = true;
      if (socket) socket.close();
    };

    open();
    return feed;
  }

  global.DominoAudio = { connect: connect, SILENT: SILENT };
})(window);
`;

/**
 * The page at / - a working overlay, and the example to copy from.
 *
 * Transparent background so it composites over whatever is under it in OBS.
 * Draws a ring of spectrum bars that breathes with the bass and flashes on a
 * beat: enough to see the feed working the moment the source is added.
 */
export const BRIDGE_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Domino audio overlay</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  canvas { display: block; width: 100vw; height: 100vh; }
  #hint {
    position: fixed; left: 12px; bottom: 10px;
    font: 12px/1.4 system-ui, sans-serif; color: rgba(255,255,255,0.55);
    background: rgba(0,0,0,0.35); padding: 6px 9px; border-radius: 6px;
  }
  #hint b { color: #fff; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="hint">Domino overlay: <b id="state">connecting…</b> <span id="bpm"></span></div>
<script src="domino-audio.js"></script>
<script>
  var feed = DominoAudio.connect();
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');
  var state = document.getElementById('state');
  var bpmEl = document.getElementById('bpm');
  var params = new URLSearchParams(location.search);
  var hue = Number(params.get('hue') || 300);
  var hideHint = params.get('hint') === '0';
  if (hideHint) document.getElementById('hint').style.display = 'none';

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
  }
  addEventListener('resize', resize);
  resize();

  var flash = 0;
  feed.on(function (f) { if (f.beat) flash = 1; });

  function draw() {
    requestAnimationFrame(draw);
    var f = feed.latest;
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    var cx = w / 2, cy = h / 2;
    var base = Math.min(w, h) * 0.22;
    var radius = base * (1 + 0.18 * f.bassAtt);
    flash *= 0.88;

    // Beat flash: a soft disc behind everything.
    if (flash > 0.02) {
      var g = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 2.2);
      g.addColorStop(0, 'hsla(' + hue + ',90%,70%,' + (0.35 * flash) + ')');
      g.addColorStop(1, 'hsla(' + hue + ',90%,70%,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // Spectrum ring.
    var bins = f.spectrum.length;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, base * 0.045);
    for (var i = 0; i < bins; i++) {
      var a = (i / bins) * Math.PI * 2 - Math.PI / 2;
      var v = f.spectrum[i];
      var len = base * 0.08 + v * base * 0.9;
      var x0 = cx + Math.cos(a) * radius, y0 = cy + Math.sin(a) * radius;
      var x1 = cx + Math.cos(a) * (radius + len), y1 = cy + Math.sin(a) * (radius + len);
      ctx.strokeStyle = 'hsla(' + (hue + i * 1.6) + ',85%,' + (55 + v * 30) + '%,0.9)';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }

    // Waveform inside the ring.
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = Math.max(1.5, base * 0.02);
    ctx.beginPath();
    var n = f.wave.length;
    for (var k = 0; k < n; k++) {
      var t = k / (n - 1);
      var x = cx - radius * 0.8 + t * radius * 1.6;
      var y = cy + f.wave[k] * radius * 0.5;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    state.textContent = feed.connected ? (f.active ? 'live' : 'connected, silent') : 'waiting for Domino';
    bpmEl.textContent = f.bpm > 0 && f.bpmConfidence > 0.08 ? '· ' + Math.round(f.bpm) + ' bpm' : '';
  }
  draw();
</script>
</body>
</html>
`;
