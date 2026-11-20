# Jinx (design)

Status: design, not implemented. "Jinx" is a working name. The game will
live in `games/jinx` (a web app on `@tvpipe/party`, like
`games/drawbluff`). The design work behind this document is in
`games/jinx/design/`: two TV mockups (`tabletop/tv.html`,
`gameshow/tv.html`, open them in Chrome), the word list (`words/`) and the
clue matcher with its tests (`matching/`).

A cooperative word game with personal scores for 3–8 players, in
English. It takes the general idea of *Just One*: one player guesses a
word from one-word clues, and identical clues cancel. The rest is our
own: the game decides which clues are the same, the guesser picks
whose clue to turn, a pot shrinks with every card, clue-givers can bet
on a clue, the guess is typed live on the TV, and the evening ends with
awards and a web of every word and clue.

The TV is the table everybody watches. The phones hold what is secret:
the word (clue-givers), the clue being written, the guess being typed.

## 1. A round

```
hot seat ─▶ writing ─▶ jinx check ─▶ reveal ─▶ verdict ─▶ replay + MVP clue ─▶ scores
  4 s        ≤ 45 s       ~6–12 s      ≤ ~2 min    ~6 s       ≤ 20 s              ~5 s
```

- **Hot seat.** One player is the **guesser**, in turn. Everybody else is
  a **clue-giver** and sees the secret word on their phone. The TV never
  shows the word before the verdict, and the guesser's phone never does.
- **Writing (45 s, ends early when all clues are in).** Each clue-giver
  types one clue. With 3 players each clue-giver writes two. A clue may
  be marked **bold** (§4). Clues that break the rules against the secret
  word are rejected on the phone with the reason and the player types
  again (§5.3). Nothing about collisions between clues is shown or hinted
  while writing: the TV only shows who is done. Clues cannot change after
  the timer.
- **Jinx check.** All clues lie face down on the TV with their authors.
  Clues that are the same (§5.2) fly into each other and shatter, with the
  reason ("PLURAL", "SAME WORD × 3"). Everyone sees whose cards died, no
  one sees the words.
- **Reveal.** The surviving cards stay face down. The guesser picks on
  the phone which card to turn next ("Anna trusts… Ben"). After any card
  the guesser may guess once, or pass. While the guesser types, every
  letter appears on the TV as it is typed, deletions included. The room
  must stay silent.
- **Verdict.** The word comes out, the guess is judged (§5.4), points
  are paid (§4).
- **Replay.** All clues face up with their authors, the jinxed ones
  taped back together ("3 of you wrote LAVA"). After a right guess the
  guesser picks the **MVP clue** on the phone.
- **Scores.** Personal points, and the room's count ("6 of 8 words").

If every clue is jinxed, the round goes straight to the verdict: the word
counts as missed, nobody scores.

## 2. A game

- **Players: 3–8.** The game has as many rounds as guessers: every player
  guesses once with 6–8 players, twice with 3–5 (a host setting can
  change it: once, twice). A game takes about 10–20 minutes.
- **Guesser order:** the join order, rotated by one each game.
- **Joining late:** from the next round, appended to the guesser order
  (the game gets one or two rounds longer). A player who leaves is
  skipped as guesser; a clue-giver who is gone when writing ends simply
  has no card.
- **End of the game:** the room's result first, then the MVP of the
  night, then the awards, then the word web (§6). The VIP's phone offers
  "Play again".

## 3. Timers

| Moment | Time | When it runs out |
|---|---|---|
| Writing | 45 s (host setting: 30 / 45 / 60 / 90) | clues not submitted are lost (no card) |
| Reveal: each decision (turn a card or guess) | 30 s | a random face-down card is turned; after the last card, a pass |
| Reveal: once the guesser starts typing | at least 15 s left | the draft is submitted as the guess, if any letters, else a pass |
| MVP clue | 20 s | no MVP clue this round |

A guesser who is disconnected at the start of the reveal gets the same
timers: the game goes on without them.

## 4. Scoring

Small whole numbers, so the pot can be a tower of chips (one chip, one
point).

**The pot** starts at **10**. It loses **1 per jinxed clue** (at the jinx
check) and **2 per turned card after the first**. It never goes below
**2**: a right guess always pays something.

| Who | When | Points |
|---|---|---|
| Guesser | right | the pot |
| Guesser | wrong | −2 |
| Guesser | pass | 0 |
| Clue-giver | the card was turned before a right guess | +2 (bold: +4) |
| Clue-giver | the card was jinxed | 0 (bold: −2) |
| Clue-giver | the card was not turned, or the guess was wrong | 0 (also bold) |
| Clue-giver | the guesser picked it as MVP clue | +3 |

The tension this sets up:

