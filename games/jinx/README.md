# Jinx

A team word game for 3–8 players on
[`@tvpipe/party`](../../npm/party), in English and German: the room plays
as one, with one bank of chips and no personal points. One player guesses a
secret word from one-word clues the others write on their phones; clues
that are the same (the game decides: same word, plural, verb form, word
family, typo, …) jinx and are lost. The guesser picks whose card to turn,
the pot shrinks with every card and goes into the room's bank on a right
guess, clue-givers can bet the room's chips on a bold clue, and the guess
is typed live on the TV. The bank climbs towards the room's titles and its
record; the evening ends with the room's title, the best clues of the
night, awards and a web of every word and clue.
The design, with every rule and number: [`docs/jinx-design.md`](../../docs/jinx-design.md).

It is a web app for [`tvpipe game play`](../../docs/playshare-design.md):
tvpipe serves it, the game runs in its host page (a window on the
computer), the TV page is cast to AirPlay and Chromecast receivers, and
phones join with the QR code.

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 3–8 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`), the clue matchers (`match.ts` English, `match-de.ts` German, `lang.ts` picks one), the game (`game.ts`), bots (`bots.ts`), the views (`views.ts`: the contract between host, TV and phones) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | the party, the TVs, the players, settings (language, rounds, writing time, words), a muted preview of the TV; `strings.ts` |
| `screen/` | the TV page | the table seen from above; `strings.js` |
| `phone/` | the phone page | faces, clues, cards, the guess; `strings.js`, `i18n.js` (numbers, plurals, lists) |
| `data/words.txt`, `data/dict.txt`, `data/words.de.txt`, `data/dict.de.txt` | per language: the secret words (with difficulty, category, accepted guesses, banned clues), the dictionary for typos and word forms | fetched by the host page; `design/` has how they were made (German: `design/words/de/`, `design/matching/de/`); `dict.de.txt` is the German Wiktionary's, CC BY-SA 4.0 (`dict.de-LICENSE.txt`) |
| `CREDITS.md` | the word lists' and dictionaries' sources | |

## Running it

```sh
cargo build --release -p tvpipe-cli         # tvpipe
(cd npm/party && npm ci && npm run build)
cd games/jinx && npm install && npm run build
../../target/release/tvpipe game play .     # or: tvpipe game play games/jinx
npm run zip                                 # jinx.zip (tvpipe game pack)
```

Pick the TVs in tvpipe's launcher, then Start: the window becomes the host
page. Scan the QR code on the TV; the first player is the VIP and starts from their phone once three
are in (or the host page's Start), and offers "Play again" at the end.

Settings: language, rounds (auto: every player guesses twice with 3–5 players, once
with 6–8; or once, or twice), writing time (30/45/60/90 s), words (easy,
normal: mostly easy and medium with one hard word in ten, hard: medium
and hard). The room deals no word twice until it dealt them all (kept per
language in the host page's `localStorage`) and never two related words
in one game. The host page also keeps the room's record: its best bank
for a game of that many rounds.

## Languages

English and German. The language is the room's: a setting on the host
page, which starts with the browser's language (then the last choice on
that computer) and changes only between games. It goes with the room and
TV views (`lang`), so every phone, the TV and the host page speak it; a
phone may switch for itself on the join screen, in the lobby and at the
end. Each language has its own words (`data/words.de.txt`), dictionary
and clue matcher (`game/lang.ts`): what jinxes in German is German
grammar, read from a lexicon of the German Wiktionary (Hunde/Hund,
lief/laufen, größer/groß, Schneemänner/Schneemann, Bäcker/backen; see
`design/matching/de/SPEC.md`), and the reasons on the tape are German ("PLURAL", "ANDERE
FORM", "WORTFAMILIE"). The pages' texts are in `strings.js`/`strings.ts`,
written for each language rather than translated (German: "du", the
same cheeky host, German stamps: RICHTIG!, DANEBEN, EINGELOGGT; JINX! stays
the game's word). A language whose data files are missing cannot be
picked. Long German compounds fit: card words shrink, then condense, then
break onto a second line on the phone's small cards; the secret word on
the phone's index card condenses further; running text hyphenates
(`lang` on every page).

## Tests

`npm test`: the matchers' known-answer tables (`test/match*.test.ts`), the
German word list against the German matcher (`test/words-de.test.ts`), the
rules (`test/rules.test.ts`: the pot, the bank, dealing, guesser order, titles and goals,
awards, the web), and whole games with bots on `@tvpipe/party`'s relay
in memory (`test/game.test.ts`): 3 and 4 players, play again, clue
refusals and replacing, all clues jinxed, wrong guesses and passes (the bank never below 0), the bank, best clues and the record, timers
for a silent or disconnected guesser, a late joiner, a player who leaves,
a guesser who leaves, the secrecy of the word on the TV and the guesser's
phone; a German game with bots, the language switched between games
(each language with its own dealt words) and a German refusal.

`node test/live/play.ts [--bots N] [--rounds auto|1|2] [--lang en|de] [--out DIR]` (after
`npm run build`; not part of `npm test`): a whole game on the real `tvpipe
game play` with headless Chrome as the host window, the TV and a phone, bots
for the others; screenshots of every phase, layout checks, and checks that
no phone shows a jinx or the word before the TV does. Bots write the
word's category or another word from the word list, so they jinx now and
then, and they peek at the word to guess. They are for tests: the host
page's bot buttons show only with `?bots` in its URL or with `tvpipe
game play --dev`. `--lang de` plays a
German room (screenshots in `/tmp/jinx-live-de`): the phone's browser in
German, German clues and guesses, the same layout checks.
