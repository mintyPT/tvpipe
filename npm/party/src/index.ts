/**
 * @tvpipe/party: party games for `tvpipe game play`. The game's host page
 * keeps the room (players, keys, views, actions) with {@link Party} and
 * talks to tvpipe with {@link Tvpipe}; phones and the TV page use
 * {@link PartyClient}. tvpipe serves these modules at `/_tvpipe/lib/`.
 * See README.md and docs/playshare-design.md.
 *
 * @module
 */

export {
  Party,
  PartyError,
  Player,
  PROTOCOL,
  BYE,
  HELLO_TIMEOUT,
  token,
  MAX_TV_DELAY,
  type ActionHandler,
  type ActionInfo,
  type ByeReason,
  type CollectOptions,
  type JoinInfo,
  type LateJoin,
  LATE_JOIN,
  type Logger,
  type LogLevel,
  type PartyEvents,
  type PartyLimits,
  type PartyOptions,
  type PartyStats,
  type Role,
  type Screen,
  type Sender,
} from "./party.ts";
export {
  Tvpipe,
  TvpipeError,
  HostedParty,
  needsPairing,
  PAIRING_REQUIRED,
  PICKER_MESSAGE,
  GAME_PICKER,
  GAME_PICKER_MESSAGE,
  TV_DISPLAY_MS,
  TV_RENDER_MS,
  tvDelayOf,
  type CastStatus,
  type ConnectOptions,
  type Device,
  type HostedPartyOptions,
  type Info,
  type NextGame,
  type PairStatus,
  type PartyLinks,
  type ReceiverStatus,
  type Resolution,
  type Selection,
  type TunnelInfo,
  type TvpipeEvents,
} from "./tvpipe.ts";
export { TvpipeRelay, frame, OP_TEXT, OP_BINARY, type Relay, type RelayConn, type Via } from "./relay.ts";
export { Emitter } from "./emitter.ts";
export { RejoinBadge } from "./rejoin.ts";
export {
  HostPage,
  SettingsForm,
  hostStrings,
  languageField,
  lateJoinField,
  preferredLang,
  textIn,
  type Choice,
  type ChoiceField,
  type Field,
  type HostGame,
  type HostRunOptions,
  type HostShellOptions,
  type Text,
  type ToggleField,
  type Value,
} from "./host.ts";
export { StateBox, diff, applyDiff, toJson, type Diff, type Json, type JsonObject } from "./sync.ts";
export { cleanText, graphemes, nameKey } from "./names.ts";
export { blockEmoji, hasEmoji, stripEmoji } from "./emoji.ts";
export { TokenBucket, WindowCounter } from "./limits.ts";
export {
  PartyClient,
  PartyActionError,
  memoryStorage,
  CARRY_LIMIT,
  qrSvg,
  drawQr,
  joinText,
  type Corner,
  type PartyClientOptions,
  type RejoinBadgeOptions,
  type QrRows,
  type Carried,
  type StorageLike,
  type Status,
  type WebSocketFactory,
  type WebSocketLike,
} from "./client.ts";
export { memoryRelay, MemoryRelay, dropOuts, type DropKind, type DropOutOptions, type DropOuts } from "./testing.ts";
export {
  SurfaceEncoder,
  captureAudio,
  slrwRecord,
  wallMicros,
  type CanvasSource,
  type EncoderOptions,
  type SurfaceInfo,
  type SurfaceStats,
  type SurfaceStatus,
} from "./surface.ts";
