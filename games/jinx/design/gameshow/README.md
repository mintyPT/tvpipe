# Jinx — the TV as a Saturday-night show

Direction: **game show / bold motion graphics.** The TV is the host, the
set and the scoreboard of a live show taped on your couch. Big skewed
slab type, a slowly turning sunburst behind everything, three spotlights
that sweep the stage and lock onto whoever matters, hard-edged shapes
with solid drop shadows, and a host voice that is cheeky but never mean.
Everything is flat colour with hard edges: it looks like a set, and it
survives H.264.

Open the mockup: **`tv.html`** in Chrome (double-click, no server
needed). Details at the end.

---

## 1. The look

### Palette (flat fills only)

| token | hex | used for |
|---|---|---|
| `--night` | `#140b34` | the studio; the only background colour |
| `--wall` | `#1c1047` | sunburst rays (low contrast against night: they move without banding) |
| `--floor` | `#26155f` | the stage disc at the bottom (a hard ellipse with a lit rim) |
| `--gold` | `#ffc928` | the show's colour: logo, the pot, wins, the leader, "the word" |
| `--hot` | `#ff2f7d` | card backs, the jinx, hot seat, podiums |
| `--cyan` | `#25e2ff` | clues and information: labels, the word web, the scanner |
| `--flame` | `#ff7a1a` | bold cards only |
| `--red` | `#ff3b3b` | the JINX stamp, wrong, struck, the last 5 seconds |
| `--lime` | `#b5f23d` | done ticks, positive deltas |
| `--ink` / `--dark` | `#fff7e6` / `#0b0620` | warm white text and card faces / outlines, hard shadows, text on light |

Mood washes change the burst and the cones, never the whole screen:
`hero` (rays lighter, cones converge), `win` (gold cones, burst spins
4× faster), `bad` (rays go wine-red, cones red). Each is one class on
`#tv`.

### Type

Only fonts we already ship (`fonts/`, copied from Drawbluff, OFL):

- **IBM Plex Sans 700, uppercase, skewed −8°** (`.slam`): every headline,
  every clue word, names. The skew is the show's motion even when nothing
  moves. Hard text shadow `0 7px 0 #0b0620` instead of a blur.
- **Michroma 24–26 px, tracked +0.1em** (`.label`): the "broadcast
  graphics" voice: ROUND 3 OF 8, THE POT, TONIGHT'S CONTESTANTS. Never
  below 24 px.
- **Plex Sans 500–700, sentence case, 30–32 px** (`.say`): the host's
  asides under the headlines.
- (Sixtyfour was tried for an LED timer: its scanlines are a fine
  pattern that smears in H.264. Dropped; the timer is Plex 700 96 px.)

Sizes at the 1280×720 layout: headlines 52–150 px, clue words 26–48 px
(auto-fit to the card, 26 px floor), names 24–28 px, labels 24 px.
Nothing smaller than 24 px anywhere on the TV.

### Shapes

- **Slabs**: parallelograms skewed −8° (plates, chips) and −14° (the
  transition wipe). Every plate has a solid offset shadow (`0 6px 0`).
- **Cards**: 20 px radius, 6 px dark outline, 9 px hard shadow. Back:
  hot pink with a `J!` mark and an inset frame; bold: flame orange with a
  flame sticker on the corner. Front: warm white, the word big and
  skewed. The author plate (avatar + name) hangs off the bottom edge
  *outside* the 3D flip, so the author stays readable while the card
  turns.
- **The pot**: a ring of 20 chunky gold segments (50 points each) around a
  dark disc with the number. Segments go dark one at a time,
  counterclockwise from 12 o'clock: you can read "how much is left" from
  across the room without reading a number.
- **Bulbs**: 26 px (header) / 54 px (finale) circles: lit gold = word
  got, red ring with a slash = missed, white ring = this round.
- **The marquee**: a pink frame of 40 chasing bulbs around the logo
  (only on the cold open; it is the one place with many small moving
  things, and it is short).
- **Studio**: sunburst (16 rays, SVG), stage floor disc, three spotlight
  cones (flat white at 5.5 %, hard edges, they sway slowly and can
  `aim(x, y)` at anything).

### Avatars: shape characters

Eight ready-made **shape characters**: circle, square, triangle, star,
hexagon, diamond, drop, pill, each with its own colour, a thick dark
outline and two big googly eyes. Recommendation over the doodle:

- The silhouette is the identity: readable at 3 m at 44 px, and
  colour-blind-safe (shape and colour both differ).