- The guesser wants to guess early (the pot shrinks), the clue-givers
  want their card turned (only turned cards pay). Who the guesser trusts
  first is a public statement; the MVP clue pays the clue that helped.
- The obvious clue helps most but jinxes most. Bold is the bet on it:
  "nobody else will write this, and it will be turned".
- A wrong guess costs the guesser and pays no one, so passing after the
  last card is a real choice.

**The room** counts words found ("6 of 8"). The end screen gives it a
title: 100 % *Telepaths*, ≥ 75 % *Mind readers*, ≥ 50 % *In sync*,
≥ 25 % *Mixed signals*, below *Total jinx*.

## 5. Words and clues

### 5.1 The secret words

`data/words.txt`: about 1,000 English words, one per line:
`word<TAB>difficulty<TAB>category<TAB>also_right<TAB>banned` (the last two
optional, comma-separated). Built and curated in `games/jinx/design/words/`:

- Selected from open data on how widely known, how concrete and how
  early learned a word is (Lancaster Sensorimotor Norms, Glasgow Norms,
  CYP-LEX, Open English WordNet: all CC BY 4.0; SCOWL for US/UK spelling
  splits), then a curation pass, then a read of the whole list by hand.
  The pipeline reruns from the raw data; the raw data is not committed.
  Non-commercial datasets (word prevalence, SUBTLEX-US) feed nothing.
  The sources are credited in the game (`CREDITS.md`).
- Rules for a word: everybody at a casual party knows it instantly (kids
  from about 10, fluent non-native speakers, US and UK), several obvious
  clues and room for creative ones, one word, no plurals or inflected
  forms, no proper nouns or brands, nothing sexual, tragic or political
  (knife, sword, skull, zombie, police are in; alcohol, guns, death,
  religion, kiss are out), no US/UK split meanings or spellings (pants,
  chips, color).
- A short word stays even when ordinary words contain it by accident
  (car in carpet, lion in million): nobody writes those as clues, and a
  rejected clue is only retyped (§5.3). It is left out when a natural,
  fair clue for it would be rejected.
- `also_right`: guesses that also count (bbq for barbecue, bike for
  bicycle). `banned`: clues that are rejected as "too close" (obvious
  translations: chat for cat).
- **Dealing:** difficulty is a host setting. *Easy*: easy words only.
  *Normal* (default): easy and medium, about 2:3, and one hard word in
  ten. *Hard*: medium and hard. A game never deals two related words
  (fire and firework, sea and ocean: the word notes list them). A room
  deals no word twice until it dealt them all, across games (the host
  page keeps that in `localStorage`, as Drawbluff does with prompts).

### 5.2 When two clues are the same (jinx)

The rules are deterministic and run in the host page. Each pair of clues
is checked in this order; the first rule that applies is the reason the
TV shows. The matcher's full specification, with every table, is
`games/jinx/design/matching/SPEC.md`; the prototype is `match.ts` with
461 known-answer cases.

**Cleaning** (on every clue and guess): Unicode NFKC, lowercase, accents
off (café = cafe), punctuation off (U.S.A. = usa), spaces and hyphens do
not matter (ice cream = ice-cream = icecream), runs of 3+ letters shortened
(hmmmm = hmm), a leading a/an/the/to off when there are two words, number
words to digits (seven = 7; 007 stays 007). A clue is one word; two
words are allowed and joined (ice cream, New York), three are rejected.
At most 24 characters. Emoji in a word clue are decoration; a clue of
only an emoji matches only the same emoji.

| # | Rule | TV | Same | Not the same |
|---|---|---|---|---|
| 1 | same after cleaning | SAME WORD | Cat/CAT, ice cream/icecream | |
| 1b | same number | SAME NUMBER | 7/seven, 1st/first | 7/007 |
| 2 | UK/US spelling, ph = f | OTHER SPELLING | colour/color, mum/mom | four/for |
| 3 | plural | PLURAL | glass/glasses, mouse/mice | news/new |
| 4 | verb form | VERB FORM | hope/hoping, swim/swam | hoped/hopped, saw/see |
| 5 | word family | SAME FAMILY | prince/princess, teach/teacher, sun/sunny, france/french | corner/corn, mother/moth, universe/university |
| 6 | typo (5+ letters, never between two dictionary words) | TYPO | chocolate/choclate | shirt/short, bear/beer |

- Grouping is **transitive**: teach ~ teacher ~ teachers jinxes all three.
  Every pair in a group keeps its reason, so the TV can explain each slam.
- **Not** the same, on purpose: homophones between clues (night/knight),
  compounds and parts (fire/firetruck), prefixes (happy/unhappy),
  synonyms and translations (cat/kitten). The game does not pretend to
  know meaning.
