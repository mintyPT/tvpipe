// Known-answer tests for match.ts. Run: node --test match.test.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  adjacentKeys,
  checkSubmit,
  clean,
  dictionary,
  clue,
  explain,
  groupClues,
  invalidClue,
  judgeGuess,
  parseNumberWords,
  parseWordList,
  sameClue,
  spellNorm,
  typoCost,
} from "../game/match.ts";

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

/** Run every row, then fail once with all mismatches (easier to read than the first one). */
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
// Cleaning: raw input -> key (or error)
// ---------------------------------------------------------------------------

const CLEAN = table(`
  cat                | cat           | word
  "  Cat  "          | cat           | word      # trimmed
  CAT                | cat           | word
  Café               | cafe          | word
  naïve              | naive         | word
  Straße             | strasse       | word
  Encyclopædia       | encyclopaedia | word
  ice cream          | icecream      | word
  ice-cream          | icecream      | word
  Ice–Cream          | icecream      | word      # en dash
  icecream           | icecream      | word
  merry-go-round     | merrygoround  | word      # hyphens do not count as words
  AC/DC              | acdc          | word
  Mr. Bean           | mrbean        | word
  U.S.A.             | usa           | word
  rock'n'roll        | rocknroll     | word
  don’t              | dont          | word      # curly apostrophe
  Bang!              | bang          | word
  Riiiiiinnng        | riinng        | word      # runs of 3+ become 2
  hmmm               | hmm           | word
  007                | 007           | number
  7                  | 7             | number
  seven              | 7             | number
  Seventeen          | 17            | number
  twenty-one         | 21            | number
  twenty one         | 21            | number
  one hundred        | 100           | number
  thousand           | 1000          | number
  first              | 1st           | number
  1st                | 1st           | number
  second             | second        | word      # also a unit of time
  R2-D2              | r2d2          | word
  seven dwarfs       | 7dwarfs       | word
  a cat              | cat           | word      # leading article dropped
  The Beatles        | beatles       | word
  to run             | run           | word
  the end            | end           | word
  a                  | a             | word
  fire 🔥            | fire          | word      # emoji decorate, the word counts
  🔥                 | ~🔥           | symbol
  👍🏽                 | ~👍           | symbol    # skin tone dropped
  $                  | dollar        | word
  &                  | and           | word
  ｃａｔ             | cat           | word      # full-width (NFKC)
  ﬁsh                | fish          | word      # ligature (NFKC)
  "   "              | empty         | error
  !!!                | empty         | error
  a b c              | too-many-words | error
  New York City      | too-many-words | error
  кот                | not-english   | error
  猫                 | not-english   | error
  supercalifragilisticexpialidocious | too-long | error
`);

test("clean: known answers", () => {
  const bad: string[] = [];
  for (const [raw, want, kind] of CLEAN) {
    const c = clean(raw);
    const got = c.ok ? `${c.clue.key} ${c.clue.kind}` : `${c.error} error`;
    if (got !== `${want} ${kind}`) bad.push(`${JSON.stringify(raw)}: got ${got}, want ${want} ${kind}`);
  }
  assert.deepEqual(bad, []);
});

test("explain: TV lines", () => {
  assert.equal(explain(clue("Cats"), clue("cat"), "plural"), "Cats = cat · plural");
  assert.equal(explain(clue("elefant"), clue("elephant"), "spelling"), "elefant ≈ elephant · other spelling");
  assert.equal(explain(clue("snowman"), clue("snow"), "contains the word"), "snowman ⊃ snow · contains the word");
});

test("clean: display keeps the typed form, trimmed", () => {
  const c = clue("  Ice   Cream ");
  assert.equal(c.display, "Ice Cream");
  assert.deepEqual(c.parts, ["ice", "cream"]);
});

// ---------------------------------------------------------------------------
// Clue vs clue: these jinx
// ---------------------------------------------------------------------------

