// tvpipe player page (`--to browser`, protocol: docs/player-protocol.md).
//
// Connects to tvpipe's WebSocket on the page's own origin, decodes the
// H.264 records with WebCodecs (VideoDecoder) and plays the PCM records
// with Web Audio, both on tvpipe's clock: each record carries the instant
// its frame has on the session's shared timeline, the page learns how
// tvpipe's clock maps to its own (ping/pong) and presents the frame the
// playout delay later, like the TVs on the same timeline.
//
// URL options (besides the token `t`):
//   delay=MS   playout delay instead of tvpipe's (e.g. 500 for a steadier
//              picture when presenting into a video call)
//   stats=1    show the statistics from the start
//   ui=0       never show controls, messages or the sound button (OBS)
//
// Self-contained: no imports, no external resources. `window.tvpipePlayer`
// exposes the state and statistics (the tests read them).
(function () {
  'use strict';
  var VERSION = 1;
  var KIND_AUDIO = 2, KIND_H264 = 3;
  var FLAG_KEY = 1, FLAG_ANNEXB = 2;
  var HEADER = 13;
  // Decoded frames held for presentation; more means we are far behind.
  var MAX_FRAMES = 90;
  // A decoder with this many chunks queued is behind: skip to a keyframe.
  var MAX_DECODE_QUEUE = 24;
  // Audio chunks within this of the running schedule are played back to
  // back; further off, the schedule restarts at the right time.
  var AUDIO_SLACK = 0.03;

  var params = new URLSearchParams(location.search);
  var token = params.get('t') || '';
  var delayParam = params.has('delay') ? Number(params.get('delay')) : NaN;
  var ui = params.get('ui') !== '0';

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('video');
  var statsEl = $('stats'), clockEl = $('clock');
  var g = canvas.getContext('2d', { alpha: false });

  var P = window.tvpipePlayer = {
    version: VERSION,
    state: 'connecting',   // connecting, waiting, streaming, ended
    config: null,
    delayMs: null,
    offsetUs: null,        // tvpipe's clock minus the page's (µs)
    rttUs: null,
    stats: null,
    log: []
  };

  function newStats() {
    return {
      records: 0, bytes: 0, decoded: 0, drawn: 0,
      skippedWaiting: 0,    // delta frames before the first keyframe
      droppedLate: 0,       // decoded but overtaken before their turn
      droppedBehind: 0,     // decoder or queue overflow
      decodeErrors: 0, keyRequests: 0,
      delaySum: 0, delayN: 0, delayMax: 0,  // capture instant -> shown (ms)
      lateSum: 0, lateN: 0,                 // shown after its due time (ms)
      audioChunks: 0, audioLate: 0, audioResyncs: 0, audioSkipped: 0,
      audioLeadMs: null, audioSkewMs: null
    };
  }
  P.stats = newStats();

  // -------------------------------------------------------------------
  // UI

  function log(level, message) {
    P.log.push(level + ': ' + message);
    if (P.log.length > 200) P.log.shift();
    (level === 'error' ? console.error : console.log)('tvpipe: ' + message);
    send({ type: 'log', level: level, message: message });
  }

  function showMessage(title, detail) {
    var m = $('message');
    if (!ui || title === null) { m.hidden = true; return; }
    m.querySelector('b').textContent = title;
    $('detail').textContent = detail || '';
    m.hidden = false;
  }

  var idleTimer = null;
  function active() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { document.body.classList.add('idle'); }, 2500);
  }
  if (!ui) {
    $('controls').hidden = true;
    document.body.classList.add('idle');
  } else {
    document.addEventListener('mousemove', active);
    document.addEventListener('pointerdown', active);
    active();
  }

  function toggleFullscreen() {
    var d = document;
    var el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    } else {
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) {
        var r = req.call(el);
        if (r && r.catch) r.catch(function () {});
      }
    }
  }
  function toggleStats() { statsEl.hidden = !statsEl.hidden; renderStats(); }
  $('fullscreen').addEventListener('click', toggleFullscreen);
  $('statsButton').addEventListener('click', toggleStats);
  canvas.addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 's' || e.key === 'S') toggleStats();
  });
  if (params.get('stats') === '1') statsEl.hidden = false;

  // -------------------------------------------------------------------
  // Clocks (µs). The page's: performance.now(). tvpipe's: from pongs.

  function nowUs() { return performance.now() * 1000; }

  var samples = [];
  function onPong(m) {
    var t1 = nowUs();
    var t0 = Number(m.t), srv = Number(m.now);
    if (!isFinite(t0) || !isFinite(srv) || t1 < t0) return;
    samples.push({ rtt: t1 - t0, off: srv - (t0 + t1) / 2 });
    if (samples.length > 16) samples.shift();
    // The quickest round trip says the most.
    var best = samples[0];
    for (var i = 1; i < samples.length; i++) if (samples[i].rtt < best.rtt) best = samples[i];
    P.offsetUs = best.off;
    P.rttUs = best.rtt;
  }

  // When a record stamped `ts` (tvpipe µs) is due on the page clock.
  function dueUs(ts) { return ts - P.offsetUs + P.delayMs * 1000; }

  // -------------------------------------------------------------------
  // Socket

  var ws = null, retries = 0, pingTimer = null, statsTimer = null;
  // Record bytes received and last acknowledged: tvpipe limits what is
  // in flight to each tab, so one slow viewer cannot hold up a tunnel.
  var rxBytes = 0, ackedBytes = 0, ACK_EVERY = 32768;
  function send(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch (e) { /* closing */ }
    }
  }
  function ping() { send({ type: 'ping', t: nowUs() }); }

  function connect() {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
      '/ws?t=' + encodeURIComponent(token);
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      retries = 0;
      samples = [];
      rxBytes = 0;
      ackedBytes = 0;
      send({
        type: 'hello', version: VERSION, agent: navigator.userAgent,
        features: {
          videoDecoder: typeof VideoDecoder !== 'undefined',
          audioContext: typeof (window.AudioContext || window.webkitAudioContext) !== 'undefined',
          outputTimestamp: !!(window.AudioContext && AudioContext.prototype.getOutputTimestamp)
        }
      });
      // A few quick samples, then one a second.
      for (var i = 0; i < 5; i++) setTimeout(ping, i * 60);
      clearInterval(pingTimer);
      pingTimer = setInterval(ping, 1000);
      clearInterval(statsTimer);
      statsTimer = setInterval(reportStats, 2000);
    };
    ws.onmessage = function (e) {
      if (typeof e.data === 'string') {
        var m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        onText(m);
      } else {
        rxBytes += e.data.byteLength;
        if (rxBytes - ackedBytes >= ACK_EVERY) {
          ackedBytes = rxBytes;
          send({ type: 'ack', bytes: rxBytes });
        }
        onRecord(e.data);
      }
    };
    ws.onclose = function () {
      clearInterval(pingTimer);
      clearInterval(statsTimer);
      ws = null;
      resetMedia();
      if (P.state !== 'ended') {
        P.state = 'connecting';
        showMessage('Reconnecting…', 'tvpipe is not reachable.');
      }
      var wait = Math.min(5000, 300 * Math.pow(2, retries++));
      setTimeout(connect, wait);
    };
  }

  function onText(m) {
    switch (m.type) {
      case 'pong': onPong(m); break;
      case 'status':
        if (m.state === 'waiting') {
          P.state = 'waiting';
          showMessage('Waiting for the stream…', m.message === 'Waiting for the stream…' ? '' : m.message);
        }
        break;
      case 'config': configure(m); break;
      case 'end':
        P.state = 'ended';
        resetMedia();
        showMessage('The stream ended.', m.reason && m.reason !== 'the stream ended' ? m.reason : '');
        break;
      default: break;  // unknown types are ignored
    }
  }

  // -------------------------------------------------------------------
  // Video

  var decoder = null, waitingKey = true, frames = [];

  function b64bytes(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function decoderConfig() {
    var v = P.config.video;
    var c = { codec: v.codec, optimizeForLatency: true };
    if (v.description) c.description = b64bytes(v.description);
    return c;
  }

  function newDecoder() {
    closeDecoder();
    waitingKey = true;
    if (typeof VideoDecoder === 'undefined') return;
    decoder = new VideoDecoder({ output: onFrame, error: onDecodeError });
    try {
      decoder.configure(decoderConfig());
    } catch (e) {
      log('error', 'cannot configure the video decoder: ' + e.message);
      closeDecoder();
    }
  }

  function closeDecoder() {
    if (decoder && decoder.state !== 'closed') {
      try { decoder.close(); } catch (e) { /* closed */ }
    }
    decoder = null;
    while (frames.length) frames.shift().close();
  }

  function requestKey(reason) {
    waitingKey = true;
    P.stats.keyRequests++;
    send({ type: 'keyframe', reason: reason });
  }

  function onDecodeError(e) {
    P.stats.decodeErrors++;
    log('error', 'video decoder: ' + (e && e.message ? e.message : e));
    decoder = null;  // a failed decoder is closed; a new one comes with the next record
    requestKey('decoder error');
  }

  function onFrame(f) {
    P.stats.decoded++;
    frames.push(f);
    if (frames.length > MAX_FRAMES) {
      frames.shift().close();
      P.stats.droppedBehind++;
    }
  }

  function onVideo(ts, flags, data) {
    if (!P.config) return;
    var key = (flags & FLAG_KEY) !== 0;
    if (!decoder) {
      newDecoder();
      if (!decoder) return;
    }
    if (waitingKey) {
      if (!key) { P.stats.skippedWaiting++; return; }
      waitingKey = false;
    }
    if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      P.stats.droppedBehind++;
      requestKey('decoder behind');
      return;
    }
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: data }));
    } catch (e) {
      onDecodeError(e);
    }
  }

  // Half a display refresh (µs): a frame due before the middle of the
  // coming refresh is drawn now, so frames are on time ± half a refresh
  // instead of up to a whole one late.
  var halfRefresh = 0, lastTick = 0;

  // `at`: the refresh's own time (requestAnimationFrame's, µs), steady
  // where the callback's start is not, so frames due near the middle of
  // a refresh do not flip between two refreshes with the page's load.
  function draw(at) {
    if (P.offsetUs === null || P.delayMs === null || !frames.length) return;
    var now = nowUs();
    if (!(at > now - 50000 && at <= now)) at = now;
    var pick = -1;
    for (var i = 0; i < frames.length && dueUs(frames[i].timestamp) <= at + halfRefresh; i++) pick = i;
    if (pick < 0) return;
    for (var j = 0; j < pick; j++) {
      frames.shift().close();
      P.stats.droppedLate++;
    }
    var f = frames.shift();
    var w = f.displayWidth, h = f.displayHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    try {
      g.drawImage(f, 0, 0, w, h);
    } catch (e) {
      log('error', 'drawing a frame: ' + e.message);
    }
    var s = P.stats;
    var delay = (now - (f.timestamp - P.offsetUs)) / 1000;
    s.drawn++;
    s.delaySum += delay; s.delayN++;
    if (delay > s.delayMax) s.delayMax = delay;
    s.lateSum += (now - dueUs(f.timestamp)) / 1000; s.lateN++;
    f.close();
    // The wallclock in the frame that shows the picture (for latency
    // photos of the test pattern's burned-in clock).
    if (!statsEl.hidden) clockEl.textContent = new Date().toISOString().slice(11, 23) + ' UTC';
    if (P.state !== 'streaming') {
      P.state = 'streaming';
      showMessage(null);
    }
    lastDrawn = now;
  }

  var lastDrawn = 0;
  function loop(t) {
    var dt = (t - lastTick) * 1000;
    lastTick = t;
    if (dt > 2000 && dt < 50000) halfRefresh += (dt / 2 - halfRefresh) * 0.1;
    draw(t * 1000);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  // rAF stops in hidden tabs; timers keep going (throttled).
  setInterval(function () {
    if (document.hidden) {
      halfRefresh = 0;
      draw();
    }
  }, 8);

  // -------------------------------------------------------------------
  // Audio

  var actx = null, nextTime = 0;

  function audioContext() {
    if (actx) return actx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC({ latencyHint: 'interactive' });
    actx.onstatechange = updateSound;
    return actx;
  }

  function updateSound() {
    var needed = !!(P.config && P.config.audio && actx && actx.state !== 'running' && P.state !== 'ended');
    $('sound').hidden = !ui || !needed;
  }

  function startAudio() {
    if (!actx) return;
    var r = actx.resume();
    if (r && r.then) r.then(updateSound, function () {});
    nextTime = 0;
  }
  $('sound').addEventListener('click', startAudio);
  document.addEventListener('pointerdown', function () {
    if (actx && actx.state !== 'running') startAudio();
  });
  document.addEventListener('keydown', function () {
    if (actx && actx.state !== 'running') startAudio();
  });

  // The context time at which a sample is heard at page time `us`: from
  // the output timestamp (where the context is at the speaker), else from
  // currentTime and the reported latency. Their difference is in the
  // statistics (audioSkewMs) for diagnosis.
  function contextTimeAt(us) {
    var lat = actx.outputLatency || actx.baseLatency || 0;
    var simple = actx.currentTime + (us / 1000 - performance.now()) / 1000 - lat;
    if (actx.getOutputTimestamp) {
      var ts = actx.getOutputTimestamp();
      if (ts && ts.performanceTime > 0) {
        var t = ts.contextTime + (us / 1000 - ts.performanceTime) / 1000;
        P.stats.audioSkewMs = Math.round((t - simple) * 1000);
        return t;
      }
    }
    return simple;
  }

  function onAudio(ts, data) {
    var a = P.config && P.config.audio;
    var s = P.stats;
    if (!a || !actx || actx.state !== 'running' || P.offsetUs === null) { s.audioSkipped++; return; }
    var ch = a.channels, n = Math.floor(data.byteLength / (2 * ch));
    if (n <= 0) return;
    var buf = actx.createBuffer(ch, n, a.sampleRate);
    var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (var c = 0; c < ch; c++) {
      var out = buf.getChannelData(c);
      for (var i = 0, o = c * 2; i < n; i++, o += 2 * ch) out[i] = dv.getInt16(o, true) / 32768;
    }
    var t = contextTimeAt(dueUs(ts));
    if (nextTime > 0 && Math.abs(t - nextTime) < AUDIO_SLACK) {
      t = nextTime;
    } else if (nextTime > 0) {
      s.audioResyncs++;
    }
    var lead = t - actx.currentTime;
    s.audioLeadMs = Math.round(lead * 1000);
    if (lead < 0.002) {
      s.audioLate++;
      nextTime = 0;
      return;
    }
    var src = actx.createBufferSource();
    src.buffer = buf;
    src.connect(actx.destination);
    src.start(t);
    nextTime = t + n / a.sampleRate;
    s.audioChunks++;
  }

  // -------------------------------------------------------------------
  // Records and configuration

  function onRecord(buf) {
    if (buf.byteLength < HEADER) return;
    var dv = new DataView(buf);
    var kind = dv.getUint8(0);
    var ts = dv.getUint32(1, true) + dv.getUint32(5, true) * 4294967296;
    var len = dv.getUint32(9, true);
    if (len !== buf.byteLength - HEADER) return;
    P.stats.records++;
    P.stats.bytes += buf.byteLength;
    if (kind === KIND_H264 && len >= 1) {
      onVideo(ts, dv.getUint8(HEADER), new Uint8Array(buf, HEADER + 1));
    } else if (kind === KIND_AUDIO) {
      onAudio(ts, new Uint8Array(buf, HEADER));
    }
  }

  function configure(m) {
    P.config = m;
    P.delayMs = isFinite(delayParam) && delayParam >= 0 ? delayParam : Number(m.latency) || 0;
    P.state = 'waiting';
    showMessage('Waiting for video…', '');
    if (typeof VideoDecoder === 'undefined') {
      showMessage('This browser cannot decode video.',
        'tvpipe needs WebCodecs: Chrome, Edge, Safari 16.4+ or Firefox 130+.');
      log('error', 'no VideoDecoder in ' + navigator.userAgent);
    } else {
      VideoDecoder.isConfigSupported(decoderConfig()).then(function (r) {
        if (!r.supported) log('error', 'this browser cannot decode ' + m.video.codec);
      }, function () {});
      newDecoder();
    }
    nextTime = 0;
    if (m.audio) audioContext();
    updateSound();
    log('info', 'playing ' + m.video.width + 'x' + m.video.height + ' ' + m.video.codec +
      (m.audio ? ', PCM ' + m.audio.sampleRate + ' Hz ' + m.audio.channels + ' ch' : '') +
      ', delay ' + P.delayMs + ' ms');
  }

  function resetMedia() {
    closeDecoder();
    P.config = null;
    nextTime = 0;
    updateSound();
  }

  // -------------------------------------------------------------------
  // Statistics

  var last = { at: performance.now(), drawn: 0, decoded: 0, bytes: 0 };
  // Over the last second.
  var rates = { fps: 0, decodedFps: 0, kbps: 0, delayMs: null, delayMaxMs: null, lateMs: null };

  function summary() {
    var s = P.stats;
    return {
      type: 'stats',
      state: P.state,
      fps: rates.fps, decodedFps: rates.decodedFps, kbps: rates.kbps,
      delayMs: rates.delayMs, delayMaxMs: rates.delayMaxMs, lateMs: rates.lateMs,
      targetMs: P.delayMs,
      drawn: s.drawn, decoded: s.decoded,
      droppedLate: s.droppedLate, droppedBehind: s.droppedBehind,
      skippedWaiting: s.skippedWaiting, decodeErrors: s.decodeErrors,
      queue: frames.length, decodeQueue: decoder ? decoder.decodeQueueSize : 0,
      audio: actx ? actx.state : 'none',
      audioChunks: s.audioChunks, audioLate: s.audioLate, audioResyncs: s.audioResyncs,
      audioLeadMs: s.audioLeadMs, audioSkewMs: s.audioSkewMs,
      rttMs: P.rttUs === null ? null : +(P.rttUs / 1000).toFixed(2)
    };
  }
  P.summary = summary;

  function reportStats() { send(summary()); }

  function renderStats() {
    var now = performance.now(), dt = (now - last.at) / 1000;
    if (dt >= 1) {
      var s = P.stats;
      rates.fps = +((s.drawn - last.drawn) / dt).toFixed(1);
      rates.decodedFps = +((s.decoded - last.decoded) / dt).toFixed(1);
      rates.kbps = Math.round((s.bytes - last.bytes) * 8 / dt / 1000);
      rates.delayMs = s.delayN ? +(s.delaySum / s.delayN).toFixed(1) : null;
      rates.delayMaxMs = s.delayN ? +s.delayMax.toFixed(1) : null;
      rates.lateMs = s.lateN ? +(s.lateSum / s.lateN).toFixed(1) : null;
      last = { at: now, drawn: s.drawn, decoded: s.decoded, bytes: s.bytes };
      s.delaySum = 0; s.delayN = 0; s.lateSum = 0; s.lateN = 0; s.delayMax = 0;
    }
    if (statsEl.hidden) return;
    var x = summary(), v = P.config && P.config.video;
    $('statsText').textContent = [
      'video   ' + (v ? v.width + 'x' + v.height + ' ' + v.codec : '–') + '  ' + x.fps + ' fps  ' + x.kbps + ' kbit/s',
      'delay   ' + (x.delayMs === null ? '–' : x.delayMs + ' ms') + ' (max ' + x.delayMaxMs + ', target ' + x.targetMs + ' ms)',
      'dropped ' + x.droppedLate + ' late, ' + x.droppedBehind + ' behind, ' + x.skippedWaiting + ' before a keyframe',
      'queue   ' + x.queue + ' frames, ' + x.decodeQueue + ' decoding, errors ' + x.decodeErrors,
      'audio   ' + x.audio + ', ' + x.audioChunks + ' chunks, lead ' + (x.audioLeadMs === null ? '–' : x.audioLeadMs + ' ms') +
        ', late ' + x.audioLate + ', resyncs ' + x.audioResyncs +
        (x.audioSkewMs === null ? '' : ', skew ' + x.audioSkewMs + ' ms'),
      'clock   rtt ' + (x.rttMs === null ? '–' : x.rttMs + ' ms')
    ].join('\n');
  }
  setInterval(renderStats, 250);

  connect();
})();
