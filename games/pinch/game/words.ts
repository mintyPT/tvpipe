/**
 * Everything Pinch says (docs/pinch-design.md §7–§10, §12), in English
 * and German, written separately: the German has its own jokes and its
 * own 1920s (Ganoven, Schupo, Funzel), not a translation. The voice: a
 * 1920s heist drawn like a 1960s spy cartoon; deadpan, dry, a little
 * smug, fast, anachronisms on purpose. Rules for adding lines:
 * design/words.md.
 *
 * The tables (`WORDS.en`, `WORDS.de`) hold templates, functions of their
 * parameters; where a line repeats there are several variants and the
 * caller picks one with its rng. The functions below take language-free
 * parameters (an {@link Area} for a place, an {@link Item}, a {@link Dir8})
 * and resolve them in the language asked for.
 *
 * Limits (tested with typical names, every room and every item): a TV
 * ticker line (facts and claims) ≤ {@link TICKER_MAX} characters, a phone
 * button ≤ {@link BUTTON_MAX}, a refusal ≤ {@link REFUSAL_MAX}.
 */

import type { Item, Lang, OutsideKind, Random, RoomKind } from "./items.ts";

export type { Lang } from "./items.ts";

export const TICKER_MAX = 70;
export const BUTTON_MAX = 14;
export const REFUSAL_MAX = 32;
/** The tape's captions and the outcome cards' lines. */
export const CAPTION_MAX = 100;
/** Estates per language. */
export const ESTATE_COUNT = 30;
/** How often a claim gets an aside ("Ben seems sure."), when it fits. */
export const ASIDE_CHANCE = 1 / 3;

// ---------------------------------------------------------------------------
// Places

/** The four directions of gates and wings. */
export const DIRS4 = ["n", "e", "s", "w"] as const;
export type Dir4 = (typeof DIRS4)[number];
/** The eight directions of a Seen mark's arrow. */
export const DIRS8 = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export type Dir8 = (typeof DIRS8)[number];
/**
 * A building's half, or the garden (an Area; tips never name the garden:
 * loot is never outside).
 */
export type Wing = Dir4 | "garden";

/** A wing as map.ts keeps it: the building and its half. */
export interface HouseWing {
  readonly building: number;
  readonly half: Dir4;
}

/**
 * A place, language-free, as the game keeps it. `variant` picks one of
 * the kind's names (any number: it wraps, the languages have different
 * counts); `n` numbers rooms of the same name ("Bedroom 2"). `building`
 * (0 the main house, 1 the guest house) names the house when a lot has two.
 */
export type Area =
  | { readonly room: RoomKind; readonly variant?: number; readonly n?: number }
  | { readonly outside: OutsideKind; readonly variant?: number; readonly n?: number }
  | { readonly door: RoomKind; readonly variant?: number; readonly n?: number }
  | { readonly gate: Dir4 }
  | { readonly spot: string }
  | { readonly wing: Wing; readonly building?: number };

/** A place in words: the blueprint's label and the forms a sentence needs. */
export interface Noun {
  /** For the blueprint, title case ("Billiard Room", "Billardzimmer"). */
  readonly label: string;
  /** Subject or object: "the library", "die Bibliothek". */
  readonly the: string;
  /** Where: "in the library", "on the lawn", "in der Bibliothek", "auf dem Rasen". */
  readonly in: string;
  /** Where to: "to the library", "in die Bibliothek". */
  readonly to: string;
}

/** An estate's name and how to say "at it" ("at the Van Doren Estate", "auf Schloss Groschenstein"). */
export interface Estate {
  readonly name: string;
  readonly at: string;
}

// ---------------------------------------------------------------------------
// Parameters. In the tables, `where` is a Noun, `item` a name, `dir` a word.

export interface IntertitleParams {
  briefing: { estate: Estate };
  round: { thief: string; round: number };
  heist: object;
  tape: object;
  scores: object;
  final: object;
}

export interface TipParams {
  item: string;
  where: Noun;
}

export interface FactParams {
  start: object;
  sighting: { camera: number; where: Noun };
  tampered: { camera: number };
  glass: { where: Noun };
  lamp: { where: Noun };
  firecracker: { where: Noun };
  alarm: { where: Noun; seconds: number };
  missing: { item: string; where: Noun };
  ping: { where: Noun };
  held: { guard: string; thief: string; where: Noun };
  holdBroken: { guard: string; thief: string };
  holdSlipped: { guard: string; thief: string };
  arrest: { guard: string; thief: string };
  gotAway: { thief: string };
  timeUp: object;
  lastMinute: object;
  lightsOn: { where: Noun };
  lightsOff: { where: Noun };
}

export interface ClaimParams {
  clear: { guard: string; where: Noun };
  seen: { guard: string; where: Noun; dir: string };
  post: { guard: string; where: Noun };
  look: { guard: string; where: Noun };
}

export interface OutcomeParams {
  pinched: { thief: string; guard: string };
  gotAway: { thief: string };
  police: { thief: string };
  left: { thief: string };
}

export interface CaptionParams {
  liePost: { guard: string; where: Noun };
  lieClear: { guard: string; thief: string; where: Noun };
  closeShave: { guard: string; thief: string; paces: number };
  firecracker: { thief: string; guards: number; where: Noun };
  alarm: { thief: string; where: Noun };
  hold: { guard: string; thief: string };
  slipped: { guard: string; thief: string };
  arrest: { guard: string; thief: string };
  car: { thief: string; haul: number };
  sighting: { thief: string; camera: number };
  tampered: { thief: string; camera: number };
  tags: { thief: string };
  timeUp: { thief: string };
}

export interface AwardParams {
  stickyFingers: { name: string; haul: number };
  longArm: { name: string; holds: number; arrests: number };
  closeShave: { name: string; paces: number };
  tallTales: { name: string; lies: number };
  lightsOut: { name: string; lights: number };
}

export interface RoleParams {
  thief: { spot: string; where: Noun };
  guard: { where: Noun };
}

export type FactKind = keyof FactParams;
export type ClaimKind = keyof ClaimParams;
export type OutcomeKind = keyof OutcomeParams;
export type CaptionKind = keyof CaptionParams;
export type AwardId = keyof AwardParams;
export type IntertitleKind = keyof IntertitleParams;
export type Role = keyof RoleParams;

export const BUTTONS = [
  "take",
  "pickLock",
  "climb",
  "lightsOn",
  "lightsOff",
  "smashLamp",
  "tamper",
  "stripTags",
  "hold",
  "flashlightOn",
  "flashlightOff",
  "firecracker",
  "throw",
  "wriggle",
  "clear",
  "seen",
  "post",
  "look",
  "open",
  "close",
  "cancel",
  "ready",
  "skip",
] as const;
export type ButtonId = (typeof BUTTONS)[number];

export const REFUSALS = [
  "tooFar",
  "notInLight",
  "lightOff",
  "handsFull",
  "notInSight",
  "cooldown",
  "noFirecrackers",
  "held",
  "slippery",
  "nothingHere",
  "alreadyHeld",
  "busy",
  "blocked",
  "holding",
] as const;
export type RefusalId = (typeof REFUSALS)[number];

export const UI = [
  "catalogue",
  "missing",
  "held",
  "haul",
  "tag",
  "marks",
  "tip",
  "car",
  "tape",
  "play",
  "round",
  "total",
  "reward",
  "podium",
] as const;
export type UiId = (typeof UI)[number];

export type Template<P> = (p: P) => string;
export type Table<M> = { readonly [K in keyof M]: readonly Template<M[K]>[] };