const SAME = table(`
  # exact after cleaning
  cat          | cat          | same word
  Cat          | CAT          | same word
  café         | cafe         | same word
  ice cream    | icecream     | same word
  ice-cream    | Ice Cream    | same word
  rock'n'roll  | rock-n-roll  | same word
  Bang!        | bang         | same word
  hmmm         | hmmmmm       | same word
  007          | 007          | same word
  🔥           | 🔥           | same word
  # numbers
  7            | seven        | same number
  21           | twenty-one   | same number
  100          | one hundred  | same number
  1st          | first        | same number
  # spelling (UK/US, ph/f)
  colour       | color        | spelling
  colours      | colors       | spelling
  favourite    | favorite     | spelling
  neighbour    | neighbor     | spelling
  centre       | center       | spelling
  theatre      | theater      | spelling
  metres       | meters       | spelling
  organise     | organize     | spelling
  organisation | organization | spelling
  analyse      | analyze      | spelling
  catalogue    | catalog      | spelling
  grey         | gray         | spelling
  tyre         | tire         | spelling
  aluminium    | aluminum     | spelling
  pyjamas      | pajamas      | spelling
  moustache    | mustache     | spelling
  doughnut     | donut        | spelling
  jewellery    | jewelry      | spelling
  aeroplane    | airplane     | spelling
  mum          | mom          | spelling
  elephant     | elefant      | spelling
  telephone    | telefone     | spelling
  defence      | defense      | spelling
  # plurals
  cat          | cats         | plural
  horse        | horses       | plural
  glass        | glasses      | plural
  box          | boxes        | plural
  bus          | buses        | plural
  church       | churches     | plural
  hero         | heroes       | plural
  potato       | potatoes     | plural
  city         | cities       | plural
  cookie       | cookies      | plural
  pie          | pies         | plural
  wolf         | wolves       | plural
  knife        | knives       | plural
  leaf         | leaves       | plural
  glove        | gloves       | plural
  quiz         | quizzes      | plural
  crisis       | crises       | plural
  mouse        | mice         | plural
  child        | children     | plural
  tooth        | teeth        | plural
  foot         | feet         | plural
  goose        | geese        | plural
  person       | people       | plural
  cactus       | cacti        | plural
  snowman      | snowmen      | plural
  grandchild   | grandchildren| plural
  menu         | menus        | plural
  virus        | viruses      | plural
  ice cream    | ice creams   | plural
  dog's        | dog          | plural      # possessive reads as plural
  colours      | color        | plural      # spelling + plural
  # verb forms
  run          | running      | verb form
  run          | ran          | verb form
  running      | runs         | verb form
  hope         | hoping       | verb form
  hope         | hoped        | verb form
  hop          | hopping      | verb form
  hop          | hopped       | verb form
  dance        | dancing      | verb form
  dance        | danced       | verb form
  cry          | cried        | verb form
  tie          | tied         | verb form
  die          | dying        | verb form
  agree        | agreed       | verb form
  travel       | travelled    | verb form
  travelled    | traveled     | verb form
  swim         | swam         | verb form
  fly          | flew         | verb form
  eat          | eaten        | verb form
  go           | went         | verb form
  sing         | sang         | verb form
  write        | written      | verb form
  build        | building     | verb form
  begin        | beginning    | verb form
  create       | created      | verb form
  ski          | skiing       | verb form
  # same family
  prince       | princess     | same family
  actor        | actress      | same family
  lion         | lioness      | same family
  god          | goddess      | same family
  teach        | teacher      | same family
  teacher      | teaching     | same family
  teachers     | teach        | same family
  bake         | baker        | same family
  run          | runner       | same family
  big          | bigger       | same family
  big          | biggest      | same family
  happy        | happier      | same family
  happy        | happiness    | same family
  good         | better       | same family
  dark         | darkness     | same family
  quick        | quickly      | same family
  gentle       | gently       | same family
  sun          | sunny        | same family
  rain         | rainy        | same family
  ice          | icy          | same family
  shine        | shiny        | same family
  help         | helpful      | same family
  care         | careless     | same family
  care         | carefully    | same family
  child        | childish     | same family
  child        | childhood    | same family
  art          | artist       | same family
  cycle        | cyclist      | same family
  piano        | pianist      | same family
  japan        | japanese     | same family
  china        | chinese      | same family
  italy        | italian      | same family
  canada       | canadian     | same family
  america      | american     | same family
  music        | musician     | same family
  magic        | magician     | same family
  music        | musical      | same family
  france       | french       | same family
  act          | action       | same family
  invent       | invention    | same family
  inventor     | invention    | same family
  create       | creation     | same family
  inform       | information  | same family
  pay          | payment      | same family
  friend       | friendship   | same family
  king         | kingdom      | same family
  free         | freedom      | same family
  wash         | washable     | same family
  danger       | dangerous    | same family
  fame         | famous       | same family
  gold         | golden       | same family
  wood         | wooden       | same family
  chick        | chicken      | same family
  athlete      | athletic     | same family
  history      | historic     | same family
  biology      | biologist    | same family
  long         | length       | same family
  deep         | depth        | same family
  volcano      | volcanic     | same family
  # typos
  chocolate    | choclate     | typo
  chocolate    | chocolaet    | typo        # swapped letters
  banana       | banaan       | typo
  rhythm       | rythm        | typo        # extra key next to its neighbour
  shirt        | shurt        | typo        # neighbouring key
  pizza        | pizzs        | typo
  giraffe      | giraffee     | typo        # extra letter next to its double
  broccoli     | brocoli      | typo        # doubled letter, long word
  dinosaur     | dinosuar     | typo
  dinosaur     | dinosuars    | typo        # typo + plural
  elephant     | elephnat     | typo
  strawberry   | strawbery    | same family # both reach "strawber" (-y); the reason reads oddly
  hamburger    | hamburgre    | spelling    # through the -re/-er rule
  hamburger    | hamburher    | typo
  necessary    | neccessary   | typo
  # transitivity helpers
  teach        | teachers     | same family
`);

