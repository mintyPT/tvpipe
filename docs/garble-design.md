# Garble (design)

A telephone drawing game for 4–12 players in `games/garble`: a web app on
`@tvpipe/party`, like `games/drawbluff`. Draw, guess, pass it on; every
player only sees the step right before theirs. On top of the telephone
game sit two secrets that pull against the shared goal of keeping chains
alive: a word each player tries to smuggle in, and one Wrecker who wants
chains to die. People judge; the machine only checks facts.

## 1. Why it is fun

- **Drift is funny by itself.** "A peacock showing off" becomes "a
  sneaky pancake" in four steps. Bad drawers make it better, not worse,
  which is the opposite of Drawbluff, where a good drawing matters.
- **Nobody waits.** Every step, every player works on one chain at the
  same time, so a step takes as long as its timer at most, whatever the
  room's size.
- **The reveal is a story**, told on the TV card by card, and judged by
  the one person who knows how it started.
- **Contradicting desires.** Everybody wants chains to survive (it pays
  everyone in them) but also wants their own word in them (which bends
  them), and one player wants them dead. Every bend is suspicious: an
  honest bad drawing, a smuggled word, or the Wrecker?
- **Progressive disclosure** on three levels: you see one step of a
  chain; the TV shows a chain one card at a time; secrets come out in
  order (smuggled words at their verdict, the Wrecker at the end of the
  round, everyone's word on the ledger).

## 2. A round

```
secrets ─▶ step 1 (draw) ─▶ step 2 (guess) ─▶ … ─▶ step S (guess) ─▶ reveal (per chain) ─▶ hunt ─▶ unmask ─▶ scores
 11 s        80 s              30 s                    30 s             show, judge, verdict    35 s     ~9 s     12 s
```

- **Secrets.** Every phone shows the same face-down card ("top secret");
  held, it shows the player's word, and for one player also "You are the
  Wrecker". The TV explains both (and the round's twist).
- **Steps.** Seats are shuffled each round. Chain `c` starts at seat `c`;
  step `k` of chain `c` is done by seat `(c + k) % n`, so each step is a
  permutation (everyone busy) and no chain visits a player twice. Chains
  have `S = min(length, n)` steps rounded down to even (4, 6 or 8 by the
  room's setting), always ending with a guess. The first step deals two
  prompts to pick from, then draw. A drawer reads the latest guess of
  the chain (a skipped guess passes the one before on); a guesser sees
  the latest drawing. Missing answers count as an empty page or a skipped
  guess; the chain goes on.
- **Reveal.** Each chain in turn: the prompt, then each drawing (it
  draws itself, stroke by stroke) and each guess (written in), the camera
  following along the thread. Then everything at once (chains over five
  cards snake over two rows) while the chain's **author** judges on their
  phone: tap the first guess that no longer says it (everything after it
  dies with it), or "it survived". The TV stamps ALIVE on each guess up
  to the death, DEAD on the one that killed it, cuts the thread there,
  and names the drawer and guesser of that link. Smuggled words get a
  highlighter and a tag ("zebra · Gizmo's secret word"). Phones can
  react meanwhile (four bubbles that float up the TV).
- **Hunt.** Everyone names a suspect (not themselves). The TV and the
  phones show how many deaths each player was at, the only evidence there
  is besides what everyone saw.
- **Unmask.** The votes land as pins, the most-voted card shakes, the
  Wrecker's card flips: caught or got away.

Several rounds make a game (default 2). The Wrecker rotates (the fewest
times Wrecker so far); words and prompts are dealt from decks the room
keeps from game to game (no repeats until all were dealt).

## 3. Judging: people for taste, the machine for facts

- **Where a chain died** is taste ("is 'skateboarding granny' still
  'grandma on a skateboard'?"), so a person decides: the author, who drew
  the prompt and is the only one who knew it. It is quick (one tap), and
  the author's verdict is itself evidence: a Wrecker judging their own
  chain dishonestly is visible to the room. The verdict is monotonic (the
  first dead guess; no revival). Without an answer (the author left, is
  away, or the timer ran out) the machine judges: a guess still says the
  prompt when they share a meaningful word (`alike` in `game/rules.ts`).
- **Whether a word was smuggled** is a fact the machine checks
  (`says`): the same word folded (case, accents, `ß`), the same stem
  (plural and inflection endings, English and German), or for stems of
  four letters and more, inside a longer word (`Piratenoma`,
  `rocketship`). A player's word counts where it **first** shows up in a
  guess written by **someone else**, **after** the player's own step, and
  not in the prompt. Writing your own word into your own guess counts for
  nobody (and blocks it for later). Secret words are dealt so that none is
  in the round's prompts, and none contains another.

## 4. Points

| | |
|---|---|
| Each link that survived (a drawing and the guess after it) | 100 to its drawer, 100 to its guesser |
| Your word smuggled into a chain | 300 (once per chain) |
| The Wrecker: a chain that died at their drawing or guess | 300 each, **void if caught** |
| Naming the Wrecker | 200 each |
| The Wrecker, not caught | 400 |

The Wrecker is caught when they alone have the most votes (a tie lets
them go). A 6-player round with 6 steps has 3 links per chain and every
player in 6 chains: about 600 a round for keeping everything alive, so a
smuggled word is worth half a round of survival, and the Wrecker breaking
three chains and getting away (1300) beats any honest player, which is
why catching them matters.

## 5. Twists (progressive disclosure on the guesses)

With twists on (the default) the rounds rotate: 1 **clear** (the drawing
draws itself, then stays; replay), 2 **Glimpse** (it draws itself, stays
three seconds, then fades: guess from memory), 3 **Peephole** (covered;
only a circle under the finger shows it), then clear again.

## 6. The look

Paper and ink on a dark cutting mat. Drawings are black ink only, on
off-white paper with tape. Prompts are typed (Special Elite) on manila
tags, guesses handwritten (Caveat) on index cards, headings and rubber
stamps in Anton. Red is the thread, death and the Wrecker; blue is life;
a highlighter marks smuggled words; each player's colour appears only on
their pin and avatar. Everything moves: the logo's paper letters bob,
name tags drop in, cards are dealt, slips travel round the ring of
players between steps, drawings replay, stamps thump, threads get cut,
votes land as pins, polaroids flip, scores count up. Short synthesized
sounds on the TV only (the host's preview is muted).

The phone is made for thumbs: the pad as large as the screen allows with
the tools under the thumb, the keyboard-aware guess screen, big tiles
for the judge, the suspects and reactions; secrets show only while a
finger holds them.

## 7. Views and privacy

The host is the only authority (docs/party-design.md §5). A player's
word reaches only their own phone, and the Wrecker's role only the
Wrecker's, until the unmasking; a word becomes public on the TV when it
is smuggled, all of them on the ledger. `test/game.test.ts` watches every
view of a whole game for leaks.

## 8. Not done (yet)

- More than 12 players: the reveal shows every chain, about 30–45 s
  each; past 12 it would need Drawbluff's spotlights and a gallery.
- Joining mid-game: newcomers wait for the next round (`wait`) or the
  next game (`closed`); a chain cannot take a player in mid-round.
- The machine's verdict is a simple word match; synonyms ("granny" for
  "grandma") count as dead. It only matters when the author does not
  judge.
- Bots cannot see drawings: the host page gives them what a drawing was
  meant to be (and the drawer's word now and then), so games with bots
  survive, drift and smuggle.