/** One language's words. Both languages fill every field (the type checks it; the tests check the rest). */
export interface Words {
  readonly lang: Lang;
  readonly tagline: string;
  /** The lobby's how-to-play, three short steps. */
  readonly howTo: readonly [string, string, string];
  /** {@link ESTATE_COUNT} of them. */
  readonly estates: readonly Estate[];
  readonly intertitles: Table<IntertitleParams>;
  readonly tips: readonly Template<TipParams>[];
  readonly facts: Table<FactParams>;
  readonly claims: Table<ClaimParams>;
  readonly asides: readonly Template<{ guard: string }>[];
  readonly outcomes: { readonly [K in OutcomeKind]: { readonly title: string; readonly subs: readonly Template<OutcomeParams[K]>[] } };
  readonly captions: Table<CaptionParams>;
  readonly awards: { readonly [K in AwardId]: { readonly name: string; readonly citations: readonly Template<AwardParams[K]>[] } };
  /** The role reveal: the top bar's name, the card's title, its lines (all shown). */
  readonly roles: { readonly [K in Role]: { readonly name: string; readonly title: string; readonly lines: readonly Template<RoleParams[K]>[] } };
  readonly buttons: Readonly<Record<ButtonId, string>>;
  readonly refusals: Readonly<Record<RefusalId, string>>;
  readonly ui: Readonly<Record<UiId, string>>;
  /** The names of a room kind or an outside kind, labels, in variant order. */
  readonly names: (kind: RoomKind | OutsideKind) => readonly string[];
  readonly noun: (area: Area) => Noun;
  readonly dir: (d: Dir8) => string;
  readonly money: (dollars: number) => string;
}

// ---------------------------------------------------------------------------
// Helpers

const cap = (s: string): string => s.charAt(0).toLocaleUpperCase() + s.slice(1);
const titleCase = (s: string): string => s.replace(/(^|[\s-])(\p{Ll})/gu, (_, a: string, b: string) => a + b.toLocaleUpperCase());
const up = (s: string, lang: Lang): string => s.toLocaleUpperCase(lang);
const wrap = <T>(list: readonly T[], i: number | undefined): T => list[(((Math.trunc(i ?? 0) % list.length) + list.length) % list.length)]!;

/** Thousands separated: "12,500" or "12.500". */
function grouped(n: number, sep: string): string {
  const s = String(Math.round(Math.abs(n)));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += sep;
    out += s[i];
  }
  return (n < 0 ? "-" : "") + out;
}

