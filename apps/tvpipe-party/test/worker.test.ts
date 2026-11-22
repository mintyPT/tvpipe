import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { STALE_MS } from "../src/links.ts";
import { handle } from "../src/app.ts";
import { testEnv, type TestEnv } from "./shim.ts";

const ORIGIN = "https://tvpipe.party";
const JOIN = "https://some-random-words.trycloudflare.com/?r=BCDF#k=AbCdEfGhIjKlMnOp_-12";
const JOIN2 = "https://65b3d1e2edd55529.baqlo7vg7agz.opentunnel.xyz/?r=BCDF#k=ZyXwVuTsRqPoNmLk_-34";
const T0 = 1_700_000_000_000;
/** Where /BCDF leads: the frame page (docs/short-links.md). */
const FRAMED = "/p#c=some-random-words&r=BCDF&k=AbCdEfGhIjKlMnOp_-12";
const FRAMED2 = "/p#o=65b3d1e2edd55529.baqlo7vg7agz&r=BCDF&k=ZyXwVuTsRqPoNmLk_-34";

let env: TestEnv;
beforeEach(() => {
  env = testEnv();
});

function req(method: string, path: string, init: { body?: string; secret?: string; ip?: string } = {}): Request {
  const headers: Record<string, string> = { "CF-Connecting-IP": init.ip ?? "192.0.2.1" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.secret !== undefined) headers.Authorization = `Bearer ${init.secret}`;
  return new Request(ORIGIN + path, { method, headers, body: init.body, redirect: "manual" });
}

async function create(body: unknown, now = T0, ip?: string): Promise<Response> {
  return handle(req("POST", "/api/links", { body: JSON.stringify(body), ip }), env, now);
}

interface Created {
  code: string;
  short: string;
  url: string;
  secret: string;
}

async function created(body: unknown, now = T0): Promise<Created> {
  const res = await create(body, now);
  assert.equal(res.status, 201);
  return (await res.json()) as Created;
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(typeof body.error.message, "string");
  return body.error.code;
}

test("POST honours a free proposed code", async () => {
  const res = await create({ url: JOIN, code: "bcdf" });
  assert.equal(res.status, 201);
  assert.match(res.headers.get("Content-Type")!, /^application\/json/);
  const body = (await res.json()) as Created;
  assert.equal(body.code, "BCDF");
  assert.equal(body.short, "https://tvpipe.party/BCDF");
  assert.equal(body.url, JOIN);
  assert.match(body.secret, /^[A-Za-z0-9_-]{43}$/);
  const row = env.DB.sqlite.prepare("SELECT * FROM links").get() as Record<string, unknown>;
  assert.equal(row.code, "BCDF");
  assert.equal(row.created, T0);
  assert.equal(row.updated, T0);
  assert.match(row.secret as string, /^[0-9a-f]{64}$/);
  assert.notEqual(row.secret, body.secret);
});

test("short uses the request's origin", async () => {
  const res = await handle(
    new Request("http://localhost:8787/api/links", { method: "POST", body: JSON.stringify({ url: JOIN, code: "BCDF" }) }),
    env,
    T0,
  );
  assert.equal(((await res.json()) as Created).short, "http://localhost:8787/BCDF");
});

