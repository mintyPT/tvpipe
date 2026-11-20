/**
 * TV sync by tapping along (docs/party-design.md §8.1): how much later a
 * TV shows a picture than this computer's screen. A metronome flashes
 * (and clicks) on the wall clock's beats, here and on the TV page
 * tvpipe casts (`/_tvpipe/tvsync/`, the same computer's clock); a person
 * taps along with each, and the difference of the two medians is the
 * TV's delay. The run here takes out the person's own habit (taps come
 * a little early, or late) and this screen's lag, which a phone has too:
 * what is left is how far the TV is behind a phone. The launcher runs
 * it per TV and keeps the TV's part (`tvsync.set`).
 */
/** The beat, ms: a tempo people tap along with steadily. */
export const BEAT_MS = 750;
/** How long a flash lasts, ms. */
export const FLASH_MS = 120;
/** Every how many beats one is accented (a bar). */
export const BAR = 4;
/** Taps counted per run (after {@link SKIP_TAPS}). */
export const TAPS = 10;
/** The first taps of a run, while people find the beat, are not counted. */
export const SKIP_TAPS = 2;
/** Taps further apart than this (the median absolute deviation, ms) are a run to do again. */
export const MAX_SPREAD_MS = 60;
/**
 * How late a tap is after the beat it answers: the beat is the one
 * nearest to `tap - expected` (taps for a TV come about its delay after
 * their beat), so delays up to half a beat off the expectation are told
 * apart. Times in ms on the wall clock.
 */
export function tapOffset(tap, expected, beat = BEAT_MS) {
    const k = Math.round((tap - expected) / beat);
    return tap - k * beat;
}
export function median(xs) {
    if (xs.length === 0)
        return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Sums up a run's tap times (wall clock, ms), the first {@link SKIP_TAPS} left out. */
export function tapRun(taps, expected, beat = BEAT_MS) {
    const offsets = taps.slice(SKIP_TAPS).map((t) => tapOffset(t, expected, beat));
    const offset = median(offsets);
    const spread = median(offsets.map((o) => Math.abs(o - offset)));
    return { offset, spread, taps: offsets.length, ok: offsets.length >= TAPS && spread <= MAX_SPREAD_MS };
}
/**
 * The TV's display lag from the two runs: how much later than this
 * screen it shows a picture (`total`), less the playout delay its
 * receiver was set up with (`delayMs`): what the TV adds (`displayMs`,
 * at least 0), which stays the same when the playout delay changes.
 */
export function displayLag(here, tv, delayMs) {
    const total = Math.round(tv.offset - here.offset);
    return { total, displayMs: Math.max(0, Math.min(2000, total - delayMs)) };
}
/** Wall-clock time (`Date.now()`'s clock) of an input event, from its precise timestamp. */
export function eventTime(ev) {
    const skew = Date.now() - (performance.timeOrigin + performance.now());
    return performance.timeOrigin + ev.timeStamp + skew;
}
/** A beat's index and whether it is the bar's first. */
export function beatOf(wall, beat = BEAT_MS) {
    const index = Math.floor(wall / beat);
    return { index, phase: wall - index * beat, accent: index % BAR === 0 };
}
/**
 * Flashes an element on the beats (the class `flash`, and `accent` on a
 * bar's first) and clicks with Web Audio when `audio` is given. The
 * clicks are scheduled to be heard with the flash: `lead` ms after the
 * beat (about a frame), less the output's own latency (`compensate`;
 * not on the TV page, whose sound is captured before any output).
 */
export class Metronome {
    #el;
    #audio;
    #lead;
    #compensate;
    #raf = 0;
    #timer;
    #scheduled = -1;
    #on = false;
    constructor(el, opts = {}) {
        this.#el = el;
        this.#audio = opts.audio;
        this.#lead = opts.lead ?? 16;
        this.#compensate = opts.compensate ?? true;
    }
    get running() {
        return this.#on;
    }
    start() {
        if (this.#on)
            return;
        this.#on = true;
        const frame = () => {
            if (!this.#on)
                return;
            const b = beatOf(Date.now());
            const lit = b.phase < FLASH_MS;
            this.#el.classList.toggle("flash", lit);
            this.#el.classList.toggle("accent", lit && b.accent);
            this.#raf = requestAnimationFrame(frame);
        };
        this.#raf = requestAnimationFrame(frame);
        if (this.#audio) {
            void this.#audio.resume().catch(() => { });
            this.#schedule();
            this.#timer = setInterval(() => this.#schedule(), 100);
        }
    }
    stop() {
        this.#on = false;
        cancelAnimationFrame(this.#raf);
        if (this.#timer)
            clearInterval(this.#timer);
        this.#timer = undefined;
        this.#el.classList.remove("flash", "accent");
    }
    /** Clicks for the beats of the next 400 ms. */
    #schedule() {
        const ctx = this.#audio;
        if (!ctx || ctx.state !== "running")
            return;
        const now = Date.now();
        const out = this.#compensate ? ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000 : 0;
        for (let k = Math.max(this.#scheduled + 1, Math.floor(now / BEAT_MS)); k * BEAT_MS < now + 400; k++) {
            const at = ctx.currentTime + (k * BEAT_MS + this.#lead - out - now) / 1000;
            this.#scheduled = k;
            if (at < ctx.currentTime)
                continue;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = k % BAR === 0 ? 1760 : 1320;
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(0.5, at + 0.002);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
            osc.connect(gain).connect(ctx.destination);
            osc.start(at);
            osc.stop(at + 0.06);
        }
    }
}
