# Jinx: "Tactile tabletop" TV direction

**Open the mockup:** `games/jinx/design/tabletop/tv.html` in Chrome, straight from the
file system. It has no server, no build step and no network access. The window scales
the 1280×720 stage to fit. Keys: `←/→` change phase, `1`–`9` and `0` jump to a phase,
`R` replays the current phase, `Space` runs its main action, `S` toggles the synthesized
sound (off by default), `G` shows the 5% safe area and `H` hides the control bar. Each
phase's own keys (`J F T V W M U A L`) are on the buttons.
URL options: `?phase=4`, `?wrong=1` (the wrong-guess path), `?long=1` (15-letter clues),
`?controls=0` (a clean 1280×720 picture, for screenshots).

---

## 1. The idea

**The TV is a game table seen from directly above, on a premium board-game night.**
Everything on screen is an object you could pick up: cards with printed backs, poker
chips, wooden letter tiles, a kraft-paper envelope with a wax seal, masking tape, rubber
stamps, a kitchen timer, a score pad, a label-maker strip. Nothing is a "UI panel". Each
piece of game information belongs to an object, and every state change is something
**physical happening to an object**: dealt, flipped, slammed, shattered, torn, stamped,
taped or punched.

Why this suits Jinx: the core drama is *cards colliding*. A tabletop makes collisions
readable at a glance (two cards fly at each other, so they matched) and gives the room
the shared ritual of a card game: the slow turn of a card, the hush, the slam.

The tone is warm and playful, not casino. Faces are doodled, the tape is a little
crooked, stamps land at an angle. The physics stay restrained: things have weight,
overshoot once and settle.

### Rules for the video encoder (H.264 at ~30 fps, seen from 3 m)

