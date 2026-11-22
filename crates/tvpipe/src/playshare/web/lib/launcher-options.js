/**
 * The web launcher's answers to "Where should the game show?"
 * (docs/browser-party-design.md, "The launcher"): the screens `WebHub`
 * offers (`kind: "browser"`, named `this`, `cable`, `window`, `none`)
 * with the words for this device, the best one first, AirPlay mirroring
 * as instructions on Apple devices, and the way to the tvpipe app for
 * Apple TV and Chromecast (`appWay`). No DOM here: the launcher passes
 * what it found out about the device (`detectDevice`).
 */
import { LOCAL_PREFIX } from "./screens.js";
/** The screens' names in web mode. */
export const SCREENS = ["this", "cable", "window", "none"];
/** Finds out what `DeviceInfo` says, from the browser's own objects. */
export function detectDevice(nav, coarse) {
    const ua = nav.userAgent;
    const touchPoints = nav.maxTouchPoints ?? 0;
    // iPadOS Safari says "Macintosh"; only the touch points tell.
    const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
    const iphone = /iPhone|iPod/.test(ua);
    const mac = !ipad && /Macintosh|Mac OS X/.test(ua);
    const mobile = ipad || iphone || /Android|Mobile/.test(ua);
    const touch = mobile || (coarse && touchPoints > 0 && !/Windows|Macintosh|X11|CrOS/.test(ua));
    const chromium = !touch && /Chrome\/|Edg\//.test(ua) && !/OPR\//.test(ua);
    const windows = !touch && /Windows/.test(ua);
    return { touch, apple: ipad ? "ipad" : iphone ? "iphone" : mac ? "mac" : null, chromium, windows };
}
function thisLabel(d) {
    if (d.apple === "ipad")
        return "This iPad";
    if (d.apple === "iphone")
        return "This iPhone";
    return "This screen";
}
/** The steps to mirror to an Apple TV on this device. */
export function mirrorSteps(d) {
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
export function screenOptions(devices, d) {
    const has = new Set(devices.filter((x) => x.kind === "browser").map((x) => x.name));
    const out = [];
    const add = (o) => {
        if (o)
            out.push(o);
    };
    const here = has.has("this")
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
    const cable = has.has("cable")
        ? {
            id: "cable",
            device: "cable",
            label: "The TV on the cable",
            tag: "Cable",
            note: "The game goes full screen on the other screen; this window keeps the room's controls.",
        }
        : null;
    const window = has.has("window")
        ? {
            id: "window",
            device: "window",
            label: "A second window",
            tag: "Window",
            note: "A window with the game's picture: drag it onto the TV or projector, then Full screen. This window keeps the room's controls.",
        }
        : null;
    const mirror = d.apple && has.has("this")
        ? {
            id: "mirror",
            device: "this",
            label: "Apple TV, by mirroring",
            tag: "AirPlay",
            note: `${d.apple === "mac" ? "macOS" : d.apple === "iphone" ? "iOS" : "iPadOS"} shows this screen on the Apple TV, a little later than here.`,
            steps: mirrorSteps(d),
        }
        : null;
    const none = has.has("none")
        ? {
            id: "none",
            device: "none",
            label: "Another screen",
            tag: "tvpipe.party/tv",
            note: "Any browser can show the game: a smart TV's, another laptop's. Open tvpipe.party/tv there and type the room's code.",
        }
        : null;
    if (d.touch)
        [here, mirror, cable, window].forEach(add);
    else if (cable)
        [cable, here, window, mirror].forEach(add);
    else
        [here, window, mirror].forEach(add);
    add(none);
    return out;
}
/** The launcher's row for the tvpipe app (`ScreenOption.id`; not a screen of `select`). */
export const APP_ROW = {
    id: "app",
    label: "Apple TV or Chromecast — with the tvpipe app",
    tag: "tvpipe app",
    note: "The tvpipe app on a computer casts the game to the TV itself.",
};
/** The app's installers (site/build.py's install block). */
export const INSTALL = {
    unix: "curl -fsSL https://tvpipe.party/install.sh | sh",
    windows: "irm https://tvpipe.party/install.ps1 | iex",
};
/**
 * The way to the tvpipe app for `game`: this computer's installer and
 * `tvpipe game play GAME`; on touch devices both installers, for a
 * computer on the TV's Wi-Fi.
 */
export function appWay(d, game) {
    const play = { text: `tvpipe game play ${game}` };
    const note = "tvpipe finds the TVs on this Wi-Fi and casts sharper and with less delay than mirroring; it starts its own room, so phones scan its new QR code.";
    if (d.touch) {
        return {
            intro: "On a Mac, Windows or Linux computer on the TV's Wi-Fi:",
            commands: [{ text: INSTALL.unix, os: "macOS, Linux" }, { text: INSTALL.windows, os: "Windows" }, play],
            note,
        };
    }
    return { commands: [{ text: d.windows ? INSTALL.windows : INSTALL.unix }, play], note };
}
/**
 * The app's screens beside its TVs (docs/browser-party-design.md, "The
 * setups": a laptop with a cable): `local:this` (the TV picture over the
 * host page in its window) always, `local:cable` (a window full screen on
 * the other screen) when the computer has one (`screen.isExtended`).
 * `HostedParty.cast` shows them in the page; tvpipe casts to the rest.
 */
export function appScreens(extended) {
    const out = [{ name: `${LOCAL_PREFIX}this`, kind: "browser", title: "This screen" }];
    if (extended)
        out.push({ name: `${LOCAL_PREFIX}cable`, kind: "browser", title: "The TV on the cable" });
    return out;
}
/** What the app's launcher says under a local screen. */
export function appScreenNote(name) {
    return name === `${LOCAL_PREFIX}cable`
        ? "The game full screen on the other screen (a TV or projector on a cable); this window keeps the room's controls"
        : "The game fills the host's window (full screen with ⛶); the room's controls are behind ⋯";
}
