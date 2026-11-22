/**
 * QR codes made in the page (web mode has no tvpipe to ask): a port of
 * tvpipe's encoder (`crates/tvpipe/src/util/qr.rs`), with its choices, so
 * both give the same symbol for the same text: ISO/IEC 18004 Model 2,
 * byte mode (the text's UTF-8, no ECI), level M, else L when M does not
 * fit, the smallest version that fits, and the mask with the lowest
 * penalty (N1–N4 as Nayuki's generator reads them; the first on a tie).
 * The known-answer tests compare with the Rust encoder's output
 * (`test/vectors/qr.txt`).
 */

export interface QrSymbol {
  /** Modules per side. */
  size: number;
  /** Row by row, `"1"` dark, `"0"` light. */
  rows: string[];
}

export const QR_MAX_VERSION = 40;

/** Level L, M: error correction codewords per block, by version. */
const ECC_PER_BLOCK = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
];

/** Level L, M: blocks, by version. */
const BLOCKS = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
];

/** Index into the tables: 0 is L, 1 is M. */
type Level = 0 | 1;
const L: Level = 0;
const M: Level = 1;
/** The two format bits of a level. */
const FORMAT_LEVEL = [1, 0];

/**
 * The QR code of `text` (byte mode, M else L, the smallest version up to
 * `maxVersion`); `null` when it does not fit.
 */
export function encodeQr(text: string, maxVersion: number = QR_MAX_VERSION): QrSymbol | null {
  const data = new TextEncoder().encode(text);
  const max = Math.min(maxVersion, QR_MAX_VERSION);
  for (const level of [M, L]) {
    for (let v = 1; v <= max; v++) {
      if (fits(data.length, v, level)) return toSymbol(encodeAt(data, v, level));
    }
  }
  return null;
}

/** For tests: the symbol at a version, level (`"L"`/`"M"`) and mask (default: the best), and every mask's penalty. */
export function encodeQrAt(data: Uint8Array, version: number, level: "L" | "M", mask?: number): QrSymbol & { mask: number; penalty: number } {
  const s = encodeAt(data, version, level === "L" ? L : M, mask);
  return { ...toSymbol(s), mask: s.mask, penalty: penalty(s.modules, s.size) };
}

interface Encoded {
  size: number;
  mask: number;
  modules: Uint8Array;
}

function toSymbol(s: Encoded): QrSymbol {
  const rows: string[] = [];
  for (let y = 0; y < s.size; y++) {
    let r = "";
    for (let x = 0; x < s.size; x++) r += s.modules[y * s.size + x] ? "1" : "0";
    rows.push(r);
  }
  return { size: s.size, rows };
}

// --- Capacity

function rawDataModules(v: number): number {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const align = Math.floor(v / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (v >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(v: number, level: Level): number {
  return Math.floor(rawDataModules(v) / 8) - ECC_PER_BLOCK[level]![v]! * BLOCKS[level]![v]!;
}

function countBits(v: number): number {
  return v <= 9 ? 8 : 16;
}

function fits(len: number, v: number, level: Level): boolean {
  return len < 1 << countBits(v) && 4 + countBits(v) + 8 * len <= 8 * dataCodewords(v, level);
}

// --- Codewords

function dataStream(data: Uint8Array, v: number, level: Level): number[] {
  const capacity = dataCodewords(v, level);
  const bytes: number[] = [];
  let len = 0;
  const push = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) {
      if (len % 8 === 0) bytes.push(0);
      if ((value >>> i) & 1) bytes[bytes.length - 1]! |= 0x80 >> len % 8;
      len++;
    }
  };
  push(0b0100, 4);
  push(data.length, countBits(v));
  for (const b of data) push(b, 8);
  push(0, Math.min(capacity * 8 - len, 4));
  for (let i = 0; bytes.length < capacity; i++) bytes.push(i % 2 === 0 ? 0xec : 0x11);
  return bytes;
}

function gfMul(a: number, b: number): number {
  let r = 0;
  while (b !== 0) {
    if (b & 1) r ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
    b >>= 1;
  }
  return r & 0xff;
}

function rsGenerator(degree: number): number[] {
  const g = new Array<number>(degree).fill(0);
  g[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      g[j] = gfMul(g[j]!, root);
      if (j + 1 < degree) g[j]! ^= g[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  return g;
}

function rsRemainder(data: number[], gen: number[]): number[] {
  const rem = new Array<number>(gen.length).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0]!;
    rem.shift();
    rem.push(0);
    for (let i = 0; i < rem.length; i++) rem[i]! ^= gfMul(gen[i]!, factor);
  }
  return rem;
}

function interleave(data: number[], v: number, level: Level): number[] {
  const blocks = BLOCKS[level]![v]!;
  const ecc = ECC_PER_BLOCK[level]![v]!;
  const short = Math.floor(data.length / blocks);
  const longBlocks = data.length % blocks;
  const gen = rsGenerator(ecc);
  const parts: { d: number[]; e: number[] }[] = [];
  let at = 0;
  for (let i = 0; i < blocks; i++) {
    const len = short + (i >= blocks - longBlocks ? 1 : 0);
    const d = data.slice(at, at + len);
    at += len;
    parts.push({ d, e: rsRemainder(d, gen) });
  }
  const out: number[] = [];
  for (let i = 0; i <= short; i++) for (const p of parts) if (i < p.d.length) out.push(p.d[i]!);
  for (let i = 0; i < ecc; i++) for (const p of parts) out.push(p.e[i]!);
  return out;
}

// --- Matrix

interface Grid {
  size: number;
  dark: Uint8Array;
  fn: Uint8Array;
}

function set(g: Grid, x: number, y: number, dark: boolean): void {
  const i = y * g.size + x;
  g.dark[i] = dark ? 1 : 0;
  g.fn[i] = 1;
}

function alignmentPositions(v: number): number[] {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2;
  const step = v === 32 ? 26 : Math.floor((v * 4 + n * 2 + 1) / (n * 2 - 2)) * 2;
  const size = 4 * v + 17;
  const pos: number[] = [];
  for (let i = 0; i < n - 1; i++) pos.push(size - 7 - i * step);
  pos.push(6);
  return pos.reverse();
}

function functionPatterns(v: number): Grid {
  const size = 4 * v + 17;
  const g: Grid = { size, dark: new Uint8Array(size * size), fn: new Uint8Array(size * size) };
  for (let i = 0; i < size; i++) {
    set(g, 6, i, i % 2 === 0);
    set(g, i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(g, x, y, d !== 2 && d !== 4);
        }
      }
    }
  }
  const pos = alignmentPositions(v);
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(g, pos[j]! + dx, pos[i]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(g, 0);
  if (v >= 7) drawVersion(g, versionBits(v));
  return g;
}