- They **act**: pupils look at the action (all eyes turn to whoever just
  joined; the guesser looks at the card she picks), they blink at
  random, and they have moods: `normal`, `blind` (a blindfold for the
  guesser while clues are written), `happy` (^ ^), `shock` (jinxed),
  `sad` (wrong guess).
- Cheap: one inline SVG each, mood = swap the face group.

A doodle can come later as the *face*: draw on your phone inside your
shape's silhouette (Drawbluff's canvas), keep the shape and colour.

### Motion language

- **Easing**: `back` (`cubic-bezier(.34,1.56,.64,1)`) for anything that
  lands: plates, letters, cards, crowns. `in` (accelerate) for things
  that fall or collide. `snap` (`.7,0,.2,1`) for wipes. Nothing floats in
  linearly except the scanner and timers.
- **Slam text**: letters drop from −70 px at 1.7× and land with overshoot,
  22–50 ms stagger; the big ones zoom from 3×. A thud under the first
  letter.
- **Two-hit lines**: "ANNA TRUSTS…" lands, 650 ms of nothing, then the
  name lands in gold. Pause = drama, and it costs nothing.
- **The stinger wipe** between phases: four slabs (gold, pink, cyan,
  night) sweep across at −14°, 70 ms apart (covered at 570 ms); on the
  night slab a gold title slams ("ROUND 3", "JINX CHECK", "THE REVEAL")
  and holds 520 ms; the slabs leave in reverse, revealing the new scene.
  1.2 s without a title, 2.0 s with one. Inside a phase there are no
  wipes, things move on the set.
- **Hits** (only on the hero moments): a 260 ms white flash at 60–75 %,
  a 340 ms screen shake of ±8–18 px, a shock ring, shards or confetti.
- **Budget**: transform and opacity only (WAAPI `element.animate`). At most
  ~45 moving pieces at once (confetti). Ambient motion is slow (cones
  8–11 s, burst 26 s per turn) so the encoder has quiet frames between
  the hits.

### Sound (Web Audio, synthesized, in `tv.js`)

One master gain → compressor → (in the game: `captureAudio`). No files.

| cue | recipe | where |
|---|---|---|
| whoosh | noise, band-pass sweep 300→3500 Hz, 0.55 s | every wipe |
| sting | 3-note saw stab (G C E) + slam | stinger titles |
| thud / slam | sine 150→38 Hz drop + low-passed noise | slam text, impacts |
| shatter | 12 random high-passed noise ticks + glassy triangles over 0.4 s | the jinx |
| stamp | sine 70→38 Hz + click | stamps, lock-in |
| flip | 70 ms noise click + 500→900 Hz chirp | every card turn |
| drain | square blips, 1150 Hz falling 45 Hz per segment | the pot shrinking |
| key / backspace | 30 ms noise "thock" + 190 Hz body / falling square | live typing |
| heartbeat | two sine thumps (64/58 Hz), every 900 ms | **under the typing: the room goes silent, so does the show** |
| drumroll | noise bursts every 45 ms, crescendo, crash + boom | verdict, MVP, awards |
| fanfare | C-E-G-C saw arpeggio, held chord, sparkle | right guess, MVP |
| buzzer | two detuned saws 110/117 Hz, 0.75 s | wrong guess |
| woodblock | 780/1040 Hz sine ticks | last 5 seconds |
| ding / pop / bulb | sine bells, rising chromatic bulbs | joins, chips, the room meter |
| riser | saw 180→900 Hz, low-passed, slow attack | before a reveal |

### The copy: the host

Short, second person, a wink. Headlines in caps (`ANNA IS IN THE HOT
SEAT`, `NAILED IT!`, `SO CLOSE. SO WRONG.`), asides in sentence case
underneath (`Everyone else: one word. Make it count.`). Teasing is about
the situation, never the player's intelligence. It names people (it is
their show), it never tells the guesser anything she must not know, and
it never asks the room to speak. Samples:

- Lobby: "Phones out. Scan in. No word is safe." / "Welcome, Dev. Mind
  your words." / "Hana: full house!"
- Writing: "One word each. Don't think alike." / "Five seconds. Commit to
  something!" / "CLUES LOCKED!"
- Jinx: "Same clue? Both cards go up in smoke." / "Uh-oh. Great
  minds…" / "TOO CLOSE TO THE WORD" / "4 CLUES SURVIVE" / "Anna, eyes up.
  Blindfold off."
