import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PartyError } from "@tvpipe/party";

import { PROMPT_LIST } from "./prompts.ts";
import {
  buildOptions,
  cleanTitle,
  deal,
  deck,
  decoyOrder,
  displayTitle,
  optionsFor,
  parsePrompts,
  PHONE_LIES,
  pickLiars,
  plan,
  revealOrder,
  rotate,
  score,
  seeded,
  share,
  shuffle,
  spread,
  titleKey,
  validateDrawing,
  type Lang,
  type Option,
  type Prompt,
} from "../game/rules.ts";
import { drawingFrames, drawingInput, get, has, parseVectors, RULES } from "./vectors.ts";

test("the shared rule vectors (test/vectors/rules.txt)", () => {
  const blocks = parseVectors(readFileSync(RULES, "utf8"));
  const seen = new Map<string, number>();
  for (const b of blocks) {
    const kind = get(b, "test");
    seen.set(kind, (seen.get(kind) ?? 0) + 1);
    const at = `rules.txt:${b.line}`;
    const json = (key: string) => JSON.parse(get(b, key));
    switch (kind) {
      case "rng": {
        const r = seeded(Number(get(b, "seed")));
        assert.deepEqual(json("values"), (json("values") as number[]).map(() => r() * 2 ** 32), at);
        break;
      }
      case "shuffle": {
        const n = Number(get(b, "n"));
        assert.deepEqual(shuffle(Array.from({ length: n }, (_, i) => i), seeded(Number(get(b, "seed")))), json("order"), at);
        break;
      }
      case "title":
        assert.equal(cleanTitle(json("input")), json("clean"), at);
        assert.equal(displayTitle(cleanTitle(json("input"))), json("display"), at);
        assert.equal(titleKey(json("input"), has(b, "lang") ? (get(b, "lang") as Lang) : undefined), json("key"), at);
        break;
      case "drawing": {
        const input = drawingInput(b);
        if (has(b, "error")) {
          assert.throws(() => validateDrawing(input, undefined, drawingFrames(b)), (e: unknown) => e instanceof PartyError && e.code === get(b, "error"), at);
        } else {
          const out = get(b, "output");
          assert.deepEqual(validateDrawing(input, undefined, drawingFrames(b)), out === "input" ? input : JSON.parse(out), at);
        }
        break;
      }
      case "plan":
        for (const [n, spotlights, liars, pipelined] of json("table") as [number, number, number, boolean][]) {
          assert.deepEqual(plan(n), { spotlights, liars, pipelined }, `${at}: ${n}`);
        }
        break;
      case "share":
        for (const [n, base, seen, want] of json("cases") as number[][]) assert.equal(share(n!, base!, seen!), want, at);
        break;
      case "liars": {
        const lied = new Map(Object.entries(json("lied") as Record<string, number>));
        const first = json("first") as string | null;
        assert.deepEqual(pickLiars(json("pool"), lied, Number(get(b, "n")), seeded(Number(get(b, "seed"))), first ?? undefined), json("liars"), at);
        break;
      }
      case "rotate": {
        const keys = json("keys") as Record<string, number>;
        assert.deepEqual(rotate(json("pool"), (id) => keys[id]!, Number(get(b, "n")), seeded(Number(get(b, "seed")))), json("picked"), at);
        break;
      }
      case "turn": {
        const lies = new Map(json("lies") as [string, string][]);
        const options = buildOptions(json("truth"), lies, json("spares"), seeded(Number(get(b, "seed"))), Number(get(b, "min")));
        assert.deepEqual(options, json("options"), at);
        const own = json("own") as Record<string, string[]>;
        for (const [p, ids] of Object.entries(own)) assert.deepEqual(optionsFor(p, options).map((o) => o.id), ids, at);
        const shown = deal(options, json("voting"), PHONE_LIES, seeded(Number(get(b, "dealSeed"))));
        assert.deepEqual(Object.fromEntries(shown), json("shown"), at);
        const scoring = score(json("artist"), options, shown, new Map(json("votes") as [string, string][]), Number(get(b, "round")));
        assert.deepEqual(Object.fromEntries(scoring.points), json("points"), at);
        assert.deepEqual(Object.fromEntries(scoring.voters), json("voters"), at);
        assert.deepEqual(Object.fromEntries(scoring.seen), json("seen"), at);
        assert.deepEqual(revealOrder(options as Option[], scoring.voters).map((o) => o.id), json("reveal"), at);
        break;
      }
      case "prompts":
        assert.deepEqual(parsePrompts(json("input")).map((p) => [p.tag, p.text, p.decoys]), json("parsed"), at);
        break;
      case "spread": {
        const tags = json("tags") as string[];
        assert.deepEqual(spread(tags.map((_, i) => i), (i) => tags[i]!, Number(get(b, "window"))), json("order"), at);
        break;
      }
      case "deck": {
        const src = get(b, "prompts");
        const prompts: readonly Prompt[] = src === "file" ? PROMPT_LIST : (JSON.parse(src) as [string, string][]).map(([tag, text]) => ({ tag, text }));
        const d = deck(prompts, seeded(Number(get(b, "seed"))));
        const want = json("dealt") as string[];
        assert.deepEqual(want.map(() => d.pop()!.text), want, at);
        break;
      }
      case "decoys": {
        const spares = (json("spares") as [string, string][]).map(([tag, text]) => ({ tag, text }));
        assert.deepEqual(decoyOrder(spares, get(b, "tag")).map((p) => p.text), json("order"), at);
        break;
      }
      default:
        assert.fail(`${at}: unknown test ${kind}`);
    }
  }
  for (const kind of ["rng", "shuffle", "title", "drawing", "plan", "share", "liars", "rotate", "turn", "prompts", "spread", "deck", "decoys"]) assert.ok((seen.get(kind) ?? 0) > 0, kind);
});
