/**
 * The TV sync page (`/_tvpipe/tvsync/`): the launcher casts it to a TV
 * while people tap along with its flashes (`../tapsync.ts`). It flashes
 * and clicks on the wall clock's beats; tvpipe's browser renders it on
 * the same computer as the launcher, so both count the same beats.
 */
import { Metronome } from "../lib/tapsync.js";
const el = document.getElementById("beat");
let audio;
try {
    audio = new AudioContext();
}
catch {
    audio = undefined;
}
new Metronome(el, { audio, compensate: false }).start();
