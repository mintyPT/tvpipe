# Jinx: clue cleaning and matching (German)

Status: implemented (`game/match-de.ts`, tests in `test/match-de.test.ts`),
next to the English matcher (`../SPEC.md`, `game/match.ts`). Both have the
same API and the same reasons; `game/lang.ts` picks one per room. This
document says what is different in German and why; everything it does not
mention works as in English (the three biases: strict between clues, medium
against the secret word, lenient for guesses; transitive grouping; the
submit check; emoji and symbol clues).

## 1. Why German needs a lexicon

English gets by with rules: a few endings (-s, -es, -ed, -ing), a table of
~200 irregular forms and a curated list of words that only look derived
(corner is not corn + er). German does not:

- **Every noun has its own plural**, and the ending does not tell which:
  Hund/Hunde, Haus/Häuser, Mutter/Mütter, Auto/Autos, Museum/Museen,
  Lehrerin/Lehrerinnen, Bäcker/Bäcker. Case adds more (Hundes, Häusern).
- **Verbs have ~30 forms**, strong verbs with vowel changes: laufen, läuft,
  lief, liefe, gelaufen; gehen, ging, gegangen; sein, bin, war, gewesen.
  Separable verbs split in a sentence and join in the participle
  (aufstehen, steht auf, aufgestanden).
- **Adjectives decline and compare**: rot, rote, roten, röter, rötesten;
  hoch, hohe, höher, höchste; gut, besser, beste.
- **Endings collide with words**: a rule that strips -e finds Reis in Reise,
  Schal in Schale, Rind in Rinde, Not in Note, Kart in Karte, taub in Taube;
  a rule that strips -en finds a verb in every second noun (Planet/planen,
  Wiese/weisen, Eisen/Eis). The Wiktionary even lists some of them as real
  forms (Reise is an old plural of Reis, Schale a rare one of Schal).

So the forms come from a **lexicon**, and the rules only do what a lexicon
cannot: compounds and unknown words.

## 2. The lexicon (`data/dict.de.txt`)

Built by `build-lexicon.ts` from the German Wiktionary (kaikki.org's
wiktextract dump of de.wiktionary.org; CC BY-SA 4.0, see
`dict.de-LICENSE.txt`), with OpenSubtitles frequencies (Hermit Dave's
FrequencyWords, content CC BY-SA 4.0; only used to choose, no counts ship) deciding what goes in:

- **47,500 lemmas** (nouns, verbs, adjectives, names of places, and
  function words for "known") whose forms occur at least 20 times in the
  subtitles, plus every secret word and `also_right` form of
  `words.de.txt`. 217,000 stored forms; 1.5 MB, **343 KB gzipped** with the parts
  (English: 242 KB). Loads in ~100 ms into ~195,000 map entries.
- **Forms**: nouns' case forms and plurals, verbs' finite forms (present,
  past, subjunctive, imperative) and participles, adjectives' comparison
  bases. Regular declension endings (-e, -em, -en, -er, -es) of adjectives
  and participles are not stored; the matcher strips them and looks up the
  base. Dropped: forms tagged variant, archaic, obsolete, rare, regional or
  colloquial, and the old dative -e (dem Hunde).