- Reveal: "Anna, whose card do you turn first?" / "ANNA TRUSTS… BEN" /
  "SHHH! Anna is typing. Not a sound, people." / "One guess. No
  take-backs."
- Verdict: "NAILED IT!" / "SO CLOSE. SO WRONG." / "NO GUESS. NO GLORY." /
  "The pot goes home empty."
- Replay: "TWO OF YOU WROTE LAMP" / "Keeper did the heavy lifting."
- End: "CERTIFIED MIND READERS" (room rank titles by %: *Total
  strangers* <30 %, *Polite acquaintances*, *Old friends*, *Certified
  mind readers* ≥65 %, *One brain, many bodies* 100 %), awards: "Jinxed
  each other 4 times. Get a room." / "Fearless. Wrong, but fearless."

---

## 2. Storyboard (1280×720 layout, safe area 64 px left/right, 36 px top/bottom)

Every game phase shares a **header strip** at y 36–96: the gold `JINX!`
chip, `ROUND 3 OF 8` (Michroma), optional status plate, and at the right
the room meter (8 bulbs). Below it, at y ~104–164, the **host line**:
one sentence that changes with the beat.

### 0 Cold open (when the game starts, ~2.5 s)

- **Layout**: centered marquee frame 780×360 at (250,140) with 40 bulbs;
  `JINX!` 300 px gold, `!` pink; pink plate "GREAT MINDS COLLIDE" at y 540.
- **Moves**: marquee pops (500 ms back); cones swing to centre; letters
  fall from −260 px rotated −12°, one every 380 ms with a rising thud;
  on `!`: slam + flash 35 % + shake; subtitle pops; bulbs chase every 130 ms.
- **Room**: "oh, it's *a show*."
- **Phone**: logo, "Scan the TV to join".

### 1 Lobby / join

- **Layout**: left column (64–464): `JINX!` 130 px; a white "ticket"
  tilted −2° with SCAN TO PLAY, QR 290 px, `ROOM WXYZ`. Right (510–1216):
  `TONIGHT'S CONTESTANTS` in cyan; 2×4 podiums (trapezoid stand + name
  plate), empty ones dashed "SEAT OPEN"; host line plate bottom-right.
  VIP gets a gold `VIP` tag.
- **Moves**: podiums pop in (60 ms stagger). A join: the character drops
  from −520 px (620 ms, ease-in), squashes on landing, the stand flashes
  pink, name pops, **every other character's eyes turn to the newcomer**,
  ding; the host line greets them by name. START: the characters do a
  wave (jump −40 px, 70 ms stagger) over a riser, then `LET'S PLAY!`
  zoom-slams 150 px.
- **Room**: arrival at the studio; people point at their character.
- **Phone**: name, pick a shape+colour (taken ones greyed), "You're on
  the TV!"; the VIP sees START once 3 are in.

### 2 Hot seat (round intro, ~4 s, after a `ROUND 3` stinger)

- **Layout**: centre stage: gold ring 300 px around the guesser (220 px)
  at (640,330); `ANNA IS IN THE HOT SEAT` 72 px at y 470; plate
  "Everyone else: one word. Make it count." at y 580.
- **Moves**: cones converge (550 ms), riser; ring pops; Anna drops in and
  squashes; slam; 300 ms later **the blindfold drops on** (mood swap +
  280 ms squash + stamp).
- **Room**: everyone knows who must not look at the phones.
- **Phone**: guesser: "You're in the hot seat. Don't look at anyone's
  phone." Others: "Anna guesses. Get ready."

### 3 Writing (~40 s)

- **Layout**: left (64–394): the blindfolded guesser 170 px, `HOT SEAT`
  plate, "Anna can't see the word. You can." Centre (430–850, y
  130–380): **the vault**, a dark card with a gold border, a huge `?`,
  `THE SECRET WORD`, `4 OF 7 CLUES IN`. Right (950–1216): the timer
  (Plex 700 96 px in a dark box, skewed) and a shrinking gold bar. Bottom
  (y 484–684): the clue-givers in a row, 100 px each, thinking dots above.
- **Moves**: timer ticks every second, bar shrinks linearly. A clue in:
  dots → lime tick (pop), a small face-down card flies from the player
  in an arc into the vault (520 ms), the vault bumps, the counter
  updates. A bold clue flies as a flame card and a flame plate
  "🔥 SOMEONE WENT BOLD" rises over the vault for 2 s. Last 5 s: the
  timer turns red, pulses with a woodblock each second; the host line
  says "Five seconds. Commit to something!". All in / time: `CLUES
  LOCKED!` stamp + small shake.