const EN_NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const DE_NUM = ["kein", "ein", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf"];

/** "one guard", "three guards", "14 guards". */
function enCount(n: number, one: string, many = `${one}s`): string {
  return `${EN_NUM[n] ?? String(n)} ${n === 1 ? one : many}`;
}

/** German with the article's ending for one ("eine Wache", "einen Schritt"). */
function deCount(n: number, one: string, many: string, ending: string): string {
  return n === 1 ? `ein${ending} ${one}` : `${DE_NUM[n] ?? String(n)} ${many}`;
}

/** Tiles to whole paces, at least one. */
const paces = (tiles: number): number => Math.max(1, Math.round(Number.isFinite(tiles) ? tiles : 1));

// ---------------------------------------------------------------------------
// English

type EnPrep = "in" | "on" | "at";
interface EnName {
  readonly name: string;
  readonly prep?: EnPrep;
}

const EN_ROOMS: Readonly<Record<RoomKind, readonly string[]>> = {
  foyer: ["foyer", "entrance hall", "grand hall"],
  corridor: ["corridor", "hallway", "passage"],
  ballroom: ["ballroom", "music room"],
  library: ["library", "reading room"],
  study: ["study", "smoking room", "den"],
  gallery: ["gallery", "portrait gallery", "trophy room"],
  kitchen: ["kitchen", "scullery"],
  dining: ["dining room", "banquet hall", "breakfast room"],
  billiards: ["billiard room", "games room"],
  conservatory: ["conservatory", "orangery", "palm house"],
  bedroom: ["bedroom", "master bedroom", "guest bedroom", "blue bedroom"],
  bathroom: ["bathroom", "powder room"],
  vault: ["vault", "strongroom"],
  security: ["security office", "porter's lodge", "watch room"],
  garage: ["garage", "motor house"],
  shed: ["potting shed", "tool shed"],
};

const EN_OUTSIDE: Readonly<Record<OutsideKind, readonly EnName[]>> = {
  street: [{ name: "street", prep: "on" }, { name: "avenue", prep: "on" }],
  garden: [{ name: "garden" }, { name: "rose garden" }, { name: "lawn", prep: "on" }],
  carpark: [{ name: "car park" }, { name: "motor court" }],
  alley: [{ name: "alley" }, { name: "back lane" }],
  yard: [{ name: "yard" }, { name: "stable yard" }, { name: "courtyard" }],
};

const EN_DIR: Readonly<Record<Dir8, string>> = {
  n: "north",
  ne: "north-east",
  e: "east",
  se: "south-east",
  s: "south",
  sw: "south-west",
  w: "west",
  nw: "north-west",
};

const EN_HOUSES = ["main house", "guest house"];

function enNoun(name: string, prep: EnPrep = "in", n?: number, article = true): Noun {
  const numbered = n !== undefined && n > 1;
  const the = numbered ? `${name} ${n}` : article ? `the ${name}` : name;
  return { label: titleCase(numbered ? `${name} ${n}` : name), the, in: `${prep} ${the}`, to: `to ${the}` };
}

function enArea(a: Area): Noun {
  if ("room" in a) return enNoun(wrap(EN_ROOMS[a.room], a.variant), "in", a.n);
  if ("outside" in a) {
    const o = wrap(EN_OUTSIDE[a.outside], a.variant);
    return enNoun(o.name, o.prep, a.n);
  }
  if ("door" in a) {
    const room = enNoun(wrap(EN_ROOMS[a.door], a.variant), "in", a.n);
    const name = `${room.label.toLowerCase()} door`;
    return { label: `${room.label} Door`, the: `the ${name}`, in: `at the ${name}`, to: `to the ${name}` };
  }
  if ("gate" in a) return enNoun(`${EN_DIR[a.gate]} gate`, "at");
  if ("spot" in a) return { label: a.spot, the: `spot ${a.spot}`, in: `at spot ${a.spot}`, to: `to spot ${a.spot}` };
  if (a.wing === "garden") return enNoun("garden");
  const house = a.building === undefined ? "" : ` of the ${wrap(EN_HOUSES, a.building)}`;
  return enNoun(`${EN_DIR[a.wing]} wing${house}`);
}

const enMoney = (d: number): string => `$${grouped(d, ",")}`;
const enPaces = (t: number): string => enCount(paces(t), "pace");
const enTimes = (n: number): string => (n === 1 ? "once" : n === 2 ? "twice" : `${EN_NUM[n] ?? n} times`);
const poss = (name: string): string => `${name}'s`;

const EN: Words = {
  lang: "en",
  tagline: "One thief, a whole house after them, and the lights are out.",
  howTo: [
    "One of you is the thief. Everyone else is house security.",
    "The thief steals in the dark and runs for the car. Security lights them up, holds them and makes the arrest.",
    "Everyone gets a turn with the sack. The biggest haul wins.",
  ],
  estates: [
    "The Van Doren Estate",
    "Château Moneybags",
    "Gilded Acres",
    "Blackwood Hall",
    "The Pemberton-Smythe Place",
    "Villa Ostentatia",
    "Fairweather Manor",
    "Castle Overdraft",
    "The Ashcombe Residence",
    "Old Money House",
    "Featherstonehaugh Park",
    "Montclair Towers",
    "Lord Puddington's Pile",
    "Whitlock Abbey",
    "Tremaine Court",
    "The Glitterington Estate",
    "Hollowmere Hall",
    "Stockbroker's Folly",
    "Dunmillion Castle",
    "The Crumley-Gold Mansion",
    "Mallory House",
    "Sunnyvale Grange",
    "Château Nouveau-Riche",
    "Bellweather Lodge",
    "The Tuppenny-Grand Estate",
    "Wexley Priory",
    "Ravenscroft Manor",
    "Pennywhistle Park",
    "Marblethorpe Hall",
    "Highdollar House",
  ].map((name) => ({ name, at: `at ${name.replace(/^The /, "the ")}` })),
  intertitles: {
    briefing: [
      ({ estate }) => `MEANWHILE, ${up(estate.at, "en")}…`,
      ({ estate }) => `${up(estate.at, "en")}, THE FAMILY IS AWAY. THE SILVER IS NOT.`,
      ({ estate }) => `THAT NIGHT, ${up(estate.at, "en")}, NOBODY SUSPECTED A THING…`,
      ({ estate }) => `LATE ONE EVENING, ${up(estate.at, "en")}…`,
      ({ estate }) => `${up(estate.at, "en")}, THE DOGS HAVE THE NIGHT OFF.`,
    ],
    round: [
      ({ thief, round }) => `ROUND ${round}. ${up(thief, "en")} PUTS ON THE STRIPES.`,
      ({ thief, round }) => `ROUND ${round}. ${up(thief, "en")} BUYS A FLAT CAP.`,
      ({ thief, round }) => `ROUND ${round}. ${up(thief, "en")} HAS A FOOLPROOF PLAN.`,
    ],
    heist: [
      () => "THE LIGHTS GO DOWN…",
      () => "AND THEN, A FOOTSTEP…",
      () => "MIDNIGHT. THE CLOCK STRIKES. NOBODY LISTENS.",
      () => "ENTER: A STRIPED SWEATER.",
    ],
    tape: [() => "LATER, AT THE STATION…", () => "THE TAPE, WHICH CANNOT EXIST YET…", () => "AND NOW, FROM ANOTHER ANGLE…"],
    scores: [() => "COUNTING THE TAKE…", () => "MEANWHILE, AT THE BANK…", () => "THE ACCOUNTS ARE SETTLED."],
    final: [() => "AND SO THE NIGHT ENDS…", () => "THE END. THE SILVER WAS NEVER SEEN AGAIN.", () => "THE END. NOBODY TELL THE INSURANCE."],
  },
  tips: [
    ({ item, where }) => `Word is: ${item}, ${where.in}.`,
    ({ item, where }) => `A little bird mentions a certain ${item}, ${where.in}.`,
    ({ item, where }) => `TELEGRAM: ${up(item, "en")} ${up(where.in, "en")} STOP EAT THIS TELEGRAM STOP`,
    ({ item, where }) => `The butler, for a small fee: ${item}, ${where.in}.`,
    ({ item, where }) => `Your inside man swears by it: ${item}, ${where.in}. He swore about the dog, too.`,
  ],
  facts: {
    start: [() => "SYSTEM ARMED. ALL QUIET. FOR NOW.", () => "NIGHT WATCH BEGINS. THE TEA IS STILL HOT."],
    sighting: [
      ({ camera, where }) => `CAMERA ${camera}: a striped sweater ${where.in}.`,
      ({ camera, where }) => `CAMERA ${camera}: someone in stripes ${where.in}.`,
      ({ camera, where }) => `CAMERA ${camera}: a flat cap and a sack ${where.in}.`,
    ],
    tampered: [
      ({ camera }) => `CAMERA ${camera}: static. Someone has feelings about cameras.`,
      ({ camera }) => `CAMERA ${camera}: snow on the screen. It is not snowing.`,
      ({ camera }) => `CAMERA ${camera}: off the air. Viewers are asked to stay calm.`,
    ],
    glass: [({ where }) => `NOISE: breaking glass ${where.in}.`, ({ where }) => `CRASH ${where.in}. A display case, by the sound of it.`],
    lamp: [({ where }) => `NOISE: a lamp pops ${where.in}.`, ({ where }) => `POP ${where.in}. One lamp fewer.`],
    firecracker: [({ where }) => `BANG ${where.in}. Not a champagne cork.`, ({ where }) => `NOISE: a firecracker ${where.in}. How festive.`],
    alarm: [
      ({ where, seconds }) => `ALARM ${where.in}! Police in ${seconds} seconds.`,
      ({ where }) => `THE BELL ${where.in}. The police reach for their hats.`,
    ],
    missing: [({ item, where }) => `MISSING ${where.in}: ${item}.`, ({ item, where }) => `GONE: ${item}, from ${where.the}.`],
    ping: [({ where }) => `PING near ${where.the}. GPS tag, patent pending.`, ({ where }) => `PING: tagged loot near ${where.the}. Satellites, somehow.`],
    held: [
      ({ guard, thief, where }) => `HELD ${where.in}! ${guard} has ${thief} in the light.`,
      ({ guard, thief, where }) => `HELD: ${thief}, by ${guard}, ${where.in}. Run!`,
    ],
    holdBroken: [
      ({ guard, thief }) => `HOLD BROKEN. ${thief} slips out of ${poss(guard)} light.`,
      ({ guard, thief }) => `${guard} lost the light. ${thief} did not wait around.`,
    ],
    holdSlipped: [
      ({ guard, thief }) => `HOLD OVER. ${thief} wriggles free of ${guard}.`,
      ({ guard, thief }) => `${thief} is loose again. ${guard} is still pointing.`,
    ],
    arrest: [({ guard, thief }) => `ARREST: ${guard} collars ${thief}.`, ({ guard, thief }) => `PINCHED: ${thief}, by ${guard}. Cuffs, nickel-plated.`],
    gotAway: [({ thief }) => `ENGINE NOISE. ${thief} is gone.`, ({ thief }) => `TYRES SQUEAL. ${thief} waves from the back seat.`],
    timeUp: [() => "TIME. The police arrive, eventually.", () => "SIRENS. The police have found the address."],
    lastMinute: [() => "ONE MINUTE. The police are lacing their boots.", () => "ONE MINUTE LEFT. Somewhere, a siren warms up."],
    lightsOn: [({ where }) => `LIGHTS ON ${where.in}.`, ({ where }) => `LIGHTS ON ${where.in}. Somebody wants to be seen.`],
    lightsOff: [({ where }) => `LIGHTS OUT ${where.in}.`, ({ where }) => `LIGHTS OUT ${where.in}. Somebody likes the dark.`],
  },
  claims: {
    clear: [
      ({ guard, where }) => `${guard}: ${where.the} is clear.`,
      ({ guard, where }) => `${guard}: nobody ${where.in}.`,
      ({ guard, where }) => `${guard}: checked ${where.the}. Empty.`,
    ],
    seen: [
      ({ guard, where, dir }) => `${guard}: seen ${where.in}, heading ${dir}.`,
      ({ guard, where, dir }) => `${guard}: stripes ${where.in}, going ${dir}!`,
    ],
    post: [
      ({ guard, where }) => `${guard}: I've got ${where.the}.`,
      ({ guard, where }) => `${guard}: ${where.the} is covered.`,
      ({ guard, where }) => `${guard}: standing guard ${where.in}.`,
    ],
    look: [({ guard, where }) => `${guard}: over here, ${where.in}!`, ({ guard, where }) => `${guard}: come and look ${where.in}.`],
  },
  asides: [
    ({ guard }) => `${guard} seems sure.`,
    ({ guard }) => `${guard} would know.`,
    () => "Allegedly.",
    ({ guard }) => `Hand on heart, says ${guard}.`,
    () => "Noted.",
    ({ guard }) => `${guard} swears it.`,
  ],
  outcomes: {
    pinched: {
      title: "PINCHED!",
      subs: [
        ({ thief, guard }) => `${guard} collars ${thief}. The loot goes back on the shelf.`,
        ({ thief }) => `${thief} is going to the station. The haul is going nowhere.`,
      ],
    },
    gotAway: {
      title: "GOT AWAY",
      subs: [
        ({ thief }) => `${thief} is gone. Security is still looking under the sofa.`,
        ({ thief }) => `${thief} drives off. A car alarm chirps, sixty years early.`,
      ],
    },
    police: {
      title: "THE POLICE ARRIVE",
      subs: [
        ({ thief }) => `${thief} was still on the grounds. That counts as pinched.`,
        ({ thief }) => `The police find ${thief} behind a hedge. Pinched.`,
      ],
    },
    left: {
      title: "THE THIEF HAS LEFT THE BUILDING",
      subs: [
        ({ thief }) => `${thief} vanished from the phone. This round does not count.`,
        ({ thief }) => `${thief} is off the line. No score, no questions.`,
      ],
    },
  },
  captions: {
    liePost: [
      ({ guard, where }) => `${poss(guard)} post ${where.in}. ${guard} was never ${where.in}.`,
      ({ guard, where }) => `${guard} guarded ${where.the}. From somewhere else entirely.`,
    ],
    lieClear: [
      ({ guard, thief, where }) => `${guard} called ${where.the} clear. ${thief} was in it.`,
      ({ guard, thief }) => `"Clear," said ${guard}. ${thief} was behind the curtain.`,
    ],
    closeShave: [
      ({ guard, thief, paces: p }) => `${guard}, ${enPaces(p)} from ${thief}, looking the other way.`,
      ({ guard, thief, paces: p }) => `${thief} passes ${guard} at ${enPaces(p)}. ${guard} admires the wallpaper.`,
    ],
    firecracker: [
      ({ guards, where }) => `One firecracker sent ${enCount(guards, "guard")} to ${where.the}.`,
      ({ guards, where }) => `${cap(enCount(guards, "guard"))} rushed to ${where.the}. Waiting there: a firecracker.`,
    ],
    alarm: [
      ({ thief, where }) => `${thief} lifts the big one ${where.in}. The bell has opinions.`,
      ({ thief, where }) => `The alarm ${where.in}. ${thief} skipped the small print.`,
    ],
    hold: [({ guard, thief }) => `${guard} has ${thief} in the beam.`, ({ guard, thief }) => `The light finds ${thief}. ${guard} looks very pleased.`],
    slipped: [({ guard, thief }) => `${thief} wriggles out of ${poss(guard)} light.`, ({ guard }) => `${guard} lets go. Not on purpose.`],
    arrest: [({ guard }) => `${guard} makes the arrest. Rewind that bit.`, ({ guard, thief }) => `${guard} collars ${thief}. Someone frame this.`],
    car: [
      ({ thief, haul }) => `${thief} reaches the car with ${enMoney(haul)}. Nobody checked the car.`,
      ({ thief, haul }) => `And there goes ${thief}, with ${enMoney(haul)} in a sack.`,
    ],
    sighting: [
      ({ thief, camera }) => `Camera ${camera} catches ${thief}. Not the good side.`,
      ({ thief, camera }) => `Camera ${camera}: ${thief}, in glorious black and white.`,
    ],
    tampered: [
      ({ thief, camera }) => `${thief} gives camera ${camera} the static treatment.`,
      ({ thief, camera }) => `Camera ${camera}'s last sight: ${thief}, with a screwdriver.`,
    ],
    tags: [
      ({ thief }) => `${thief} strips the tracker tags. The satellites are confused.`,
      ({ thief }) => `The workbench. ${thief} removes the patent pending.`,
    ],
    timeUp: [
      ({ thief }) => `Time. ${thief} was still admiring the silver.`,
      ({ thief }) => `The police arrive. ${thief} had one more room in mind.`,
    ],
  },
  awards: {
    stickyFingers: {
      name: "Sticky Fingers",
      citations: [
        ({ name, haul }) => `${name} walked off with ${enMoney(haul)}. Allegedly.`,
        ({ name, haul }) => `${enMoney(haul)}, and not one fingerprint. Well done, ${name}.`,
      ],
    },
    longArm: {
      name: "Long Arm of the Law",
      citations: [
        ({ name, holds, arrests }) => `${name}: ${enCount(holds, "hold")}, ${enCount(arrests, "arrest")}. Remarkably long arms.`,
        ({ name, holds, arrests }) => `${name} laid hands on the thief ${enTimes(holds + arrests)}. Hands: still warm.`,
      ],
    },
    closeShave: {
      name: "Close Shave",
      citations: [
        ({ name, paces: p }) => `${name} passed a guard at ${enPaces(p)}. Nobody noticed.`,
        ({ name, paces: p }) => `${name}, ${enPaces(p)} from a bowler hat, and never seen.`,
      ],
    },
    tallTales: {
      name: "Tall Tales",
      citations: [
        ({ name, lies }) => `${name} reported ${enCount(lies, "thing")} the tape disagrees with.`,
        ({ name, lies }) => `${name}: ${enCount(lies, "report")}, every one of them confident.`,
      ],
    },
    lightsOut: {
      name: "Lights Out",
      citations: [
        ({ name, lights }) => `${name} switched off ${enCount(lights, "light")}. The power company sends thanks.`,
        ({ name, lights }) => `${name} turned off ${enCount(lights, "light")}. The dark is grateful.`,
      ],
    },
  },
  roles: {
    thief: {
      name: "Thief",
      title: "YOU ARE THE THIEF",
      lines: [
        ({ spot, where }) => `Your car waits at ${spot}, ${where.in}. Only you know which.`,
        () => "Steal what you can, keep to the dark, and get back to the car before the police do.",
      ],
    },
    guard: {
      name: "Security",
      title: "YOU ARE SECURITY",
      lines: [
        ({ where }) => `You start ${where.in}. The thief starts somewhere in the dark.`,
        () => "Light them up and tap to hold; a second guard makes the arrest. Talk all you like: the thief hears it too.",
      ],
    },
  },
  buttons: {
    take: "Take",
    pickLock: "Pick lock",
    climb: "Climb",
    lightsOn: "Lights on",
    lightsOff: "Lights off",
    smashLamp: "Smash lamp",
    tamper: "Tamper",
    stripTags: "Strip tags",
    hold: "HOLD",
    flashlightOn: "Flashlight on",
    flashlightOff: "Flashlight off",
    firecracker: "Firecracker",
    throw: "Tap to throw",
    wriggle: "Wriggle!",
    clear: "Clear",
    seen: "Seen",
    post: "Post",
    look: "Look",
    open: "Open",
    close: "Close",
    cancel: "Cancel",
    ready: "Ready",
    skip: "Fast forward",
  },
  refusals: {
    tooFar: "Too far.",
    notInLight: "Not in your light.",
    lightOff: "Switch your light on first.",
    handsFull: "Your hands are full.",
    notInSight: "You can't see them from here.",
    cooldown: "Steady… one moment.",
    noFirecrackers: "No firecrackers left.",
    held: "You're held. Wriggle!",
    slippery: "Too slippery, for now.",
    nothingHere: "Nothing to do here.",
    alreadyHeld: "Already held. Go arrest them!",
    busy: "One thing at a time.",
    blocked: "The way is blocked.",
    holding: "Not in the middle of a hold.",
  },
  ui: {
    catalogue: "Catalogue",
    missing: "missing",
    held: "HELD",
    haul: "Haul",
    tag: "GPS",
    marks: "Marks",
    tip: "The tip",
    car: "Your car",
    tape: "THE TAPE",
    play: "PLAY",
    round: "Round",
    total: "Total",
    reward: "Reward",
    podium: "The richest",
  },
  names: (kind) => ((EN_ROOMS as Record<string, readonly string[]>)[kind] ?? EN_OUTSIDE[kind as OutsideKind].map((o) => o.name)).map(titleCase),
  noun: enArea,
  dir: (d) => EN_DIR[d],
  money: enMoney,
};

// ---------------------------------------------------------------------------
// German

type Gender = "m" | "f" | "n";
type DePrep = "in" | "auf" | "an";
interface DeName {
  readonly name: string;
  readonly g: Gender;
  readonly prep?: DePrep;
}

const d = (name: string, g: Gender, prep?: DePrep): DeName => (prep ? { name, g, prep } : { name, g });

const DE_ROOMS: Readonly<Record<RoomKind, readonly DeName[]>> = {
  foyer: [d("Foyer", "n"), d("Eingangshalle", "f"), d("Vestibül", "n")],
  corridor: [d("Flur", "m"), d("Korridor", "m"), d("Gang", "m")],
  ballroom: [d("Ballsaal", "m"), d("Musikzimmer", "n"), d("Spiegelsaal", "m")],
  library: [d("Bibliothek", "f"), d("Lesezimmer", "n")],
  study: [d("Arbeitszimmer", "n"), d("Herrenzimmer", "n"), d("Rauchsalon", "m")],
  gallery: [d("Galerie", "f"), d("Ahnengalerie", "f"), d("Trophäenzimmer", "n")],
  kitchen: [d("Küche", "f"), d("Spülküche", "f")],
  dining: [d("Speisezimmer", "n"), d("Bankettsaal", "m"), d("Frühstückszimmer", "n")],
  billiards: [d("Billardzimmer", "n"), d("Spielzimmer", "n")],
  conservatory: [d("Wintergarten", "m"), d("Orangerie", "f"), d("Palmenhaus", "n")],
  bedroom: [d("Schlafzimmer", "n"), d("Gästezimmer", "n"), d("Damenzimmer", "n"), d("Ankleidezimmer", "n")],
  bathroom: [d("Badezimmer", "n"), d("Waschraum", "m")],
  vault: [d("Tresorraum", "m"), d("Panzerraum", "m")],
  security: [d("Wachstube", "f"), d("Pförtnerloge", "f"), d("Sicherheitszentrale", "f")],
  garage: [d("Garage", "f"), d("Remise", "f")],
  shed: [d("Gartenhaus", "n"), d("Geräteschuppen", "m")],
};

const DE_OUTSIDE: Readonly<Record<OutsideKind, readonly DeName[]>> = {
  street: [d("Straße", "f", "auf"), d("Allee", "f", "auf")],
  garden: [d("Garten", "m"), d("Rosengarten", "m"), d("Rasen", "m", "auf")],
  carpark: [d("Parkplatz", "m", "auf"), d("Wagenhof", "m", "auf")],
  alley: [d("Gasse", "f"), d("Hintergasse", "f")],
  yard: [d("Hof", "m", "auf"), d("Wirtschaftshof", "m", "auf"), d("Innenhof", "m")],
};

const DE_DIR: Readonly<Record<Dir8, string>> = {
  n: "Norden",
  ne: "Nordosten",
  e: "Osten",
  se: "Südosten",
  s: "Süden",
  sw: "Südwesten",
  w: "Westen",
  nw: "Nordwesten",
};
const DE_DIR4: Readonly<Record<Dir4, string>> = { n: "Nord", e: "Ost", s: "Süd", w: "West" };
const DE_HOUSES = ["des Haupthauses", "des Gästehauses"];

const NOM: Record<Gender, string> = { m: "der", f: "die", n: "das" };
/** Dative after a preposition, contracted where German does. */
const DAT: Record<DePrep, Record<Gender, string>> = {
  in: { m: "im", f: "in der", n: "im" },
  auf: { m: "auf dem", f: "auf der", n: "auf dem" },
  an: { m: "am", f: "an der", n: "am" },
};
/** Accusative (where to). */
const ACC: Record<DePrep, Record<Gender, string>> = {
  in: { m: "in den", f: "in die", n: "ins" },
  auf: { m: "auf den", f: "auf die", n: "aufs" },
  an: { m: "an den", f: "an die", n: "ans" },
};

function deNoun(x: DeName, n?: number, tail = ""): Noun {
  const name = (n !== undefined && n > 1 ? `${x.name} ${n}` : x.name) + tail;
  const p = x.prep ?? "in";
  return { label: name, the: `${NOM[x.g]} ${name}`, in: `${DAT[p][x.g]} ${name}`, to: `${ACC[p][x.g]} ${name}` };
}

function deArea(a: Area): Noun {
  if ("room" in a) return deNoun(wrap(DE_ROOMS[a.room], a.variant), a.n);
  if ("outside" in a) return deNoun(wrap(DE_OUTSIDE[a.outside], a.variant), a.n);
  if ("door" in a) {
    const room = wrap(DE_ROOMS[a.door], a.variant);
    const zu = room.g === "f" ? "zur" : "zum";
    return deNoun(d("Tür", "f", "an"), undefined, ` ${zu} ${deNoun(room, a.n).label}`);
  }
  if ("gate" in a) return deNoun(d(`${DE_DIR4[a.gate]}tor`, "n", "an"));
  if ("spot" in a) return deNoun(d(`Stellplatz ${a.spot}`, "m", "auf"));
  if (a.wing === "garden") return deNoun(d("Garten", "m"));
  const house = a.building === undefined ? "" : ` ${wrap(DE_HOUSES, a.building)}`;
  return deNoun(d(`${DE_DIR4[a.wing]}flügel`, "m"), undefined, house);
}

const deMoney = (dollars: number): string => `${grouped(dollars, ".")} $`;
/** Accusative: "einen Schritt", "zwei Schritte". */
const dePaces = (t: number): string => deCount(paces(t), "Schritt", "Schritte", "en");
const deGuards = (n: number): string => deCount(n, "Wache", "Wachen", "e");
const deTimes = (n: number): string => (n === 0 ? "kein Mal" : n === 1 ? "einmal" : `${n}-mal`);

const DE: Words = {
  lang: "de",
  tagline: "Ein Langfinger, das ganze Haus hinterher, und das Licht ist aus.",
  howTo: [
    "Einer von euch klaut, alle anderen halten Wache.",
    "Der Langfinger schleicht im Dunkeln zur Beute und dann zum Wagen. Die Wache leuchtet, hält fest und nimmt fest.",
    "Jeder kommt einmal mit dem Sack dran. Die fetteste Beute gewinnt.",
  ],
  estates: [
    ["Villa Pfeffersack", "in der Villa Pfeffersack"],
    ["Schloss Groschenstein", "auf Schloss Groschenstein"],
    ["Gut Goldammer", "auf Gut Goldammer"],
    ["Haus Hochwohlgeboren", "im Haus Hochwohlgeboren"],
    ["Schloss Dukatenfels", "auf Schloss Dukatenfels"],
    ["Villa Neureich", "in der Villa Neureich"],
    ["Palais Protz", "im Palais Protz"],
    ["Burg Habenichts", "auf Burg Habenichts"],
    ["Rittergut Silberlöffel", "auf Rittergut Silberlöffel"],
    ["Schloss Sorgenfrei", "auf Schloss Sorgenfrei"],
    ["Villa Zinseszins", "in der Villa Zinseszins"],
    ["Gut Talerhausen", "auf Gut Talerhausen"],
    ["Schloss Pomp an der Prunk", "auf Schloss Pomp an der Prunk"],
    ["Herrenhaus Kragenstolz", "im Herrenhaus Kragenstolz"],
    ["Palais Goldgrund", "im Palais Goldgrund"],
    ["Villa Monokel", "in der Villa Monokel"],
    ["Jagdschloss Hirschgeweih", "im Jagdschloss Hirschgeweih"],
    ["Schloss Pleitenstein", "auf Schloss Pleitenstein"],
    ["Haus Börsenglück", "im Haus Börsenglück"],
    ["Gut Kronenthal", "auf Gut Kronenthal"],
    ["Villa Champagnerlaune", "in der Villa Champagnerlaune"],
    ["Schloss Hohenrendite", "auf Schloss Hohenrendite"],
    ["Landsitz derer von Knauser", "auf dem Landsitz derer von Knauser"],
    ["Palais Prunkenau", "im Palais Prunkenau"],
    ["Villa Erbschleich", "in der Villa Erbschleich"],
    ["Wasserschloss Moneten", "im Wasserschloss Moneten"],
    ["Gut Schampusbach", "auf Gut Schampusbach"],
    ["Schloss Mammonsruh", "auf Schloss Mammonsruh"],
    ["Haus Tresorien", "im Haus Tresorien"],
    ["Villa Dividende", "in der Villa Dividende"],
  ].map(([name, at]) => ({ name: name!, at: at! })),
  intertitles: {
    briefing: [
      ({ estate }) => `UNTERDESSEN, ${up(estate.at, "de")} …`,
      ({ estate }) => `${up(estate.at, "de")} SIND DIE HERRSCHAFTEN VERREIST. DAS TAFELSILBER NICHT.`,
      ({ estate }) => `IN JENER NACHT AHNTE ${up(estate.at, "de")} NIEMAND ETWAS …`,
      ({ estate }) => `SPÄT AM ABEND, ${up(estate.at, "de")} …`,
      ({ estate }) => `${up(estate.at, "de")} HABEN DIE HUNDE HEUTE FREI.`,
    ],
    round: [
      ({ thief, round }) => `RUNDE ${round}. ${up(thief, "de")} ZIEHT DEN RINGELPULLI AN.`,
      ({ thief, round }) => `RUNDE ${round}. ${up(thief, "de")} HAT EINEN TODSICHEREN PLAN.`,
      ({ thief, round }) => `RUNDE ${round}. ${up(thief, "de")} PUTZT DIE SCHIEBERMÜTZE.`,
    ],
    heist: [
      () => "DAS LICHT GEHT AUS …",
      () => "PLÖTZLICH: EIN SCHRITT IM DUNKELN …",
      () => "MITTERNACHT. DIE STANDUHR SCHLÄGT. KEINER HÖRT HIN.",
      () => "AUFTRITT: EIN RINGELPULLI.",
    ],
    tape: [() => "SPÄTER, AUF DER WACHE …", () => "DAS BAND, DAS ES NOCH GAR NICHT GEBEN DÜRFTE …", () => "UND JETZT AUS EINEM ANDEREN WINKEL …"],
    scores: [() => "KASSENSTURZ.", () => "UNTERDESSEN, BEI DER BANK …", () => "DIE BEUTE WIRD GEZÄHLT …"],
    final: [() => "UND SO ENDET DIE NACHT …", () => "ENDE. DAS SILBER BLIEB VERSCHOLLEN.", () => "ENDE. BITTE NICHTS DER VERSICHERUNG SAGEN."],
  },
  tips: [
    ({ item, where }) => `Ein Vögelchen zwitschert: ${item}, ${where.in}.`,
    ({ item, where }) => `TELEGRAMM: ${up(item, "de")} ${up(where.in, "de")} STOP TELEGRAMM AUFESSEN STOP`,
    ({ item, where }) => `Der Butler, gegen Trinkgeld: ${item} – ${where.in}.`,
    ({ item, where }) => `Dein Mann im Haus schwört: ${item}, ${where.in}. Beim Hund hat er auch geschworen.`,
    ({ item, where }) => `Am Stammtisch heißt es: ${item}, ${where.in}. Prost.`,
  ],
  facts: {
    start: [() => "ANLAGE SCHARF. ALLES RUHIG. NOCH.", () => "NACHTSCHICHT BEGINNT. DER KAFFEE IST NOCH WARM."],
    sighting: [
      ({ camera, where }) => `KAMERA ${camera}: ein Ringelpulli ${where.in}.`,
      ({ camera, where }) => `KAMERA ${camera}: verdächtige Streifen ${where.in}.`,
      ({ camera, where }) => `KAMERA ${camera}: Schiebermütze mit Sack ${where.in}.`,
    ],
    tampered: [
      ({ camera }) => `KAMERA ${camera}: Schneegestöber. Draußen schneit es nicht.`,
      ({ camera }) => `KAMERA ${camera}: Sendepause. Bitte bleiben Sie dran.`,
      ({ camera }) => `KAMERA ${camera}: nur noch Rauschen. Da war jemand fleißig.`,
    ],
    glass: [({ where }) => `LÄRM: Glas klirrt ${where.in}.`, ({ where }) => `SCHEPPERN ${where.in}. Klang nach Vitrine.`],
    lamp: [({ where }) => `LÄRM: eine Lampe zerspringt ${where.in}.`, ({ where }) => `PLOPP ${where.in}. Eine Lampe weniger.`],
    firecracker: [({ where }) => `KNALL ${where.in}. Kein Sektkorken.`, ({ where }) => `LÄRM: ein Knallfrosch ${where.in}. Wie festlich.`],
    alarm: [
      ({ where, seconds }) => `ALARM ${where.in}! Polizei in ${seconds} Sekunden.`,
      ({ where }) => `ES KLINGELT ${where.in}. Die Schupo sattelt auf.`,
    ],
    missing: [({ item, where }) => `VERMISST ${where.in}: ${item}.`, ({ item, where }) => `${cap(where.in)} fehlt: ${item}.`],
    ping: [({ where }) => `PING ${where.in}. Peilsender, Patent angemeldet.`, ({ where }) => `PING: Diebesgut mit Sender, ungefähr ${where.in}.`],
    held: [
      ({ guard, thief, where }) => `GESTELLT ${where.in}! ${guard} hat ${thief} im Licht.`,
      ({ guard, thief, where }) => `${guard} hält ${thief} fest, ${where.in}. Schnell!`,
    ],
    holdBroken: [
      ({ guard, thief }) => `LOSGERISSEN: ${thief} entwischt ${guard}.`,
      ({ guard, thief }) => `${guard} verliert das Licht. ${thief} wartet nicht.`,
    ],
    holdSlipped: [
      ({ guard, thief }) => `${thief} zappelt sich frei. ${guard} leuchtet ins Leere.`,
      ({ guard, thief }) => `FREI: ${thief} ist ${guard} durch die Lappen gegangen.`,
    ],
    arrest: [({ guard, thief }) => `FESTNAHME: ${guard} schnappt ${thief}.`, ({ guard, thief }) => `${thief} in Handschellen. Glückwunsch, ${guard}.`],
    gotAway: [({ thief }) => `MOTORGERÄUSCH. ${thief} ist über alle Berge.`, ({ thief }) => `REIFEN QUIETSCHEN. ${thief} winkt vom Rücksitz.`],
    timeUp: [() => "ZEIT UM. Die Schupo ist da, endlich.", () => "TATÜTATA. Die Polizei hat die Adresse gefunden."],
    lastMinute: [() => "NOCH EINE MINUTE. Die Schupo schnürt die Stiefel.", () => "LETZTE MINUTE. Irgendwo wärmt sich eine Sirene auf."],
    lightsOn: [({ where }) => `LICHT AN ${where.in}.`, ({ where }) => `LICHT AN ${where.in}. Da will jemand gesehen werden.`],
    lightsOff: [({ where }) => `LICHT AUS ${where.in}.`, ({ where }) => `LICHT AUS ${where.in}. Da mag es jemand dunkel.`],
  },
  claims: {
    clear: [
      ({ guard, where }) => `${guard}: ${cap(where.the)} ist sauber.`,
      ({ guard, where }) => `${guard}: ${cap(where.in)} ist keiner.`,
      ({ guard, where }) => `${guard}: ${where.label} geprüft. Leer.`,
    ],
    seen: [
      ({ guard, where, dir }) => `${guard}: gesichtet ${where.in}, Richtung ${dir}.`,
      ({ guard, where, dir }) => `${guard}: Ringel ${where.in}, ab nach ${dir}!`,
    ],
    post: [
      ({ guard, where }) => `${guard}: Ich stehe ${where.in}.`,
      ({ guard, where }) => `${guard}: ${cap(where.the)} ist bewacht.`,
      ({ guard, where }) => `${guard}: Ich halte die Stellung ${where.in}.`,
    ],
    look: [({ guard, where }) => `${guard}: Alle ${where.to}!`, ({ guard, where }) => `${guard}: Schaut mal ${where.in} nach.`],
  },
  asides: [
    ({ guard }) => `${guard} ist sich sicher.`,
    () => "Angeblich.",
    () => "Ehrenwort.",
    ({ guard }) => `Sagt ${guard}.`,
    () => "Zur Kenntnis genommen.",
    ({ guard }) => `${guard} schwört Stein und Bein.`,
  ],
  outcomes: {
    pinched: {
      title: "GESCHNAPPT!",
      subs: [
        ({ thief, guard }) => `${guard} schnappt ${thief}. Die Beute kommt zurück ins Regal.`,
        ({ thief }) => `${thief} wandert ins Kittchen. Die Beute bleibt im Haus.`,
      ],
    },
    gotAway: {
      title: "ÜBER ALLE BERGE",
      subs: [
        ({ thief }) => `${thief} ist weg. Die Wache sucht noch unterm Sofa.`,
        ({ thief }) => `${thief} braust davon. Eine Autoalarmanlage zwitschert, 60 Jahre zu früh.`,
      ],
    },
    police: {
      title: "DIE SCHUPO IST DA",
      subs: [
        ({ thief }) => `${thief} war noch auf dem Gelände. Das zählt als geschnappt.`,
        ({ thief }) => `Die Schupo findet ${thief} hinter der Hecke. Geschnappt.`,
      ],
    },
    left: {
      title: "SPURLOS VERSCHWUNDEN",
      subs: [
        ({ thief }) => `${thief} ist vom Telefon verschwunden. Diese Runde zählt nicht.`,
        ({ thief }) => `${thief} hat aufgelegt. Keine Punkte, keine Fragen.`,
      ],
    },
  },
  captions: {
    liePost: [
      ({ guard, where }) => `${guard} meldet: Posten ${where.in}. Da war ${guard} nie.`,
      ({ guard, where }) => `${cap(where.the)}, bewacht von ${guard}. Von ganz woanders aus.`,
    ],
    lieClear: [
      ({ guard, thief, where }) => `${guard} meldet: ${where.label} sauber. ${thief} war mittendrin.`,
      ({ guard, thief }) => `„Sauber“, sagt ${guard}. ${thief} steht hinterm Vorhang.`,
    ],
    closeShave: [
      ({ guard, thief, paces: p }) => `${guard}, ${dePaces(p)} von ${thief} entfernt, schaut woandershin.`,
      ({ guard, thief, paces: p }) => `${thief} huscht an ${guard} vorbei, ${dePaces(p)} entfernt. ${guard} bewundert die Tapete.`,
    ],
    firecracker: [
      ({ guards, where }) => `Ein Knallfrosch schickt ${deGuards(guards)} ${where.to}.`,
      ({ guards, where }) => `${cap(deGuards(guards))} ${guards === 1 ? "stürmt" : "stürmen"} ${where.to}. Dort wartet: ein Knallfrosch.`,
    ],
    alarm: [
      ({ thief }) => `${thief} hebt das Prunkstück an. Die Glocke hat etwas dagegen.`,
      ({ thief, where }) => `Alarm ${where.in}. ${thief} hat das Kleingedruckte nicht gelesen.`,
    ],
    hold: [({ guard, thief }) => `${guard} hat ${thief} im Lichtkegel.`, ({ guard, thief }) => `Das Licht findet ${thief}. ${guard} ist sehr zufrieden.`],
    slipped: [({ guard, thief }) => `${thief} zappelt sich aus dem Licht von ${guard}.`, ({ guard }) => `${guard} lässt los. Nicht absichtlich.`],
    arrest: [({ guard }) => `${guard} nimmt fest. Bitte noch mal zurückspulen.`, ({ guard, thief }) => `${guard} schnappt ${thief}. Das kommt ins Familienalbum.`],
    car: [
      ({ thief, haul }) => `${thief} erreicht den Wagen, mit ${deMoney(haul)}. Den Wagen hat keiner kontrolliert.`,
      ({ thief, haul }) => `Und weg ist ${thief}, mit ${deMoney(haul)} im Sack.`,
    ],
    sighting: [
      ({ thief, camera }) => `Kamera ${camera} erwischt ${thief}. Nicht die Schokoladenseite.`,
      ({ thief, camera }) => `Kamera ${camera}: ${thief}, in prächtigem Schwarzweiß.`,
    ],
    tampered: [
      ({ thief, camera }) => `${thief} verpasst Kamera ${camera} ein Schneegestöber.`,
      ({ thief, camera }) => `Das Letzte, was Kamera ${camera} sah: ${thief} mit Schraubenzieher.`,
    ],
    tags: [
      ({ thief }) => `${thief} entfernt die Peilsender. Die Satelliten sind verwirrt.`,
      ({ thief }) => `Die Werkbank. ${thief} schraubt das Patent ab.`,
    ],
    timeUp: [
      ({ thief }) => `Zeit um. ${thief} bewundert noch das Tafelsilber.`,
      ({ thief }) => `Die Schupo kommt. ${thief} wollte nur noch ein Zimmer mitnehmen.`,
    ],
  },
  awards: {
    stickyFingers: {
      name: "Langfinger des Abends",
      citations: [
        ({ name, haul }) => `${name} trug ${deMoney(haul)} hinaus. Mutmaßlich.`,
        ({ name, haul }) => `${deMoney(haul)} und kein einziger Fingerabdruck. Respekt, ${name}.`,
      ],
    },
    longArm: {
      name: "Goldene Trillerpfeife",
      citations: [
        ({ name, holds, arrests }) => `${name}: ${deTimes(holds)} gestellt, ${deTimes(arrests)} festgenommen. Die Pfeife glüht noch.`,
        ({ name, holds, arrests }) => `${name} hat ${deTimes(holds + arrests)} zugepackt. Ordnung muss sein.`,
      ],
    },
    closeShave: {
      name: "Haarscharf",
      citations: [
        ({ name, paces: p }) => `${name} kam einer Wache bis auf ${dePaces(p)} nahe. Keiner hat’s gemerkt.`,
        ({ name, paces: p }) => `${name}, ${dePaces(p)} neben einer Melone, und nie gesehen.`,
      ],
    },
    tallTales: {
      name: "Seemannsgarn",
      citations: [
        ({ name, lies }) => `${name}: ${deCount(lies, "Meldung", "Meldungen", "e")}, und das Band sagt: stimmt nicht.`,
        ({ name, lies }) => `${name} hat ${deTimes(lies)} geflunkert. Mit fester Stimme.`,
      ],
    },
    lightsOut: {
      name: "Zappenduster",
      citations: [
        ({ name, lights }) => `${name} hat ${deTimes(lights)} das Licht ausgeknipst. Das Elektrizitätswerk dankt.`,
        ({ name, lights }) => `${name} knipste ${deTimes(lights)} aus. Die Dunkelheit sagt danke.`,
      ],
    },
  },
  roles: {
    thief: {
      name: "Langfinger",
      title: "HEUTE NACHT KLAUST DU",
      lines: [
        ({ spot, where }) => `Dein Fluchtwagen: ${spot}, ${where.in}. Nur du weißt es.`,
        () => "Schnapp dir, was du tragen kannst, bleib im Dunkeln und sei vor der Schupo zurück am Wagen.",
      ],
    },
    guard: {
      name: "Wache",
      title: "HEUTE NACHT HÄLTST DU WACHE",
      lines: [
        ({ where }) => `Du fängst ${where.in} an. Der Langfinger irgendwo im Dunkeln.`,
        () => "Anleuchten, antippen, festhalten; eine zweite Wache nimmt fest. Redet ruhig laut, der Langfinger hört eh mit.",
      ],
    },
  },
  buttons: {
    take: "Nehmen",
    pickLock: "Knacken",
    climb: "Klettern",
    lightsOn: "Licht an",
    lightsOff: "Licht aus",
    smashLamp: "Zerdeppern",
    tamper: "Sabotieren",
    stripTags: "Entwanzen",
    hold: "HALT!",
    flashlightOn: "Funzel an",
    flashlightOff: "Funzel aus",
    firecracker: "Knallfrosch",
    throw: "Wohin werfen?",
    wriggle: "Zappeln!",
    clear: "Sauber",
    seen: "Gesichtet",
    post: "Posten",
    look: "Hierher!",
    open: "Öffnen",
    close: "Schließen",
    cancel: "Abbrechen",
    ready: "Bereit",
    skip: "Vorspulen",
  },
  refusals: {
    tooFar: "Zu weit weg.",
    notInLight: "Nicht in deinem Licht.",
    lightOff: "Erst die Funzel an.",
    handsFull: "Die Hände sind voll.",
    notInSight: "Von hier nicht zu sehen.",
    cooldown: "Ruhig Blut … gleich.",
    noFirecrackers: "Keine Knallfrösche mehr.",
    held: "Festgehalten. Zappeln!",
    slippery: "Noch zu glitschig.",
    nothingHere: "Hier gibt’s nichts zu tun.",
    alreadyHeld: "Schon gestellt. Festnehmen!",
    busy: "Erst das eine, dann das andere.",
    blocked: "Da geht’s nicht durch.",
    holding: "Nicht mitten im Festhalten.",
  },
  ui: {
    catalogue: "Katalog",
    missing: "fehlt",
    held: "GESTELLT",
    haul: "Beute",
    tag: "GPS",
    marks: "Markierungen",
    tip: "Der Tipp",
    car: "Dein Wagen",
    tape: "DAS BAND",
    play: "WIEDERGABE",
    round: "Runde",
    total: "Gesamt",
    reward: "Belohnung",
    podium: "Die Reichsten",
  },
  names: (kind) => ((DE_ROOMS as Record<string, readonly DeName[]>)[kind] ?? DE_OUTSIDE[kind as OutsideKind]).map((x) => x.name),
  noun: deArea,
  dir: (x) => DE_DIR[x],
  money: deMoney,
};

/** Both languages' words. */
export const WORDS: Readonly<Record<Lang, Words>> = { en: EN, de: DE };

// ---------------------------------------------------------------------------
// The API: language-free parameters in, a line out.

/** A table's parameters as the game passes them: `where` an Area, `item` an Item, `dir` a Dir8. */
export type Pub<P> = { [K in keyof P]: K extends "where" ? Area : K extends "item" ? Item : K extends "dir" ? Dir8 : P[K] };

/** One of a list, by the rng (the last for an rng that returns 1). */
export function pick<T>(list: readonly T[], rng: Random): T {
  if (list.length === 0) throw new Error("pick from an empty list");
  return list[Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)))]!;
}

