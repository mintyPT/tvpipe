# Measurements and experiments

Results that shaped the code, with enough detail to repeat them. Browser
player timings are in [`player-protocol.md`](player-protocol.md#browsers).
The test pattern and how to measure with it: [Latency](https://tvpipe.party/manual/latency/).

## Glass-to-glass latency: Apple TV 4K (2026-11-18)

AppleTV6,2, tvOS 26.6.1. `tvpipe debug pattern --encoder builtin` (built-in
H.264, 1280x720@30, 2764 kbit/s), default latency profile ("wireless":
video lead 100 ms, audio 170 ms), Wi-Fi sender (MacBook Pro), TV in its
normal picture mode. The burned-in clock is the UTC wallclock at frame
generation.

Method: iPhone photos of the TV; latency = photo EXIF time
(`DateTimeOriginal` + `SubSecTimeOriginal`) − clock on the TV. Calibrated
with a photo of a millisecond clock on the sender's own monitor: the
iPhone's EXIF time ran **~555 ms late** relative to the image content.

| | |
|---|---|
| Raw (10 photos) | 682–914 ms, mean 800 ms |
| Phone timestamp offset | −555 ms (one calibration photo) |
| Sender monitor lag | +10–30 ms (estimate) |
| **Glass-to-glass** | **≈ 250–270 ms (±50 ms)** |

Receiver reports during the run: 0 lost, 0 late, 0 glitches. Sender side:
frames leave on schedule (−5..+3 ms) with ≥ 96 ms headroom. The spec's
"normal" profile (85 ms audio lead) glitched about once per second on
this Apple TV, which is why the automatic profile is the default.

Not measured yet: more calibration photos, TV game mode, lower
`--latency`, the ffmpeg path, Cast hardware.

## Share capture cadence (2026-11-21)

What the receivers get from `share URL` (and `game play`'s TV): headless
Chrome 158 on a MacBook Pro (M5 Max, macOS 26.6), `tvpipe -v share URL --to browser`,
1920x1080@30, the timestamps of the video records as tvpipe receives them.
Two pages: a canvas animation (light), and 40 CSS-animated boxes plus a
text update per frame with a 10–40 ms busy loop in 15 % of the frames
(a game's TV page doing work). "Uneven" is the share of frames a 60 Hz
screen would not hold for exactly two refreshes (simulated over 20
phases, the browser player's rule).

| | encoded fps (of 30 captured) | frame spacing | uneven at 60 Hz | capture → tvpipe p99 |
|---|---|---|---|---|
| light, before | 29.5 | 31–67 ms (sd 4.8) | 7.1 % | 4.6 ms |
| busy, before | 21.5 | 31–93 ms (sd 13.4) | 39 % | 34 ms |
| light, after | 30 | 33.3 ms (sd 0.04) | 0.2 % | 7.4 ms |
| busy, after | 30 | 33.3 ms (sd 0.05) | 0.3 % | 9.2 ms |

Before, the engine ran on the page's thread in Chrome, stamped each frame
when that thread got to it, and skipped a frame that came less than
31.3 ms after the last one encoded: arrival jitter of a few ms skipped
2–3 % of the frames of an idle page (a 67 ms hole each), and a busy page
lost a quarter of them. Chrome's own `VideoFrame.timestamp` stayed
33.3 ± 0.3 ms apart throughout, also while the page's thread delivered
the frames up to 50 ms late. Now (docs/share-protocol.md, "Binary
messages", "Media socket"): the engine runs in a worker (the track
processor's `readable` moved there), frames are stamped with their
capture time on an even grid, and the worker sends them over its own
socket. Audio stamped on arrival at the busy page made tvpipe resync its
PCM timeline (±50 ms) several times a minute; timed by its sample count
it does not. `--fps 60` on the busy page: 60 fps, 16.7 ms apart (sd
0.01).

## Cast default delay

openscreen's sender defaults to a 200 ms target delay. 5-minute soaks on a
Google TV over Wi-Fi saw ACK/feedback gaps of ~220 ms and 4–7
`MaxDurationInFlight` drops per 5 minutes at 200 ms, each costing up to a
GOP waiting for a keyframe. tvpipe uses 300 ms (~80 ms of margin); wired
or quiet networks can go lower with `--latency`.

## B-frames and AAC on openscreen's `cast_receiver`

Run with `scripts/receivers/cast-receiver.sh run` (openscreen's
`cast_receiver`, the ffmpeg + SDL build) and

```sh
TVPIPE_PT_KIND=bframes TVPIPE_PT_ORDER=dts \
    cargo test media::input::experiments -- --ignored --nocapture
```

(`crates/tvpipe/src/media/input.rs`, `mod experiments`: 1280x720@30 x264 files made by
ffmpeg, sent unchanged through `cast::StreamingSink`, frames paced in
decode order; the verdict comes from the receiver's log.)

| File | Timestamps sent | Result |
|---|---|---|
| no B-frames | pts | all frames decoded; no warnings, also at 120 ms playout delay |
| B-frames (`-bf 3`, pyramid, reorder depth 2) | pts | **broken**: RTP timestamps must increase and the in-flight window works on reference times, so frames going back in time trip `MaxDurationInFlight` (59 of 180 frames dropped) |
| B-frames | dts | all frames decoded, no drift warnings (play-out margin 47 ms vs 84 ms without B-frames) |
| no B-frames + raw AAC-LC | raw access units | **every AAC frame fails**: the receiver has no AudioSpecificConfig and runs ffmpeg's parser, which needs ADTS |
| same | ADTS-wrapped AAC | decodes and plays |
| MKV, H.264 + Opus | pts | decodes, no errors |

"dts" only works because openscreen's decoder assigns decoded pictures to
sent frames first-in-first-out. A receiver that maps output pictures by
their own timestamps (Chrome's pipeline, probably the Apple TV) would show
B-frames out of order, so this does **not** show that B-frames are safe.
Consequences in the code:

- Passthrough refuses B-frames. `TVPIPE_EXPERIMENT_BFRAMES=dts` (or `pts`)
  makes `play FILE` pass them through for hardware experiments.
- Passthrough refuses keyframe intervals over 4 s: a single
  `MaxDurationInFlight` drop at session start cost a whole 2 s GOP in
  several runs.
- The Cast sink sends AAC ADTS-framed, like Chromium's sender
  (`media/cast/encoding/audio_encoder.cc`).

Still open on hardware: B-frames on the Apple TV and a Chromecast; whether
the Apple TV scales a stream larger than its advertised canvas.

## Windows timer resolution

Windows ends timed waits on the system tick (15.6 ms by default), not when
they are due. Windows 11 ARM64 (build 26200, Parallels VM, 4 vCPUs, idle;
100 waits each, release build):

| wait | default timer: avg / p50 / p90 / max | `timeBeginPeriod(1)`: avg / p50 / p90 / max |
|---|---|---|
| `thread::sleep(1 ms)` | 3.0 / 2.8 / 5.3 / 6.5 ms | 4.4 / 4.4 / 7.4 / 7.7 ms |
| `thread::sleep(10 ms)` | 17.9-21.4 / 15.9-16.5 / 24-43 / 48-50 ms | 10.7 / 10.5 / 11.5 / 13.2 ms |
| `Condvar::wait_timeout(1 ms)` | 19.6-24.7 / 16.7 / 19.7-57 / 73-77 ms | 2.5 / 2.1 / 4.2 / 9.3 ms |
| `Condvar::wait_timeout(10 ms)` | 25.6-26.7 / 17.0 / 47-63 / 74-78 ms | 10.6 / 10.8 / 11.0 / 11.5 ms |
| UDP read timeout 1 ms | 24.5-24.8 / 16.8 / 54-69 / 74-79 ms | 1.6 / 1.9 / 2.0 / 2.4 ms |
| UDP read timeout 10 ms | 23.2 / 16.8 / 48 / 70-76 ms | 10.7 / 10.7 / 11.5 / 12.5 ms |

macOS for comparison: every wait within ~0.3 ms of due. With the default
timer, Cast bursts and feedback came tens of ms late, the in-flight window
filled and two session tests failed about one run in five; with
`timeBeginPeriod(1)` they passed 60 of 60 runs. Pacing with `sleep` alone
was rejected: it still overshoots by several ms and would have meant
rewriting every pacing and receive loop.
