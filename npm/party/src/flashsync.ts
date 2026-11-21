/**
 * TV sync by matching flashes (docs/party-design.md §8.1): how much later
 * a TV shows a picture than this computer's screen. The TV page tvpipe
 * casts (`/_tvpipe/tvsync/`) and the launcher show the same pattern of
 * numbered flashes, both from this computer's wall clock; the launcher
 * shows it `lag` ms late, and the person moves the lag until both screens
 * flash together. Then this screen waits exactly as long as the TV
 * takes, which is how far the TV is behind a phone (whose own lag is
 * about this screen's).
 *
 * The flashes come at uneven intervals, not on a beat: an even beat
 * looks in step with a copy one beat late (a TV 750 ms behind a 750 ms
 * beat flashes "together" with the computer), an uneven pattern only
 * at the right lag. The numbers tell which screen is ahead.
 */

/**
 * The intervals between flashes, ms: no two runs of them add up to the
 * same up to {@link MAX_LAG_MS}, so this screen's flashes, shifted by
 * anything but the right lag, meet the TV's at most once a cycle.
 */
export const INTERVALS: readonly number[] = [700, 500, 800, 900, 600, 1000, 1100];
/** One cycle of the pattern, ms. */
export const CYCLE_MS = INTERVALS.reduce((a, b) => a + b, 0);
/** How long a flash lasts, ms. */
export const FLASH_MS = 100;
/** The largest lag the launcher offers, ms (tvpipe keeps display lags up to 2000 ms). */
export const MAX_LAG_MS = 2000;

/** The flash showing at a wall-clock time: its number (1 to {@link INTERVALS}' length), ms since it came, whether it is lit. */
export function flashAt(wall: number): { n: number; phase: number; lit: boolean } {
  let c = ((wall % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  let i = 0;
  while (c >= INTERVALS[i]!) {
    c -= INTERVALS[i]!;
    i++;
  }
  return { n: i + 1, phase: c, lit: c < FLASH_MS };
}

/**
 * The TV's own part of a lag the person matched (`total`, ms behind this
 * screen): less the playout delay its receiver was set up with
 * (`delayMs`), what the TV adds (render, capture, the TV itself; 0 to
 * {@link MAX_LAG_MS}), which stays right when the playout delay changes.
 */
export function displayLag(total: number, delayMs: number): number {
  return Math.max(0, Math.min(MAX_LAG_MS, Math.round(total - delayMs)));
}

/**
 * Draws the pattern into an element, `lag` ms late: the class `flash`
 * while a flash is lit, and the flash's number as its text.
 */
export class Flasher {
  readonly #el: HTMLElement;
  #raf = 0;
  #on = false;
  #shown = 0;
  /** How late this element shows the pattern, ms. */
  lag: number;

  constructor(el: HTMLElement, lag = 0) {
    this.#el = el;
    this.lag = lag;
  }

  get running(): boolean {
    return this.#on;
  }

  start(): void {
    if (this.#on) return;
    this.#on = true;
    const frame = () => {
      if (!this.#on) return;
      const f = flashAt(Date.now() - this.lag);
      this.#el.classList.toggle("flash", f.lit);
      if (f.n !== this.#shown) {
        this.#shown = f.n;
        this.#el.textContent = String(f.n);
      }
      this.#raf = requestAnimationFrame(frame);
    };
    this.#raf = requestAnimationFrame(frame);
  }

  stop(): void {
    this.#on = false;
    cancelAnimationFrame(this.#raf);
    this.#el.classList.remove("flash");
    this.#el.textContent = "";
    this.#shown = 0;
  }
}
