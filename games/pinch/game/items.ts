/**
 * Pinch's catalogue (docs/pinch-design.md §6): every item a night can
 * hold, its value, size and the places and rooms it suits, with its name
 * (and an optional deadpan note) in English and German, written
 * separately (the German is not a translation: it may name the thing its
 * own way, as long as it is the same size and worth the same).
 *
 * `pickCatalogue` chooses a night's items for the loot places the map
 * offers. It is pure: an rng in, items and suggested places out; the map
 * owns where things end up. The words around the items live in
 * `words.ts`; the rules for writing more are in design/words.md.
 */

import { AREA_KINDS, KEEPS, ROOM_KINDS, type AreaKind, type Keep, type RoomKind } from "./map.ts";

export type Lang = "en" | "de";
export const LANGS: readonly Lang[] = ["en", "de"];

/** A text in both languages. */
export type Text = Readonly<Record<Lang, string>>;

/** A random source: a number in [0, 1), like `Math.random` or `() => rng.float()` (rng.ts). */
export type Random = () => number;

// The kinds of rooms, outside areas and ways of keeping loot are the map's
// (one definition, game/map.ts); re-exported here for the words.
export { KEEPS, ROOM_KINDS, type Keep, type RoomKind };

/** The kinds of outside areas of a lot (map.ts `AREA_KINDS`). */
export const OUTSIDE_KINDS = AREA_KINDS;
export type OutsideKind = AreaKind;

/** Small items take one of the thief's four slots, large ones two. */
export type Size = "small" | "large";
export const SLOTS: Readonly<Record<Size, number>> = { small: 1, large: 2 };

/** The thief's slots. */
export const THIEF_SLOTS = 4;

export const MIN_VALUE = 200;
export const MAX_VALUE = 25_000;
/** Items eligible for a tracker tag are worth at least this. */
export const TAG_VALUE = 5_000;
/** The longest item name (either language), for the catalogue column and the ticker. */
export const ITEM_NAME_MAX = 32;
/** The longest note. */
export const ITEM_NOTE_MAX = 40;
/** The number of items in {@link ITEMS}. */
export const ITEM_COUNT = 60;
/** A night's catalogue: at least, at most. */
export const NIGHT_MIN = 8;
export const NIGHT_MAX = 14;

export interface Item {
  /** Stable, lowercase with dashes; the same in every language. */
  readonly id: string;
  /** Dollars, {@link MIN_VALUE}–{@link MAX_VALUE}. */
  readonly value: number;
  readonly size: Size;
  /** The ways it can be kept, the first the likeliest. */
  readonly keep: readonly Keep[];
  /** The rooms it suits. */
  readonly rooms: readonly RoomKind[];
  /** May carry a tracker tag ("GPS, patent pending"): only valuable items. */
  readonly tagged: boolean;
  readonly name: Text;
  /** A short deadpan line for the catalogue. */
  readonly note?: Text;
}

/** `[en, de]` pairs, to keep the table below readable. */
type Pair = readonly [string, string];

function def(
  id: string,
  value: number,
  size: Size,
  keep: readonly Keep[],
  rooms: readonly RoomKind[],
  name: Pair,
  note?: Pair,
): Item {
  const item: Item = {
    id,
    value,
    size,
    keep,
    rooms,
    tagged: value >= TAG_VALUE,
    name: { en: name[0], de: name[1] },
    ...(note ? { note: { en: note[0], de: note[1] } } : {}),
  };
  return item;
}

/**
 * The catalogue, cheapest first. Most things are cheap and near the
 * doors; a few are worth a night's risk. Display cases suit galleries,
 * libraries, studies, ballrooms and bedrooms; safes the vault, studies and
 * bedrooms; the pedestal the vault, the gallery, the library, the study,
 * the ballroom and the bedroom (each with at least three items, tested).
 */