test("sameClue: these jinx", () => {
  expectAll(SAME, (a, b) => sameClue(clue(a), clue(b)));
  expectAll(SAME, (a, b) => sameClue(clue(b), clue(a)));
});

// ---------------------------------------------------------------------------
// Clue vs clue: these must NOT jinx
// ---------------------------------------------------------------------------

const DIFFERENT = table(`
  car          | care         | -
  car          | cared        | -
  care         | career       | -
  cat          | cut          | -
  cat          | catch        | -
  news         | new          | -
  hop          | hope         | -
  hoped        | hopped       | -
  plan         | plane        | -
  planed       | planned      | -
  filed        | filled       | -
  diner        | dinner       | -        # both are words
  later        | latter       | -
  desert       | dessert      | -
  super        | supper       | -
  comma        | coma         | -
  bear         | beer         | -
  house        | horse        | -
  house        | mouse        | -
  night        | light        | -
  night        | knight       | -        # homophones are different clues
  flower       | flour        | -
  fight        | right        | -        # first letter differs
  bread        | break        | -
  beach        | bench        | -
  train        | brain        | -
  plant        | planet       | -
  monkey       | money        | -
  scream       | cream        | -
  flight       | light        | -
  tablet       | table        | -
  stable       | table        | -
  pirate       | private      | -
  united       | unit         | -
  evening      | even         | -
  herring      | her          | -
  earring      | ear          | -
  ring         | rings        | plural   # (sanity: ring does inflect)
  corner       | corn         | -
  mother       | moth         | -
  brother      | broth        | -
  flower       | flow         | -
  shower       | show         | -
  letter       | let          | -
  number       | numb         | -
  manner       | man          | -
  hammer       | ham          | -
  summer       | sum          | -
  water        | wat          | -
  liver        | live         | -
  cover        | cove         | -
  power        | pow          | -
  party        | part         | -
  army         | arm          | -
  belly        | bell         | -
  carry        | car          | -
  penny        | pen          | -
  bunny        | bun          | -
  every        | ever         | -
  fairy        | fair         | -
  ready        | read         | -
  story        | store        | -
  gravy        | grave        | -
  city         | cite         | -
  irony        | iron         | -
  early        | ear          | -
  apply        | apple        | -
  finish       | fine         | -
  final        | fine         | -
  sandal       | sand         | -
  animal       | anime        | -
  universe     | university   | -
  organ        | organization | -
  question     | quest        | -
  mission      | miss         | -
  station      | state        | -
  pigment      | pig          | -
  listen       | list         | -
  kitten       | kit          | -
  wallet       | wall         | -
  ballet       | ball         | -
  island       | land         | -
  carpet       | car          | -        # compounds are not jinxes between clues
  firetruck    | fire         | -
  sandcastle   | quicksand    | -
  happy        | unhappy      | -
  seven        | sevens       | -        # number vs word
  7            | 007          | -
  1            | won          | -
  cat          | 🐱           | -
  saw          | see          | -
  left         | leave        | -
  felt         | feel         | -
  rose         | rise         | -
  giraffe      | girafe       | -        # doubled letter in a short word: too many real pairs
  dinosaur     | dinasour     | -        # phonetic misspelling, two substitutions
  # known weak spots without a dictionary: real words one key apart
  trial        | trail        | typo
  string       | sting        | typo
  shirt        | short        | typo
  clock        | click        | typo
`);

test("sameClue: these do not jinx (or jinx as noted)", () => {
  expectAll(DIFFERENT, (a, b) => sameClue(clue(a), clue(b)));
  expectAll(DIFFERENT, (a, b) => sameClue(clue(b), clue(a)));
});

// ---------------------------------------------------------------------------
// With a dictionary: two known words are never typos of each other
// ---------------------------------------------------------------------------