- **Homographs** (§1's collisions): a form that is a lemma of its own of
  the same part of speech, and not of the same family, belongs to that
  lemma (Reise is not Reis's plural, Schale not Schal's, lauter "pure" not
  laut's comparative). Imperatives, subjunctives and bare stems give way to
  a lemma of any part of speech (Planet is not "ihr planet", Eis not
  "eis!", Wein not "ich wein'"). Common forms do not give way: sang stays a
  form of singen, Schwamm and schwimmen jinx (§7).
- **Families**: which lemma derives from which, from three sources:
  etymology sections ("Ableitung vom Stamm des Verbs backen mit dem
  Derivatem -er", only derivations, not compounds; the base must be linked
  and start like the word), the entry's own feminine and diminutive forms
  (Hund names Hündin and Hündchen; Lehrerin names Lehrer), and
  "Wortbildungen" lists filtered to base + suffix (Läufer from laufen,
  freundlich from Freund; not Hühnerei from Huhn, which is Hühner + Ei).
  `family-deny.tsv` removes links players would not call a family
  (Zeitung/Zeit, still/stellen, Messer/messen: the Wiktionary's second
  Messer is "der Messende").
- **Parts**: what a compound is made of, from its etymology
  ("Determinativkompositum aus Schnee und Mann", "gebildet aus der Partikel
  weg … und dem Verb laufen"): 8,600 lemmas. The parts must be the word's
  start and end (the dump sometimes gives a compound its head's etymology:
  Kühlschrank gets Schrank's). 9,800 lemmas are marked as no compound: the
  etymology says derivation or loan (Unglück, Sandale, Tornado, Matrose)
  and is the word's own, not its head's.

Format, one line per lemma and part of speech:
`lemma<TAB>pos<TAB>forms<TAB>family<TAB>parts`. Forms are written against the
lemma: letters to drop from its end, then the rest (`hund` with `e` is
hunde, `haus` with `3äuser` is häuser). Nouns and names: `singular
forms|plural forms`; verbs: `finite forms|participles`; adjectives: the
comparison bases. `pos` is n, v, a, e (place), x (other); `n*` is a noun
declined like an adjective (der Alte, ein Alter). `parts` is `schnee+mann`,
`-` for no compound, or empty.

## 3. Cleaning

As English (`../SPEC.md` §3), except:

| Step | German | Example |
| --- | --- | --- |
| letters | a–z, ä ö ü ß and digits; ä ö ü ß **stay in the key**; other accents go | Bär → bär, Straße → straße, Café → cafe |
| not letters | "Nur Buchstaben und Ziffern" | кот |
| articles | a leading der/die/das/den/dem/des/ein/eine/…/am goes when there are two words | der Hund → hund, am besten → besten |
| separable verbs | two words whose second is a verb particle join particle first | steht auf → aufsteht (a form of aufstehen) |
| numbers | German number words, written together or apart | einundzwanzig, zweihundertdrei, neunzehnhundert, zwei Millionen |
| ordinals | erste/r/s … zwanzigste, and "3." typed with its dot, are `3.` | erste = 1., dritter = 3. |
| symbols | € euro, £ pfund, % prozent, & und, ° grad, § paragraf | |

"ein" and "eine" alone stay words (they are articles more often than
numbers).

## 4. Clue vs clue

| # | Rule | Reason (TV) | Jinx | Must not jinx |
| --- | --- | --- | --- | --- |
| 1 | same key | gleiches Wort / gleiche Zahl | Hund/HUND, Eis-Bär/Eisbär, sieben/7, erste/1. | 7/007 |
| 2 | same spelled form: ä = ae, ö = oe, ü = ue, ß = ss, ph = f, th = t, foreign c = k/z, a table (Joghurt/Jogurt, Portemonnaie/Portmonee, Ketchup/Ketschup) | andere Schreibweise | Bär/Baer, Straße/Strasse, Delfin/Delphin, Zirkus/Circus | |
| 2b | the umlaut left out, unless both are words | andere Schreibweise | Schlüssel/Schlussel | Bar/Bär, schon/schön |
| 3 | one is a form of the other (or both of one lemma): plural | Plural | Hund/Hunde, Haus/Häuser, Museum/Museen, Schneemann/Schneemänner | Reis/Reise, Schal/Schale, Rind/Rinde |
| 4 | … a verb form | Verbform | laufen/lief/gelaufen/läuft, aufstehen/steht auf, gelaufen/gelaufene | Planet/planen, Wiese/weisen |
| 5 | … another form (declension, comparison, case) | andere Form | rot/rote, gut/besser/beste, groß/größte, Hund/Hundes | |
| 6 | same family: one derives from the other (two steps), both derive from one word (siblings), or one family group | Wortfamilie | Lehrer/Lehrerin, Katze/Kätzchen, Bäcker/backen/Bäckerei, Fahrer/Fahrt, Sonne/sonnig, frei/Freiheit, groß/Größe, Lauf/laufen, Frankreich/französisch | Zeit/Zeitung, Messer/messen, Kind/Kindergarten (compound) |
| 7 | typo: as English, on a QWERTZ keyboard (z next to u and t, y next to x, ü ö ä next to p, l, ö; an umlaut next to its vowel) | Tippfehler | Schokolade/Schokolode, Krokodil/Krokodiel | Hose/Rose, Kiste/Küste (two words) |

Two words that are lemmas of their own and meet only as forms of a third
are those words, not forms (Reise and Reis are both forms of reisen: "ich
reise", "reis!"). Two lemmas where one is also a form of the other are a
family (Lauf is "lauf!" of laufen; Fliege and fliegen): the TV says
Wortfamilie rather than Verbform.

Not jinxes, as in English: compounds and their parts (Feuer/Feuerwehr,
Kind/Kindergarten, Eis/Eisbär), prefixes (Glück/Unglück,
laufen/weglaufen), homophones between clues (Meer/mehr), synonyms and
translations. Cousins are not a family (langsam and Länge are siblings via
lang and do jinx; their derivations would not).

### Compounds

German writes compounds as one word and makes them up on the spot, so the
lexicon cannot list them. A word the lexicon does not know is split: the
**longest known word at the end** (the head, which German inflects) after a
**known first part** (a word, a word with a Fugen element: Sonne-n-,
Arbeit-s-, Hund-e-, Kind-er-; a noun without its -e: Schul-; a verb stem:
Back-, Wander-; or a compound of those). The compound inflects as its
head: Schneemänner = schnee + männer (Mann, plural) → Schneemann, plural.
Its family is its head's, prefixed (Bergsteigerin → Bergsteiger). A
compound with a noun head counts as a known word for typos (two words are
never typos of each other); "Flugzeig" (Flug + zeig, a verb) does not, so
it is a typo of Flugzeug.

### Without the lexicon

The matcher works without `dict.de.txt` (tests, or if it fails to load),
with rule-based endings (-s, -es, -n, -en, -e, -er, -ern, -nen) on both
sides, like English's candidate sets: plain plurals jinx, irregular ones
and families do not, and typos are not blocked between real words.

## 5. Clue vs secret word

`invalidClue`, in order: rules 1–6 of §4, the umlaut left out even
between two words (Bar for Bär), sounds the same, typo, containment, then
the word list: a `banned` word (a translation) only as written or spelled
otherwise (bell for Glocke must not reject bellen, nor rocket Rock), an
`also_right` word (an accepted guess) also in its forms (Velos for Velo),
never its family, parts or typos (Flieger for Flugzeug must not reject
fliegen).

**Sounds the same**: a homophone table (Stadt/statt, Mann/man, das/dass,
ist/isst, …) and a sound key: ä = e, äu = eu, ai = ei, ie/ih = i, a
lengthening h is silent, aa/ee/oo are one vowel, final b d g are p t k, v =
f, ck = k, dt = t, tz = z, chs/x = ks, qu = kw, y = ü, -ig = -ich. Doubled
consonants stay (Ofen is not offen). Meer/mehr, Wal/Wahl, Rad/Rat,
Seite/Saite, Lid/Lied, Fogel/Vogel, Fuks/Fuchs, Artzt/Arzt.

**Containment**, the most German rule (closed compounds everywhere). When
the lexicon knows what a word is made of, its parts decide (and the parts
of its parts: Feuerwehrauto has Feuer): Reisepass is Reise + Pass, not
Reis; Butterbrot has no rot. When it knows the word is no compound, nothing
is contained (Sandale, Tornado, Matrose, Kamerad). Otherwise the rule:

- the clue contains the secret: it starts with the secret as a compound's
  first part (with its Fugen and its plural: Sonnenblume, Kindergarten,
  Hühnerei, Arbeitsplatz, Schulbus, Schifffahrt) and the rest is a word, or
  ends with it after a known first part or a prefix (Eisbär, Zahnbürste,
  Unglück, weglaufen). Every reading of an inflected clue must contain it
  (Schneemänner reads Schneemann).
- the secret contains the clue: Schnee, Mann for Schneemann; Blume for
  Sonnenblume; Ball for Fußball; Hände for Handschuh.
- with the lexicon the rest must be a content word (a noun, adjective or
  verb, or their forms; not a function word or a finite verb form: Sand-wich,
  Ka-merad), and a first part that is another word is that word (Reise- is
  not Reis + e): Hundert is not Hund + ert, Torte not Tor + te, Alarm not
  Al + arm. The inseparable verb prefixes are no parts (gestern is not
  ge + Stern, gering not ge + Ring). Eisen is rejected for Eis, but as a
  family (eisen, "to ice"), not as containment.
- 2-letter secrets are never checked (no Ei: Polizei, Bäckerei); the word
  list has none.

## 6. Guesses

Right: same word or number, spelling (also the umlaut left out: Bar for
Bär, Strasse for Straße), plural, verb form, word form, the female form of
a job or animal and back (Lehrerin for Lehrer, Ärztin for Arzt: the same
answer to a German group; English refuses princess for prince), sounds the
same, typo with the guess leniency (doubled letters from 5 letters, a
wrong vowel from 6: Girafe, Kugelschrieber), and `also_right`. Wrong:
family (Bäckerei for Bäcker), parts and compounds (Fuß for Fußball,
Teddybär for Bär), other words (Bier for Bär, Rose for Hose).

## 7. Known weak spots

- **Homographs are one key**: Kiefer (jaw, pine), Bank (bench, bank), Arm
  (arm, poor), Eisen (iron, "to ice"): the matcher cannot tell which one a
  player meant, so the union of their forms and families counts
  (Eisen/Eis jinx as family, Schwamm/schwimmen as verb form, Taube/taub do
  not jinx because Taube is a noun of its own).
- **The Wiktionary's families are uneven**: some derivations have no link
  (feurig/Feuer), some links are etymology players do not feel (Land and
  Landung, Brot and Brötchen are a family, which Just One's rules would
  agree with; Zeitung/Zeit was removed). `family-deny.tsv` is the place for
  more, found by reading `sweep-report.md` (`node sweep.ts`).
- **Compound splits are greedy**: the longest known head wins, which is
  right for nearly every compound; a word made of two short words by
  accident may read as a compound and so count as a known word for typos.
- **Diminutives outside the standard**: Swiss -li (Fischli) and Austrian
  -erl are not in the lexicon and not jinxed with their base.
- **Phonetic misspellings** beyond the sound key are missed, as in English.
- Words outside the lexicon get the rule-based endings only.

## 8. Files

| File | What |
| --- | --- |
| `game/match-de.ts` | the matcher (same API as `match.ts`) |
| `test/match-de.test.ts` | known answers (needs `data/dict.de.txt`) |
| `fetch.sh` | downloads the Wiktionary dump and the frequencies into `../../words/raw/de/` (git-ignored) |
| `build-lexicon.ts` | builds `../../../data/dict.de.txt` and `dict.de-LICENSE.txt`; `--explain WORD…` shows what it knows about some words |
| `family-deny.tsv` | family links to drop |
| `sweep.ts` | pairs of common words that jinx, by reason (`sweep-report.md`) |
| `LICENSE-NOTICE.txt` | the text of `dict.de-LICENSE.txt` |