- Typo matching uses a **dictionary** shipped with the game
  (`data/dict.txt`: SCOWL up to size 60 with names, plus the secret words;
  about 240 KB gzipped, loaded only by the host page). Two dictionary
  words are never typos of each other.

### 5.3 Clues that are too close to the word (rejected at submit)

The clue-giver knows the word, so these are checked when the clue is
sent; the phone says why and the field stays open. Nothing is struck on
the TV.

- Rules 1–6 above against the secret word: "Too close to the word: plural".
- Sounds the same: whether for weather, knight for night, kat for cat.
- Contains the word: snowmen, t-shirt, sunflower for sun, unhappy for
  happy (but not hear for ear, giant for ant, history for story).
- Part of the word: snow or man for snowman, foot for football (but not
  land for island, plane for planet).
- The word's `banned` list.
- With 3 players: the same as the player's own other clue ("You already
  wrote that").

### 5.4 Guesses

More lenient than clues, because a refused right guess is the worst
moment of a round. Right: the same word after cleaning, other spelling,
plural, verb form, sounds the same, a typo (doubled letters from 5
letters, a wrong vowel from 6), or the word's `also_right` list. Not
right: the same family (princess for prince), a part (foot for
football), another word of similar shape (bear/beer, plane/planet). An
accepted near miss shows its reason next to the word ("≈ typo").

## 6. The end of the game

1. **The room:** "6 of 8 words", the room's title (§4), the words of the
   night as cards (missed ones struck).
