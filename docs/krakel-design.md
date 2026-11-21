# Krakel (design)

A drawing game for 3–10 players in `games/krakel`: a web app on
`@tvpipe/party`, like `games/drawbluff`. Everyone draws a word of the
same category, with time to do it well. Then the TV redraws each
picture stroke by stroke, always in the same time, and the others type
what it is: the sooner someone names it, the more for them and for the
artist. ("Krakel": German for a scrawl.)

It was asked for by children who wanted more time to draw than
Drawbluff gives, and to be ranked on how good their drawing is. A vote
for "the best" does not do that (it is a vote for friends, and against
whoever leads), so the ranking comes from the room's own reading: a good
drawing is one that is named early.

## 1. Why it is fun

- **Time to draw, and nobody waits.** Everyone draws at once, for one to
  three minutes, with colours, four widths, an eraser and undo.
- **Near misses.** A round's words come from one category (zoo animals:
  fox, wolf, jackal …), a different word for each player. A rough
  sketch is not enough: what tells a wolf from a fox has to be there.
- **The replay is a race.** The TV redraws the picture under a pencil,
  in the order it was drawn, squeezed or stretched to the guess time.
  The room watches a grey shape grow legs ("hippo!", "rhino!") until
  the ear gives it away.
- **Guessing is typed, and a wrong guess costs.** Guess at the grey
  shape and the phone locks for a few seconds; wait for the ear and
  someone else is first.
- **The order is a skill.** What gives a picture away should be drawn
  first; details drawn last only show at the end. The phone and the TV
  say so while everyone draws.
- **The ranking is the room's reading.** Every drawing earns its artist
  half of what its guessers earned; the round ends with the drawings in
  that order, gold, silver, bronze. One heart from everyone picks the
  room's favourite on top of that.

## 2. A round

```
start ─▶ draw (everyone at once) ─▶ per drawing: count-in ─▶ replay + guesses ─▶ the word ─▶ gallery: hearts ─▶ ranking ─▶ scores
          120 s                                   4 s          45 s (or all have it)  6.5 s      25 s            12 s        9 s
```

- **The deal.** The room's category deck deals a category (none twice
  until all were dealt, game after game), and from it a different word
  for every player: two to pick from when the category has twice as
  many words as there are players (ours always have: at least 20), else
  one. The category is on the TV and on every phone; a word only on its
  artist's phone.
- **Drawing.** The pad: thirteen pens (black, grey, eleven colours) and
  an eraser (it paints paper), four widths, undo, clear (asks once).
  Until the first stroke the word can be swapped for the other one. The
  page is kept on the phone while it is drawn (`localStorage`), so a
  reload or another app loses nothing. "Done" asks once while more
  than 15 s are left (it cannot be taken back); when time is up the
  phone hands in what there is. The TV shows who is drawing how much
  (a scribble per player that grows with their ink) and who is done,
  never what. When everyone has handed in, the round goes on.
- **On stage**, in a shuffled order, each drawing with ink (a blank page
  is skipped and earns nothing):
  - *The count-in* (4 s): whose it is, 3, 2, 1.
  - *The replay* fills the guess time (30, 45, 60 or 90 s): the drawing
    is whole after 85 % of it and stands for the rest. Time is spent by
    ink: each stroke takes the pen's way to it (45 grid units), then
    its length (a dot: 14), so a drawing of any size takes the same
    time and nothing waits for a pause the artist made. The phones show
    the same replay at the same moment (both draw `progressAt(now)` on
    the host's clock; the TV's is ahead by its own delay).
  - *Guesses* are typed on the phone and judged by the game (§3). Right:
    points by time, the phone shows them and keeps watching. Wrong: the
    phone is locked for the room's lockout (0, 2, 4 or 8 s; default 4),
    and the TV shows the guess, struck out, beside its player; a near
    miss ("so close!") is not shown: it would give the word away. The
    artist does not guess and sees who has it.
  - The replay ends when the time is up, or 0.9 s after everyone who is
    there has it.
  - *The word* (6.5 s): stamped across the sheet, the blanks filled in,
    who had it and when, what the drawing pays.
- **The gallery.** Every drawing of the round with its word and artist.
  Everyone gives one heart (not to their own; 25 s, or until all gave
  theirs; whoever has fewer than two other drawings to choose from
  gives none). Then the tiles move into the round's ranking and the
  medals land from the last place to the first.
- **Scores**, then the next round; after the last, the podium, the
  *Krakel of the game* (the drawing that earned its artist the most,
  redrawn once more) and the *sharpest eye* (the most points for
  guessing).
