# pinch's fonts

From the google/fonts repository on GitHub (`ofl/limelight`,
`ofl/josefinsans`, `ofl/courierprime`), the whole fonts, not subset,
only repacked from TTF into WOFF2 (fontTools); the glyphs and names are
unmodified. They cover German.

| File | Font | Used for | License |
|---|---|---|---|
| `limelight.woff2` | Limelight (400) | the Deco display face: the logo, titles, intertitles, outcome cards, HELD | SIL OFL 1.1: `OFL-limelight.txt` |
| `josefin-sans.woff2` | Josefin Sans (variable, 100–700) | text: names, the catalogue, buttons, room names on the blueprint, claims | SIL OFL 1.1: `OFL-josefin-sans.txt` |
| `courier-prime.woff2`, `courier-prime-bold.woff2` | Courier Prime (400, 700) | the typewriter: the ticker's facts, the printed tags on the map, the tape's timecode | SIL OFL 1.1: `OFL-courier-prime.txt` |

`deco.css` declares them as `Limelight`, `Josefin Sans` and
`Courier Prime`; `draw.js` uses the same names on the canvas.