2. **MVP of the night:** the highest score; ties go to more MVP clues,
   then fewer jinxed clues. Shown with a stat line ("41 points · 3 MVP
   clues · never jinxed").
3. **Awards** (each only when someone qualifies, at least 2):
   - **Mind meld:** the pair whose clues jinxed together most often.
   - **Lone wolf:** most clues that survived and were turned before a
     right guess.
   - **Kamikaze:** most jinxed clues.
4. **Word web:** every word of the evening as a card, the clues as tags
   around it, and red yarn between a word and every clue the room used
   for more than one word (by the clue's cleaned form). Clues used only
   once stay small next to their word, so the web is never empty.

## 7. The TV

Both mockups are worth opening; the game takes the **tabletop** as its
look and the **game show's** pacing and voice.

### 7.1 Look: a game table seen from above

- A deep teal-green felt (`#1f4744`), one flat colour. Every piece of
  information is an object on it: clue cards (tomato backs with a
  cream **J** diamond; bold cards ink-black with a gold flame sticker;
  cream faces with the word in ink), poker-chip avatars, the pot as a
  tower of gold chips with a cream number label, a kraft envelope with a
  wax seal holding the word, a kitchen dial timer, rubber stamps (JINX!,
  RIGHT!, NOT IT, LOCKED IN), masking-tape labels for reasons, a spiral
  score pad, a red label-maker tape for the guess, an MVP rosette, red
  yarn and push-pins for the word web. Wooden letter tiles for the logo.
- Palette, type and object sizes: `games/jinx/design/tabletop/README.md`
  §2–§4. Type is IBM Plex Sans (and Plex Mono for the tape, the timer
  and the room code), shipped with the game. A handwritten face for the
  clue words is an option for later; it needs the human's OK.
- **Avatars:** each player draws a face on the phone in the lobby
  (Drawbluff's canvas, one ink colour, a few seconds) and it is printed
  into the centre of a chip in the player's colour. A shuffle button
  gives a ready-made face (and bots get one). The chip carries state: a
  crown (VIP), a blindfold (the guesser during writing), a wiggling
  pencil (writing), a ✓ (done), moods (happy, shocked, sad).

### 7.2 Motion and voice, from the game show

- **The host line:** one line of copy on a strip of masking tape under
  the header that changes with each beat, in a cheeky voice that is
  never mean, never tells the guesser anything and never asks the room
  to speak ("One word each. Don't think alike.", "Same clue? Both cards
  go up in smoke.", "SO CLOSE. SO WRONG."). Big moments land in **two
  hits**: "ANNA TRUSTS…", 650 ms of nothing, "BEN".
- **The hot seat:** a short round intro: the guesser's chip in a light
  pool in the centre, "ANNA IS IN THE HOT SEAT", the blindfold drops on.
- **Phase changes** without a wipe: objects are swept off and dealt onto
  the table. The round title ("ROUND 3", "JINX CHECK") is a rubber stamp.
- **Silence under the typing:** while the guesser types, the sound bed
  stops and only a heartbeat and the label-maker clicks are heard.
- **A light pool** (a flat lighter disc on the felt) that moves to what
  matters (the hot seat, the card being turned, the MVP), in place of the
  game show's spotlights.

### 7.3 The three big moments

1. **The jinx:** the matching cards lift, accelerate into each other and
   slam (a short table shake, a dust puff, a low thud), shatter into
   paper shards that fall with gravity, a JINX! stamp lands with the
   reason on tape, a bold author's −2 floats up, a chip falls off the
   pot. Several groups play one after another, each faster. No jinx: a
   gold CLEAN! stamp.
2. **The guess and the verdict:** the SHHH! sign swings down, every
   letter is punched into the label tape as it is typed, the tape is
   snipped, a drumroll while the envelope shivers, the word rises out of
   it. Right: a RIGHT! stamp, paper confetti, the pot pours chip by chip
   into the guesser's chip. Wrong: a NOT IT stamp, a trombone, the chips
   tumble off the table.
3. **The MVP of the night and the word web:** the winner's chip drops
   onto a pedestal in the light pool, a ribbon unfurls; then the evening
   as a red-yarn board, drawn string by string. It is the closing frame
   people take a photo of.

The card turn is the most frequent beat: quick and satisfying (about
2 s from the pick to the chips), not spectacular.

### 7.4 Built for the stream

The TV page is rendered in a headless Chrome and H.264-encoded at about
30 fps ([`playshare-design.md`](playshare-design.md) §9):

- A 1280×720 layout (it renders sharper at 1080p and 4K), one screen, no
  scrolling, everything inside a 5 % safe area (x 64–1216, y 36–684).
- Nothing under 24 px; clue words 40–44 px, shrinking to 24 px, then
  condensed (`scaleX` ≥ 0.74) so 15 letters fit on a card. 5–7 surviving
  cards use two rows.
- Flat colours and hard edges, short shadows; no grain, noise, fine
  patterns or large gradients; few, big particles.
- Only transform and opacity are animated (plus small clip-path and
  stroke wipes), with the Web Animations API, no library, no canvas.
  Full-frame motion is limited to short table shakes (at most three per
  round). No idle loops on large areas.
- Nothing important faster than about 6 frames.
- Sound is synthesized with Web Audio (no audio files) and routed
  through `captureAudio`; the recipes are in both READMEs. The host
  page's preview is muted (`#mute=1`, as Drawbluff).
- The TV animates the difference between two views and holds every final
  state statically, so a TV that reconnects renders the current state
  without replaying anything.

## 8. The phones

| Phase | Clue-giver | Guesser |
|---|---|---|
| Lobby | name, draw your face (or shuffle), "Look at the TV!"; the VIP starts from 3 players | |
| Hot seat | "Anna guesses. Get ready." | "You're in the hot seat. Don't look at anyone's phone." |
| Writing | the word on an index card, one field, the bold flame toggle, Send; a rejected clue shows the reason and stays editable; then "Sent: BEACON 🔥" | "Eyes on the TV: your friends are writing", who is done |
| Jinx check | your card's fate ("JINXED with Esme: plural"), not the other words | "3 clues survived · 4 were jinxed" |
| Reveal | the cards (face down or turned) and "Shh, no hints!" | the face-down cards as buttons with their authors' faces, the pot, the guess field, Pass |
| Verdict | your points and why ("Your card was turned · bold ×2") | ✓ or ✗, the word, the points |
| Replay | the replay; "Anna is picking the MVP clue…" | all clues as buttons: "Which clue helped most?" |
| Scores | your rank and total; "You're up next!" for the next guesser | the same |
| End | the room's result, your line, your award; the VIP: Play again | the same |

## 9. Shape of the code

As drawbluff: `game/` (the rules: `rules.ts`, `match.ts`, `game.ts`, bots;
TypeScript on `@tvpipe/party`, tested in Node), `host/` (the host page:
the party, the TV, the players, settings: rounds, writing time,
difficulty), `screen/` (the TV page), `phone/` (the phone page), `data/`
(`words.txt`, `dict.txt`, fetched by the host page), `CREDITS.md`.

- The host page runs all the rules and matching; phones and the TV only
  show views and send actions.
- `screen` view: the phase, the cards (authors, bold, face down or the
  word once turned or in the replay), the jinx groups with their
  reasons, the turn order, the pot, the **guess draft**, the scores. The
  word only from the verdict on.
- The guess draft: the guesser's phone sends its field's text as an
  action on every change (throttled to about 20 per second); the host
  copies it into the screen view. Only the submitted guess is judged.
- Bots (for tests; the host page shows their buttons only with
  `?bots`) write clues from a
  per-word list of plausible clues, so jinxes happen, and guess the word
  after a random number of cards.

## 10. Open

- The name: check "Jinx" against existing party games before it is
  published.
- The numbers in §4 (pot 10, −2 per card, bold ±, MVP +3) are a first
  guess: play-test them with bots and people.
- The word family rule's not-derived list will need entries from real
  play ("same family" where players disagree).
- More languages later: the cleaning is English-specific (number words,
  plurals, families, the dictionary), the rest of the game is not.
