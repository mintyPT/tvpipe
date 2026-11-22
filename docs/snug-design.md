# Snug (design)

A cooperative puzzle game for 2–8 players in `games/snug`: a web app on
`@tvpipe/party`, like `games/shifty`. The idea is the race-the-sand-timer
tiling puzzle (Ubongo and its kin: fill a shape exactly with a handful of
polyominoes); the rules, the name and the look are our own, and the game
is turned inside out: **everyone fills the same shape together, and
nobody sees anyone else's pieces until they are on the board.** The
team plays against one clock.

## 1. Why it is fun

- **One puzzle, split across heads.** Every board is cut into pieces and
  dealt out: each player holds part of the answer and nobody holds all of
  it. A player can solve nothing alone; the room has to talk ("who has
  something that reaches into the top-left notch?", "mine is like a
  staircase with a tail").
- **Placing is showing.** A piece on the board is seen by everyone, on
  the TV and on every phone, so dropping one in is also how a player
  shows what they hold. Only its owner can move it again, so the others
  steer: "Ben, turn yours over and push it one to the left."
- **Dead ends nobody sees alone.** Most placements that fit make the
  board unsolvable (§8: 78–97 % of the first ones), and many only show it
  once the hands are compared: Anna knows her pieces do not fill the
  L-shaped gap, Ben knows his do not, and only saying so tells them both.
- **Against the clock, not each other.** One team clock; every solved
  board gives time back. The score is how many boards the room solves.
- **Two players work.** With two, each holds half the answer and every
  dead end needs both; the hardest setting is still fair (§7).

## 2. A game

```
lobby ──▶ board 1 ──▶ solved! ──▶ board 2 ──▶ … ──▶ time's up ──▶ the end
            the clock runs        +time back                 (the solution, the hands)
```

- The VIP starts from the phone (or the host page). The clock starts at
  `60 s + 15 s × pieces needed` (2 players: 150 s), times the room's
  **pace** (relaxed ×1.5, normal ×1, rushed ×0.75).
- **A board**: a new shape appears on the TV and every phone, and each
  player's phone gets their hand. The board is solved when every cell is
  covered; leftover pieces do not matter.
- **Solved**: the clock stops, the board bounces and sparkles, the
  leftover pieces (the spares) pop out of their owners' hands onto the
  TV, and the clock gets back `10 s + 6 s × pieces needed` (2 players:
  +46 s; pace applies). After a short celebration (4.5 s, the clock
  paused) the next board comes; it was made meanwhile.
- **Time's up** ends the game: the TV shows the board as it was, then the
  generator's solution in the owners' colours and every hand turned up
  ("it would have gone like this"); then the end screen: boards solved,
  the room's best of the session, and three awards (§11).

## 3. Pieces and hands

- **Pieces** are free polyominoes (turning and flipping allowed) of 3 to
  5 cells: the two trominoes, five tetrominoes and twelve pentominoes,
  each in every orientation (1, 2, 4 or 8 of them). They have no names on
  screen: players describe them in their own words.
- **Hands**: with 2–3 players each player holds **3 pieces the board
  needs**, with 4–8 players **2**; plus **one spare** each that the
  generator did not use (§8). A spare may still fit (a board can be
  filled more than one way); the board does not care which pieces cover
  it.
- **The deal** gives every player the same number of needed pieces, the
  cells as even as the board allows (largest pieces first, each to the
  player with the fewest cells so far), then the spares. Piece ids are
  shuffled so that nothing in a view tells a spare from a needed piece.
- **Secrecy**: a piece's shape reaches only its holder's phone until it
  is placed. The TV and the other phones see how many pieces each player
  still holds, never which.

## 4. Placing, moving, lifting

- A phone drags a piece from its hand onto the board (turned and flipped
  on the phone, which only it sees); letting go over cells that are all
  on the board and free places it (`place`: the piece and its cells). The
  host checks that the cells are one of the piece's orientations, inside
  the board and free, and refuses with `taken`, `outside` or `shape`.
- **Collisions**: the host takes actions one at a time; when two phones
  drop pieces on the same cells at once the first wins and the second
  bounces back to its hand ("Mia was quicker").
- **Moving and lifting**: only a piece's owner moves it (dragging it to
  other cells) or lifts it back into the hand (a tap). Others ask out
  loud, or point at it (§5).
- **Lifting costs time on hard** (3 s off the clock, moving too);
  placing never does.
- The board is solved the moment its last cell is covered: that action
  answers `solved`, and the celebration starts (with the TV, §10).

## 5. Pointing: the shared cursor