function resolve<P>(lang: Lang, p: object): P {
  const w = WORDS[lang];
  const out: Record<string, unknown> = { ...p };
  if ("where" in p) out.where = w.noun(p.where as Area);
  if ("item" in p) out.item = (p.item as Item).name[lang];
  if ("dir" in p) out.dir = w.dir(p.dir as Dir8);
  return out as P;
}

/** The words of a language (English for anything else). */
export function words(lang: Lang): Words {
  return WORDS[lang] ?? EN;
}

/** An estate by index (wraps): a round keeps the index, so the name follows the room's language. */
export function estate(lang: Lang, index: number): Estate {
  return wrap(words(lang).estates, index);
}

/** A place in words. */
export function noun(lang: Lang, area: Area): Noun {
  return words(lang).noun(area);
}

/** The blueprint label of a room (or outside area) of this kind and variant. */
export function placeLabel(lang: Lang, kind: RoomKind | OutsideKind, variant = 0): string {
  return wrap(words(lang).names(kind), variant);
}

/** A silent-film intertitle, in capitals. */
export function intertitle<K extends IntertitleKind>(lang: Lang, kind: K, p: IntertitleParams[K], rng: Random): string {
  return pick(words(lang).intertitles[kind] as readonly Template<IntertitleParams[K]>[], rng)(p);
}

