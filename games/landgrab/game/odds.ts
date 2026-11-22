/**
 * The odds of a fight (docs/landgrab-design.md §2), for the phone's
 * amount picker: how likely `att` attackers beat `def` defenders when
 * they fight to the end (the attacker throws up to three dice, the
 * defender up to two, highest against highest, a tie to the defender).
 * Exact, from every throw's outcomes counted once and a table over the
 * armies left on both sides.
 */

/** Per dice count `[a, d]`: the chances of `[attacker's losses, defender's losses, p]`. */
const THROWS = new Map<string, [number, number, number][]>();

/** The outcomes of one throw of `a` against `d` dice, counted over all 6^(a+d) throws. */
export function throwOutcomes(a: number, d: number): [number, number, number][] {
  const key = `${a}:${d}`;
  const known = THROWS.get(key);
  if (known) return known;
  const counts = new Map<string, number>();
  const n = a + d;
  const total = 6 ** n;
  const dice = new Array<number>(n).fill(1);
  for (let k = 0; k < total; k++) {
    let x = k;
    for (let i = 0; i < n; i++) {
      dice[i] = (x % 6) + 1;
      x = Math.floor(x / 6);
    }
    const att = dice.slice(0, a).sort((p, q) => q - p);
    const def = dice.slice(a).sort((p, q) => q - p);
    let la = 0;
    let ld = 0;
    for (let i = 0; i < Math.min(a, d, 2); i++) {
      if (att[i]! > def[i]!) ld++;
      else la++;
    }
    const o = `${la}:${ld}`;
    counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  const out = [...counts].map(([o, c]) => {
    const [la, ld] = o.split(":").map(Number) as [number, number];
    return [la, ld, c / total] as [number, number, number];
  });
  THROWS.set(key, out);
  return out;
}

/** Known chances by `att * 4096 + def`. */
const WIN = new Map<number, number>();

/** The chance that `att` attackers take a territory held by `def` (0 … 1). */
export function winChance(att: number, def: number): number {
  att = Math.max(0, Math.floor(att));
  def = Math.max(0, Math.floor(def));
  if (def === 0) return att > 0 ? 1 : 0;
  if (att === 0) return 0;
  if (att > 4000 || def > 4000) return att > def ? 1 : 0;
  // Fill the table upwards: every throw costs at least one army, so smaller states come first.
  for (let a = 1; a <= att; a++) {
    for (let d = 1; d <= def; d++) {
      const key = a * 4096 + d;
      if (WIN.has(key)) continue;
      let p = 0;
      for (const [la, ld, q] of throwOutcomes(Math.min(3, a), Math.min(2, d))) {
        const a2 = a - la;
        const d2 = d - ld;
        p += q * (d2 <= 0 ? 1 : a2 <= 0 ? 0 : WIN.get(a2 * 4096 + d2)!);
      }
      WIN.set(key, p);
    }
  }
  return WIN.get(att * 4096 + def)!;
}

/** The fewest attackers (up to `most`) that take `def` with at least `chance`, or 0 if even `most` do not. */
export function armiesFor(def: number, chance: number, most: number): number {
  for (let a = 1; a <= most; a++) if (winChance(a, def) >= chance) return a;
  return 0;
}