export const ITEMS: readonly Item[] = [
  def("night-lunch", 200, "small", ["loose"], ["security"], ["Night Watchman's Lunch", "Pausenbrot vom Nachtwächter"], ["Ham, probably", "Leberwurst, vermutlich"]),
  def("vhs-tape", 200, "small", ["loose"], ["bedroom", "library", "security", "billiards"], ["Unlabelled VHS Tape", "VHS-Kassette ohne Etikett"], ["Ominous", "Beunruhigend"]),
  def("wheelbarrow", 200, "large", ["loose"], ["garage", "shed", "vault", "kitchen"], ["Wheelbarrow of Banknotes", "Schubkarre voll Inflationsgeld"], ["Foreign. Buys one sandwich.", "Die Schubkarre ist mehr wert"]),
  def("gnome", 250, "small", ["loose"], ["conservatory", "shed", "garage"], ["Garden Gnome", "Gartenzwerg"], ["Saw everything. Says nothing.", "Hat alles gesehen. Schweigt."]),
  def("dressing-gown", 250, "small", ["loose"], ["bathroom", "bedroom"], ["Silk Dressing Gown", "Seidener Morgenmantel"], ["Monogrammed, sadly", "Mit Monogramm. Leider."]),
  def("hip-flask", 300, "small", ["loose"], ["study", "billiards", "garage", "bathroom", "security"], ["Silver Hip Flask", "Silberner Flachmann"], ["Half full, optimistically", "Halb leer, realistisch betrachtet"]),
  def("piano-key", 300, "small", ["loose"], ["ballroom"], ["Middle C from the Grand Piano", "Eingestrichenes C vom Flügel"], ["The rest of the piano stays", "Der Rest bleibt hier"]),
  def("puzzle-cube", 300, "small", ["loose"], ["library", "bedroom", "billiards", "study"], ["Puzzle Cube", "Zauberwürfel"], ["Unsolved since 1974", "Ungelöst seit 1974"]),
  def("bowler", 300, "small", ["loose"], ["security", "foyer", "corridor"], ["Spare Bowler Hat", "Ersatz-Melone"], ["Regulation size", "Laut Dienstvorschrift"]),
  def("prize-marrow", 300, "large", ["loose"], ["shed", "kitchen", "conservatory"], ["Prize Marrow", "Preiskürbis"], ["Second at the county fair", "Zweiter Platz, Kreisschau"]),
  def("lava-lamp", 350, "small", ["loose"], ["bedroom", "study", "billiards", "ballroom"], ["Lava Lamp", "Lavalampe"], ["Groovy, eventually", "In 40 Jahren der letzte Schrei"]),
  def("fountain-pen", 350, "small", ["loose"], ["study", "library", "security"], ["Fountain Pen", "Füllfederhalter"], ["Signs cheques that bounce", "Unterschreibt ungedeckte Schecks"]),
  def("walkman", 400, "small", ["loose"], ["bedroom", "study", "billiards", "conservatory", "security"], ["Walkman", "Walkman"], ["For when they invent tapes", "Kassetten werden noch erfunden"]),
  def("pheasant", 400, "large", ["loose"], ["library", "study", "billiards", "dining", "corridor"], ["Stuffed Pheasant", "Ausgestopfter Fasan"], ["Looks offended", "Schaut beleidigt"]),
  def("cigars", 450, "small", ["loose"], ["study", "billiards", "library"], ["Box of Cuban Cigars", "Kiste Havannas"], ["Only one is chewed", "Nur eine ist angekaut"]),
  def("spoons", 500, "small", ["loose"], ["dining", "kitchen"], ["Monogrammed Silver Spoons", "Silberlöffel mit Monogramm"], ["Someone else's initials", "Fremde Initialen"]),
  def("caviar", 500, "small", ["loose"], ["kitchen", "dining"], ["Tin of Caviar", "Dose Kaviar"], ["Best before 1927", "Mindestens haltbar bis 1927"]),
  def("cuckoo-clock", 500, "large", ["loose"], ["dining", "kitchen", "corridor", "foyer"], ["Cuckoo Clock", "Kuckucksuhr"], ["One cuckoo too many", "Kuckuckt einmal zu oft"]),
  def("gin", 600, "large", ["loose"], ["kitchen", "dining", "billiards", "bathroom", "garage", "shed"], ["Crate of Prohibition Gin", "Kiste Schwarzgebrannter"], ["Bathtub vintage", "Jahrgang Badewanne"]),
  def("typewriter", 600, "large", ["loose"], ["study", "library", "security"], ["Typewriter", "Reiseschreibmaschine"], ["The Y sticks", "Das Ü klemmt"]),
  def("bust", 600, "large", ["loose"], ["library", "foyer", "gallery", "study", "corridor"], ["Bust of Great-Grandpapa", "Büste des Urgroßvaters"], ["Disapproves", "Guckt streng"]),
  def("orchid", 600, "small", ["loose"], ["conservatory", "bedroom"], ["Prize Orchid", "Preisgekrönte Orchidee"], ["Must be praised daily", "Will täglich gelobt werden"]),
  def("candelabra", 700, "large", ["loose"], ["dining", "ballroom", "foyer", "corridor"], ["Silver Candelabra", "Silberner Kandelaber"]),
  def("billiard-cue", 800, "large", ["loose"], ["billiards"], ["Gold-Tipped Billiard Cue", "Vergoldetes Queue"], ["Misses all the same", "Trifft trotzdem nicht"]),
  def("toilet-brush", 800, "small", ["loose"], ["bathroom"], ["Gold Toilet Brush", "Goldene Klobürste"], ["Lightly used", "Kaum benutzt"]),
  def("gramophone", 900, "large", ["loose"], ["ballroom", "study", "library", "bedroom"], ["Gramophone", "Grammophon"], ["Knows one song", "Kann genau ein Lied"]),
  def("robot-vacuum", 900, "small", ["loose"], ["ballroom", "foyer", "corridor", "dining"], ["Robot Vacuum", "Saugroboter"], ["Circling since 1922", "Dreht seit 1922 seine Runden"]),
  def("microwave", 900, "large", ["loose"], ["kitchen"], ["Microwave Oven", "Mikrowelle"], ["Reheats the future", "Wärmt die Zukunft auf"]),
  def("hood-ornament", 900, "small", ["loose"], ["garage"], ["Hood Ornament", "Kühlerfigur"], ["Bent, like the chauffeur", "Verbogen, wie der Chauffeur"]),
  def("will", 900, "small", ["safe"], ["study", "vault", "bedroom"], ["Last Will and Testament", "Letzter Wille des Barons"], ["Leaves it all to the cat", "Alles erbt der Kater"]),
  def("cognac", 1_100, "small", ["loose"], ["dining", "study", "billiards", "kitchen"], ["1899 Cognac", "Cognac Jahrgang 1899"], ["Topped up with cold tea", "Mit kaltem Tee nachgefüllt"]),
  def("pocket-watch", 1_200, "small", ["loose", "case"], ["bedroom", "study", "dining", "bathroom"], ["Gold Pocket Watch", "Goldene Taschenuhr"], ["Runs slow, like its owner", "Geht nach. Wie der Herr Baron."]),
  def("recipe", 1_200, "small", ["safe", "loose"], ["kitchen", "vault", "study"], ["Cook's Secret Recipe", "Omas Geheimrezept"], ["Step four: more butter", "Zutat drei: Schmalz"]),
  def("zeppelin", 1_300, "large", ["loose"], ["study", "library", "billiards", "ballroom"], ["Model Zeppelin", "Zeppelinmodell"], ["Please do not smoke near it", "Bitte nicht daneben rauchen"]),
  def("car-phone", 1_500, "small", ["loose"], ["garage", "study", "security"], ["Brick Phone", "Autotelefon"], ["No network yet. Exclusive.", "Netz kommt noch. Sehr exklusiv."]),
  def("swamp-deed", 1_500, "small", ["safe"], ["study", "vault"], ["Deed to a Swamp in Florida", "Urkunde: Sumpfgrundstück"], ["Waterfront, mostly water", "Seelage. Teils im See."]),
  def("globe", 1_600, "large", ["loose"], ["library", "study"], ["Antique Globe", "Antiker Globus"], ["Several countries missing", "Australien fehlt noch"]),
  def("jazz-record", 1_800, "small", ["loose"], ["ballroom", "billiards", "bedroom"], ["Signed Jazz Record", "Signierte Schellackplatte"], ["Signed by the drummer", "Signiert vom Schlagzeuger"]),
  def("racing-trophy", 2_200, "large", ["loose", "case"], ["billiards", "foyer", "garage", "study"], ["Motor Racing Trophy", "Rennpokal"], ["Second place, engraved first", "Zweiter Platz, als Erster graviert"]),
  def("persian-rug", 2_400, "large", ["loose"], ["foyer", "study", "library", "bedroom", "dining"], ["Persian Rug", "Perserteppich"], ["Does not fly. We checked.", "Fliegt nicht. Geprüft."]),
  def("jade-chess", 2_400, "small", ["loose", "case"], ["library", "study", "billiards"], ["Jade Chess Set", "Schachspiel aus Jade"], ["One pawn short", "Ein Bauer fehlt"]),
  def("stocks", 2_500, "small", ["safe", "loose"], ["study", "vault", "library"], ["Stock Certificates", "Aktienpaket"], ["Pre-crash", "Vor dem Börsenkrach"]),
  def("guitar", 2_600, "large", ["loose"], ["ballroom", "bedroom", "billiards"], ["Electric Guitar", "E-Gitarre"], ["Rock and roll pending", "Rock ’n’ Roll folgt in Kürze"]),
  def("pearls", 4_500, "small", ["case", "safe"], ["bedroom", "gallery", "vault", "ballroom"], ["Pearl Necklace", "Perlenkette"], ["Real, says the jeweller", "Echt, sagt der Juwelier"]),
  def("bonds", 5_000, "small", ["safe"], ["vault", "study"], ["Bearer Bonds", "Inhaberschuldverschreibungen"], ["Finders keepers, legally", "Wer sie hat, hat sie"]),
  def("diamond-ring", 5_500, "small", ["case", "safe", "loose"], ["bedroom", "bathroom", "vault"], ["Diamond Ring", "Diamantring"], ["Left by the sink", "Lag am Waschbecken"]),
  def("gold-bars", 6_000, "large", ["safe", "loose"], ["vault"], ["Gold Bars", "Goldbarren"], ["Heavy, in a good way", "Schwer, aber im Guten"]),
  def("opal", 7_000, "small", ["case", "safe"], ["bedroom", "vault", "gallery"], ["Duchess's Opal", "Opal der Herzogin"], ["Unlucky. For her.", "Bringt Unglück. Ihr."]),
  def("ming-vase", 7_500, "large", ["case", "pedestal"], ["gallery", "foyer", "library", "conservatory"], ["Ming Vase", "Ming-Vase"], ["Ming-ish", "Ungefähr Ming"]),
  def("duke-portrait", 8_000, "large", ["loose"], ["gallery", "library", "foyer", "dining", "study"], ["Portrait of an Unsmiling Duke", "Herzog mit Doppelkinn (Öl)"], ["Has never smiled", "Lächelt nicht. Nie."]),
  def("tiara", 9_000, "small", ["case", "safe", "pedestal"], ["bedroom", "gallery", "vault", "ballroom"], ["Diamond Tiara", "Diamantdiadem"], ["For formal heads only", "Nur für festliche Köpfe"]),
  def("dinosaur-egg", 10_000, "large", ["case", "pedestal"], ["gallery", "library", "conservatory"], ["Dinosaur Egg", "Dinosaurier-Ei"], ["Do not incubate", "Nicht ausbrüten"]),
  def("violin", 11_000, "large", ["case", "pedestal"], ["ballroom", "gallery", "library"], ["Stradivarius Violin", "Stradivari-Geige"], ["Slightly out of tune", "Leicht verstimmt, wie alle hier"]),
  def("rembrandt", 12_000, "large", ["loose", "pedestal"], ["gallery"], ["Rembrandt (Probably)", "Rembrandt (vermutlich)"], ["Signed in pencil", "Mit Bleistift signiert"]),
  def("moon-rock", 13_000, "small", ["case", "pedestal"], ["gallery", "study", "library"], ["Moon Rock", "Mondgestein"], ["A souvenir from 1969", "Mitbringsel von 1969"]),
  def("sandal", 14_000, "small", ["case", "pedestal"], ["gallery", "library", "study"], ["Tutankhamun's Left Sandal", "Tutanchamuns linke Sandale"], ["Right one sold separately", "Die rechte ist verliehen"]),
  def("bible", 16_000, "large", ["case", "safe", "pedestal"], ["library", "study", "vault"], ["Gutenberg Bible", "Gutenberg-Bibel"], ["Dog-eared at the good bits", "Mit Eselsohren"]),
  def("faberge-egg", 18_000, "small", ["case", "safe", "pedestal"], ["gallery", "study", "vault", "bedroom"], ["Fabergé Egg", "Fabergé-Ei"], ["Do not boil", "Nicht kochen"]),
  def("crown", 21_000, "small", ["safe", "pedestal"], ["vault", "gallery", "ballroom"], ["Crown of Lower Moldavonia", "Krone von Großwackelstein"], ["Country discontinued", "Das Land gibt’s nicht mehr"]),
  def("ruby", 25_000, "small", ["safe", "pedestal"], ["vault", "gallery", "bedroom"], ["Maharaja's Ruby", "Rubin des Maharadschas"], ["Cursed, says the brochure", "Verflucht, laut Prospekt"]),
];

