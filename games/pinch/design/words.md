# Pinch: notes on the words

For whoever writes the next lines. Everything Pinch says lives in
`game/words.ts` (the ticker, claims, intertitles, the tape, outcomes,
awards, the phone) and `game/items.ts` (the catalogue).
`test/words.test.ts` checks both languages; run `npm test`.

## The voice

A 1920s heist drawn like a 1960s spy cartoon. The narrator is a
security teletype and a silent-film title card who has seen it all:
**deadpan, dry, a little smug, fast**. It states the facts and lets one
small detail do the joke. It never explains the joke or uses an
exclamation mark to sell it (it uses one when somebody should *run*).

**Anachronisms are the house joke**: a GPS tag "patent pending", a
Walkman "for when they invent tapes", a microwave that "reheats the
future", moon rock "a souvenir from 1969", a car alarm that chirps
"sixty years early". Use them as asides, never as the whole line.

Examples:

- `CAMERA 2: snow on the screen. It is not snowing.`
- `Ben: the library is clear. Ben seems sure.`
- `One firecracker sent three guards to the kitchen.`
- `Your inside man swears by it: Maharaja's Ruby, in the east wing. He swore about the dog, too.`
- `KAMERA 2: Schneegestöber. Draußen schneit es nicht.`
- `Ben meldet: Posten am Nordtor. Da war Ben nie.`
- `TELEGRAMM: RUBIN DES MAHARADSCHAS IM OSTFLÜGEL STOP TELEGRAMM AUFESSEN STOP`
- Catalogue: *Gold Toilet Brush — Lightly used*; *Schubkarre voll Inflationsgeld — Die Schubkarre ist mehr wert*.

## Rules

- **Two languages, written separately.** German is not a translation:
  its own jokes and its own 1920s (Schupo, Ganove, Langfinger, Funzel,
  Kittchen, Knallfrosch, Inflationsgeld). An item keeps its id, value,
  size and places in both languages but may be named its own way
  (*Crate of Prohibition Gin* / *Kiste Schwarzgebrannter*).
- **Own jokes only.** No catchphrases or lines lifted from films, TV or
  books, no spy-show quotes. Family-friendly-ish: no slurs, no bodies, no
  real living people (long-dead names like Rembrandt or Tutankhamun are
  fine).
- **Facts and claims stay apart.** Facts (the teletype) are true and
  start with a capitalised keyword (`ALARM`, `MISSING`, `LICHT AUS`).
  Claims are what a guard says, always `Name: …`, and may be lies; their
  asides doubt them gently ("Allegedly."), never reveal the truth.
- **Tips name a building's half** ("the east wing", "of the guest house"
  on a lot with two), never the garden: loot is never outside.
- **Never leak.** A line only names what the game made public: a fact
  never names a guard's position, a claim never says whether it is true,
  only the tape does.
- **Limits** (tested with names of 8 characters, every room variant,
  numbered rooms and every item): a ticker line ≤ 70 characters (asides
  are dropped when they would not fit), a phone button ≤ 14, a refusal
  ≤ 32, captions and outcome lines ≤ 100, item names ≤ 32, notes ≤ 40.
- **Neutral about the people.** Players are named, never gendered:
  "Anna", not "she"; in German use the name or the role words
  *Langfinger* and *Wache*, never "der Dieb/die Diebin".
- **Places come in forms.** Write `${where.the}`, `${where.in}`,
  `${where.to}`, `${where.label}`: the noun builder does the articles,
  prepositions and German cases (*im Billardzimmer*, *auf dem Rasen*,
  *ins Badezimmer*, *an der Tür zur Bibliothek*). Never glue an article to
  a place by hand.
- **Items without articles.** Item names are catalogue labels ("Maharaja's
  Ruby", "Fabergé-Ei"), so templates use them label-style
  (`MISSING in the vault: Maharaja's Ruby.`, `Ein Vögelchen zwitschert:
  Rubin des Maharadschas, im Ostflügel.`): after a colon or a dash, after
  "a certain", or in a telegram's capitals, never "the ${item}" (tested).
  So names carry no leading article and no comma ("Rembrandt (Probably)",
  "Herzog mit Doppelkinn (Öl)"). `PINCH_WORDS_SAMPLE=1 npm test` prints
  every such template with a few items to read through.
- **Counts as words.** "three guards", "zwei Wachen", "one pace",
  "einen Schritt" come from the helpers; German verbs agree with one or
  many.
- **Variants.** Anything said more than once a game has at least two
  variants (briefings and tips four or more) and the tests require it.
  A new variant must work with every room, item and typical name.
- **The counts are fixed and tested:** 60 items, 30 estates per
  language, 5 awards, 3 how-to steps.
- **Values.** $200–$25,000; most items under $1,600, a few over $10,000.
  Items from $5,000 can carry a tag; pedestal items are worth $7,000 or
  more. Every room kind has at least three loose items; cases, safes and
  pedestals have at least three items in each room the map may put them.
- **Typography.** Proper umlauts and ß, NFC, the ellipsis character `…`
  (German with a space before it), German quotes „…“ and ’.