test("a taken code gives a random one; after 24 h it is free again", async () => {
  const first = await created({ url: JOIN, code: "BCDF" });
  const second = await created({ url: JOIN2, code: "BCDF" }, T0 + STALE_MS);
  assert.notEqual(second.code, "BCDF");
  assert.match(second.code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  // Refreshed codes stay taken; the 24 h count from the last update.
  const third = await created({ url: JOIN2, code: "BCDF" }, T0 + STALE_MS + 1);
  assert.equal(third.code, "BCDF");
  assert.equal(third.url, JOIN2);
  // The old owner lost it.
  const put = await handle(req("PUT", "/api/links/BCDF", { body: "{}", secret: first.secret }), env, T0 + STALE_MS + 2);
  assert.equal(put.status, 404);
  assert.equal(await errorCode(put), "not-found");
});

test("an invalid proposal gives a random code", async () => {
  for (const code of ["ABCD", "BCD", "BCDFG", 42, null, ""]) {
    const body = await created({ url: JOIN, code });
    assert.match(body.code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  }
  const body = await created({ url: JOIN });
  assert.match(body.code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
});

test("503 no-code when nothing is free", async () => {
  // Fill every code.
  const insert = env.DB.sqlite.prepare("INSERT INTO links VALUES (?, ?, ?, ?, ?)");
  const A = "BCDFGHJKLMNPQRSTVWXZ";
  env.DB.sqlite.exec("BEGIN");
  for (const a of A) for (const b of A) for (const c of A) for (const d of A) insert.run(a + b + c + d, JOIN, "x", T0, T0);
  env.DB.sqlite.exec("COMMIT");
  const res = await create({ url: JOIN, code: "BCDF" }, T0 + 1);
  assert.equal(res.status, 503);
  assert.equal(await errorCode(res), "no-code");
});

test("POST errors", async () => {
  let res = await create({ url: "https://evil.com/?r=BCDF#k=AbCdEfGhIjKlMnOp_-12" });
  assert.equal(res.status, 400);
  assert.equal(await errorCode(res), "bad-url");
  res = await create({ url: 7 });
  assert.equal(await errorCode(res), "bad-url");
  res = await create({ code: "BCDF" });
  assert.equal(res.status, 400);
  assert.equal(await errorCode(res), "bad-request");
  for (const body of ["not json", "", "[1]", "null", '"x"']) {
    res = await handle(req("POST", "/api/links", { body }), env, T0);
    assert.equal(res.status, 400, body);
    assert.equal(await errorCode(res), "bad-request");
  }
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM links").get()!.n, 0);
});

test("413 for bodies over 4 KiB", async () => {
  const big = JSON.stringify({ url: JOIN, pad: "x".repeat(5000) });
  let res = await handle(req("POST", "/api/links", { body: big }), env, T0);
  assert.equal(res.status, 413);
  const reg = await created({ url: JOIN, code: "BCDF" });
  res = await handle(req("PUT", "/api/links/BCDF", { body: big, secret: reg.secret }), env, T0);
  assert.equal(res.status, 413);
  // Without Content-Length (a stream): still counted.
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000)));
      c.close();
    },
  });
  res = await handle(
    new Request(ORIGIN + "/api/links", { method: "POST", body: stream, duplex: "half" } as RequestInit),
    env,
    T0,
  );
  assert.equal(res.status, 413);
});

test("PUT refreshes with the right secret, 404 with a wrong one", async () => {
  const reg = await created({ url: JOIN, code: "BCDF" });
  let res = await handle(req("PUT", "/api/links/bcdf", { body: "{}", secret: reg.secret }), env, T0 + 1000);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { code: "BCDF", short: "https://tvpipe.party/BCDF", url: JOIN });
  const row = env.DB.sqlite.prepare("SELECT created, updated FROM links").get()!;
  assert.equal(row.created, T0);
  assert.equal(row.updated, T0 + 1000);

  res = await handle(req("PUT", "/api/links/BCDF", { body: "{}", secret: "wrong" }), env, T0 + 2000);
  assert.equal(res.status, 404);
  assert.equal(await errorCode(res), "not-found");
  res = await handle(req("PUT", "/api/links/BCDF", { body: "{}" }), env, T0 + 2000);
  assert.equal(res.status, 404);
  res = await handle(req("PUT", "/api/links/GHJK", { body: "{}", secret: reg.secret }), env, T0 + 2000);
  assert.equal(res.status, 404);
  res = await handle(req("PUT", "/api/links/ABCD", { body: "{}", secret: reg.secret }), env, T0 + 2000);
  assert.equal(res.status, 404);
  assert.equal(env.DB.sqlite.prepare("SELECT updated FROM links").get()!.updated, T0 + 1000);

  // An empty body is {}.
  res = await handle(req("PUT", "/api/links/BCDF", { secret: reg.secret }), env, T0 + 3000);
  assert.equal(res.status, 200);
});