- **Flat colours, hard edges.** The felt is one solid colour. Any "texture" is
  printed-on shapes (the mat's frame, the dashed zones). There is no noise, grain, wood
  grain, paper fibre or large gradient, so nothing bands or eats bitrate.
- **Short, chunky shadows** (a 6 px offset plus a small blur) under the objects only.
- **Few, big particles.** Dust puffs are 34 px discs (8–12 of them). Confetti is 18–28 px
  (at most ~70). Card shards are large polygons (≈10 per card).
- **Only transform and opacity are animated** (plus `clip-path` wipes and
  `stroke-dashoffset` on small elements). Every animation runs on the Web Animations API.
- **The only full-frame motion** is a table shake: 3–13 px for 300–400 ms, three per
  round at most. A global translation is cheap for H.264 (motion vectors), and it is short.
- **Type:** nothing under 24 px. Clue words are 40–44 px and shrink to fit, never below
  24 px. Past that floor a word is condensed with `scaleX` (≥ 0.74), which is enough for
  15-letter clues on a 210 px card. Names are 24–30 px uppercase on dark tabs.
- **5% safe area:** content stays inside x 64–1216 and y 36–684. Only the mat's
  decorative frame, flying shards and confetti cross it.

## 2. Palette

| Role | Colour | Notes |
|---|---|---|
| Felt (background) | `#1f4744` | deep teal-green play mat, a single flat colour |
| Printed on the mat | `#2a5b57` | the frame, zones, dashed outlines |
| Secondary text on felt | `#a8d3cd` | labels, hints (7.7:1 on the felt) |
| Cream text on felt | `#fff6e2` | primary text on the felt |
| Paper (card faces, notes, pad) | `#fbf1dc` | warm cream, never pure white |
| Card face frame | `#efe0bf` | printed inner border |
| Ink | `#1d1a2b` | all text on paper, outlines (3–4 px), the bold card back |
| Secondary ink | `#5d5244` | small labels on paper (5.6:1) |
| Tomato | `#df4a3c` | card backs, JINX!, wax seal, pins and yarn |
| Gold | `#f6b93b` / edge `#c9861b` | chips/pot, bold flame sticker, MVP rosette |
| Leaf | `#2f9e57` | right, checks, positive points on paper |
| Dymo red | `#c9252c` | the guess tape |
| Wood / kraft | `#f1d29a`, `#d9b98a` | letter tiles, envelope, pedestal |
| Player colours (token rims) | `#ff7a5c #4aa8f5 #8bd648 #ffc63d #b48fff #ff8cc6 #ff9845 #3fd9c7` | eight colours, each also told apart by its face |

Contrast rule: text sits on cream or on the felt, never on a player colour.

## 3. Type

- **IBM Plex Sans** (variable, local woff2, OFL) for everything. Weight 700 uppercase
  with +0.06–0.14em tracking for labels and words; weight 600 sentence case for copy.
- **IBM Plex Mono 500** for the label-maker guess tape, the timer and the room code. The
  mono spacing makes the tape read like embossed type.
- Character comes from the objects, not the fonts: the logo is four Scrabble-like wooden
  tiles `J₈ I₁ N₁ X₈`, and the room's final count uses the same tiles.
- Optional upgrade: a handwritten marker face (OFL, e.g. *Kalam* or *Gochi Hand*) only
  for the clue words on face-up cards, so they read as "written by your friend".
  Check its legibility at 24 px and ask before adding it. The mockup does without.

## 4. Objects

**Clue cards** (210×150; 240×165 in the reveal row; radius 14):
- *Face:* cream, a printed inner frame, the word in ink, uppercase and centred. The
  author's token is a sticker overlapping the top-left corner, and the author's name is
  on a dark tab under the card. Turned cards get a yellow highlighter swipe under the
  word and a numbered badge (1, 2, …) for the turn order.
- *Back:* tomato with a cream frame and a cream diamond with **J**, plus the author's
  token sticker. This tells the room *whose* card it is without saying *what* it is.
- *Bold back:* ink-black with a gold frame and gold diamond, and a round gold **flame
  sticker** at the top-right corner. It reads as "special" from across the room. The
  flame stays on the face once turned.
- During writing the cards are bare backs: nobody can tell bold cards or authors yet.

**Avatars = poker-chip tokens.** A coloured disc with notched cream edge marks, an ink
outline and a cream centre with an ink face. The proposal: each player **doodles their
face on the phone in the lobby** (Drawbluff's canvas, one ink colour, 4 s) and it is
printed into the chip's centre as a rubber-stamp impression. A shuffle button gives eight
ready-made faces (the mockup's) as the fallback for "I can't draw" and for bots. The
rim colour plus the face keeps tokens distinct for colour-blind players. Tokens carry
state: a crown (VIP), a blindfold (the guesser while clues are written), a pencil
wiggling (still writing), a green ✓ sticker (done).

**The pot** is a tower of gold chips on a printed ring, with a cream label showing the
number. Each point is one chip, so the pot shrinking is *visible* as chips leave the
tower, and chips fly to the guesser when they win.

**Others:** a kraft envelope with a wax "?" seal (the secret word lives there all round),
a kitchen dial timer (a gold wedge that turns red at 10 s), rubber stamps (JINX!, VOID,
RIGHT!, NOT IT, LOCKED IN, IN SYNC!), masking-tape labels for reasons and captions, a
spiral score pad, a hanging "SHHH!" sign, a red Dymo label tape for the guess, an MVP
rosette, and red yarn with push-pins for the word web.

## 5. Motion language

- **Weight first.** Things are lifted (scale 1.05–1.14, larger shadow), travel, and land
  with an impact: a short squash (scaleY 0.86–0.9), a 3–13 px table shake proportional
  to the mass, and a dust puff.
- **Easing vocabulary:** `out` cubic-bezier(.2,.8,.2,1) for settling; `in` (.55,0,.9,.35)
  for anything that slams (it accelerates *into* the impact); `back` (.3,1.6,.5,1) for
  stickers and stamps popping into place; `inout` (.65,0,.35,1) for flips and slides.
- **Durations:** pops 220–300 ms; flips 620–650 ms; dealing 460–560 ms with a 80–110 ms
  stagger; slams 640–700 ms of travel; suspense holds of 700–1100 ms before anything the
  room waits for. These are tuned for 30 fps: nothing important is faster than ~6 frames.
- **One thing at a time.** Each beat has one focal motion, and secondary motions (pot
  chips, tallies) follow 200–450 ms after it lands, so the eye is led around the table.
- **No idle loops** on large areas. The only loops are small: the pencil wiggle on
  writing tokens and the caret blink on the tape.

## 6. Sound design (Web Audio, synthesized, via `captureAudio`)

Everything comes from oscillators and one noise buffer, with no audio files (all of it is
in the mockup's `sfx`):

| Event | Recipe |
|---|---|
| Card slides on felt | band-passed noise sweeping 1.8→0.7 kHz, 180 ms, soft attack |
| Card lands (thwap) | low-passed noise 70 ms + a 150→80 Hz blip |
| Flip | two high-passed ticks 70 ms apart + an air whoosh (noise 0.5→2.6 kHz) |
| Token drops (wood) | triangle 240→110 Hz + a band-passed knock |
| **Jinx slam** | sine 120→38 Hz, 450 ms, plus low-passed noise: the thud you feel |
| **Shatter** | high-passed noise burst + resonant sweep + 7 random glassy ticks |
| Tear | resonant noise sweeping 2.6→0.5 kHz (a rip) |
| Stamp | short low-passed noise + 190→90 Hz |
| Marker stroke | narrow-band noise around 3 kHz, 220 ms (a squeak) |
| Chip | two inharmonic sines ~2.6 kHz + ×1.52 (a clink), pitch jittered |
| Label-maker letter | a high click + a 450 Hz "chunk"; backspace is a softer chunk |
| Snip | two high clicks 60 ms apart |
| Timer tick (last 10 s) | 1.9 kHz square blip + noise tick |
| Drumroll | band-passed noise hits every 45 ms with a crescendo, then a cymbal (high-passed noise) |
| Right | a marimba-ish C–E–G–C arpeggio + a held major triad + sizzle |
| Wrong | a 4-note sawtooth "wah-wah" through a low-pass, with vibrato on the last |
| MVP / sparkle | 9 quick random high sines |

The mix runs through one compressor. While the guesser types, everything except the
letter clicks goes quiet, so the room hears the hush too.

---

## 7. Storyboard

Coordinates are the 1280×720 layout. The header (all round phases) has the round tab at
the top left (64, 36), "HIROKO GUESSES" with a token next to it, and the room tally at
the top right: "2 of 3" plus ten mini cards (cream found, tomato missed, dashed to come).

### 7.1 Lobby + join

- **Layout:** left column: the wooden JINX tiles (64, 50), the tagline "One word each.
  Don't think alike.", the QR on a cream card taped to the table (96, 236; QR 256 px), the
  room code `KQZM` in mono, the URL below. Right: "AT THE TABLE 5 / 8" and eight seats in
  a 4×2 grid (from 588, 158; 157 px pitch). Each seat is a token (100 px) on a cream
  place card with the name; empty seats are a dashed ring and "open seat". A paper slip
  at the bottom: "Anna starts the game from her phone".
- **Motion:** the tiles drop in with a twist (420 ms each, 110 ms stagger, back easing,
  a wooden clack each). A **player joining** sees their chip fall from above (it starts
  scaled 1.6× with a far, soft shadow and lands in 260 ms), squashes, settles (440 ms in
  all), raises a dust puff and makes a wooden thunk, then the place card flips up
  (rotateX −90→0, 320 ms) and the counter bumps. The VIP gets a gold crown.
- **Feel:** "pull up a chair". Every new arrival gets a little moment that everyone sees.
- **Phone:** name, then *draw your face* in a circle (4 s, one ink colour, or shuffle a
  ready-made face), then a preview of your chip with "Look at the TV!".

### 7.2 Writing (~40 s)

- **Layout:** the guesser's chip (110 px, blindfolded) with "Hiroko guesses / Everyone
  else: ONE word, on your phone" (323–960, 104–200). In the middle row: the sealed
  envelope (190, 272), the dashed "clue pile" zone (560, 268, 300×196) with a "4 of 7
  in" tag, and the kitchen timer (960, 280, 170 px). At the bottom: the clue-givers'
  chips (84 px, 150 px apart, centred) with names. Writers have a wiggling pencil.
- **Motion:** a submission throws a bare face-down card from that player's chip onto the
  pile in an arc (560 ms: it grows to 1.1× mid-air, spins and lands at a random angle)
  with a slide then a thwap. A green ✓ sticker pops on the chip (300 ms, back) and the
  tag bumps. The timer wedge shrinks every second. From 10 s it turns tomato, ticks and
  wobbles ±5° per second. When all are in, an "ALL IN!" stamp lands on the pile.
- **The TV never shows bold or who wrote what here**: all the backs are the same.
- **Feel:** a calm, busy hum. The tension comes from the pile growing and the dial.
- **Phone (clue-giver):** the secret word on an index card, one text field (one word,
  ≤ 15), a peel-off **flame sticker** toggle ("Bold: ×2 if turned, −2 if jinxed"), then
  "Submit" throws the card up off the phone. **Phone (guesser):** "Eyes on the TV —
  your friends are writing", the same envelope, nothing else.

### 7.3 Jinx check

- **Layout:** the seven cards dealt face down in a 4+3 grid (row 1 at y 146, row 2 at
  y 366, 210×150, 26 px gaps, centred on x 64–980), with the author stickers and names;
  bold cards turn black with a flame. The pot tower on the right (1010–1216) starts full
  (12). The banner "Checking for jinxes…" sits at y 604.
- **Motion (the example: 3× LAVA, 1 invalid), ≈ 9.5 s:**
  1. *Deal* from the pile: 460 ms per card, 100 ms stagger; the flame stickers pop at 900 ms.
  2. *Inspector:* a big magnifying glass sweeps row 1 then row 2 (1500 ms).
  3. **JINX:** the matching cards lift (scale 1.14, a slight back-swing) and then
     **accelerate into each other** at the empty slot of one of them (680 ms, ease-in),
     → **SLAM** (a 13 px / 380 ms shake, 12 dust discs, the sub thud) → a 200 ms hold →
     **SHATTER** into ~10 paper shards per card that fly out, spin and fall with gravity
     (650–950 ms) → a **"JINX!" stamp** slams on the spot (260 ms, from 2.8×) →
     masking tape wipes in under it with the reason: **"SAME WORD × 3"**, "SAME STEM",
     "PLURAL", "TYPO", "SAME FAMILY" → a penalty floats up if a bold card died
     ("Anna's bold card −2") → one chip tumbles off the pot.
  4. **Invalid:** the card lifts, a thick ink **marker X** is drawn over it (2×230 ms,
     with squeaks), a "VOID" ink stamp and the tape "TOO CLOSE TO THE WORD" follow,
     800 ms to read, then the card **tears in two** along a zig-zag and the halves drop
     off the table (820 ms). Another chip falls.
  5. *Clean-up:* the stamps fade, the survivors glide into the reveal row (620 ms,
     80 ms stagger), and the banner stamps in: **"4 lost · 3 clues left for Hiroko"**.
- Several jinx groups play one after another, each ~25% faster than the one before.
  With no jinx at all, a gold "CLEAN!" stamp lands instead and the pot keeps its chips.
- **Feel:** the room *gasps and laughs*. Everyone knows whose cards just died (stickers,
  names), but the words stay secret, so the authors squirm without spoiling anything.
- **Phone (guesser):** "3 clues survived · 4 were jinxed", with broken-card icons and no
  words. **Phone (clue-givers):** your own fate ("JINXED with 2 others" or "Survived"),
  without the other words.

### 7.4 Reveal (the guesser picks, the pot shrinks, the guess is typed live)

- **Layout:** the survivors in a row of 240×165 cards at y 190 (3 cards: x 112, 402,
  692; 5–7 cards: two rows of 220×150). The pot on the right. The guess area at
  y 540–664: the label "HIROKO'S GUESS" over a dashed slot "Hiroko may guess after any card".
- **Motion, turning a card:** a speech bubble "Hiroko trusts Dev" pops above the chosen
  card (280 ms, back) and the card lifts (240 ms) → an **800 ms suspense hold** → the
  **flip**: rotateY 180→0 over 640 ms while the card rises toward the camera (scale 1.32
  and −50 px at the midpoint) and comes back down → a thwap, a 3 px shake, dust → the
  highlighter swipes under the word (280 ms) and the order badge pops → **the pot
  drains**: two chips hop off the tower and tumble away (700 ms each, 170 ms apart,
  clinks) while the pot number pulses red and counts down. A bold card's flame flares
  and "bold ×2" floats up.
- **Motion, the guess:** a **"SHHH! Hiroko is guessing" sign drops** on two strings from
  the top edge and swings to rest (1700 ms, damped: −12°, 9°, −5°, 2.5°, −1°). A red
  label-maker tape unrolls in the guess slot (260 ms), and **each letter the guesser types
  is punched into it live**: 140 ms, the letter pops from 1.8× with an embossed
  highlight, the tape jolts 4 px, with a click and a chunk. Backspace knocks the letter
  off (140 ms). On submit: a snip, the tape jolts and tilts −1.5°, and a gold
  "LOCKED IN" stamp lands next to it. Passing stamps "PASS" over the empty slot.
- **Feel:** concentration, then *agony*. The room can watch the guesser go wrong letter
  by letter ("VOLCAMO…") and has to stay silent. That is the comedy.
- **Phone (guesser):** the face-down cards as big buttons with the authors' faces
  ("Turn Dev's card"), the pot value, a text field "Guess (one shot)" and "Pass".
  **Phone (others):** the same cards read-only, the word, and a reminder: "Shh — no
  hints!".

### 7.5 Verdict

- **Layout:** the guesser's chip large on the left (84, 220; 150 px). The envelope in the
  centre (410, 160). The guess tape below it (y ≈ 490). The pot on the right.
- **Motion:** a **drumroll** (1100 ms) while the envelope shivers (±2.5°, 120 ms
  cycles) → a cymbal: the flap flips open (340 ms) and the wax seal pops off → the word
  card rises out of the envelope (380 ms) while the envelope drops away (420 ms), then
  grows to full size, centred (460 ms, back): **"THE WORD WAS · VOLCANO"** at 88 px →
  the guess tape slides up under it (360 ms).
  - **Right:** a green **"RIGHT!" stamp** slams on the card's corner (shake), paper
    confetti bursts from the word (54 pieces, 1.3–2 s) with the fanfare, and the **whole
    pot slides chip by chip into the guesser's chip** (520 ms each, 110 ms apart, a clink
    on arrival), "+6" floats up and the chip does a happy hop.
  - **Wrong / pass:** a marker line strikes through the tape (it stays readable), an ink
    **"NOT IT"** stamp, the trombone, the word card wobbles, and the chips tumble off
    the table ("back to the bank").
  - Then the clue-givers' chips slide up along the bottom (y 600, 90 ms stagger), each
    with its points popping in: +1, +2 for bold, −1 for Anna's jinxed bold card, 0 in
    muted teal. Last, the tally's mini card for this round flips to found or missed and
    the count updates ("3 of 4").
- **Feel:** a release. A cheer (or a groan) that the TV amplifies.
- **Phone:** guesser: "RIGHT! +6" or "It was VOLCANO". Everyone else: your points this
  round, with why ("Your card was turned · bold ×2").

### 7.6 Replay + MVP clue

- **Layout:** header "ROUND 4 · REPLAY" with the word on a paper tab and a ✓. Row 1
  (y 128): the survivors face up in turn order with their badges ("NOT TURNED" tape on
  the rest). Row 2 (y 352–510): the **jinxed cards fanned in a stack, taped back
  together** with crack lines, with the caption tape **"3 of you wrote LAVA"**. Next to
  them the invalid card with a marker line through it and "TOO CLOSE TO THE WORD". The
  right column has a note "THIS ROUND" (the points) and a note "Hiroko picks the MVP clue…".
- **Motion:** the cards deal in face up from below (520 ms, 110 ms stagger), the tape
  strips slap onto the broken stack (160 ms each, a stamp sound), and the captions fade
  up. **MVP:** a gold **rosette with ribbons** flies in from the top right (520 ms,
  ease-in, spinning from 2.4×), slams onto the chosen card's corner (squash, gold dust,
  shake), a shine sweeps across the card (700 ms), "+3 Fatima" floats, and the right
  note turns into "MVP CLUE · POMPEII · Fatima +3".
- **Feel:** "Ohhh, *that's* why" plus some teasing. This is where the jinxes get funny.
- **Phone (guesser):** all clues as tappable cards: "Which clue helped most?". Everyone
  else: the replay plus "Hiroko is choosing…".

### 7.7 Scores

- **Layout:** a spiral **score pad** on the left (64, 44, 640×640, tilted −1°): rank,
  chip, name, this round's delta (green/red, "–" for 0), total. Right: "THE ROOM,
  TOGETHER": **"3 of 4"** at 128 px, "words found so far", ten card slots (✓ cream,
  ✕ tomato, dashed to come), then "Next up: [chip] Anna guesses".
- **Motion:** the pad slides up from below and settles at an angle (620 ms, back) and
  the room block slides in from the right. The deltas are *written in* left to right
  (a clip wipe, 240 ms each, 110 ms stagger, a marker squeak). The totals count up
  (500 ms). Then **the rows re-sort**: moving rows swap with a slight lift (700 ms), a
  "▲2" floats on climbers, and the leader's row turns gold.
- **Feel:** a quick breather and some bragging, without dwelling (≈ 4 s, then on).
- **Phone:** your rank "#2 of 8", your total, and for the next guesser: "You're up next!".

### 7.8 End 1: the room's result + MVP of the night

- **Layout:** the tab "GAME OVER · THE ROOM". Wooden tiles **7 of 10** (130×150) at
  y 112, "words found together", then the 10 words of the night as cards in two rows of
  five (y 340 and 444; missed ones grey with a red line through), and a rating stamp
  ("IN SYNC!"; 10 = TELEPATHS, 8–9 = MIND READERS, 6–7 = IN SYNC, 4–5 = MIXED SIGNALS,
  ≤ 3 = TOTAL JINX).
- **Motion:** the tiles drop (420 ms, 140 ms stagger, clacks), the cards deal from
  below (480 ms, 80 ms stagger), the stamp lands, and a little confetti.
- **MVP of the night:** everything drops away (420 ms) → a **spotlight** (a flat lighter
  disc of felt, 500 px) scales in, a wooden pedestal appears → a 1500 ms drumroll → the
  winner's chip (220 px) **drops onto the pedestal** (520 ms, the big slam and shake) →
  confetti (70) and the fanfare → a tomato **ribbon "MVP OF THE NIGHT" unfurls** from the
  centre (420 ms) → "Fatima · 41 points · 3 MVP clues · never jinxed".
- **Feel:** "we did it" first (cooperative), then one person's moment of glory.
- **Phone:** room result and your own line ("#2 · 33 points · 2 MVP clues").

### 7.9 End 2: awards

- **Layout:** three tall award cards (320×460) at x 110, 480 and 850, y 140, fanned ±2°:
  title, a big icon, the winners' chips, names and one stat line.
- **Motion:** dealt face down (560 ms, 150 ms stagger). For each card: a short drumroll
  (600 ms) → lift → flip (650 ms, up to 1.14×) → a static sunburst behind it scales in
  (600 ms, back; it does *not* keep rotating) → a fanfare, and the winners' chips pop in
  (320 ms, 120 ms stagger). 900 ms between cards.
- Awards: **Mind meld** (the pair that jinxed each other most: "jinxed each other 4
  times"), **Lone wolf** ("6 one-of-a-kind clues that got turned"), **Kamikaze** ("lost
  5 clues to jinxes (and kept going)").
- **Phone:** your award, if you won one, as a card you can screenshot.

### 7.10 End 3: the word web

- **Layout:** a detective's evidence board on the table. The ten words are cream cards
  (196×70, 32 px; missed ones grey with a "missed" tag) on a loose grid around the
  edges. The **clues several words shared** are masking-tape tags with push-pins in
  between (HOT, FIRE, KNIGHT, HAUNTED, ARMOR, ITALY, SAND, COLD, WHITE, BEEP). **Red
  yarn** runs from each tag to every word it was a clue for, sagging a little like real
  string. The layout is precomputed (a small force layout with fixed slots, words at the
  edges and hubs inside), with at most ~12 hubs, so every label stays ≥ 26 px.
- **Motion:** the word cards slap down one by one (300 ms, 80 ms stagger). Then hub by
  hub, every 300 ms: the tag is pinned (220 ms) and its strings *draw* out to the words
  (480 ms, `stroke-dashoffset`) with a zip. The whole web appears in ≈ 4.5 s, then holds
  still.
- **Feel:** "look what our brains did tonight". It is fun to point at ("HOT was a clue
  for FOUR words?!"), and it is a good photo and a good closing frame.
- **Phone:** "Play again?" (VIP: same players / new players), plus your clue that
  appears most often on the web.

---

## 8. The three hero moments

1. **The Jinx slam and shatter (7.3).** This is the game's signature, so it gets the most
   craft: cards that *accelerate* into each other, a felt sub thud with a table shake,
   paper shards from the actual card backs (stickers and all) flying with gravity, then
   a rubber stamp and a tape label that explains the rule. Invalid clues get a different
   death (marker X, VOID, tear), so the two rules stay distinct. Three-way jinxes pile
   all three cards up before they explode.
2. **The live guess into the verdict (7.4 → 7.5).** One continuous tension arc: the SHHH
   sign swings down, the room watches letters punched into the label tape one by one
   (typos included), the snip, a drumroll while the sealed envelope shivers, the word
   rising out of it, then RIGHT! with confetti and **the pot pouring chip by chip into
   the guesser's token**, or the trombone with the chips tumbling off the table.
3. **The word web (7.10).** The whole evening on one screen as a red-string conspiracy
   board, drawn string by string. It is the screenshot people take home, and it turns
   the cooperative score into a story.

(The card turn with the pot draining is the most frequent beat and is tuned to be quick
and satisfying, not spectacular: ~1.8 s from the pick to the chips.)

## 9. Scaling notes

- **8 players / 7 clues:** the jinx grid is 4+3 cards of 210×150. A reveal with 5–7
  survivors uses the same grid (still no word below 24 px), and the guess area moves to
  y 600 with a 72 px tape.
- **3 players (2 givers × 2 clues):** 4 cards. Each giver's two cards sit side by side
  under one name tab. Inside one player's own pair, a jinx is drawn with only one
  sticker on the stamp ("YOU JINXED YOURSELF").
- **Long names:** place cards and name tabs truncate with an ellipsis at their width.
  Names are uppercase on tabs, so at most ~10 characters show in full.
- **Bots / reconnecting players:** a grey chip with a dashed rim, kept in its seat.
- **Reduced motion (a host setting):** no shakes, half the particles and halved travel;
  the timings stay the same, so the pacing does not change.

## 10. Implementation notes for the real TV page

- Plain DOM + CSS + the Web Animations API (`el.animate`), as in the mockup. There is no
  canvas and no library. Shards are clones of the card's back face with polygon
  `clip-path`s, and tears are two zig-zag halves.
- Phases are driven by the view (`screen.phase`, the cards, the jinx groups with reasons,
  the turn order, `guessDraft` for the live typing). The TV animates the *difference*
  between two views and holds every final state statically, so a TV that reconnects
  mid-phase renders the current state without replaying anything.
- The live guess needs a throttled draft from the guesser's phone (≈ every keystroke,
  ≤ 20/s) in the view; the TV punches one letter per changed character.
- Sound: one `AudioContext` and the synth table above, routed through `captureAudio`;
  `#mute=1` on the host preview, as Drawbluff does.
- Files: `tv.html`, `tv.css`, `tv.js` (all phases, the fake data and the controls) and
  `fonts/` (Plex Sans and Plex Mono, copied from `crates/tvpipe/src/browser/fonts/`, OFL).
