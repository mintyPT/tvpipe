> Superseded by `docs/jinx-design.md` (the decided design). This brief is
> what the design subagents started from.

# Jinx — design brief (working name)

A new playshare game for `tvpipe game play`, inspired by the general idea of
the board game "Just One" but not a copy: our own name, rules twists, words
and look. English only for now. 3–8 players.

Read for the platform: `AGENTS.md`, `docs/games.md`, `npm/party/README.md`,
and the reference game `games/drawbluff` (README, `screen/`, `phone/`,
`game/`). The TV page is a web page rendered in a headless Chrome on the
host computer, captured and H.264-encoded (30 fps typical, up to 60), cast to
an AirPlay/Chromecast TV. Layout is e.g. 1280x720 CSS px, rendered sharper at
1080p/4K (devicePixelRatio). Sound: Web Audio routed through `captureAudio`
(a DOM `<audio>` is not captured on the surface path). Games run in browsers:
no Node at runtime, no Rust game logic. Games may take their own npm deps,
but prefer none.

## Rules (current state of the discussion)

- **One guesser per round**, rotating; everyone else is a clue-giver (2–7).
  With 3 players each clue-giver gives two clues. A game is each player
  guessing once or twice (~10–15 min).
- **Writing (~40 s)**: every clue-giver sees the secret word on their phone
  and types ONE word as a clue. The guesser's phone never shows the word;
  the TV never shows the word until the verdict. While writing, nothing about
  collisions is revealed (the TV only shows who has submitted).
- **Bold clues**: when submitting, a clue-giver may mark the clue *bold*. On
  the TV it is a face-down card with a flame. Survives and is turned before the
  right guess → double points. Jinxed → its author loses points.
- **Jinx**: all clues flip face down on the TV. Clues that match (the game
  decides, deterministically: case, plurals, word family, typos, …) slam
  together and shatter, with a short reason ("same stem"). Invalid clues
  (contain the word, same family as the word) are struck. The guesser sees
  how many were lost, never the words.
- **Reveal**: the surviving face-down cards carry their author's avatar; the
  **guesser picks which card to turn next** ("I trust Anna first"). A **pot**
  of points starts full and shrinks with every turned card (and a bit per
  jinx). After any card the guesser may type a guess on the phone; **the
  typed guess appears live on the TV** letter by letter (the room must stay
  silent). One guess only; or pass.
- **Verdict**: right → word appears, celebration; wrong/pass → word appears
  anyway.
- **Replay**: all clues with authors, including the jinxed ones ("three of
  you wrote *cheese*"). The guesser taps the **MVP clue** on the phone.
- **Scoring is mixed**: a cooperative room total ("9 of 13 words") plus
  personal points (guesser: by pot; clue-givers: clue turned before a right
  guess, bold doubling/penalty, MVP-clue bonus).
- **End**: room result, then the MVP of the game, then awards from stats
  (Mind meld: the pair that jinxed each other most; Lone wolf: most unique
  clues that helped; Kamikaze: most jinxed), and a **word web**: every word of
  the evening on one screen, linked by the clues that led to it.
- Avatars: undecided (ready-made characters vs a quick doodle in the lobby,
  Drawbluff has a drawing canvas).

Scratch space for design work: `games/jinx/design/` (not committed yet).
Do not change anything outside `games/jinx/`. Do not commit. Do not add
dependencies without asking.