- **Settings** (the host page, or the VIP's phone in the lobby): rounds
  1–4 (default 2), time to draw 1, 1½, 2 or 3 minutes (default 2), time
  to guess 30, 45, 60 or 90 s (default 45), letters shown or hidden
  (§3), the lockout, and on the host page the language and whether
  latecomers join at the next round or not during a game.
- **A game** of two rounds with six players takes about 15 minutes:
  2 min drawing and 6 × (4 + ≤ 45 + 6.5) s on stage a round.
- **Leaving and joining.** A phone that drops out keeps its seat (the
  library); its drawing goes on stage without it, and nobody waits for
  its guess. Whoever was removed for good takes their drawing with them.
  Latecomers play from the next round.

## 3. Judging a guess

`judge(guess, word, lang, all)` in `game/rules.ts`, known answers in
`test/rules.test.ts`. A guess is folded (lowercase, `ß` → `ss`, umlauts
and accents off, anything but letters and digits a space) and loses its
leading article (`a`, `the`; `ein`, `der` …). It is **right** when it

1. is the word or one of its other names from the list
   (`hippo|hippopotamus`), written as one or apart (`firetruck`);
2. has the same stem (one plural or inflection ending off: `foxes`,
   `Füchse`, `Katzen`);
3. has the word inside it, for a guess of one word and a stem of four
   letters and more (`Babykatze`, `Segelschiff` for `Schiff`); or
4. is a spelling slip away: no letter off for words up to 4 letters,
   one up to 7, two from 8 (insert, delete, replace, or two neighbours
   swapped: `elefant`, `Krokodiel`, `girafe`), **unless** the guess is
   another word of the language's whole list, by its letters or its
   stem (`Laus` is not a misspelt `Maus`, `Tatze` not a `Katze`; a
   `swordfis` is still a swordfish, though it has a `sword` inside).

One slip more than allowed is **close**: the phone says so (and is
locked like after any wrong guess). A guess of several words is never
taken apart ("fox wolf dog" is wrong), so the lockout cannot be beaten
by typing every animal at once.

**Letters** (easy, the default): the TV and the phones show the word's
shape, a blank per letter (`fire truck` → `____ _____`). Hidden (hard):
only the category.

## 4. Points

| | |
|---|---|
| A right guess | 1000 at the start of the replay, falling evenly to 200 at its end (in tens), by the host's clock when the guess arrives |
| The first right guess of a drawing | +200 |
| The artist | half of what the drawing's guessers earned by time (without the +200) |
| The favourite | 500 to the drawing with the most hearts, at least two (ties split it) |

- The time is the host's when the guess arrives, not the phone's word:
  over a replay of half a minute a phone's few ms on the way cost a
  point or two, and no phone's clock has to be believed.
- The artist's half makes a round's drawing worth about a third of what
  a player can earn in it, whatever the number of players (each player
  guesses `n − 1` drawings and has `n − 1` guessers). An earlier draft
  paid the *average* of the guessers; with eight players that is a
  tenth of the round and drawing well would hardly matter.
- **The ranking of a round's drawings** is by the artist's points, then
  by how many named it, then by the first right guess; equal drawings
  share a place.
- Nobody plays against the table: the artist wants to be read, the
  guessers want to read. The only way to hurt a leader is not to name
  their drawing, which costs the same points.

## 5. Words

`data/words.txt`, `data/words.de.txt`: 22 categories each, 573 and 576
words, written for each language on its own (not translated word by
word).

```
== Zoo animals
lion
hippo|hippopotamus
polar bear|ice bear
```

- A category has at least 20 words (two to pick from for each of ten
  players) and holds things that look alike when doodled and can still
  be told apart by a detail.
- A word is concrete, drawable by a nine-year-old in two minutes, and
  spellable by one. Other names are true alternatives for the same
  thing (synonyms, regional names: `Karotte|Möhre|Mohrrübe`, short and
  long forms), never a broader word; misspellings and regular plurals
  are the matcher's job.
- A word is in one category. In a category no word or other name says
  another entry as written, so no category has both `Schiff` and
  `Segelschiff`, `ball` and `football`. `node scripts/words.ts` and
  `test/words.test.ts` check it, and that every name is right for its
  own entry and for no other of its category.

## 6. The look and the sound

A sunny desk: yellow with dots, paper cards with a fat black outline
and a hard shadow, one bouncy hand-lettered font for everything
(Shantell Sans, variable; the logo's letters bounce on its bounce axis).
Drawbluff is purple, Garble a dark cutting mat, Jinx green felt: Krakel
is the bright one.

- **The pencil draws.** On the TV a pencil follows the replay's point;
  it lifts on the way from one stroke to the next. (`cut()` in
  `game/ink.ts` gives the point and whether the pen is down.)
- **The pencil runs out.** Every clock on the TV is a pencil that gets
  shorter, with the seconds beside it; red and ticking at the end.
- **Guesses** pop up as struck-out speech bubbles in the guesser's row;
  a right one turns the row green and moves it up, in the order they
  came.
- **The ranking**: the gallery's tiles glide into their order, medals
  are stamped from the last to the first, confetti for the first.
- **Sound** (the TV page, synthesized, nothing to load): a toy
  xylophone (joins, right guesses climbing a pentatonic scale, medals,
  the fanfare), a wood block for the last five seconds, a boing for a
  wrong guess, and the pencil's scratch on paper while the replay's pen
  is down, brighter the faster it moves. The host page's preview is
  muted.
- **The phone**: the same paper and pens; the word above the pad, the
  pens below it, in reach of a thumb. It buzzes for right and wrong.

## 7. Views and privacy

The host is the only authority; phones and the TV get views
(`game/game.ts` lists them).

- A word reaches only its artist's phone until its reveal. The TV, the
  watch link and the guessers get the drawing, the artist's name, the
  replay's start and end, and (easy mode) the word's shape.
- A wrong guess goes to the TV as a transient message (`guess`: `{ id,
  text }`, through `party.moderate`); a near miss as `{ id, close: true
  }` without its text.
- While everyone draws the TV gets how much ink each player has put
  down (the phones' continuous input), never the strokes.
- Drawings are checked when they arrive (`validateDrawing`: at most 900
  strokes and 20 000 points, whole numbers on the grid, a pen of the
  palette), guesses cleaned to 28 characters.

## 8. Not done (yet)

- **More than ten players.** Every drawing needs its own time on the
  TV; a big room would need Drawbluff's spotlights (some drawings on
  stage, the rest in the gallery) or replays on the phones in groups.
- **A handicap for the leader** (fewer colours, a fat brush, a mirrored
  pad): Mario Kart's rubber band for mixed ages. The lockout and the
  typed guess already slow the fastest a little; whether that is enough
  has to be played.
- **Fill.** A bucket is not a stroke; the brush does it for now.
- **Words by age**, and more categories (jobs, school, the beach).
- **Sound on the phones.**