function drawFormat(g: Grid, bits: number): void {
  const size = g.size;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(g, 8, i, bit(i));
  set(g, 8, 7, bit(6));
  set(g, 8, 8, bit(7));
  set(g, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(g, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(g, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(g, 8, size - 15 + i, bit(i));
  set(g, 8, size - 8, true);
}

function formatBits(level: Level, mask: number): number {
  const data = (FORMAT_LEVEL[level]! << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawVersion(g: Grid, bits: number): void {
  const size = g.size;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(g, a, b, dark);
    set(g, b, a, dark);
  }
}

function versionBits(v: number): number {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (v << 12) | rem;
}

function place(g: Grid, codewords: number[]): void {
  const size = g.size;
  const total = codewords.length * 8;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (const x of [right, right - 1]) {
        const at = y * size + x;
        if (!g.fn[at] && i < total) {
          g.dark[at] = (codewords[i >>> 3]! >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

// --- Penalty

function penalty(m: Uint8Array, size: number): number {
  let score = 0;
  const line = new Uint8Array(size);
  for (const vertical of [false, true]) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) line[b] = vertical ? m[b * size + a]! : m[a * size + b]!;
      // Run lengths, light first, the light outside (`size`) at both ends.
      const runs: number[] = [size];
      let color = 0;
      for (const dark of line) {
        if (dark !== color) {
          runs.push(0);
          color = dark;
        }
        runs[runs.length - 1]!++;
      }
      if (color) runs.push(0);
      const last = runs.length - 1;
      runs[last]! += size;
      for (let i = 0; i < runs.length; i++) {
        const inside = runs[i]! - size * ((i === 0 ? 1 : 0) + (i === last ? 1 : 0));
        if (inside >= 5) score += 3 + (inside - 5);
      }
      score += 40 * finderLike(runs);
    }
  }
  for (let y = 1; y < size; y++) {
    for (let x = 1; x < size; x++) {
      const c = m[y * size + x];
      if (m[y * size + x - 1] === c && m[(y - 1) * size + x] === c && m[(y - 1) * size + x - 1] === c) score += 3;
    }
  }
  let dark = 0;
  for (const d of m) dark += d;
  const total = size * size;
  const k = Math.ceil(Math.abs(20 * dark - 10 * total) / total) - 1;
  return score + 10 * k;
}

function finderLike(runs: number[]): number {
  let count = 0;
  for (let i = 0; i + 7 <= runs.length; i += 2) {
    const n = runs[i + 1]!;
    if (n > 0 && runs[i + 2] === n && runs[i + 3] === 3 * n && runs[i + 4] === n && runs[i + 5] === n) {
      if (runs[i]! >= 4 * n && runs[i + 6]! >= n) count++;
      if (runs[i + 6]! >= 4 * n && runs[i]! >= n) count++;
    }
  }
  return count;
}

function encodeAt(data: Uint8Array, v: number, level: Level, mask?: number): Encoded {
  const codewords = interleave(dataStream(data, v, level), v, level);
  const g = functionPatterns(v);
  place(g, codewords);
  const masked = (mk: number): Grid => {
    const out: Grid = { size: g.size, dark: g.dark.slice(), fn: g.fn.slice() };
    for (let i = 0; i < out.dark.length; i++) {
      if (!g.fn[i] && maskBit(mk, i % g.size, Math.floor(i / g.size))) out.dark[i]! ^= 1;
    }
    drawFormat(out, formatBits(level, mk));
    return out;
  };
  if (mask !== undefined) return { size: g.size, mask, modules: masked(mask).dark };
  let best: Encoded | undefined;
  let bestScore = Infinity;
  for (let mk = 0; mk < 8; mk++) {
    const out = masked(mk);
    const p = penalty(out.dark, out.size);
    if (p < bestScore) {
      bestScore = p;
      best = { size: out.size, mask: mk, modules: out.dark };
    }
  }
  return best!;
}
