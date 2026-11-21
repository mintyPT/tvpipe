# Jinx: clue cleaning and matching (English)

Status: design + working prototype (`match.ts`, `match.test.ts`, `sweep.ts`).
Run the tests with `node --test match.test.ts` (Node 22.6+ strips the types;
Node 26 needs no flag) and the data sweep with `node sweep.ts` (needs the word
list workstream's `../words/raw/` data; writes `sweep-report.md`).

The game decides and nobody argues, so every rule here is deterministic, the
same on every device, explainable in two or three words on the TV
("cats = cat · plural"), and biased the way that feels fair:

| Check | When it is wrong… | Bias |
| --- | --- | --- |
| clue vs clue (jinx) | two different words shatter: feels arbitrary and costs points | **strict**: only "the same word" in some form; a missed duplicate just shows the guesser two similar cards |
| clue vs secret word (invalid) | a fair clue is rejected, or a cheat ("Shurt") gets through | **medium**: catch forms, family, typos, sound-alikes and compound parts |
| guess vs secret word | a right guess with a slip is refused (the worst moment of the round) | **lenient**: forgive plurals, verb forms, sound-alikes, typos, doubled letters, wrong vowels |

## 1. What the reference rules say

Just One (Repos Production) rulebook, the source of the genre:

- A clue is **a single word**. Valid: a compound (merry-go-round), a proper
  noun (Sherlock, Red Bull), a number (007), onomatopoeia (Riiing), an
  acronym (FBI, SMS) or a special character ($ for America).
- **Identical clues** (all cancelled): two identical words (Mouse/Mouse);
  variants from the same word family (Prince/Princess); variants of the same
  word: plurals, gender variants and spelling mistakes "don't count as actual
  differences" (Prince/Princes, Actor/Actress, Philosophy/Filosofie).
- **Invalid clues**: the mystery word written differently (Shurt for Shirt),
  in a foreign language (Buisson for Shrub), a word from the same family
  (Princess for Prince), an invented word (Swee'ting for Cake), a homophone
  (Whether for Weather).
- **Guess**: one guess; "if the guess has the same pronunciation as the
  mystery word, the guess is valid".

Board Game Arena's implementation removes exact matches automatically and
leaves the rest to a player; its help page lists Japan/Japanese as same
base, Horse/Horses, Rhythm/Rythem, Colour/Color (as "written differently"),
and admits the family rule is debatable: sandcastle vs quicksand "many
players would consider a clash", unclear vs uncertain (shared un-) not;
translations are "a frequent source of disagreements" (sombrero for hat).

Digital word games: TriviaMaker's lenient spelling allows nothing for
answers of 4 letters or fewer, one transposition for 5–9, two for 10+, never
on numbers. Keiko's Words allows Damerau distance 0 under 5 letters, 1 up to
8, 2 beyond, and its key rule: **"a guess that is itself a real dictionary
word is never treated as a typo of something else"**. Algolia's typo
tolerance works the same way (by length, first letter usually kept). Our
sweep (section 9) confirms the dictionary rule is what makes typo matching
fair: without it, 2754 pairs of common real words (shirt/short,
truck/trick, clock/click) are one keyboard slip apart.

## 2. Where the checks run

All matching runs in the **host page**: the game's own window on the
computer, which owns the game state (not the TV page, which only renders
what the host sends, and not the phones). It works from the cleaned strings
only; phones may clean input for instant feedback, but the host re-cleans
what it receives and decides.

Decided:

- **Invalid clues are rejected at submit, never struck on the TV.** When a
  giver submits, the host runs `checkSubmit` and, on a rejection, sends the
  phone a message ("Contains the word. Try another clue"); the giver types
  again. The same call rejects input errors (empty, too long, too many
  words, not English letters) and, with 3 players, a giver's second clue
  that matches their own first clue ("Same as your other clue (plural)").
  Clues that pass are final.
- **Jinx (clue vs clue) runs when writing ends**, on the accepted clues only
  (nothing about collisions may leak while writing). `groupClues` still
  strikes invalid clues first, but after the submit check there are none.

## 3. Cleaning: raw phone input to a canonical clue

`clean(raw)` returns `{ display, key, parts, kind }` or an input error. The
TV shows `display`; everything compares `key`.

| Step | Rule | Example |
| --- | --- | --- |
| 1 | Unicode NFKC: full-width letters, ligatures, compatibility forms | `ｃａｔ` → cat, `ﬁsh` → fish |
| 2 | Remove invisible characters (zero-width space, BOM, soft hyphen); keep ZWJ for emoji | |
| 3 | Unify apostrophes (’ ‘ ` ´ ʼ → ') and dashes (‐ – — − → -) | `don’t`, `Ice–Cream` |
| 4 | Collapse whitespace, trim. Empty → error "Type a clue" | `"  Cat  "` → display `Cat` |
| 5 | Length: at most **24 characters** (display) → "Too long" | supercalifragilistic… |
| 6 | Lowercase (locale-independent), fold ß→ss æ→ae œ→oe ø→o ł→l đ/ð→d þ→th ı→i, strip diacritics (NFD, drop marks) | Café → cafe, Straße → strasse |
| 7 | Split into words on spaces; hyphens, slashes and underscores join parts of one word | ice cream (2 words), merry-go-round (1 word) |
| 8 | At most **2 words** (names, open compounds: Red Bull, ice cream, New York) → "One word please (two at most, for names)" | a b c, New York City |
| 9 | A part that is exactly one symbol reads as its name: `$ € £ ¥ % & + @ °` → dollar, euro, … | `$` → dollar |
| 10 | Emoji and other symbols are decoration: dropped from the key when the clue has letters or digits | `fire 🔥` → fire |
| 11 | A clue of only emoji/symbols is a **symbol clue**: key `~` + the emoji without variation selectors and skin tones; it only matches the same emoji | `👍🏽` → `~👍` |
| 12 | Punctuation is dropped (. ' ! ? , " ( ) …) | U.S.A. → usa, rock'n'roll → rocknroll, Bang! → bang |
| 13 | Anything left that is not a–z or 0–9 (Cyrillic, CJK, Greek) → "English letters and numbers only" | кот, 猫 |
| 14 | Runs of 3+ identical characters become 2 (onomatopoeia, emphasis) | Riiiiiinnng → riinng, hmmm = hmmmmm |
| 15 | Drop a leading a / an / the / to when there are two words | a cat → cat, The Beatles → beatles, to run → run |
| 16 | Number words become digits, for the whole clue or each word: units, teens, tens, hundred, thousand, million, billion, "and"; ordinals first…twelfth except **second** (a unit of time) | seven → 7, twenty-one → 21, one hundred → 100, first → 1st |
| 17 | `key` = the parts joined without spaces; `kind` = number (only digits, optionally st/nd/rd/th), symbol, or word | ice cream → icecream |

Decisions:

- **Spaces and hyphens do not matter**: ice cream = ice-cream = icecream =
  Ice Cream. Players write compounds all three ways.
- **Multiple words**: allowed up to 2 and joined (not rejected), because
  names and open compounds are legitimate one-word clues in Just One
  terms. A third word is rejected on the phone, where the player can fix it.
- **Digits vs number words**: 7 = seven ("same number"). Leading zeros are
  kept: 007 is a Bond clue, not 7. Plural number words (sevens) stay words.
- **Emoji**: decoration in word clues; a pure emoji clue is allowed (Just One
  allows $) but matches only the same emoji. The TV font must render it (the
  page is rendered in headless Chrome on the host; check emoji fonts on
  Linux hosts).
- **Profanity**: not filtered here (decided: no filter for now).
- Original case and spelling are kept for display, the replay and the word
  web.

## 4. Clue vs clue: when two clues jinx

Rules apply in order; the first that fires gives the reason. Each pair is
symmetric. Only clues of the same kind compare (a number never jinxes a
word, a symbol only its identical symbol).

| # | Rule | TV reason | Jinx | Must NOT jinx |
| --- | --- | --- | --- | --- |
| 1 | same key after cleaning | same word | Cat/CAT, café/cafe, ice cream/icecream, hmmm/hmmmmm | |
| 1b | same key, one typed as digits | same number | 7/seven, 21/twenty-one, 1st/first | 7/007, sevens/seven |
| 2 | same after UK→US and ph→f spelling | other spelling | colour/color, centre/center, organise/organize, catalogue/catalog, grey/gray, tyre/tire, mum/mom, aeroplane/airplane, elephant/elefant | hour/hor, four/for, fire/fier, acre/acer, timbre/timber, noise/noize |
| 3 | one is a plural of the other (or both of one word) | plural | cat/cats, glass/glasses, bus/buses, city/cities, wolf/wolves, knife/knives, mouse/mice, child/children, snowman/snowmen, cactus/cacti, ice cream/ice creams | news/new, caves/cafe, his/hi, gas/ga |
| 4 | verb forms of one verb | verb form | run/running/ran, hope/hoping/hoped, hop/hopping/hopped, dance/danced, cry/cried, travel/travelled/traveled, swim/swam, go/went, begin/beginning | hope/hopping (hop), car/cared (care), filed/filled, planed/planned, saw/see, left/leave, felt/feel, rose/rise, born/bear |
| 5 | same word family (one derivational suffix, two when the outer one is -ly/-ness/-ful/-less/-ship/-hood/-ment/-dom) | same family | prince/princess, actor/actress, teach/teacher/teaching, big/bigger, happy/happiness, sun/sunny, ice/icy, help/helpful, care/carefully, japan/japanese, china/chinese, italy/italian, america/american, music/musician, france/french, act/action, king/kingdom, gold/golden, long/length, good/better | care/career, corner/corn, mother/moth, shower/show, letter/let, party/part, story/store, every/ever, finish/fine, final/fine, sandal/sand, animal/anime, universe/university, organ/organization, question/quest, happen/happy, soldier/sell, minister/mine |
| 6 | a typo of each other (section 6) | typo | chocolate/choclate, shirt/shurt, rhythm/rythm, broccoli/brocoli, dinosaur/dinosuar | diner/dinner, desert/dessert, later/latter, bear/beer, house/horse, fight/right, night/light, train/brain, plant/planet, scream/cream |
| 7 | stretched: one is the other with letters doubled, nothing else; the stretched one unknown to the dictionary, the other known | other spelling | dog/doog, dog/ddoogg, dogs/dogss | diner/dinner (words), black/blak (undoubled), dog/doggs (no forms) |
| 8 | backwards: one is the other written backwards, exactly; the backwards one unknown to the dictionary, the other known, 4+ letters | backwards | black/kcalb, tire/erit | star/rats, stop/pots (words), dog/sgod (no forms), car/rac (3 letters) |
| 9 | two words (with a space) that share a word: the same words in any order, or a word of one related (rules 1–5) to the other clue or one of its words (3+ letters) | same word / contains the word | black car/car black, black car/black | firetruck/fire (closed compound) |

Rules 7–9 are against cheating: a word disguised to slip past the jinx
(short words have no typos), or a second word smuggled onto a card. Rules
7 and 8 need the dictionary (without it nothing is unknown); they run
after the typo rule, so a long stretched word is still a typo
(black/blackk).

Not jinxes between clues, on purpose:

- **Homophones** (night/knight, flower/flour): different words give the
  guesser different information; Just One only invalidates them against the
  mystery word.
- **Compounds and containment** (fire/firetruck, sandcastle/quicksand,
  car/carpet): sharing a part is not "the same clue". Two parts of one
  compound still tell the guesser two things.
- **Prefixes** (happy/unhappy): opposite meanings.
- **Synonyms, translations, associations** (cat/kitten, hat/cap,
  dog/chien): the game is not that clever, and must not pretend to be.

### How forms are computed (the "hand-rolled lemmatizer")

`forms(key)` is the heart of the matcher and is deliberately small:

1. **Irregular table** (~200 entries): noun plurals (men, children, feet,
   teeth, geese, mice, people, cacti, criteria, …, also inside compounds:
   snowmen, grandchildren), verb forms (be/am/is/was, go/went/gone,
   swim/swam/swum, …) and good/better/best. Left out on purpose because the
   form is a common word of its own: saw, left, felt, rose, bore, born,
   lit, ground, wound (found is kept: find).
2. **Regular inflection rules** produce *candidate* bases, not one stem:
   -s, -es (after s/x/z/ch/sh/o), -ies → y/ie, -ves → f (and -ife), -ses →
   -sis; -ed/-ing with the Porter "short word" test: if the stem is a short
   syllable like *hop* or *car*, a real -ed form would have doubled it
   (hopped, carred), so *hoped* yields *hope*, never *hop*, and *cared*
   never *car*. Doubled consonants undouble (hopped → hop, travelled →
   travel), -ied → y/ie, -eed only with a vowel-consonant before it
   (agreed, not need/seed/speed), -oed/-uing/-cked special cases. A
   stop list blocks words that only look inflected (news, series, evening,
   herring, during, united, wicked, ring/king/thing, …).
3. **Derivational suffixes** (-er, -est, -or, -ess, -ness, -ly, -y, -ful,
   -less, -ish, -ist, -ism, -ese, -ian, -an, -ic, -al, -ion, -ation, -ment,
   -hood, -ship, -dom, -able, -ible, -ive, -ous, -en) with the same spelling
   adjustments (e-restoring, y→i, undoubling) and a minimum stem length. A
   final e is never kept before a vowel suffix (career is not care + er).
   Not used: -ize (organ → organize → organization), -ity
   (universe/university, grave/gravity), -ling, -let, -ette.
4. A **not-derived list** (~250 words) blocks words that end like a
   derivation but are not one: corner, mother, shower, letter, party, story,
   finish, final, animal, question, shoulder, happen, … It was seeded by
   hand and extended from the sweep; it is the part that needs curation.
5. **Family groups** for relatives no suffix rule reaches: France/French,
   Greece/Greek, Wales/Welsh, Netherlands/Dutch, actor/actress,
   duke/duchess, deep/depth, long/length, speak/speech, fly/flight, sing/song,
   choose/choice, thief/theft, piano/pianist, volcano/volcanic.

Two clues match by inflection when their candidate sets intersect (a junk
candidate like *teache* is harmless unless the other clue produces the same
junk). This "generate candidates from both sides" approach is far more
precise than a Porter stemmer, which conflates organ/organization,
universe/university and police/policy.

## 5. Clue vs secret word: invalid clues

`invalidClue(clue, secret, opt, banned)`, in order:

| # | Rule | reason (phone message) | Invalid | Valid (must not be rejected) |
| --- | --- | --- | --- | --- |
| 1 | same key | same word / same number | SHIRT! for shirt, 7 for seven | |
| 2–5 | spelling, plural, verb form, family (as section 4) | other spelling, plural, verb form, same family | color for colour, fone for phone, shirts, mice for mouse, ran for run, teacher for teach, sunny for sun, princess for prince | the section 4 counter-examples: corn for corner, moth for mother, cared for car |
| 6 | sounds the same: homophone table (~150 groups) or a sound key (hard c = k, qu = kw, x = ks, silent kn-/wr-/wh-, ph = f) | sounds the same | whether for weather, knight for night, kat for cat, kar for car | rise for rice, baked for backed, bee for is, diner for dinner, nite for night (weak spot) |
| 7 | a typo of the secret (section 6) | typo | shurt for shirt | short for shirt (with dictionary) |
| 7b | stretched or backwards (section 4, rules 7 and 8; with a dictionary) | other spelling, backwards | doog for dog, kcalb for black | rats for star |
| 8 | the clue contains the secret: an explicit word of the clue relates to it, or the clue starts/ends with it and the rest has 3+ letters or is a prefix (un-, re-, micro-, …); with a dictionary the rest must be a word | contains the word | t-shirt, hot dog, ice cream for ice; snowman, snowmen, sunflower, sunday, football, earring, rainbow, iceberg, skateboard, microphone, airplane, strawberry, unhappy | hear, year, earth, spear for ear; giant for ant; heart/start for art; open for pen; seal for sea; scar for car; tshirt (1-letter rest); catching for cat (reads catch + ing); climbed for bed; history for story |
| 9 | the secret contains the clue the same way ("whole component of a compound secret") | part of the word | foot or ball for football, snow for snowman, butter or fly for butterfly, apple for pineapple, cream for ice cream | land for island, plane/plan for planet, range for orange, rate for pirate, wind for window |
| 10 | a form the word list bans for this word (translations, irregular relatives) | too close | chat, gato for cat (if listed) | kitten for cat |

Containment checks every reading of the clue: *catching* is also *catch* +
*ing*, and *catch* does not contain *cat* with a 3-letter rest, so
*catching* is fine for *cat*; *hotdogs* reads *hotdog* and is rejected for
*dog*.

## 6. Typos

Measured with a weighted Damerau (optimal string alignment) distance on the
spelled forms (key, UK→US, ph→f) and their plural bases:

- cost 1: a QWERTY neighbour (shirt/shurt), two adjacent letters swapped
  (chocolaet), an extra key next to a neighbouring letter (rhythm/rythm), a
  letter doubled or undoubled (only when allowed, below);
- cost 2: every other substitution, insertion or deletion.

Budget by the length of the shorter word: under 5 letters **no typos at
all** (cat/cut, bear/beer, car/card); 5–7 letters: 1; 8–11: 2; 12+: 3.
Words of up to 7 letters must share the first letter (fight/right,
night/light). Doubled letters count as a typo only from 7 letters
(diner/dinner, later/latter, desert/dessert are words); digits never.

**With a dictionary** (`opt.known`, strongly recommended, section 8): two
known words are never typos of each other, and if one is unknown every
missing or extra letter costs 1 (buter/butter).

**Guesses** are more lenient: doubled letters from 5 letters (girafe,
hyenna), any vowel for another from 6 (accordian, chandeleer,
stethescope, dictionery).

## 7. Guesses

`judgeGuess(guess, secret, opt, alsoRight)`: right if same word or number,
other spelling, plural, verb form, sounds the same (Just One's rule), a typo
(guess leniency), or matches a form the word list accepts (bbq, barbeque
for barbecue; bike for bicycle). **Not** right: same family (princess for
prince, teacher for teach, sunny for sun), containment (foot for football),
a different word of similar shape (bear/beer, bread/break, car/care,
plane/planet). The TV can show "≈ typo" or "≈ sounds the same" next to an
accepted guess.

## 8. Dictionary and word list interface

The game ships a dictionary for `opt.known` (decided). `node build-dict.ts`
builds it reproducibly from the SCOWL 2020.12.07 lists the word-list
workstream fetches into `../words/raw/`: English, American and British
words, upper-case words and proper names, sizes ≤ 60, lowercased, letters
only, plus every secret word and its `also_right` forms (as match keys).
Output: `dict.txt` (sorted, one word per line) and `dict-LICENSE.txt`
(SCOWL's permissive notice, which must ship with it). Current size:
**88,991 words, 837,760 bytes raw, 242,272 bytes gzipped**. Only the host
page loads it: `dictionary(text)` turns it into `opt.known`. Without it,
typo matching is noisy (section 9); with it, nearly all false typo pairs
disappear and containment stops striking accidental endings (elephant for
ant, history for story, Mozart for art).

`words.txt` gets two columns (decided; `parseWordList` reads them):
`word<TAB>difficulty<TAB>category<TAB>also_right<TAB>banned`, lists
comma-separated, both optional. A header comment naming the columns may
reorder them.

- `banned`: clues rejected as "too close" besides the rules: translations
  (chat/gato/Katze for cat), relatives the rules miss.
- `also_right`: guesses accepted as right (barbeque, bbq, e-mail, catsup,
  ukelele, hiccough, bike for bicycle, hippo, fridge, grandad). An accepted
  guess is also rejected as a clue.
- The test suite checks every entry of `words.txt` (cleans, rejected as its
  own clue, also_right judged right and rejected as a clue, banned
  rejected), and `sweep.ts` reports the same in section E.
- Avoid dealing related secrets in one game (already in the word notes).

## 9. Sweep results (`node sweep.ts`, see `sweep-report.md`)

Data: 24,486 CYP-LEX words with Zipf ≥ 3 (with lemmas), the dictionary
above, 989 secret words from `../words/words.txt`.

- **Inflection recall**: 7,603 of 7,687 inflected words jinx with their
  lemma (98.9 %). Misses are pronouns, the deliberately excluded
  saw/felt/left/rose/born/bore/lit/wound/bound, plural number words
  (hundreds, sevens) and rare forms (sped, leant, smelt).
- **Different lemmas that jinx** (to review): 10,407 family pairs,
  1,535 verb-form, 243 plural, 129 spelling pairs among common words. The
  most frequent ones read correctly (really/real, dark/darkness,
  dead/death, teacher/teach, magic/magician, free/freedom); the bad ones
  found were added to the not-derived list. The remaining noise is mostly
  in rare or proper words (perry/per, mary/marion, inn/inner).
- **Real-word typos between clues**: 2,754 pairs without a dictionary
  (while/whole, quite/quiet, short/shirt, truck/trick, clock/click,
  angel/angle, stick/stuck, mountain/fountain); with the dictionary 373
  pairs remain, all involving a word outside it (names, wouldn, thunk).
- **Secret words**: every secret cleans and is invalid against itself;
  all its own inflections are invalid except born/bore (bear), pent, shod,
  sunken, shrunken, taxied, wound (wind). Struck common words, with the
  dictionary: same family 263, contains 353, part of 517, typo 4 (names
  like Walter for water), sounds the same 51 (all real homophones). Full
  lists in `sweep-invalid-dict.tsv` (and `sweep-invalid.tsv` without the
  dictionary).

## 10. Grouping a round

`groupClues(clues, secret)`:

1. Strike invalid clues (none after the submit check; kept so the function
   is safe on its own).
2. Compare every pair of the remaining clues (at most 7 clue-givers, or 4
   clues with 3 players: ≤ 21 pairs).
3. **Transitive**: connected components with 2+ members are jinxed. If
   *teach* ~ *teacher* (family) and *teacher* ~ *teachers* (plural), all
   three are lost even though the rule list is applied pairwise. This is
   what players expect ("all identical clues are cancelled") and gives one
   pile of shattered cards per group.
4. Each group carries every matching pair with its reason, so the TV can
   slam the cards together pair by pair (or pick a spanning tree: one
   reason per card).

Same-author pairs (3 players, two clues each) cannot happen: the second
clue is rejected at submit if it matches the giver's first (`checkSubmit`
with `own`).

## 11. Known weak spots

- Without the dictionary, real words one slip apart jinx as "typo"
  (shirt/short, trial/trail, clock/click, string/sting) and are rejected as
  typos of the secret (fountain for mountain). With it, only words outside
  the dictionary can be typos.
- **Short secrets and containment**: *carpet* (car + pet) is rejected for
  *car* even with the dictionary, as are *important* (import + ant) for
  *ant*, *police* for *ice*, *pigeon* for *pig*. Without the dictionary
  also *elephant* for *ant*, *Mozart* for *art*, *penguin* for *pen*, and
  *pen* for *pencil*. These are rarely plausible clues; the word list could
  avoid 3-letter secrets with many such words.
- **Family is heuristic**: junk roots occasionally meet (strawberry vs
  strawbery reach "strawber" and read "same family" instead of "typo";
  vision/visible share "vis"; company/companion share "compan"). The
  not-derived list needs curation from real play logs.
- **Phonetic misspellings** beyond the sound key are missed between clues
  and for invalid clues: dinasour, nite (night), filosofie needs ph→f and
  ie→y (not done). Guesses catch more through vowel leniency.
- **Irregular forms that are words of their own** never match: saw/see,
  left/leave, felt/feel, rose/rise, born/bear. Players will accept that.
- Prefix plus suffix: *unhappiness* is not rejected for *happy*.
- Translations and synonyms are not detected (only through the word
  list's `banned` column).
- No profanity filter (decided for now).
- A guess of *diner* for *dinner* is accepted (guess leniency); *yatch*,
  *restaraunt*, *sphynx* are refused.

## 12. API (prototype)

```ts
clean(raw): { ok: true, clue: Clue } | { ok: false, error, message }
checkSubmit(raw, secret, { known?, banned?, alsoRight?, own? }):
    { ok: true, clue } | { ok: false, code, reason?, message }   // phone message
sameClue(a, b, opt?): Reason | null          // jinx?
invalidClue(clue, secret, opt?, banned?): Reason | null
judgeGuess(guess, secret, opt?, alsoRight?): Reason | null   // null = wrong
groupClues(clues, secret, opt?, banned?): { invalid, groups, survivors }
explain(a, b, reason): string               // "Cats = cat · plural"
parseWordList(text): WordEntry[]            // words.txt with also_right, banned
dictionary(text): (word) => boolean         // dict.txt -> opt.known
opt = { known?: (word) => boolean }
```

`checkSubmit` codes: `empty`, `too-long`, `too-many-words`, `not-english`
(input), `too-close` (with the reason: "That's the word in the plural",
"Too close to the word: same family", "Contains the word", "Part of the
word", "Sounds like the word", "That's the word with a typo", …) and
`own-clue`; every too-close/own-clue message ends with "Try another clue".

Everything is pure and synchronous, about 1,150 lines with all tables.
`forms()` results are cached per key.

Files: `match.ts` (the matcher), `match.test.ts` (`node --test
match.test.ts`), `build-dict.ts` (→ `dict.txt`, `dict-LICENSE.txt`),
`sweep.ts` (→ `sweep-report.md` and TSVs; run `build-dict.ts` first).

## 13. Decisions (from the human)

- Invalid clues are rejected at submit on the phone; no TV strike.
- The dictionary ships (`dict.txt`, host page only).
- Family jinxes between clues; compound parts do not (fire/firetruck).
- One word, with spaces and hyphens joined (2 words at most, for names and
  open compounds).
- 3 players: a giver's second clue matching their first is rejected at
  submit.
- No profanity filter for now.
- `words.txt` gets `also_right` and `banned` columns.