- **Room**: quiet scribbling with a ticking clock; small pops of
  progress. Nothing about collisions is revealed.
- **Phone**: clue-givers: the word big, one field, a 🔥 BOLD toggle,
  SUBMIT (then "Locked: BEACON 🔥"). Guesser: blindfold screen + who's
  done.

### 4 Jinx check (~8–12 s, `JINX CHECK` stinger) — HERO 1

- **Layout**: the line-up: 7 face-down cards 136×184 at y 196 across the
  width (author plates hanging below). Bottom-left: `LOST` + a 120 px
  count. Bottom-right: the pot (70 % size, label above). The impact
  point is (640,470).
- **Moves**: cards deal in from above (480 ms back, 70 ms stagger, flip
  sounds). **Scan**: a cyan bar sweeps left to right (1400 ms), each card
  hops as it passes, riser underneath. **Jinx**: see Hero 1. **Strike**:
  a red bar slashes the card (200 ms), `TOO CLOSE TO THE WORD` plate
  under it, the card drops off the stage rotating (700 ms ease-in), one
  pot segment goes. **Close ranks**: survivors slide together (FLIP,
  520 ms back, 50 ms stagger), `4 CLUES SURVIVE` slams, host: "Anna,
  eyes up. Blindfold off."
- The words are **never** shown here (the guesser is watching): only
  backs, authors, reasons.
- **Room**: groans and laughter: "we BOTH wrote it?!"
- **Phone**: everyone: "Checking for jinxes…" then the count; a jinxed
  giver: "JINX! You and Esme: same word (plural)." (with their own word,
  they know it anyway); guesser: "3 clues lost" only.

### 5 Reveal (`THE REVEAL` stinger, the core loop)

- **Layout**: cards grid in x 64–892, y 186–534: 1–2 cards one row, 3–4
  in 2×2 (396×153), 5–7 in 3 columns (see the note below). Right: the
  pot at full size (300 px, at 938,150) and "ANNA'S IF SHE NAILS IT".
  Bottom (y 566–684): the guess bar, dark with the guesser's avatar and
  "Pick a card on your phone… or take a guess."
- **Card turn (~2.6 s, "the heartbeat")**: host line `ANNA TRUSTS…`
  (22 ms stagger), 650 ms pause, `BEN` slams gold. Two cones swing onto
  the card (550 ms), the guesser's eyes look at it, a stamp sound; the
  card lifts (260 ms, 1.06×) and **turns** (480 ms rotateY, overshoot to
  200° and back to 180°, flip sound); a gold order badge `1` pops on its
  corner; bold: the flame flares 1.6× and a `BOLD ×2` plate lands on the
  top edge with a sparkle. Then the pot drains 3 segments, 120 ms each
  with falling blips, a red `−150` chip floats off. Fast enough to do
  four times in a row.
- **Live typing**: the host line becomes `SHHH!` (red plate) + "Anna is
  typing. Not a sound, people."; the music bed stops; **a heartbeat**
  thumps every 900 ms. Each letter drops into a white tile (200 ms back,
  key thock) left of a blinking gold caret; backspace knocks the last
  tile down (220 ms). 15 letters fit (54 px tiles, 7 px gaps).
  **Lock-in**: tiles go gold left to right (40 ms), stamp, `LOCKED IN!`,
  host "One guess. No take-backs." → cut to the verdict.
- **Room**: whispering stops; people stare at the tiles; a typo is a
  gasp.
- **Phone**: guesser: the cards as buttons with avatars ("turn next"), a
  big GUESS field, PASS. Others: "Shhh — Anna is choosing", their card's
  state (face down / turned).

### 6 Verdict (~5–7 s, no wipe: the tiles carry over) — HERO 2

- **Layout**: `ANNA SAYS` label y 118, her guess as big tiles (82×108) y
  160; `THE WORD WAS` y 312; the secret as pink `?` tiles y 354; the
  headline y 492; points chips y 614. Tiles shrink to fit 15 letters.
- **Moves**: see Hero 2. Wrong: the buzzer, `bad` wash (rays wine-red,
  red cones), guess tiles go red, shake, droop; `SO CLOSE. SO WRONG.`;
  sad avatar "+0 · The pot goes home empty." Pass: `ANNA PASSED` plate
  instead of tiles, the word flips in anyway, `NO GUESS. NO GLORY.`
- **Phone**: guesser: big ✓ or ✗ and the word; givers: "+400: your bold
  clue was turned before the right guess" / "+0".

