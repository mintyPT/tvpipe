# Jinx secret words (German)

`../../../data/words.de.txt`: **1,000 words**, the format of the English
`words.txt` with one more column
(`word<TAB>difficulty<TAB>category<TAB>also_right<TAB>banned<TAB>english`,
header comment naming the columns, `parseWordList` reads it: its `banned`
is both columns, its `english` the last). German
capitalisation as in Duden: nouns capitalised (`Hund`, `Schneemann`), verbs
(category `action`) and adjectives (`quality`) lowercase.

- Difficulty: easy 336 (34 %), medium 481 (48 %), hard 183 (18 %), the
  English proportions.
- Categories (the English ids; the UI translates them): animal 128, food 110,
  nature 97, home 89, people 61, place 56, sport 54, fantasy 45, music 44,
  transport 44, body 42, clothing 42, tool 41, action 38, event 36,
  material 31, science 28, quality 14.
- `also_right` on 498 words, `banned` (French, Spanish, Italian) on 825,
  `english` on 961 (see the rules below).

The list is hand-curated: no dataset values are in it. `source.txt` is the
source of truth (by category, with notes); `build.mjs` turns it into the TSV.

## Files

| File | What |
| --- | --- |
| `source.txt` | the list: `Wort \| e/m/h \| also_right \| english / banned \| note` (`monkey, ape / mono, singe, scimmia`), `## category` sections; notes say what a word translates (`en:bug`) and why something is or is not banned |
| `build.mjs` | `node build.mjs` writes `data/words.de.txt` and lints (categories, difficulty, duplicates, ≥ 3 letters, one word, capitalisation by part of speech, every English word translated or in `dropped.tsv`); `--review` checks against the raw data (below) and writes `../raw/de/review.tsv`; `--verbose` lists also_right forms that are themselves secrets |
| `dropped.tsv` | the 185 English words with no German secret, and why |
| `trimmed.txt` | 296 German candidates cut to keep the list near 1,000 (a reserve) |
| `short-secrets.ts` | containment sweep for secrets ≤ 5 letters (→ `../raw/de/short-secrets.tsv`); `--plausible` runs `plausible-clues.tsv` → `plausible-rejected.tsv` |
| `fair-clues.ts` | 4–5 obvious fair clues per secret (`fair-clues.tsv`, 4,855 clues, LLM-written) through `checkSubmit` → `fair-rejected.tsv` |
| `related.ts` | every pair `related()` (game/rules.ts) keeps apart → `related-pairs.tsv` |
| `fetch.sh` | raw data into `../raw/de/` (git-ignored) |