test("sameClue: dictionary blocks typos between real words", () => {
  const words = new Set(["trial", "trail", "angel", "angle", "butter", "dinner", "diner", "united", "untied"]);
  const known = (w: string) => words.has(w);
  assert.equal(sameClue(clue("trial"), clue("trail"), { known }), null);
  assert.equal(sameClue(clue("angel"), clue("angle"), { known }), null);
  assert.equal(sameClue(clue("united"), clue("untied"), { known }), null);
  assert.equal(sameClue(clue("butter"), clue("buter"), { known }), "typo"); // short word, doubled letter
  assert.equal(sameClue(clue("butter"), clue("buter")), null); // without the dictionary: too risky
  assert.equal(sameClue(clue("dinner"), clue("diner"), { known }), null);
});

// Cheats: a word stretched or written backwards to slip past the jinx, and
// two-word clues that repeat another card's word.
test("disguises: stretched, backwards, a shared word", () => {
  const words = new Set(["dog", "dogs", "car", "black", "star", "rats", "diner", "dinner", "tire", "wheel", "stop", "pots", "spot"]);
  const known = (w: string) => words.has(w);
  const rows = table(`
    # a          | b         | jinx / for the secret b
    doog         | dog       | spelling
    DDOOGG       | dog       | spelling
    carr         | car       | spelling
    dogss        | dogs      | spelling
    kcalb        | black     | backwards
    erit         | tire      | backwards
    sgod         | dog       | -                # no forms backwards
    god          | dog       | -                # 4+ letters backwards
    doggs        | dog       | -                # no forms of a stretched word
    blak         | black     | -                # only doubled, never undoubled (a typo rule's business)
    rats         | star      | -                # two words of their own
    diner        | dinner    | -
    stop         | pots      | -
  `);
  expectAll(rows, (a, b) => sameClue(clue(a), clue(b), { known }));
  expectAll(rows, (a, b) => sameClue(clue(b), clue(a), { known }));
  expectAll(rows, (a, b) => invalidClue(clue(a), clue(b), { known }));
  // Without the dictionary the disguise rules are off.
  assert.equal(sameClue(clue("doog"), clue("dog")), null);
  expectAll(
    table(`
      "black car"  | black       | contains the word
      "black car"  | "car black" | same word
      "black car"  | "black cars"| plural           # the whole clue in the plural
      "black cars" | cars        | contains the word
      "donut shape"| "black car" | -
      firetruck    | fire        | -                # closed compounds still do not jinx
      "fire truck" | firetruck   | same word
    `),
    (a, b) => sameClue(clue(a), clue(b), { known }),
  );
  const r = checkSubmit("kcalb", clue("black"), { known });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.message, "That's the word backwards. Try another clue");
});

test("clean: words that are names of object properties", () => {
  for (const w of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const c = clean(w);
    assert.equal(c.ok, true, w);
    if (c.ok) {
      assert.equal(typeof c.clue.key, "string");
      sameClue(c.clue, clue("dog"));
      invalidClue(c.clue, clue("dog"));
      judgeGuess(c.clue, clue("dog"));
    }
  }
});

// ---------------------------------------------------------------------------
// Clue vs secret word: invalid clues
// ---------------------------------------------------------------------------