### 7 Replay + MVP (`THE REPLAY` stinger, ~6 s)

- **Layout**: `HOW WE GOT TO LIGHTHOUSE` at y 110; 3×2 grid of face-up
  cards 368×168: tagline on top (`TURNED 1ST`, `NEVER TURNED`, `JINXED`,
  `TOO CLOSE`), the word, the author. Jinx groups merge into one pink
  cracked card ("LAMP · LAMPS", both avatars); struck words are
  struck-through on grey. Foot: `TWO OF YOU WROTE LAMP` plate + "Anna, tap
  the MVP clue."
- **Moves**: cards deal and flip in (140 ms stagger). MVP pick: the
  others dim to 35 %, all cones converge, the card scales 1.14×, a gold
  crown drops onto its corner (420 ms back), stamp + sparkle + a small
  confetti burst; `MVP CLUE · FAROUK +100`, "Keeper did the heavy
  lifting."
- **Room**: the post-mortem; the jinxers finally see what they had in
  common.
- **Phone**: guesser: the clue list as buttons, "Which clue cracked it?";
  others: the same list read-only, their own highlighted.

### 8 Scores (`SCOREBOARD` stinger, ~5 s)

- **Layout**: `THE ROOM` with 8 big bulbs + "3 for 3. The room is on
  fire." at y 118. Below: 8 columns (124 px) on a white baseline at y
  640, sorted by score: bar (pink, leader gold), avatar on top, score in
  Michroma, name under the baseline.
- **Moves**: bars grow from 0 (600 ms back, 60 ms stagger). This round:
  green `+550` chips pop above the scorers, their bars grow and the
  numbers count up with ticks. Re-rank: columns swap places (FLIP 650
  ms; the one moving up hops, the others dip), a crown drops on the
  leader, who goes happy, the room row fades and `ANNA TAKES THE LEAD`
  slams in its place.
- **Phone**: your total, rank "#1 of 8", this round's points with the
  reason; the room's 3/3.

### 9 End (`THAT'S THE SHOW!` stinger) — HERO 3

1. **Room result** (~4 s): `TONIGHT THE ROOM GOT` / a 230 px `9` / 13;
   13 big bulbs light one by one (170 ms, rising pitch; misses get a red
   slash and a woodblock), the number counts with them; the rank title
   `CERTIFIED MIND READERS` stamps in from 2.6× with a fanfare,
   shake and confetti.
2. **MVP of the night** (~5 s): see Hero 3.
3. **Awards** (~6 s): `THE AWARDS`; three face-down award cards (340×420).
   One at a time: cones aim, a short drumroll, the card flips (520 ms,
   overshoot) to show the title (`MIND MELD`, `LONE WOLF`, `KAMIKAZE`),
   the happy avatars, the name and one funny stat line.
4. **Word web** (~6 s): every word of the evening as a pill (gold = got
   it, outlined = missed) at fixed, hand-balanced spots; the clues that
   led to them as cyan labels on curved lines. A clue used for two or
   more words becomes a solid cyan **bridge** (SEA links LIGHTHOUSE and
   PIRATE; CHEESE links MOON, MOUSE and PIZZA). Words pop in in game
   order (140 ms), then lines draw (420 ms each), bridges with a sparkle.
   The final, quiet screen: people point at it and retell the night.
- **Phone**: room result, your stats and your award; the VIP gets PLAY
  AGAIN / NEW PLAYERS.

---

## 3. The three hero moments

### Hero 1: the JINX slam (jinx phase, ~3.5 s per jinx)

The game's name is the punchline, so it gets the biggest hit.

1. 0 ms: host line "Uh-oh. Great minds…"; the matching cards' outlines
   turn white and they lift 34 px at 1.08× (420 ms back); two cones swing
   onto them; a riser starts.
2. 650 ms: they **fly at each other**, accelerating (440 ms ease-in) on an
   arc that rises 80 px and comes down at the impact point, tilting ±18°.
3. 1090 ms, impact: boom + glass shatter, white flash 75 % (260 ms),
   screen shake ±18 px (380 ms), the cards vanish into 20 pink, white and
   dark **shards** flying out and down (650–1000 ms), a white shock
   ring scales 0.2→4 (520 ms).
4. 1090 ms: a red `JINX!` 170 px stamps from 3× at −10° (260 ms back).
5. 1350 ms: plates: the two shocked avatars "DEV + ESME" and the reason
   "SAME WORD · PLURAL"; `LOST` jumps to 2; two pot segments drain.
