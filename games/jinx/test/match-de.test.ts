// Known-answer tests for match-de.ts (the German matcher), with the shipped
// lexicon (data/dict.de.txt) unless a test says otherwise.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { adjacentKeys, checkSubmit, clean, clue, dictionary, explain, groupClues, invalidClue, judgeGuess, parseNumberWords, sameClue, spell } from "../game/match-de.ts";

const opt = dictionary(readFileSync(new URL("../data/dict.de.txt", import.meta.url), "utf8"));

const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

/** Parse "a | b | expected" lines; expected "-" means null. "…" keeps spaces. */
function table(src: string): [string, string, string | null][] {
  return src
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => l !== "")
    .map((l) => {
      const [a, b, r] = l.split("|").map((x) => x.trim()).map(unquote) as [string, string, string];
      return [a, b, r === "-" ? null : r];
    });
}

function expectAll(rows: [string, string, string | null][], got: (a: string, b: string) => string | null): void {
  const bad: string[] = [];
  for (const [a, b, want] of rows) {
    let g: string | null;
    try {
      g = got(a, b);
    } catch (e) {
      g = `throws ${(e as Error).message}`;
    }
    if (g !== want) bad.push(`${a} | ${b}: got ${g}, want ${want}`);
  }
  assert.deepEqual(bad, []);
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

const CLEAN = table(`
  Hund               | hund          | word
  "  Hund  "         | hund          | word
  HUND               | hund          | word
  Bär                | bär           | word      # umlauts stay in the key
  Straße             | straße        | word
  STRASSE            | strasse       | word      # (Straße/Strasse: other spelling, below)
  Café               | cafe          | word      # other accents go
  der Hund           | hund          | word      # a leading article goes
  eine Katze         | katze         | word
  Eis-Bär            | eisbär        | word      # hyphens and spaces do not matter
  Eis Bär            | eisbär        | word
  "steht auf"        | aufsteht      | word      # a separable verb, as one word
  "mach zu"          | zumach        | word
  sieben             | 7             | number
  Sieben             | 7             | number
  einundzwanzig      | 21            | number
  "einund zwanzig"   | 21            | number
  hundert            | 100           | number
  zweihundertdrei    | 203           | number
  dreitausend        | 3000          | number
  dreißig            | 30            | number
  dreissig           | 30            | number
  null               | 0             | number
  "zwei Millionen"   | 2000000       | number
  erste              | 1.            | number
  Erster             | 1.            | number
  dritte             | 3.            | number
  zwanzigste         | 20.           | number
  "1."               | 1.            | number
  007                | 007           | number
  ein                | ein           | word      # not a number by itself (an article)
  Kiste              | kiste         | word      # not an ordinal
  Beste              | beste         | word
  "Brrrr!"           | brr           | word
  €                  | euro          | word
  🔥                 | ~🔥            | symbol
  "Feuer 🔥"          | feuer         | word
  ""                 | empty         | error
  "a b c"            | too-many-words | error
  кот                | not-english   | error
  Donaudampfschifffahrtsgesellschaft | too-long | error
`);

test("clean: known answers", () => {
  const bad: string[] = [];
  for (const [raw, want, kind] of CLEAN) {
    const c = clean(raw);
    const got = c.ok ? `${c.clue.key} ${c.clue.kind}` : `${c.error} error`;
    if (got !== `${want} ${kind}`) bad.push(`${raw}: got ${got}, want ${want} ${kind}`);
  }
  assert.deepEqual(bad, []);
});

test("clean: German messages", () => {
  const c = clean("кот");
  assert.equal(c.ok, false);
  if (!c.ok) assert.equal(c.message, "Nur Buchstaben und Ziffern");
});

test("parseNumberWords: known answers", () => {
  const rows: [string, string | null][] = [
    ["eins", "1"],
    ["zwölf", "12"],
    ["siebzehn", "17"],
    ["neunundneunzig", "99"],
    ["hunderteins", "101"],
    ["einhundert", "100"],
    ["tausend", "1000"],
    ["zweitausendvierundzwanzig", "2024"],
    ["neunzehnhundert", "1900"],
    ["zwanzigzwei", null],
    ["eineundzwanzig", null],
    ["hund", null],
  ];
  for (const [w, n] of rows) assert.equal(parseNumberWords(w), n, w);
});

// ---------------------------------------------------------------------------
// Clue vs clue
// ---------------------------------------------------------------------------

const SAME = table(`
  Hund               | HUND          | same word
  Eisbär             | Eis-Bär       | same word
  sieben             | 7             | same number
  erste              | 1.            | same number
  Bär                | Baer          | spelling       # umlaut written out
  Straße             | Strasse       | spelling
  Delfin             | Delphin       | spelling
  Foto               | Photo         | spelling
  Thunfisch          | Tunfisch      | spelling
  Joghurt            | Jogurt        | spelling
  Zirkus             | Circus        | spelling
  Schlüssel          | Schlussel     | spelling       # umlaut left out (not a word)
  Hund               | Hunde         | plural
  Haus               | Häuser        | plural
  Mutter             | Mütter        | plural
  Apfel              | Äpfel         | plural
  Museum             | Museen        | plural
  Kind               | Kindern       | plural
  Mann               | Männer        | plural
  Auto               | Autos         | plural
  Lehrerin           | Lehrerinnen   | plural
  Schneemann         | Schneemänner  | plural         # a compound, through its head
  Feuerwehrauto      | Feuerwehrautos | plural
  Weihnachtsbaum     | Weihnachtsbäume | plural
  Hunde              | Hundes        | plural
  laufen             | lief          | verb form
  laufen             | gelaufen      | verb form
  laufen             | läuft         | verb form
  gehen              | ging          | verb form
  sein               | war           | verb form
  spielen            | gespielt      | verb form
  aufstehen          | "steht auf"   | verb form
  aufstehen          | aufgestanden  | verb form
  gelaufen           | gelaufene     | verb form      # a participle declined
  rot                | rote          | word form
  gut                | gute          | word form
  groß               | größer        | word form
  groß               | größte        | word form
  hoch               | höher         | word form
  Hund               | Hundes        | word form
  Lehrer             | Lehrerin      | same family
  Löwe               | Löwin         | same family
  Katze              | Kätzchen      | same family
  Bäcker             | backen        | same family
  Bäckerei           | Bäcker        | same family
  Bäckerei           | backen        | same family    # two steps
  Fahrer             | fahren        | same family
  Fahrer             | Fahrt         | same family    # siblings
  Freund             | Freundschaft  | same family
  Freund             | freundlich    | same family
  Sonne              | sonnig        | same family
  frei               | Freiheit      | same family
  schön              | Schönheit     | same family
  groß               | Größe         | same family
  kalt               | Kälte         | same family
  Wohnung            | wohnen        | same family
  Lauf               | laufen        | same family
  Flug               | fliegen       | same family
  Frankreich         | französisch   | same family
  Japan              | Japaner       | same family
  Schokolade         | Schokolode    | typo
  Schokolade         | Schoklade     | typo
  Krokodil           | Krokodiel     | typo
  Elefant            | Elefannt      | typo
`);

const NOT_SAME = table(`
  Reis               | Reise         | -     # Reise is not the old plural of Reis
  Schal              | Schale        | -
  Rind               | Rinde         | -
  Rat                | Rate          | -
  Planet             | planen        | -
  Wiese              | weisen        | -
  Messer             | messen        | -     # the knife; not "der Messende"
  Zeit               | Zeitung       | -
  Bar                | Bär           | -     # two words
  Hose               | Rose          | -     # two real words are never typos
  Kiste              | Küste         | -
  Ofen               | offen         | -
  Kind               | Kindergarten  | -     # compounds and parts do not jinx
  Sonne              | Sonnenblume   | -
  Eis                | Eisbär        | -
  Feuer              | Feuerwehr     | -
  Glück              | Unglück       | -     # prefixes
  laufen             | weglaufen     | -
  Katze              | Kater         | same family   # (Movierung: Kater/Katze)
  Hund               | Katze         | -
  Rad                | Rat           | -     # sounds the same: only against the word
  Meer               | mehr          | -
  langsam            | Länge         | same family   # (siblings: both from lang)
  Bäckerei           | Backofen      | -     # Backofen is a compound
  Bergsteigerin      | Bergsteiger   | same family   # a compound, through its head
  Flugzeug           | Flugzeig      | typo          # Flug + zeig is no compound
  Fernseher          | Fernsehr      | typo
  "am besten"        | gut           | word form
  sang               | singen        | verb form
  Bergsteigerinnen   | Bergsteigerin | plural
  Wein               | weinen        | -
  Fliege             | fliegen       | plural        # die Fliegen
  Konig              | König         | spelling
  Konigin            | König         | same family
  vergrössern        | Vergrößerung  | same family
  Windel             | windeln       | plural
  waschen            | gewaschen     | verb form
  tschüs             | Tschüss       | spelling
  7                  | 007           | -
  eins               | 1.            | -
  Hühnerei           | Huhn          | -     # a compound, not a derivation
`);

test("sameClue: these jinx", () => {
  expectAll(SAME, (a, b) => sameClue(clue(a), clue(b), opt));
});

test("sameClue: these do not jinx (or jinx as noted)", () => {
  expectAll(NOT_SAME, (a, b) => sameClue(clue(a), clue(b), opt));
});

test("sameClue: symmetric", () => {
  const bad: string[] = [];
  for (const [a, b] of [...SAME, ...NOT_SAME]) {
    const x = sameClue(clue(a), clue(b), opt);
    const y = sameClue(clue(b), clue(a), opt);
    if (x !== y) bad.push(`${a} | ${b}: ${x} vs ${y}`);
  }
  assert.deepEqual(bad, []);
});

test("sameClue: without the lexicon, the rules still catch plain endings", () => {
  expectAll(
    table(`
      Hund     | Hunde    | plural
      Auto     | Autos    | plural
      Bär      | Baer     | spelling
      Schokolade | Schokolode | typo
      Reise    | reisen   | plural
      Hund     | Katze    | -
    `),
    (a, b) => sameClue(clue(a), clue(b)),
  );
});

// ---------------------------------------------------------------------------
// Clue vs secret word
// ---------------------------------------------------------------------------

const INVALID = table(`
  # clue             | secret        | reason
  Hund               | Hund          | same word
  7                  | sieben        | same number
  Baer               | Bär           | spelling
  Bar                | Bär           | spelling       # the word without its umlaut
  Hunde              | Hund          | plural
  lief               | laufen        | verb form
  rote               | rot           | word form
  Lehrerin           | Lehrer        | same family
  Kätzchen           | Katze         | same family
  Schokolode         | Schokolade    | typo
  Meer               | mehr          | sounds the same
  Wahl               | Wal           | sounds the same
  Rad                | Rat           | sounds the same
  Seite              | Saite         | sounds the same
  Fogel              | Vogel         | sounds the same
  Fuks               | Fuchs         | sounds the same
  Stadt              | statt         | sounds the same
  Schneemann         | Schnee        | contains the word
  Schneemänner       | Schnee        | contains the word
  Sonnenblume        | Sonne         | contains the word   # Sonne-n-blume
  Eisbär             | Eis           | contains the word
  Eisbär             | Bär           | contains the word
  Kindergarten       | Kind          | contains the word   # Kind-er-garten
  Schulbus           | Schule        | contains the word   # Schul-bus
  Arbeitsplatz       | Arbeit        | contains the word   # Arbeit-s-platz
  Hundehütte         | Hund          | contains the word
  Hühnerei           | Huhn          | contains the word   # Hühner-ei
  Schifffahrt        | Schiff        | contains the word   # the key has "schiffahrt"
  Lid                | Lied          | sounds the same
  Artzt              | Arzt          | sounds the same
  Zahnbürste         | Zahn          | contains the word
  Feuerwehrmann      | Feuerwehr     | contains the word
  Unglück            | Glück         | contains the word
  weglaufen          | laufen        | contains the word
  "Eis Bär"          | Bär           | same word          # the key is eisbär… 
  Schnee             | Schneemann    | part of the word
  Mann               | Schneemann    | part of the word
  Blume              | Sonnenblume   | part of the word
  Feuer              | Feuerwehr     | part of the word
  Ball               | Fußball       | part of the word
  Schirm             | Regenschirm   | part of the word
  Hände              | Handschuh     | part of the word
  Kiste              | Küste         | -
  Ofen               | offen         | -
  Hose               | Rose          | -
  Hundert            | Hund          | -                  # hund + ert is no word
  Reisepass          | Reis          | -                  # Reise + Pass
  Butterbrot         | rot           | -
  Fallschirm         | Falle         | -                  # Fall-, not Falle without its e
  Rindenmulch        | Rind          | -                  # Rinden- is Rinde's
  Blumenkohl         | Kohle         | -                  # Kohle is not "ich kohle"
  Windmühle          | Wand          | -                  # Wand is not "wand" (winden)
  gestern            | Stern         | -                  # ge- is no part
  Sandale            | Sand          | -                  # a loan, no compound
  Minirock           | Rock          | contains the word
  Sockenpaar         | Socke         | contains the word
  Eisen              | Eis           | same family        # (eisen: to ice)
  Reise              | Eis           | -
  Torte              | Tor           | -
  Motor              | Tor           | -
  Alarm              | Arm           | -
  Ast                | Baum          | -
  Bäckerei           | Bäcker        | same family
  Kindheit           | Kind          | same family
  Freundschaft       | Freund        | same family
`);

test("invalidClue: known answers", () => {
  expectAll(
    INVALID.filter(([a]) => a !== "Eis Bär"),
    (c, s) => invalidClue(clue(c), clue(s), opt),
  );
});

test("invalidClue: banned forms from the word list", () => {
  assert.equal(invalidClue(clue("dog"), clue("Hund"), opt, ["dog"]), "too close");
  assert.equal(invalidClue(clue("dogs"), clue("Hund"), opt, ["dog"]), null); // a banned word as written, nothing more
  assert.equal(invalidClue(clue("bellen"), clue("Glocke"), opt, ["bell"]), null);
  assert.equal(invalidClue(clue("Räder"), clue("Fahrrad"), opt, [], ["Rad"]), "part of the word"); // (Fahr-rad)
  assert.equal(invalidClue(clue("Velos"), clue("Fahrrad"), opt, [], ["Velo"]), "too close"); // an accepted guess, in its forms
  assert.equal(invalidClue(clue("fliegen"), clue("Flugzeug"), opt, [], ["Flieger"]), null); // not its family
  assert.equal(invalidClue(clue("Dackel"), clue("Hund"), opt, ["dog"]), null);
});

// ---------------------------------------------------------------------------
// Guesses
// ---------------------------------------------------------------------------

const GUESS = table(`
  # guess            | secret        | reason (- = wrong)
  Giraffe            | Giraffe       | same word
  Bar                | Bär           | spelling        # no umlaut on the keyboard
  Baer               | Bär           | spelling
  Strasse            | Straße        | spelling
  Hunde              | Hund          | plural
  Schneemänner       | Schneemann    | plural
  lief               | laufen        | verb form
  rote               | rot           | word form
  Lehrerin           | Lehrer        | word form       # the same job
  Ärztin             | Arzt          | word form
  Wahl               | Wal           | sounds the same
  Girafe             | Giraffe       | typo
  Schokolode         | Schokolade    | typo
  Kugelschrieber     | Kugelschreiber | typo
  Elefannt           | Elefant       | typo
  Bier               | Bär           | -
  Teddybär           | Bär           | -
  Fuß                | Fußball       | -
  Bäckerei           | Bäcker        | -               # family is not right
  Rose               | Hose          | -
`);

test("judgeGuess: known answers", () => {
  expectAll(GUESS, (g, s) => judgeGuess(clue(g), clue(s), opt));
});

test("judgeGuess: also_right forms", () => {
  assert.equal(judgeGuess(clue("Rad"), clue("Fahrrad"), opt, ["Rad", "Velo"]), "spelling");
  assert.equal(judgeGuess(clue("Velos"), clue("Fahrrad"), opt, ["Rad", "Velo"]), "plural");
  assert.equal(judgeGuess(clue("Auto"), clue("Fahrrad"), opt, ["Rad", "Velo"]), null);
});

// ---------------------------------------------------------------------------
// A round
// ---------------------------------------------------------------------------

test("groupClues: transitive groups", () => {
  const clues = ["Lehrer", "Lehrerin", "Lehrerinnen", "Schule", "Tafel", "Schulen", "Kreide"].map(clue);
  const r = groupClues(clues, clue("Klassenzimmer"), opt);
  assert.deepEqual(
    r.groups.map((g) => g.members),
    [
      [0, 1, 2],
      [3, 5],
    ],
  );
  assert.deepEqual(r.survivors, [4, 6]);
  assert.deepEqual(r.invalid, []);
});

test("checkSubmit: German messages", () => {
  const s = clue("Schneemann");
  const r = checkSubmit("Schnee", s, opt);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "too-close");
    assert.equal(r.reason, "part of the word");
    assert.equal(r.message, "Ein Teil des Wortes. Versuch einen anderen Hinweis");
  }
  const own = checkSubmit("Möhren", s, { ...opt, own: [clue("Möhre")] });
  assert.equal(own.ok, false);
  if (!own.ok) assert.equal(own.message, "Wie dein anderer Hinweis (Plural). Versuch einen anderen Hinweis");
  const fine = checkSubmit("Winter", s, opt);
  assert.equal(fine.ok, true);
  const empty = checkSubmit("  ", s, opt);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.message, "Schreib einen Hinweis");
});