const INVALID = table(`
  # secret     | clue          | reason
  shirt        | shirt         | same word
  shirt        | SHIRT!        | same word
  shirt        | shirts        | plural
  shirt        | shurt         | typo
  shirt        | t-shirt       | contains the word
  shirt        | tshirt        | -          # closed compound with a 1-letter rest
  prince       | princess      | same family
  weather      | whether       | sounds the same
  night        | knight        | sounds the same
  night        | nite          | -          # weak spot: sound-alike spelling
  cat          | kat           | sounds the same
  car          | kar           | sounds the same
  phone        | fone          | spelling
  colour       | color         | spelling
  seven        | 7             | same number
  mouse        | mice          | plural
  run          | ran           | verb form
  teach        | teacher       | same family
  sun          | sunny         | same family
  sun          | sunflower     | contains the word
  sun          | sunday        | contains the word
  sun          | sunshine      | contains the word
  snow         | snowman       | contains the word
  snow         | snowmen       | contains the word
  ball         | football      | contains the word
  ball         | ball game     | contains the word
  dog          | hot dog       | contains the word
  dog          | hotdog        | contains the word
  dog          | hot dogs      | contains the word
  dog          | hotdogs       | contains the word
  sun          | sundays       | contains the word
  cat          | catching      | -          # read as catch + ing
  bed          | climbed       | -          # read as climb + ed
  bed          | bedroom       | contains the word
  story        | history       | -          # rest "hi" is too short
  ice          | ice cream     | contains the word
  ice          | iceberg       | contains the word
  ear          | earring       | contains the word
  rain         | rainbow       | contains the word
  happy        | unhappy       | contains the word
  happy        | unhappiness   | -          # weak spot: prefix + suffix
  board        | skateboard    | contains the word
  phone        | microphone    | contains the word
  plane        | airplane      | contains the word
  berry        | strawberry    | contains the word
  football     | foot          | part of the word
  football     | ball          | part of the word
  snowman      | snow          | part of the word
  butterfly    | butter        | part of the word
  butterfly    | fly           | part of the word
  pineapple    | apple         | part of the word
  rainbow      | rain          | part of the word
  kingdom      | king          | same family
  ice cream    | cream         | part of the word
  ice cream    | ice           | part of the word
  ice cream    | icecream      | same word
  # valid clues that look close
  ear          | hear          | -
  ear          | year          | -
  ear          | earth         | -
  ear          | spear         | -
  ant          | giant         | -
  art          | heart         | -
  art          | start         | -
  pen          | open          | -
  hat          | what          | -
  sea          | seal          | -
  car          | scar          | -
  island       | land          | -
  planet       | plane         | -
  planet       | plan          | -
  orange       | range         | -
  pirate       | rate          | -
  window       | wind          | -
  dinner       | diner         | -
  desert       | dessert       | -
  horse        | house         | -
  bear         | beer          | -
  bread        | break         | -
  cat          | cut           | -
  flower       | flow          | -
  mother       | moth          | -
  corn         | corner        | -
  beach        | sand          | -
  dog          | bark          | -
  sun          | moon          | -
  hat          | cap           | -          # synonyms are allowed: the game is not that clever
  # known weak spots (documented in SPEC.md)
  art          | mozart        | contains the word
  pen          | penguin       | contains the word
  car          | carpet        | contains the word
  ant          | elephant      | contains the word
  pencil       | pen           | part of the word
`);

test("invalidClue: known answers", () => {
  expectAll(INVALID, (secret, c) => invalidClue(clue(c), clue(secret)));
});

test("invalidClue: with a dictionary, the rest of a compound must be a word", () => {
  const words = new Set(["pet", "car", "carpet", "elephant", "ant", "history", "story", "mozart", "art", "snow", "man", "men", "sun", "flower", "shirt", "short", "fountain", "mountain"]);
  const known = (w: string) => words.has(w);
  const inv = (c: string, s: string) => invalidClue(clue(c), clue(s), { known });
  assert.equal(inv("carpet", "car"), "contains the word"); // car + pet: still struck
  assert.equal(inv("elephant", "ant"), null); // eleph + ant
  assert.equal(inv("mozart", "art"), null);
  assert.equal(inv("history", "story"), null);
  assert.equal(inv("snowmen", "snow"), "contains the word");
  assert.equal(inv("sunflower", "sun"), "contains the word");
  assert.equal(inv("unhappy", "happy"), "contains the word"); // prefix
  assert.equal(inv("short", "shirt"), null); // both words: no typo
  assert.equal(inv("shurt", "shirt"), "typo");
  assert.equal(inv("fountain", "mountain"), null);
});

test("invalidClue: banned forms from the word list", () => {
  assert.equal(invalidClue(clue("chat"), clue("cat"), {}, ["chat", "gato"]), "too close");
  assert.equal(invalidClue(clue("gatos"), clue("cat"), {}, ["chat", "gato"]), "too close");
  assert.equal(invalidClue(clue("kitten"), clue("cat"), {}, ["chat", "gato"]), null);
});

// ---------------------------------------------------------------------------
// Guesses
// ---------------------------------------------------------------------------