Talking about cells is hard ("the second one from the … no, your left"),
so every player has a **cursor**. Touching the board on a phone (not on
one's own piece) shows a cursor in one's colour with one's initial, at
the finger, on the TV and on every phone; a quick tap there **pings**:
a ring pops out on every screen. While a piece is dragged the cursor
shows where the finger is, never the piece. The cursor fades 3 s after
the finger lifts.

Cursors are continuous input (`client.input({ x, y, ping })`, latest
wins, at most every 100 ms): `x`, `y` in cells from the board's top left,
`null` when the finger is off, `ping` a count that goes up with each tap.
The host merges them and sets them on the room and the screen at most
every 100 ms, only when something changed.

## 6. The clock

One clock for the team, an absolute deadline in the views (host clock;
`party.deadline` so it starts when the TV shows the board). A solved
board stops it (what is left is kept) and the next board starts it again
with the time back added. Hard's lifting moves the deadline 3 s closer.
An action that comes after the deadline (plus the party's grace) is
refused with `time`.

## 7. Difficulty

| | Easy | Normal | Hard |
|---|---|---|---|
| Pieces | 3–4 cells | 4–5 cells, half and half | 4–5 cells, two thirds pentominoes |
| Boards | the most ways to fill it of the tries (§8) | the middle | the fewest |
| Pieces that fit nowhere | greyed out on the phone | greyed out | not shown |
| A board that can no longer be solved | the TV says so (after a check, §8) | — | — |
| Lifting and moving | free | free | 3 s |

Hands are secret on every level: the levels change how much the game
helps, never that. **The most restrictive setting is Hard with two
players**: six needed pieces plus two spares, mostly pentominoes, boards
with one or a few solutions, no help, lifting costs. It stays fair
because every dead end is visible to the pair once they compare what they
hold, and the clock gives each board about a minute and a half.

## 8. The generator

`game/rules.ts`, pure functions with a seeded random source:

1. **Grow**: pick the needed pieces from the level's mix; place the first
   near the middle of a box (`w × h` with `w·h ≈ 1.3 × cells`, wider
   than high by 1.35 to 1.85), each next one in any orientation and
   place inside the box that touches what is there, the likelier the
   more edges it shares (weighted by that number squared: compact but
   not square), never one that would close a hole. Reject the shape if
   it fills less than 70 % of its box.
2. **Spares**: one random piece of the level's mix per player.
3. **Count** the ways to fill the shape with all dealt pieces (an exact
   cover by backtracking: the first empty cell in reading order, every
   unused piece in every orientation that covers it), up to 50 and at
   most 40 000 steps; a count that runs out is "many".
4. Make several such boards and keep one by the level (§7): 24 with up to
   6 needed pieces (40 000 steps each), 12 with up to 9 (20 000), else 8
   (10 000); for big boards the counts mostly run out, and a count that
   ran out sorts as "many". The host makes them a try at a time, giving
   the page a turn between tries (a board takes 30–110 ms of work), and
   makes the next board during the celebration.

The generator's own tiling is the board's **solution** (shown at time's
up, used by the bots).

What placements do to a board, measured with a prototype of this solver
on random boards of 6 pieces (3 tetrominoes, 3 pentominoes, 24–28 cells,
no holes, 70 % of the box or more), counting every legal first
placement of every piece and whether the rest can still be filled:

| Ways to fill the board | First placements that leave it unsolvable |
|---|---|
| 1 | 97 % |
| 2–5 | 95 % |
| 6–20 | 88 % |
| 21–200 | 78 % |

An example, two players, one way to fill it (Anna holds T, I and Z,
Ben s, y and v; a test fixture). Ben has placed his s and his v, and
Anna her Z: everything fits, yet the board is lost, because the gap top
right is an L of four and nobody holds one. Anna knows her T and I do not
fit it, Ben knows his y does not; neither can know the board is dead
until they say so.

```
  ·     ·           s     ·           s     y
· ·   · · · ·     s s   Z · · ·     s s   y y y y
· · · · · · ·     s · · Z Z Z v     s I I I I Z v
· · · · · · ·     · · · · · Z v     T T T Z Z Z v
  ·   · · · ·       ·   · v v v       T   Z v v v
```

(The board, the dead end, the solution.)

So placing blind is nearly always wrong, which is why pieces can be
lifted on every level: a board whose placed pieces were final would be
lost on its first move. Hard makes second thoughts cost; it cannot
forbid them.

**Easy's warning**: after each placement the host runs the solver on
what is left (free cells, every piece still in a hand) within the step
budget; when it proves that nothing fills it, the TV and the phones say
"Hmm, something is stuck" until a piece is lifted. A count that runs out
says nothing.

## 9. Players who come, go and come back

- **Latecomers** (`lateJoin: "wait"`) are dealt in at the next board.
- **Away** (the phone dropped): after 8 s away, the player's pieces, in
  hand and on the board, go to the players who are there, one at a time
  to whoever holds the fewest. The board can still be solved without
  them. Back on the same board, they point and talk; they are dealt in
  again at the next board. Removed or left: at once.
- **Too few**: a board starts only with at least 2 players in the game
  (`minPlayers`; away phones count, they may come back). Fewer: the game
  ends on its end screen. A board is dealt to the players who are
  connected at its start.

## 10. Views and timing

The host is the only authority (`game/game.ts` has the views in its
header comment):

- `party.room` (every phone): the phase, the board's shape, the pieces
  on it (id, owner, cells), how many pieces each player holds, the
  cursors, the clock, the level and the pace, boards solved.
- `player.state` (one phone): the task and **the hand** (each piece's id
  and cells).
- `party.screen` (the TV): the same board, counts and cursors; at the
  celebration the spares, at time's up the solution and every hand.

**The board is a shared workspace**: placements, lifts and cursors reach
the phones at once, not with the TV (`withTv` would make every placement
on one's own phone wait a quarter to half a second, and collisions are
decided by the host anyway). Phases are not: a new board, the
celebration, time's up and the end reach the phones with the TV
(`party.withTv`), so no phone shows the next board before the TV.

## 11. The TV, the phone, the look

**The look: bubble gum.** Pastel candy on a pink quilt: a cotton-candy
background with polka dots and slow floating sparkles, hearts and
stars; the board is a quilted cream cushion with stitched edges; the
pieces are soft jelly candies in the players' colours (a light top, a
darker rim, a gloss) with **little faces**: two dot eyes that blink, rosy
cheeks and a small smile on the cell nearest the piece's middle. A
piece that lands squishes and wobbles, a refused one shakes its head; a
solved board makes every face smile wide and bounce, with confetti. A
bow sits on the logo's g. No characters, no cats: the faces are the
pieces'. Fredoka (rounded, SIL OFL) for everything; colours from a
palette of eight candy tones that stay apart on a pink ground.

**The TV** (1280×720): the logo, the shape's number, the shapes done and
the level top left, the clock top right (a candy ring that drains, red
under 15 s, throbbing and ticking each second under 10 s; the time back
pops up beside it), the board in the middle as large as fits, the team
down the left (a candy chip each with the name and a wrapped sweet per
piece still in hand), tvpipe's join badge bottom left under it. Cursors
are rounded arrows with the initial; pings are rings. Solved: the faces
close their eyes and smile, the board bounces, "Snug!", confetti, who
placed the last piece, and the spares beside their owners. Time's up:
"Time's up!", the faces go sleepy, then the placed pieces fade and the
solution drops in with every hand beside its owner. The lobby: the logo,
the tagline, how to play in three steps, the level and the clock, the
join code in a candy-striped card, the players as candies dropping into
a jar.

**The phone** (portrait): the clock and the board number on top, the
board as large as the width allows, the hand below (each piece in its own
slot: tap to turn it a quarter, the flip button under it; pieces that fit
nowhere greyed on easy and normal). Dragging a piece lifts it above the
finger (so the finger does not hide it) and shows where it would land,
snapped, on the board (dashed in one's colour, grey where it does not
fit); letting go places it at once on the phone, and the host's answer
keeps it or bounces it back with why ("Mia was quicker!"). Tapping one's own piece on
the board lifts it, dragging it moves it. Touching anywhere else on the
board is the cursor. Buzzes: a short one on placing, two on a refusal.

**Sound** (TV, synthesized): a soft pop for a placement, a squeak for a
lift, a boing for a collision, a chime for a ping, a ticking clock under
10 s, a sparkle and a fanfare for a solved board, a slide whistle at
time's up.

**Awards** at the end: *snuggest fit* (the most boards finished with
one's piece), *pointer* (the most pings), *second thoughts* (the most
lifts).

## 12. Settings

The host page and the VIP's phone: **level** (easy, normal, hard),
**pace** (relaxed, normal, rushed), the language (English, German), late
joining (wait, closed).

## 13. Checking it

`npm test`: the pieces and their orientations, the generator (every board
has no holes, is filled by its solution, keeps to its box, deals evenly),
the solver against fixtures (the board of §8's example with its one
solution and a dead first placement), placing and its refusals, whole
games with bots in memory (secrecy: no hand reaches the TV or another
phone before it is placed; collisions; hard's cost; drop-outs and the
hand-off; latecomers; too few players; cursors), and `test/live/play.ts`
through tvpipe in headless Chrome (a phone joins, turns and flips a
piece, drags its pieces onto the shape with touches, points, takes one
back; bots play the rest; a shape is solved, the next runs out of time;
screenshots of the TV and of the phone at five sizes with layout checks;
`--shots DIR` for the games list).