test("PUT with a new url replaces it; a bad url is 400", async () => {
  const reg = await created({ url: JOIN, code: "BCDF" });
  let res = await handle(
    req("PUT", "/api/links/BCDF", { body: JSON.stringify({ url: JOIN2 }), secret: reg.secret }),
    env,
    T0 + 1,
  );
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Created).url, JOIN2);
  res = await handle(req("GET", "/BCDF"), env, T0 + 2);
  assert.equal(res.headers.get("Location"), FRAMED2);

  res = await handle(
    req("PUT", "/api/links/BCDF", { body: JSON.stringify({ url: "https://evil.com/" }), secret: reg.secret }),
    env,
    T0 + 3,
  );
  assert.equal(res.status, 400);
  assert.equal(await errorCode(res), "bad-url");
  res = await handle(req("PUT", "/api/links/BCDF", { body: "nope", secret: reg.secret }), env, T0 + 3);
  assert.equal(res.status, 400);
  assert.equal(await errorCode(res), "bad-request");
});

test("DELETE: 204 always, deletes only with the secret", async () => {
  const reg = await created({ url: JOIN, code: "BCDF" });
  let res = await handle(req("DELETE", "/api/links/BCDF", { secret: "wrong" }), env, T0);
  assert.equal(res.status, 204);
  res = await handle(req("DELETE", "/api/links/BCDF"), env, T0);
  assert.equal(res.status, 204);
  assert.equal((await handle(req("GET", "/BCDF"), env, T0)).status, 302);
  res = await handle(req("DELETE", "/api/links/bcdf", { secret: reg.secret }), env, T0);
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.equal((await handle(req("GET", "/BCDF"), env, T0)).status, 404);
  res = await handle(req("DELETE", "/api/links/BCDF", { secret: reg.secret }), env, T0);
  assert.equal(res.status, 204);
  res = await handle(req("DELETE", "/api/links/nonsense", { secret: reg.secret }), env, T0);
  assert.equal(res.status, 204);
  // The code is free again at once.
  assert.equal((await created({ url: JOIN2, code: "BCDF" })).code, "BCDF");
});

test("lookups redirect to the frame page, any case, with the fragment and no-store", async () => {
  await created({ url: JOIN, code: "BCDF" });
  for (const path of ["/BCDF", "/bcdf", "/BcDf", "/bcdf/"]) {
    const res = await handle(req("GET", path), env, T0);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("Location"), FRAMED);
    assert.ok(res.headers.get("Location")!.includes("&k="));
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  }
  // Stale rows still redirect until their code is given away.
  const res = await handle(req("GET", "/BCDF"), env, T0 + 10 * STALE_MS);
  assert.equal(res.status, 302);
});

test("unknown codes: 404 join page", async () => {
  for (const path of ["/GHJK", "/ghjk", "/zzzz"]) {
    const res = await handle(req("GET", path), env, T0);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("Content-Type")!, /^text\/html/);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const page = await res.text();
    assert.ok(page.includes(`No game with the code ${path.slice(1).toUpperCase()}. Check the code on the TV.`), path);
    assert.ok(page.includes('<form method="get" action="/join">'));
  }
});

