/**
 * @tvpipe/party: party games for `tvpipe game play`. The game's host page
 * keeps the room (players, keys, views, actions) with {@link Party} and
 * talks to tvpipe with {@link Tvpipe}; phones and the TV page use
 * {@link PartyClient}. tvpipe serves these modules at `/_tvpipe/lib/`.
 * See README.md and docs/playshare-design.md.
 *
 * @module
 */
export { Party, PartyError, Player, PROTOCOL, BYE, HELLO_TIMEOUT, token, MAX_TV_DELAY, LATE_JOIN, } from "./party.js";
export { Tvpipe, TvpipeError, HostedParty, needsPairing, mergeCast, PAIRING_REQUIRED, PICKER_MESSAGE, GAME_PICKER, GAME_PICKER_MESSAGE, TV_DISPLAY_MS, TV_RENDER_MS, tvDelayOf, } from "./tvpipe.js";
export { TvpipeRelay, frame, OP_TEXT, OP_BINARY } from "./relay.js";
export { Emitter } from "./emitter.js";
export { RejoinBadge } from "./rejoin.js";
export { frameLink, announceToFrame, FRAME_MESSAGE } from "./frame.js";
export { HostPage, SettingsForm, hostStrings, languageField, lateJoinField, preferredLang, textIn, } from "./host.js";
export { StateBox, diff, applyDiff, toJson } from "./sync.js";
export { cleanText, graphemes, nameKey } from "./names.js";
export { blockEmoji, hasEmoji, stripEmoji } from "./emoji.js";
export { TokenBucket, WindowCounter } from "./limits.js";
export { PartyClient, PartyActionError, NEXT_GAME_MESSAGE, memoryStorage, CARRY_LIMIT, qrSvg, drawQr, joinText, } from "./client.js";
// Web mode: tvpipe.party in the browser (docs/browser-party-design.md).
export { WEB, isWeb, setWebMode } from "./mode.js";
export { readWebSession, writeWebSession, clearWebSession, SESSION_KEY } from "./session.js";
export { encodeQr } from "./qr.js";
export { WebHub, loadWebGames, webDevices, browserName } from "./webhub.js";
export { WebRtcRelay } from "./rtc-relay.js";
export { DataChannelSocket, dataChannelSocket, joinUrl, requestScreen } from "./rtc-socket.js";
export { HostSignal, joinSignal, SignalError } from "./signaling.js";
export { LocalHost, LocalSocket, localSocketFor, localUrl, LOCAL_CHANNEL } from "./local.js";
export { ScreenCaster, LOCAL_PREFIX, localScreen, screenWindowUrl, screenTitle, keepAwake, SCREEN_WINDOW, SCREEN_CHANNEL, SCREEN_PAGE } from "./screens.js";
export { iceServers, setWebDeps, webDeps, PUBLIC_STUN } from "./rtc.js";
export { memoryRelay, MemoryRelay, dropOuts } from "./testing.js";
export { SurfaceEncoder, captureAudio, slrwRecord, wallMicros, } from "./surface.js";
