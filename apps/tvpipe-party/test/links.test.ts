import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALPHABET,
  hashSecret,
  isJoinUrl,
  newSecret,
  normalizeCode,
  randomCode,
  webJoinUrl,
  webLink,
} from "../src/links.ts";

const KEY = "AbCdEfGhIjKlMnOp_-12";

test("accepts tvpipe's join links", () => {
  for (const url of [
    `https://some-random-words.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://65b3d1e2edd55529.baqlo7vg7agz.opentunnel.xyz/?r=BCDF#k=${KEY}`,
    `https://a.b.opentunnel.xyz/?r=ABCDEFGH#k=${"x".repeat(64)}`,
    `https://${"a".repeat(63)}.trycloudflare.com/?r=QWERTY#k=${"0".repeat(16)}`,
  ]) {
    assert.ok(isJoinUrl(url), url);
  }
});

test("rejects everything else", () => {
  for (const url of [
    `https://evil.com/?r=BCDF#k=${KEY}`,
    `https://a.b.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://x.trycloudflare.com.evil/?r=BCDF#k=${KEY}`,
    `https://x.trycloudflare.com.evil.com/?r=BCDF#k=${KEY}`,
    `https://x.trycloudflare.com:8443/?r=BCDF#k=${KEY}`,
    `https://user@x.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://user:pw@r.x.opentunnel.xyz/?r=BCDF#k=${KEY}`,
    `https://evil.com@r.x.opentunnel.xyz/?r=BCDF#k=${KEY}`,
    `https://x.opentunnel.xyz/?r=BCDF#k=${KEY}`,
    `https://a.b.c.opentunnel.xyz/?r=BCDF#k=${KEY}`,
    `https://r.x.opentunnel.xyz.evil/?r=BCDF#k=${KEY}`,
    `http://x.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://X.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://-x.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://x-.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://${"a".repeat(64)}.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://x.trycloudflare.com/?r=BCDF&next=evil#k=${KEY}`,
    `https://x.trycloudflare.com/?r=BCDF`,
    `https://x.trycloudflare.com/?r=BCDF#k=`,
    `https://x.trycloudflare.com/?r=BCDF#k=short`,
    `https://x.trycloudflare.com/?r=BCDF#k=${"x".repeat(65)}`,
    `https://x.trycloudflare.com/?r=BCDF#k=${KEY}&x=1`,
    `https://x.trycloudflare.com/?r=bcdf#k=${KEY}`,
    `https://x.trycloudflare.com/?r=BCD#k=${KEY}`,
    `https://x.trycloudflare.com/?r=BCDFGHJKL#k=${KEY}`,
    `https://x.trycloudflare.com/game?r=BCDF#k=${KEY}`,
    `https://x.trycloudflare.com?r=BCDF#k=${KEY}`,
    `https://x.trycloudflare.com//?r=BCDF#k=${KEY}`,
    `https://x.trycloudflare.com/?r=BCDF#k=${KEY}\n`,
    ` https://x.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `javascript:alert(1)`,
    "",
  ]) {
    assert.equal(isJoinUrl(url), false, url);
  }
  assert.equal(isJoinUrl(42), false);
  assert.equal(isJoinUrl(null), false);
});

test("at most 300 characters", () => {
  // The longest link the pattern allows is well under 300 characters, so
  // the length rule only cuts off junk early.
  const longest = `https://${"a".repeat(63)}.trycloudflare.com/?r=ABCDEFGH#k=${"k".repeat(64)}`;
  assert.ok(longest.length < 300 && isJoinUrl(longest));
  assert.equal(isJoinUrl(longest + "k".repeat(300)), false);
  assert.equal(isJoinUrl("x".repeat(301)), false);
});

test("codes", () => {
  assert.equal(normalizeCode("bcdf"), "BCDF");
  assert.equal(normalizeCode("BcDf"), "BCDF");
  assert.equal(normalizeCode("ABCD"), null); // vowel
  assert.equal(normalizeCode("BCD0"), null);
  assert.equal(normalizeCode("BCDFG"), null);
  assert.equal(normalizeCode(""), null);
  assert.equal(normalizeCode(1234), null);
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const c = randomCode();
    assert.match(c, new RegExp(`^[${ALPHABET}]{4}$`));
    for (const ch of c) seen.add(ch);
  }
  assert.equal(seen.size, ALPHABET.length);
});

test("secrets", async () => {
  const s = newSecret();
  assert.match(s, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newSecret(), s);
  // Known answer: SHA-256("abc").
  assert.equal(await hashSecret("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("web rooms' join links, on the service's own origin", () => {
  const O = "https://tvpipe.party";
  assert.deepEqual(webLink(`${O}/r/?r=BCDF#k=${KEY}`, O), { code: "BCDF", key: KEY });
  assert.deepEqual(webLink(`http://localhost:8787/r/?r=ZZZZ#k=${"x".repeat(64)}`, "http://localhost:8787"), {
    code: "ZZZZ",
    key: "x".repeat(64),
  });
  assert.equal(webJoinUrl(O, "BCDF", KEY), `${O}/r/?r=BCDF#k=${KEY}`);
  for (const url of [
    `https://evil.com/r/?r=BCDF#k=${KEY}`,
    `https://tvpipe.party.evil.com/r/?r=BCDF#k=${KEY}`,
    `https://tvpipe.party:443/r/?r=BCDF#k=${KEY}`,
    `http://tvpipe.party/r/?r=BCDF#k=${KEY}`,
    `https://user@tvpipe.party/r/?r=BCDF#k=${KEY}`,
    `https://tvpipe.party/r?r=BCDF#k=${KEY}`,
    `https://tvpipe.party/?r=BCDF#k=${KEY}`,
    `https://tvpipe.party/r//?r=BCDF#k=${KEY}`,
    `https://tvpipe.party/r/?r=bcdf#k=${KEY}`,
    `https://tvpipe.party/r/?r=ABCD#k=${KEY}`,
    `https://tvpipe.party/r/?r=BCDFG#k=${KEY}`,
    `https://tvpipe.party/r/?r=BCD#k=${KEY}`,
    `https://tvpipe.party/r/?r=BCDF&x=1#k=${KEY}`,
    `https://tvpipe.party/r/?r=BCDF#k=short`,
    `https://tvpipe.party/r/?r=BCDF#k=${"x".repeat(65)}`,
    `https://tvpipe.party/r/?r=BCDF#k=${KEY}&p=1`,
    `https://tvpipe.party/r/?r=BCDF#k=${KEY}\n`,
    `https://tvpipe.party/r/?r=BCDF`,
    "",
  ]) {
    assert.equal(webLink(url, O), null, url);
  }
  assert.equal(webLink(42, O), null);
  // A web link is no tunnel link and the other way round.
  assert.equal(isJoinUrl(`${O}/r/?r=BCDF#k=${KEY}`), false);
  assert.equal(webLink(`https://x.trycloudflare.com/?r=BCDF#k=${KEY}`, "https://x.trycloudflare.com"), null);
});
