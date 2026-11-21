/**
 * The TV sync page (`/_tvpipe/tvsync/`): the launcher casts it to a TV
 * and shows the same numbered flashes, late by a lag the person moves
 * until both flash together (`../flashsync.ts`). tvpipe's browser
 * renders it on the same computer as the launcher, so both go by the
 * same clock.
 */
import { Flasher } from "../lib/flashsync.js";
new Flasher(document.getElementById("beat")).start();
