/**
 * Which build of the library this is (docs/browser-party-design.md, "Web
 * mode"): tvpipe's copy (false), or tvpipe.party's, whose deployment
 * rewrites the one compiled line that exports `WEB` to say true. In web mode `Tvpipe.connect()` answers in the page
 * (`WebHub`), the relay is WebRTC and `PartyClient.fromLocation()`
 * connects over data channels.
 */

export const WEB: boolean = false;

let override: boolean | undefined;

/** Whether the library runs in web mode (the build's {@link WEB}, or a test's override). */
export function isWeb(): boolean {
  return override ?? WEB;
}

/** For tests: forces web mode on or off (`undefined`: the build's again). */
export function setWebMode(on: boolean | undefined): void {
  override = on;
}