6. +900 ms hold, everything fades (300 ms), the remaining line-up is
   back. Three-way jinxes: three cards converge on the same point (same
   timing). Several jinxes in one round: one after another, the second
   1.5 s faster (skip the riser).

### Hero 2: the lock-in and the verdict (silence → explosion)

The contrast is the trick: the loudest moment follows the quietest.

1. Typing: no music, only the heartbeat and the key thocks; `SHHH!`.
2. Lock-in: gold tiles, stamp, `LOCKED IN!`, 1.1 s hold, cut.
3. Verdict, 0 ms: the guess tiles rise from the bottom into the top row
   (420 ms back, 30 ms stagger). Cones aim at the hidden word.
4. Drumroll 1.4 s: the pink `?` tiles jitter in a wave.
5. The word flips in letter by letter (each tile rotateX through 90°,
   70 ms stagger, a tick each).
6. Right: **both rows turn gold pair by pair** (55 ms stagger) on a
   rising chromatic scale, so the room hears it's right before it
   sees it; then fanfare, flash 60 %, the `win` wash (gold cones sweep,
   the burst spins 4× faster), 44 confetti pieces from two cannons at the
   bottom corners, `NAILED IT!` zoom-slams, small shake, the points
   chips pop in one by one (`Anna +550`, `Ben +400`, `Farouk +200`) with
   happy faces.

### Hero 3: the crowning (end: MVP of the night)

The one moment of the evening that is about one person.

1. A `THE MVP OF THE NIGHT` label in gold on an empty stage with a gold
   ring; all three cones converge on it; 1.6 s drumroll.
2. Crash: flash, `win` wash, the MVP's character **launches up from the
   floor** into the ring (650 ms, overshoot to −30 px), happy face.
3. Fanfare + full confetti; the name zoom-slams at 130 px (50 ms stagger).
4. Three stat plates pop in under it (`5 MVP CLUES`, `NEVER JINXED`,
   `2,950 PTS`).

(The **card turn** is the opposite: it happens 3–6 times a round, so it
must stay short and crisp, ~2.6 s, and never get a flash or a shake.
The spotlight and the two-hit "TRUSTS… BEN" line carry it.)

---

## 4. Built for the stream

- Flat colours and hard shadows everywhere: no blur shadows, no
  gradients, no grain, no fine patterns. The only large moving area is
  the low-contrast sunburst (16 wide rays, 26 s per turn); stop it outside
  hero moments if a slow encoder struggles.
- Cones are flat 5.5 % white with hard edges: a "light" without a
  gradient to band.
- Hits are short (flash 260 ms, shake 340–380 ms) and few; between them
  frames are mostly static, so the bitrate goes to the hits.
- Everything animates transform/opacity via `element.animate` (the bars'
  `scaleY`, the cards' `rotateY`, the pupils' `translate`).
- 5 % safe area respected (toggle it with **S**): the header sits at y
  36, the guess bar ends at y 684.
- Long clues: words auto-fit their card down to 26 px. For 5–7 survivors,
  the production layout should move the pot into a compact ring in the
  top right (60 %) and give the cards the full width: 3 columns of 368 px
  fit a 15-letter word at 34 px. The guess bar fits 15 letters plus the
  caret.
- 3 players (2 givers × 2 clues): the writing row shows each giver twice
  (two status slots each), the line-up has 4 cards.

## 5. The mockup

`tv.html` + `tv.css` + `tv.js` + `fonts/`. No network, no build, no
dependencies; open the file in Chrome. The TV stage is 1280×720 scaled to
the window; a control bar sits below it (outside the TV picture).

- **← / →**: previous / next phase; **1–9, 0**: jump to a phase
- **Space**: next beat of the phase (join, submit, scan, jinx, turn,
  type, lock in, verdict, MVP, …); the beat buttons do the same
- Verdict variants: buttons "Variant: right / wrong / pass", or
  `tv.html#p=verdict&v=wrong`
- **A**: autoplay the whole show; **S**: safe-area overlay; **M**: sound
  on/off (sound starts after the first click or key press)
- The control bar shows what the phones show in that phase (📱).
- URL hash: `#p=reveal` starts at a phase, `&b=2` fast-forwards two beats,
  `&shot` hides the controls (for screenshots at 1280×720), `&mute`.

Phases: 1 Cold open · 2 Lobby · 3 Hot seat · 4 Writing · 5 Jinx check ·
6 Reveal · 7 Verdict · 8 Replay + MVP · 9 Scores · 10 The end.