const GUESS = table(`
  # secret     | guess        | reason (- = wrong)
  cat          | cat          | same word
  cat          | Cat!         | same word
  cat          | cats         | plural
  mouse        | mice         | plural
  run          | running      | verb form
  colour       | color        | spelling
  night        | knight       | sounds the same
  weather      | whether      | sounds the same
  bear         | bare         | sounds the same
  elephant     | elefant      | spelling
  chocolate    | choclate     | typo
  giraffe      | girafe       | typo
  shirt        | shurt        | typo
  7            | seven        | same number
  ice cream    | icecream     | same word
  ice cream    | ice-cream    | same word
  cat          | cut          | -
  cat          | kitten       | -
  prince       | princess     | -
  teach        | teacher      | -
  sun          | sunny        | -
  bear         | beer         | -
  bread        | break        | -
  horse        | house        | -
  dinner       | diner        | typo       # weak spot: guesses forgive doubled letters
  football     | foot         | -
  snowman      | snow         | -
  car          | care         | -
  plane        | planet       | -
  # hard-to-spell secret words (words/README.md)
  mayonnaise   | mayonaise    | typo
  croissant    | crossant     | typo
  chandelier   | chandeleer   | typo
  kaleidoscope | kalidoscope  | typo
  accordion    | accordian    | typo
  tambourine   | tamborine    | typo
  saxophone    | saxaphone    | typo
  broccoli     | brocolli     | typo
  cinnamon     | cinammon     | typo
  stethoscope  | stethescope  | typo
  leprechaun   | leprechan    | typo
  porcupine    | porkupine    | sounds the same
  chameleon    | chamelion    | typo
  pharaoh      | pharoah      | typo
  hyena        | hyenna       | typo
  dictionary   | dictionery   | typo
  cauliflower  | califlower   | typo
  somersault   | summersault  | typo       # vowel + doubled letter
  restaurant   | restaraunt   | -          # weak spot: letters moved
  yacht        | yatch        | -          # weak spot: short word, letters moved
  sphinx       | sphynx       | -          # weak spot
`);

test("judgeGuess: extra accepted forms from the word list", () => {
  assert.equal(judgeGuess(clue("BBQ"), clue("barbecue"), {}, ["bbq", "barbeque"]), "spelling");
  assert.equal(judgeGuess(clue("barbeque"), clue("barbecue"), {}, ["bbq", "barbeque"]), "typo"); // the secret's own rules come first
  assert.equal(judgeGuess(clue("bike"), clue("bicycle"), {}, ["bike"]), "spelling");
  assert.equal(judgeGuess(clue("bikes"), clue("bicycle"), {}, ["bike"]), "plural");
  assert.equal(judgeGuess(clue("trike"), clue("bicycle"), {}, ["bike"]), null);
  // the secret's own forms win over close also_right forms
  assert.equal(judgeGuess(clue("barbecue"), clue("barbecue"), {}, ["bbq", "barbeque"]), "same word");
  assert.equal(judgeGuess(clue("ukulele"), clue("ukulele"), {}, ["ukelele"]), "same word");
  assert.equal(judgeGuess(clue("dice"), clue("dice"), {}, ["die"]), "same word");
  assert.equal(judgeGuess(clue("die"), clue("dice"), {}, ["die"]), "plural");
  assert.equal(judgeGuess(clue("barbeques"), clue("barbecue"), {}, ["bbq", "barbeque"]), "typo");
});

test("judgeGuess: known answers", () => {
  expectAll(GUESS, (secret, g) => judgeGuess(clue(g), clue(secret)));
});

// ---------------------------------------------------------------------------
// Grouping a round
// ---------------------------------------------------------------------------

test("groupClues: transitive jinx groups and strikes", () => {
  const secret = clue("bread");
  const clues = ["toast", "Toasts", "toasted", "butter", "loaf", "breadcrumbs", "bakery", "baker", "flour"].map(clue);
  const r = groupClues(clues, secret);
  assert.deepEqual(r.invalid, [{ index: 5, reason: "contains the word" }]);
  assert.deepEqual(
    r.groups.map((g) => g.members),
    [
      [0, 1, 2],
      [6, 7],
    ],
  );
  assert.deepEqual(r.survivors, [3, 4, 8]);
  // Every pair in the toast group is linked with a reason.
  assert.deepEqual(
    r.groups[0]!.links.map((l) => [l.a, l.b, l.reason]),
    [
      [0, 1, "plural"],
      [0, 2, "verb form"],
      [1, 2, "verb form"],
    ],
  );
});

test("groupClues: chains join through a middle clue", () => {
  // teach ~ teacher (family), teacher ~ teachers (plural): one group of three.
  const r = groupClues(["teach", "teachers", "teacher", "school"].map(clue), clue("classroom"));
  assert.deepEqual(r.groups.map((g) => g.members), [[0, 1, 2]]);
  assert.deepEqual(r.survivors, [3]);
});