/**
 * The thief's tip: the wing of one of the three most valuable items.
 * `wing` is map.ts's `{building, half}` (the house is named only when
 * `buildings`, the lot's count, is more than one) or a {@link Wing} with
 * an optional `building` (named when given).
 */
export function tip(lang: Lang, p: { item: Item; wing: Wing | HouseWing; building?: number; buildings?: number }, rng: Random): string {
  const w = p.wing;
  const area: Area =
    typeof w === "object"
      ? (p.buildings ?? 1) > 1
        ? { wing: w.half, building: w.building }
        : { wing: w.half }
      : p.building === undefined
        ? { wing: w }
        : { wing: w, building: p.building };
  const where = noun(lang, area);
  return pick(words(lang).tips, rng)({ item: p.item.name[lang], where });
}

/** A teletype fact for the ticker. */
export function fact<K extends FactKind>(lang: Lang, kind: K, p: Pub<FactParams[K]>, rng: Random): string {
  return pick(words(lang).facts[kind] as readonly Template<FactParams[K]>[], rng)(resolve(lang, p));
}

/** A guard's mark as a ticker claim, sometimes with a deadpan aside (only when it fits the ticker). */
export function claim<K extends ClaimKind>(lang: Lang, kind: K, p: Pub<ClaimParams[K]>, rng: Random): string {
  const w = words(lang);
  const line = pick(w.claims[kind] as readonly Template<ClaimParams[K]>[], rng)(resolve(lang, p));
  if (rng() >= ASIDE_CHANCE) return line;
  const withAside = `${line} ${pick(w.asides, rng)({ guard: p.guard })}`;
  return withAside.length <= TICKER_MAX ? withAside : line;
}

