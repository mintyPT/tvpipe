/**
 * The web launcher's answers to "Where should the game show?"
 * (docs/browser-party-design.md, "The launcher"): the screens `WebHub`
 * offers (`kind: "browser"`, named `this`, `cable`, `window`, `none`)
 * with the words for this device, the best one first, and AirPlay
 * mirroring as instructions on Apple devices. No DOM here: the launcher
 * passes what it found out about the device (`detectDevice`).
 */

import type { Device } from "./tvpipe.ts";

/** What the launcher needs to know about the device it runs on. */
export interface DeviceInfo {
  /** A touch device (a tablet or phone), not a laptop with a touch screen. */
  touch: boolean;
  /** An Apple device, which can mirror to an Apple TV. */
  apple: "ipad" | "iphone" | "mac" | null;
  /** Chrome or Edge on a computer: Chrome's "Cast tab". */
  chromium: boolean;
}

/** One answer of the launcher. */
export interface ScreenOption {
  /** Unique in the list (`mirror` besides the devices' names). */
  id: string;
  /** The device `select` gets. */
  device: string;
  label: string;
  note: string;
  /** A short tag at the row's end. */
  tag: string;
  /** Steps to follow before Start (mirroring). */
  steps?: string[];
}

/** The screens' names in web mode. */
export const SCREENS = ["this", "cable", "window", "none"] as const;

/** Finds out what `DeviceInfo` says, from the browser's own objects. */
export function detectDevice(nav: { userAgent: string; maxTouchPoints?: number; platform?: string }, coarse: boolean): DeviceInfo {
  const ua = nav.userAgent;
  const touchPoints = nav.maxTouchPoints ?? 0;
  // iPadOS Safari says "Macintosh"; only the touch points tell.
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const iphone = /iPhone|iPod/.test(ua);
  const mac = !ipad && /Macintosh|Mac OS X/.test(ua);
  const mobile = ipad || iphone || /Android|Mobile/.test(ua);
  const touch = mobile || (coarse && touchPoints > 0 && !/Windows|Macintosh|X11|CrOS/.test(ua));
  const chromium = !touch && /Chrome\/|Edg\//.test(ua) && !/OPR\//.test(ua);
  return { touch, apple: ipad ? "ipad" : iphone ? "iphone" : mac ? "mac" : null, chromium };
}

function thisLabel(d: DeviceInfo): string {
  if (d.apple === "ipad") return "This iPad";
  if (d.apple === "iphone") return "This iPhone";
  return "This screen";
}

/** The steps to mirror to an Apple TV on this device. */
export function mirrorSteps(d: DeviceInfo): string[] {
  if (d.apple === "mac") {
    return [
      "Click Control Center in the menu bar, then Screen Mirroring, and pick the Apple TV.",
      "Choose Mirror Built-in Display. (Use As Separate Display makes the TV a second screen: then pick The TV on the cable in Chrome or Edge, or A second window.)",
      "Click Start: the game fills this window, full screen, and the TV shows it.",
    ];
  }
  return [
    `Open Control Center (swipe down from the top right corner of the ${d.apple === "iphone" ? "iPhone" : "iPad"}).`,
    "Tap Screen Mirroring and pick the Apple TV.",
    "Tap Start: the game fills this screen, and the TV shows it.",
  ];
}

/**
 * The answers for these devices, the best first: on touch devices this
 * screen, with a TV on a cable that TV, else this screen. `Another screen`
 * is always last.
 */
export function screenOptions(devices: readonly Device[], d: DeviceInfo): ScreenOption[] {
  const has = new Set(devices.filter((x) => x.kind === "browser").map((x) => x.name));
  const out: ScreenOption[] = [];
  const add = (o: ScreenOption | null) => {
    if (o) out.push(o);
  };
  const here: ScreenOption | null = has.has("this")
    ? {
        id: "this",
        device: "this",
        label: thisLabel(d),
        tag: "Here",
        note: d.touch
          ? "The game fills the screen: put it where everyone sees it. The room's controls are behind ⋯."
          : "The game fills this window, full screen. The room's controls are behind ⋯.",
      }
    : null;
  const cable: ScreenOption | null = has.has("cable")
    ? {
        id: "cable",
        device: "cable",
        label: "The TV on the cable",
        tag: "Cable",
        note: "The game goes full screen on the other screen; this window keeps the room's controls.",
      }
    : null;
  const window: ScreenOption | null = has.has("window")
    ? {
        id: "window",
        device: "window",
        label: "A second window",
        tag: "Window",
        note: "A window with the game's picture: drag it onto the TV or projector, then Full screen. This window keeps the room's controls.",
      }
    : null;
  const mirror: ScreenOption | null =
    d.apple && has.has("this")
      ? {
          id: "mirror",
          device: "this",
          label: "Apple TV, by mirroring",
          tag: "AirPlay",
          note: `${d.apple === "mac" ? "macOS" : d.apple === "iphone" ? "iOS" : "iPadOS"} shows this screen on the Apple TV, a little later than here.`,
          steps: mirrorSteps(d),
        }
      : null;
  const none: ScreenOption | null = has.has("none")
    ? {
        id: "none",
        device: "none",
        label: "Another screen",
        tag: "tvpipe.party/tv",
        note: "Any browser can show the game: a smart TV's, another laptop's. Open tvpipe.party/tv there and type the room's code.",
      }
    : null;
  if (d.touch) [here, mirror, cable, window].forEach(add);
  else if (cable) [cable, here, window, mirror].forEach(add);
  else [here, window, mirror].forEach(add);
  add(none);
  return out;
}