test("groupClues: nothing matches", () => {
  const r = groupClues(["bark", "bone", "leash", "puppy", "woof"].map(clue), clue("dog"));
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(r.groups, []);
  assert.deepEqual(r.survivors, [0, 1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

test("parseNumberWords: known answers", () => {
  const cases: [string, string | null][] = [
    ["zero", "0"],
    ["one", "1"],
    ["twelve", "12"],
    ["twentyone", "21"],
    ["ninetynine", "99"],
    ["onehundred", "100"],
    ["hundred", "100"],
    ["onehundredandone", "101"],
    ["twothousand", "2000"],
    ["twothousandtwentyfour", "2024"],
    ["million", "1000000"],
    ["oneone", null],
    ["twentytwenty", null],
    ["tone", null],
    ["often", null],
    ["tent", null],
    ["zeroone", null],
    ["", null],
  ];
  for (const [s, want] of cases) assert.equal(parseNumberWords(s), want, s);
});

test("adjacentKeys: QWERTY neighbours", () => {
  assert.ok(adjacentKeys("f", "g"));
  assert.ok(adjacentKeys("f", "r"));
  assert.ok(adjacentKeys("f", "t"));
  assert.ok(adjacentKeys("f", "c"));
  assert.ok(adjacentKeys("f", "v"));
  assert.ok(adjacentKeys("a", "q"));
  assert.ok(adjacentKeys("m", "k"));
  assert.ok(!adjacentKeys("f", "b"));
  assert.ok(!adjacentKeys("u", "r"));
  assert.ok(!adjacentKeys("m", "h"));
  assert.ok(!adjacentKeys("a", "a"));
});

test("typoCost: known answers", () => {
  assert.equal(typoCost("shirt", "shurt"), 1); // u next to i
  assert.equal(typoCost("shirt", "shmrt"), 2); // m far from i
  assert.equal(typoCost("trail", "trial"), 1); // swap
  assert.equal(typoCost("giraffe", "girafe"), 1); // doubled letter
  assert.equal(typoCost("giraffe", "girafe", { doubles: false }), 2); // doubles off
  assert.equal(typoCost("planet", "plant"), 2); // missing e: not a key slip
  assert.equal(typoCost("planet", "plant", { loose: true }), 1); // loose
  assert.equal(typoCost("accordion", "accordian"), 2); // o -> a: far apart
  assert.equal(typoCost("accordion", "accordian", { vowels: true }), 1);
  assert.equal(typoCost("cat", "cat"), 0);
});

test("spellNorm: known answers", () => {
  const cases: [string, string][] = [
    ["colour", "color"],
    ["colourful", "colorful"],
    ["flavours", "flavors"],
    ["hour", "hour"],
    ["four", "four"],
    ["centre", "center"],
    ["centres", "centers"],
    ["acre", "acre"],
    ["fire", "fire"],
    ["timbre", "timbre"],
    ["organise", "organize"],
    ["organisation", "organization"],
    ["noise", "noise"],
    ["wise", "wise"],
    ["catalogue", "catalog"],
    ["vogue", "vogue"],
    ["elephant", "elefant"],
    ["grey", "gray"],
  ];
  for (const [w, want] of cases) assert.equal(spellNorm(w), want, w);
});

// ---------------------------------------------------------------------------
// Submit check (phone messages)
// ---------------------------------------------------------------------------

test("checkSubmit: phone messages", () => {
  const secret = clue("snowman");
  const msg = (raw: string, opt = {}) => {
    const r = checkSubmit(raw, secret, opt);
    return r.ok ? `ok ${r.clue.key}` : `${r.code}: ${r.message}`;
  };
  assert.equal(msg("carrot"), "ok carrot");
  assert.equal(msg("  Winter! "), "ok winter");
  assert.equal(msg(""), "empty: Type a clue");
  assert.equal(msg("a very long phrase"), "too-many-words: One word please (two at most, for names)");
  assert.equal(msg("supercalifragilisticexpialidocious"), "too-long: Too long (24 characters at most)");
  assert.equal(msg("снег"), "not-english: English letters and numbers only");
  assert.equal(msg("Snowman"), "too-close: That's the word itself. Try another clue");
  assert.equal(msg("snowmen"), "too-close: That's the word in the plural. Try another clue");
  assert.equal(msg("snow"), "too-close: Part of the word. Try another clue");
  assert.equal(msg("snowmab"), "too-close: That's the word with a typo. Try another clue");
  assert.equal(msg("frosty", { banned: ["frosty"] }), "too-close: Too close to the word. Try another clue");
  // the giver's own other clue (3 players)
  const own = [clue("carrot")];
  assert.equal(msg("Carrots", { own }), "own-clue: Same as your other clue (plural). Try another clue");
  assert.equal(msg("carrot", { own }), "own-clue: Same as your other clue. Try another clue");
  assert.equal(msg("scarf", { own }), "ok scarf");
});

test("checkSubmit: other reasons and accepted guesses", () => {
  const r = (raw: string, secret: string, opt = {}) => {
    const x = checkSubmit(raw, clue(secret), opt);
    return x.ok ? "ok" : x.message;
  };
  assert.equal(r("princess", "prince"), "Too close to the word: same family. Try another clue");
  assert.equal(r("knight", "night"), "Sounds like the word. Try another clue");
  assert.equal(r("color", "colour"), "That's the word, spelled differently. Try another clue");
  assert.equal(r("swam", "swim"), "That's another form of the word. Try another clue");
  assert.equal(r("hotdog", "dog"), "Contains the word. Try another clue");
  // an accepted guess is also too close as a clue
  assert.equal(r("BBQ", "barbecue", { alsoRight: ["bbq", "barbeque"] }), "Too close to the word. Try another clue");
  assert.equal(r("grill", "barbecue", { alsoRight: ["bbq", "barbeque"] }), "ok");
  // with the dictionary
  const known = dictionary("shirt\nshort\nsleeve\n");
  assert.equal(r("short", "shirt", { known }), "ok");
  assert.equal(r("shurt", "shirt", { known }), "That's the word with a typo. Try another clue");
});

// ---------------------------------------------------------------------------
// Word list
// ---------------------------------------------------------------------------

test("parseWordList: columns, lists, comments", () => {
  const text = [
    "# Jinx secret words (English). word<TAB>difficulty<TAB>category<TAB>also_right<TAB>banned. See README.md.",
    "barbecue\tmedium\tfood\tbbq, barbeque\tbarbacoa",
    "cat\teasy\tanimal\t\tchat,gato",
    "dog\teasy\tanimal",
    "",
    "# a comment",
  ].join("\n");
  assert.deepEqual(parseWordList(text), [
    { word: "barbecue", difficulty: "medium", category: "food", alsoRight: ["bbq", "barbeque"], banned: ["barbacoa"], english: [] },
    { word: "cat", difficulty: "easy", category: "animal", alsoRight: [], banned: ["chat", "gato"], english: [] },
    { word: "dog", difficulty: "easy", category: "animal", alsoRight: [], banned: [], english: [] },
  ]);
  // A header naming only three columns still reads the two new ones by position.
  const old = parseWordList("# word<TAB>difficulty<TAB>category. See README.md.\nbicycle\teasy\ttransport\tbike\n");
  assert.deepEqual(old[0]!.alsoRight, ["bike"]);
  // Columns in another order.
  const re = parseWordList("# word<TAB>banned<TAB>also_right\nhippo\thorse\thippopotamus\n");
  assert.deepEqual([re[0]!.banned, re[0]!.alsoRight], [["horse"], ["hippopotamus"]]);
});

const WORDS = new URL("../data/words.txt", import.meta.url);
const DICT = new URL("../data/dict.txt", import.meta.url);

test("words.txt: every secret, also_right and banned form behaves", { skip: !existsSync(WORDS) && "no ../words/words.txt" }, () => {
  const entries = parseWordList(readFileSync(WORDS, "utf8"));
  assert.ok(entries.length > 100);
  const known = existsSync(DICT) ? dictionary(readFileSync(DICT, "utf8")) : undefined;
  const bad: string[] = [];
  for (const e of entries) {
    const c = clean(e.word);
    if (!c.ok) {
      bad.push(`${e.word}: does not clean (${c.error})`);
      continue;
    }
    const secret = c.clue;
    const opt = { known, banned: e.banned, alsoRight: e.alsoRight };
    if (known && !known(secret.key) && secret.kind === "word") bad.push(`${e.word}: not in dict.txt`);
    if (checkSubmit(e.word, secret, opt).ok) bad.push(`${e.word}: accepted as its own clue`);
    if (judgeGuess(secret, secret, opt, e.alsoRight) !== "same word") bad.push(`${e.word}: own guess not right`);
    for (const a of e.alsoRight) {
      const g = clean(a);
      if (!g.ok) bad.push(`${e.word}: also_right ${a} does not clean`);
      else if (!judgeGuess(g.clue, secret, opt, e.alsoRight)) bad.push(`${e.word}: also_right ${a} not judged right`);
      if (checkSubmit(a, secret, opt).ok) bad.push(`${e.word}: also_right ${a} accepted as a clue`);
    }
    for (const b of e.banned) if (checkSubmit(b, secret, opt).ok) bad.push(`${e.word}: banned ${b} accepted as a clue`);
  }
  assert.deepEqual(bad, []);
});