/** The outcome card: its title and one line. */
export function outcome<K extends OutcomeKind>(lang: Lang, kind: K, p: OutcomeParams[K], rng: Random): { title: string; sub: string } {
  const o = words(lang).outcomes[kind];
  return { title: o.title, sub: pick(o.subs as readonly Template<OutcomeParams[K]>[], rng)(p) };
}

/** A caption on the tape. */
export function caption<K extends CaptionKind>(lang: Lang, kind: K, p: Pub<CaptionParams[K]>, rng: Random): string {
  return pick(words(lang).captions[kind] as readonly Template<CaptionParams[K]>[], rng)(resolve(lang, p));
}

/** An award: its name and a citation. */
export function award<K extends AwardId>(lang: Lang, id: K, p: AwardParams[K], rng: Random): { name: string; citation: string } {
  const a = words(lang).awards[id];
  return { name: a.name, citation: pick(a.citations as readonly Template<AwardParams[K]>[], rng)(p) };
}

/** The role reveal on the phone. */
export function roleCard<K extends Role>(lang: Lang, role: K, p: Pub<RoleParams[K]>): { name: string; title: string; lines: string[] } {
  const r = words(lang).roles[role];
  const q = resolve<RoleParams[K]>(lang, p);
  return { name: r.name, title: r.title, lines: (r.lines as readonly Template<RoleParams[K]>[]).map((l) => l(q)) };
}

/** Dollars: "$12,500", "12.500 $". */
export function money(lang: Lang, dollars: number): string {
  return words(lang).money(dollars);
}

/** An item's name. */
export function itemName(lang: Lang, item: Item): string {
  return item.name[lang];
}

/** An item's catalogue note, or "". */
export function itemNote(lang: Lang, item: Item): string {
  return item.note?.[lang] ?? "";
}
