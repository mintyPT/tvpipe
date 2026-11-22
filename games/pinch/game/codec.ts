/**
 * Compact encodings for views (hand-rolled, no Buffer: the same code runs
 * in Node, the host page and phones): unsigned varints, base64url and
 * run-length encoding of tile layers. Decoders never throw: bad input
 * gives null.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** Bytes as base64url without padding. */
export function toBase64(bytes: ArrayLike<number>): string {
  let s = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i]! & 255) << 16) | ((bytes[i + 1]! & 255) << 8) | (bytes[i + 2]! & 255);
    s += ALPHABET[n >>> 18]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i]! & 255) << 16;
    s += ALPHABET[n >>> 18]! + ALPHABET[(n >>> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((bytes[i]! & 255) << 16) | ((bytes[i + 1]! & 255) << 8);
    s += ALPHABET[n >>> 18]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]!;
  }
  return s;
}

/** base64url (no padding) back to bytes, or null. */
export function fromBase64(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    const k = Math.min(4, s.length - i);
    for (let j = 0; j < 4; j++) {
      let v = 0;
      if (j < k) {
        const c = s.charCodeAt(i + j);
        v = c < 128 ? LOOKUP[c]! : -1;
        if (v < 0) return null;
      }
      n = (n << 6) | v;
    }
    out[o++] = (n >>> 16) & 255;
    if (k > 2) out[o++] = (n >>> 8) & 255;
    if (k > 3) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

/** Writes unsigned varints (7 bits a byte, low first), values below 2^31. */
export class VarintWriter {
  bytes: number[] = [];
  uint(n: number): void {
    let v = Math.max(0, Math.floor(n)) >>> 0;
    while (v >= 0x80) {
      this.bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.bytes.push(v);
  }
}

/** Reads unsigned varints; `uint()` gives -1 past the end or on overlong input. */
export class VarintReader {
  #i = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  get done(): boolean {
    return this.#i >= this.bytes.length;
  }
  uint(): number {
    let v = 0;
    for (let shift = 0; shift < 32; shift += 7) {
      if (this.#i >= this.bytes.length) return -1;
      const b = this.bytes[this.#i++]!;
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v > 0x7fffffff ? -1 : v;
    }
    return -1;
  }
}

/**
 * Run-length encodes a layer of small unsigned integers: (value, run)
 * pairs as varints, as base64url.
 */
export function rleEncode(values: ArrayLike<number>): string {
  const w = new VarintWriter();
  let i = 0;
  while (i < values.length) {
    const v = values[i]!;
    let j = i + 1;
    while (j < values.length && values[j] === v) j++;
    w.uint(v);
    w.uint(j - i);
    i = j;
  }
  return toBase64(w.bytes);
}

/** {@link rleEncode} back to exactly `length` values, each at most `max`, or null. */
export function rleDecode(s: unknown, length: number, max: number): Int32Array | null {
  const bytes = fromBase64(s);
  if (!bytes || !(length >= 0)) return null;
  const out = new Int32Array(length);
  const r = new VarintReader(bytes);
  let o = 0;
  while (!r.done) {
    const v = r.uint();
    const n = r.uint();
    if (v < 0 || v > max || n <= 0 || o + n > length) return null;
    out.fill(v, o, o + n);
    o += n;
  }
  return o === length ? out : null;
}

/** A bit set (truthy entries) as base64url, one bit a tile, low bit first. */
export function bitsEncode(values: ArrayLike<number>): string {
  const bytes = new Uint8Array(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i++) if (values[i]) bytes[i >> 3]! |= 1 << (i & 7);
  return toBase64(bytes);
}

/** {@link bitsEncode} back to `length` 0/1 values, or null. */
export function bitsDecode(s: unknown, length: number): Uint8Array | null {
  const bytes = fromBase64(s);
  if (!bytes || bytes.length !== Math.ceil(length / 8)) return null;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (bytes[i >> 3]! >> (i & 7)) & 1;
  return out;
}