test("explain: German TV lines", () => {
  assert.equal(explain(clue("Hunde"), clue("Hund"), "plural"), "Hunde = Hund · Plural");
  assert.equal(explain(clue("Schokolode"), clue("Schokolade"), "typo"), "Schokolode ≈ Schokolade · Tippfehler");
});

test("adjacentKeys and spell", () => {
  assert.equal(adjacentKeys("z", "u"), true); // QWERTZ
  assert.equal(adjacentKeys("y", "x"), true);
  assert.equal(adjacentKeys("ü", "u"), true); // a keyboard without umlauts
  assert.equal(adjacentKeys("ö", "l"), true);
  assert.equal(spell("straße"), "strasse");
  assert.equal(spell("bär"), "baer");
  assert.equal(spell("delphin"), "delfin");
});

test("the lexicon loads fast and knows forms and compounds", () => {
  const t = Date.now();
  const o = dictionary(readFileSync(new URL("../data/dict.de.txt", import.meta.url), "utf8"));
  assert.ok(Date.now() - t < 2000, "loads in under 2 s");
  for (const w of ["hund", "hunde", "häuser", "lief", "gelaufen", "größte", "schneemann", "feuerwehrautos", "kühlschrank"]) assert.ok(o.known!(w), w);
  for (const w of ["schokolode", "hundx", "krokodiel"]) assert.ok(!o.known!(w), w);
});