test("/join: the form, and ?code= as /CODE", async () => {
  await created({ url: JOIN, code: "BCDF" });
  let res = await handle(req("GET", "/join"), env, T0);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.ok(page.includes('<meta name="viewport"'));
  assert.ok(page.includes('<form method="get" action="/join">'));
  assert.ok(page.includes('name="code"'));
  for (const attr of ['autocapitalize="characters"', 'autocomplete="off"', 'inputmode="text"', 'maxlength="8"', "autofocus"]) {
    assert.ok(page.includes(attr), attr);
  }
  assert.ok(!page.includes("<script"));

  res = await handle(req("GET", "/join?code=bcdf"), env, T0);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), FRAMED);
  res = await handle(req("GET", "/join?code=+bc+df+"), env, T0);
  assert.equal(res.status, 302);

  res = await handle(req("GET", "/join?code=ghjk"), env, T0);
  assert.equal(res.status, 404);
  assert.ok((await res.text()).includes("No game with the code GHJK."));

  res = await handle(req("GET", "/join?code="), env, T0);
  assert.equal(res.status, 400);
  assert.ok((await res.text()).includes("Type the code"));
  res = await handle(req("GET", "/join?code=%3Cscript%3E"), env, T0);
  assert.equal(res.status, 400);
  const bad = await res.text();
  assert.ok(bad.includes("four letters"));
  assert.ok(!bad.includes("<script>"));
});

test("lookups are rate limited per client", async () => {
  await created({ url: JOIN, code: "BCDF" });
  for (let i = 0; i < 19; i++) {
    assert.equal((await handle(req("GET", "/GHJK"), env, T0)).status, 404);
  }
  assert.equal((await handle(req("GET", "/join?code=GHJK"), env, T0)).status, 404);
  let res = await handle(req("GET", "/GHJK"), env, T0);
  assert.equal(res.status, 429);
  assert.ok((await res.text()).includes("Wait a minute"));
  // Hits are refused too: otherwise 302 against 429 tells live codes apart.
  res = await handle(req("GET", "/BCDF"), env, T0);
  assert.equal(res.status, 429);
  res = await handle(req("GET", "/join?code=BCDF"), env, T0);
  assert.equal(res.status, 429);
  // Another client is not affected.
  res = await handle(req("GET", "/BCDF", { ip: "192.0.2.2" }), env, T0);
  assert.equal(res.status, 302);
  // The form itself is not a lookup.
  assert.equal((await handle(req("GET", "/join"), env, T0)).status, 200);
});

test("creates and updates are rate limited", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await create({ url: JOIN })).status, 201);
  let res = await create({ url: JOIN });
  assert.equal(res.status, 429);
  assert.equal(await errorCode(res), "rate-limited");
  assert.equal((await create({ url: JOIN }, T0, "192.0.2.9")).status, 201);

  for (let i = 0; i < 60; i++) {
    assert.equal((await handle(req("DELETE", "/api/links/BCDF", { secret: "x" }), env, T0)).status, 204);
  }
  res = await handle(req("PUT", "/api/links/BCDF", { body: "{}", secret: "x" }), env, T0);
  assert.equal(res.status, 429);
  assert.equal(await errorCode(res), "rate-limited");
});

test("wrong methods: 405", async () => {
  const cases: [string, string, string][] = [
    ["GET", "/api/links", "POST"],
    ["PUT", "/api/links", "POST"],
    ["GET", "/api/links/BCDF", "PUT, DELETE"],
    ["POST", "/api/links/BCDF", "PUT, DELETE"],
    ["POST", "/BCDF", "GET, HEAD"],
    ["DELETE", "/bcdf", "GET, HEAD"],
    ["POST", "/join", "GET, HEAD"],
  ];
  for (const [method, path, allow] of cases) {
    const res = await handle(req(method, path), env, T0);
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.equal(res.headers.get("Allow"), allow);
  }
});

test("everything else: static files, else the 404 page", async () => {
  let res = await handle(req("GET", "/"), env, T0);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<h1>tvpipe</h1>");
  for (const path of ["/nope", "/ABCD", "/manual/nope/", "/BCDFG", "/BCD"]) {
    res = await handle(req("GET", path), env, T0);
    assert.equal(res.status, 404, path);
    const page = await res.text();
    assert.ok(page.includes('href="/join"'));
    assert.ok(page.includes('href="/"'));
  }
  res = await handle(req("GET", "/api/nope"), env, T0);
  assert.equal(res.status, 404);
  assert.equal(await errorCode(res), "not-found");
  // HEAD has no body.
  res = await handle(req("HEAD", "/nope"), env, T0);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "");
});