const BY_ID: ReadonlyMap<string, Item> = new Map(ITEMS.map((i) => [i.id, i]));

/** The item with this id, or undefined. */
export function itemById(id: string): Item | undefined {
  return BY_ID.get(id);
}

/** Does the item suit this way of keeping in this kind of room? */
export function fits(item: Item, place: LootPlace): boolean {
  return item.keep.includes(place.keep) && item.rooms.includes(place.room);
}

// ---------------------------------------------------------------------------
// A night's catalogue

/** A place the map offers for an item: how it is kept, the room's kind, how deep it lies. */
export interface LootPlace {
  readonly keep: Keep;
  readonly room: RoomKind;
  /** Steps from the nearest outside door (more is deeper); valuable items go deep. */
  readonly depth?: number;
}

/** An item of the night. */
export interface NightItem {
  readonly item: Item;
  /** A suggested place, an index into the places given: it suits the item, distinct per item. */
  readonly place: number;
  /** Carries a tracker tag tonight: the two (three from 11 items) most valuable eligible ones. */
  readonly tagged: boolean;
}

/** Below this, an item is cheap; from it on, mid; from {@link BIG} on, big. */
const MID = 1_600;
const BIG = 10_000;

/** The number of tags tonight: two, three from 11 items on. */
export function tagCount(items: number): number {
  return items >= 11 ? 3 : 2;
}