The scripts are Node (≥ 18 for `build.mjs`, ≥ 23 for the `.ts` ones, which
import the game's matcher), no packages.

After changing the list: `node build.mjs`, then rebuild the lexicon (it
force-includes every word and also_right form):
`cd ../../matching/de && node build-lexicon.ts` (it writes `data/dict.de.txt`),
then `npm test` (`test/words-de.test.ts` checks every entry with the German
matcher), `node fair-clues.ts` and `node related.ts`.

## Rules for a word

The English rules (../README.md), adapted:

- Everybody at a casual German-speaking party knows it instantly: kids from
  about 10, in Germany, Austria and Switzerland alike.
- Several obvious clues and room for creative ones; mostly concrete things,
  animals, food, places, jobs, sports, events, a few verbs and adjectives.
- One word as Duden writes it. Closed compounds are fine and very German
  (Schneemann, Kühlschrank, Feuerwehr, Regenschirm) when they are one
  everyday concept. Two hyphenated ones (U-Boot, U-Bahn) and T-Shirt, E-Mail.
- Singular nominative, infinitive for verbs. One plurale tantum (Pommes).
- At least 3 letters (no Ei, Öl, Po).
- No proper nouns or brands; nothing sexual, tragic or political (same line
  as English: Schwert, Totenkopf, Polizei are in; alcohol, death, religion
  out; Weihnachten, Adventskranz, Osterhase are in as customs). Dropped for a
  vulgar or sexual second meaning: Schwanz (tail), lecken (lick), Samen
  (seed), and Pariser as a name for Baguette.
- No regional splits: words that mean different things or are unknown in
  one of the three countries are out (Pfannkuchen, Berliner, Krapfen,
  Semmel/Brötchen, Sahne/Obers/Rahm, Sessel as armchair, Abitur/Matura), or
  the form everybody knows is the secret and the regional names of the same
  thing are in `also_right` (Tomate: Paradeiser; Kartoffel: Erdapfel,
  Härdöpfel; Fahrrad: Velo; Handy: Natel; Krankenhaus: Spital; Treppe:
  Stiege; Dachboden: Estrich, Speicher; Hausschuh: Patschen, Finken,
  Pantoffel; Jahrmarkt: Kirmes, Kirtag, Chilbi, Dult, Kerb; Fasching:
  Karneval, Fasnacht).
- Spelling per Duden, the preferred form as the secret, the others in
  `also_right` (Delfin: Delphin; Känguru: Känguruh; Geldbörse: Portemonnaie,
  Portmonee; Saxofon: Saxophon; Joghurt: Jogurt; Ketchup: Ketschup).
- Two strong meanings are fine when they delight more than they confuse
  (Bank, Kiefer, Schloss, Leiter, Flügel, Birne, Tor, Ton, Strauß, Fliege,
  Kater); they are mostly `hard`.

### also_right and banned

Both are rejected as clues, so they must be narrow:

- `also_right`: only other **names for exactly the same thing** that a
  guesser would type meaning this word: short forms (Kuli, Dino, Mikro),
  regional names, spelling variants, the feminine of a job (Ärztin),
  synonyms in the strict sense (Oma: Großmutter; Sofa: Couch). Never broader
  or neighbouring words that make good clues: no Telefon for Handy, Pool or
  Freibad for Schwimmbad, Trophäe for Pokal, Schädel for Totenkopf, laufen
  for rennen, Bild for Foto, Stufen for Treppe. When in doubt, left out: a
  close synonym a guesser types can be judged by the room, a blocked fair
  clue is worse.
- `banned`: only translations: the English word, and French, Spanish and
  Italian ones people know. In `source.txt` the English ones come first, a
  `/` before the others; they go in the `english` column. The English ones
  are also rejected in their English forms, typos and disguises (monkeys,
  monky, mmonkey for monkey), the others only as written (singe is French
  for Affe: singing is fine). Where English has the same word with the same
  meaning, it is its own English translation (planet for Planet, so planets
  is rejected; 122 words), never a false friend (Mutter, See, Hose, Boot,
  Handy, Tee, Rock, Regal, Wald, Strand, Fell: muttered, seeing, hoses are
  fine). Which entry is English came from the German Wiktionary's
  translations (raw data, below), checked by hand where it lists the word in
  several languages (canard, plume, bureau, tableau, basket for Turnschuh). Never German words, and no translation that is
  itself a German word a player may fairly use (Star for Stern, Curry for
  Currywurst, Pasta, Box, City, Pool, Match, Trick, Test, Bulldozer, Rosa,
  Limone…; the note says so). The matcher matches banned forms as written
  or in another spelling, so translations that spell like a German word are
  out too (corn ~ Korn, catapult ~ Katapult, clavier ~ Klavier, thon ~ Ton,
  carton ~ Karton), and elf (= elf, eleven) is not banned for Elfe.
- The matcher accepts and rejects also_right forms in their own forms
  (plural, verb form), so a name whose verb is a natural clue stays out
  (Rodel: rodeln for Schlitten; Nuckel: nuckeln for Schnuller).

## Method

1. **Translate the English list** (989 words): each English word got a German
   candidate, kept when it is a good German secret (804 are in the list), or
   listed in `dropped.tsv` with a reason (185: multi-word or regional
   in German — pancake, cream, armchair, hopscotch, graduation —, vulgar
   second meanings — tail, lick, seed —, inflected forms — kite = Drachen,
   kitten = Kätzchen —, unknown — leprechaun, ogre —, near duplicates —
   alligator, quill —, and 151 trimmed for size, below).
2. **Add German everyday words** (Brezel, Currywurst, Schultüte,
   Adventskranz, Gartenzwerg, Kuckucksuhr, Laterne, Schlitten, Lederhose,
   Dirndl, Purzelbaum, Schnitzeljagd, Schornsteinfeger, Spielplatz,
   Zebrastreifen, Gänsehaut, Muskelkater…): 1,297 candidates in all.
3. **Trim to 1,000** by reading the whole list per category and cutting the
   least central words (`trimmed.txt`): rarer animals (Gecko, Hyäne, Kobra),
   specialist food (Hefe, Lauch, Sellerie), compounds whose parts are the
   natural clues (Rolltreppe, Briefmarke), job names few kids use
   (Bibliothekar, Hebamme), weak verbs (erröten, schrumpfen).
4. **Difficulty**: "how hard to guess from one-word clues". Started from the
   English tag, then by hand: compounds whose parts are the natural clues go
   up (Meerschweinchen, Nilpferd, Wassermelone, Zahnarzt: medium), two
   meanings go up (Tor, See, Schwester, Blatt), abstract or scattering
   words are hard (Morgen, Preis, Märchen, Gedicht, Pause, Strom), and
   everyday nouns with many obvious clues are easy.
5. **Spelling check** (`build.mjs --review`): every secret against the
   igerman98 Hunspell dictionaries (de_DE, de_AT, de_CH: a stem, a stem plus
   one suffix rule, or two known parts). The 13 it does not know are all
   correct (Burger, E-Mail, Heißluftballon, Knete, Kreuzworträtsel, Ninja,
   Pfeife, Schneeballschlacht, Sonnenuntergang, Spiegelei, T-Shirt, U-Bahn,
   U-Boot). The same report shows Wiktionary's regional
   labels for every word and its also_right forms, and subtitle frequency,
   both read by hand (the labels are noisy: they cover all senses).
6. **Matcher checks** (with the real German matcher and lexicon):
   - `test/words-de.test.ts`: every secret cleans, is rejected as its own
     clue and judged right as its own guess; every also_right form is judged
     right and rejected as a clue; every banned form is rejected. Passes.
   - Short secrets (`short-secrets.ts`): the lexicon words that contain a
     secret of ≤ 5 letters. Nearly all hits are the rule working
     (Eisbär for Eis, Torwart for Tor, Fahrrad for Rad) or words nobody
     writes as a clue (romantisch for Tisch, gestern for Stern, Matrose for
     Rose, Teenager for Tee). `plausible-clues.tsv` (606 natural clues for
     43 short secrets, compounds included on purpose) → `plausible-rejected.tsv`.
     No short secret dropped.
   - Fair clues (`fair-clues.ts`): 108 of 4,855 rejected. 62 are also_right
     synonyms (Oma: Großmutter, Toilette: Klo; intended), 37 compounds,
     parts and containment (Fußball for Ball, Ecken for Dreieck; the rule),
     8 family (Freundschaft, Frisur, Kater/Katze, Rätsel/raten), 1 labelled
     plural (Versteck for Verstecken). Removed on the way: about 280
     also_right and 100 banned entries that blocked fair clues.
   - Related pairs (`related.ts`): 218 pairs are never dealt together, nearly
     all compounds and families (Schnee/Schneemann, backen/Bäcker). Left
     over from the matcher: Bambus/Bus, Tee/Teenager, Eis/Eisen,
     Schwamm/schwimmen and Schwamm/Schwimmbad, Blumenkohl/Kohle,
     Wand/Windmühle, Falle/Fallschirm and Falle/Wasserfall.

## Sources and licences

Nothing from these is shipped or committed; they only check the hand-made
list. `fetch.sh` downloads them into `../raw/de/` (git-ignored).

| Data | Use | Licence |
| --- | --- | --- |
| igerman98 / "frami" Hunspell dictionaries de_DE, de_AT, de_CH (Björn Jacke, Franz Michael Baumann; via LibreOffice's dictionaries repository) | spelling check | GPLv2, GPLv3 or OASIS |
| Hermit Dave, FrequencyWords (OpenSubtitles 2018, `de_50k.txt`) | subtitle frequency in the review report | CC BY-SA 4.0 (code MIT) |
| German Wiktionary entries (wiktextract), fetched by `../../matching/de/fetch.sh` | regional labels in the review report | CC BY-SA 4.0 |
| `data/dict.de.txt`, the game's lexicon (from the German Wiktionary) | the matcher checks | CC BY-SA 4.0 (`dict.de-LICENSE.txt`) |

`fair-clues.tsv` and `plausible-clues.tsv` are written for this project
(the first by an LLM, from the word list only).

## Open questions

1. Regional names in `also_right` that are also fair clues elsewhere were
   left out (Sessel for Stuhl, Ferien for Urlaub, Kraut for Sauerkraut,
   Zuckerl for Bonbon, Rodel for Schlitten): the room can judge such guesses.
2. Schultüte is not a Swiss custom (but known); kept as medium.