function shuffled<T>(list: readonly T[], rng: Random): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * A night's catalogue: `count` items (clamped to {@link NIGHT_MIN}–
 * {@link NIGHT_MAX} and to the places there are), each with a distinct
 * place that suits it (its keep and its room's kind; when nothing suits a
 * place's room, its keep alone), the most valuable first.
 *
 * - At most one item on a pedestal, the deepest pedestal place when there
 *   are any, and it is strictly the most valuable of the night; other
 *   pedestal places stay empty.
 * - A spread: one or two big items (≥ $10,000, the pedestal's included),
 *   two to four mid ones (one of them tag-eligible, so a night has at
 *   least two tags), the rest cheap, as far as the places allow.
 * - Valuable items get the deeper places (swaps among suitable places).
 * - The tags: {@link tagCount} of the most valuable tag-eligible items.
 *
 * Fewer items come back only when the places cannot hold `count`.
 */
export function pickCatalogue(count: number, rng: Random, places: readonly LootPlace[]): NightItem[] {
  const want = Math.min(Math.max(Math.round(count), NIGHT_MIN), NIGHT_MAX);
  const used = new Set<string>();
  const taken = new Set<number>();
  const chosen: { item: Item; place: number }[] = [];
  const depth = (p: number) => places[p]?.depth ?? 0;

  // The pedestal: the deepest one, with a pedestal item that suits it.
  let cap = Infinity;
  const pedestals = places.map((p, i) => (p.keep === "pedestal" ? i : -1)).filter((i) => i >= 0);
  for (const i of pedestals) taken.add(i);
  if (pedestals.length > 0) {
    const at = shuffled(pedestals, rng).sort((a, b) => depth(b) - depth(a))[0]!;
    const place = places[at]!;
    const able = ITEMS.filter((it) => it.keep.includes("pedestal"));
    const suit = able.filter((it) => it.rooms.includes(place.room));
    const pool = suit.length > 0 ? suit : able;
    const big = pool.filter((it) => it.value >= BIG);
    const item = shuffled(big.length > 0 ? big : pool, rng)[0];
    if (item) {
      chosen.push({ item, place: at });
      used.add(item.id);
      cap = item.value;
    }
  }

  // The others by tiers: big first (they need the rarer places), then mid, then cheap.
  const bigs = (chosen.length > 0 ? 0 : 1) + (rng() < 0.5 ? 1 : 0);
  // Half the night (at least) stays cheap.
  const mids = Math.max(1, Math.min(2 + Math.min(2, Math.floor(rng() * 3)), Math.floor(want / 2) - chosen.length - bigs));
  const tiers: ((it: Item) => boolean)[] = [];
  for (let i = 0; i < bigs; i++) tiers.push((it) => it.value >= BIG);
  tiers.push((it) => it.tagged && it.value < BIG); // at least two tags a night
  for (let i = 1; i < mids; i++) tiers.push((it) => it.value >= MID && it.value < BIG);
  const cheap = (it: Item) => it.value < MID;
  const any = () => true;

  const free = () => shuffled(places.map((_, i) => i).filter((i) => !taken.has(i)), rng);
  const place = (ok: (it: Item) => boolean, strict: boolean): boolean => {
    for (const p of free()) {
      const lp = places[p]!;
      const cands = ITEMS.filter((it) => !used.has(it.id) && it.value < cap && ok(it) && (strict ? fits(it, lp) : it.keep.includes(lp.keep)));
      const item = shuffled(cands, rng)[0];
      if (item) {
        chosen.push({ item, place: p });
        used.add(item.id);
        taken.add(p);
        return true;
      }
    }
    return false;
  };
  for (const tier of tiers) {
    if (chosen.length >= want) break;
    place(tier, true);
  }
  while (chosen.length < want && (place(cheap, true) || place(any, true) || place(any, false)));

  // Valuable deep: swap two items when the dearer one sits shallower and both suit the other's place.
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of chosen) {
      for (const b of chosen) {
        const pa = places[a.place]!;
        const pb = places[b.place]!;
        if (pa.keep === "pedestal" || pb.keep === "pedestal") continue;
        if (a.item.value > b.item.value && depth(a.place) < depth(b.place) && fits(a.item, pb) && fits(b.item, pa)) {
          [a.place, b.place] = [b.place, a.place];
          changed = true;
        }
      }
    }
  }

  chosen.sort((a, b) => b.item.value - a.item.value || a.item.id.localeCompare(b.item.id));
  let tags = tagCount(chosen.length);
  return chosen.map(({ item, place }) => {
    const tagged = tags > 0 && item.tagged;
    if (tagged) tags--;
    return { item, place, tagged };
  });
}
