/**
 * Fake players: clients that play Pinch by themselves, for the tests (in
 * Node) and the host page's test mode (`?bots` or `tvpipe game play
 * --dev`), connected like a phone. They only use what a phone gets (the
 * views, their own frames, the public layer in them) unless given an
 * `oracle` (the host's truth: where the loot lies), and they are simple
 * and deterministic with a seeded rng:
 *
 * - The thief walks to loot it knows (seen in its frames, or the
 *   oracle's), takes it, and when full, out of ideas or short of time
 *   runs for its car (the briefing's spot). It explores rooms when it
 *   knows nothing, and wriggles when held.
 * - Guards switch the flashlight on and patrol rooms; one who sees the
 *   thief chases and holds when it can; when a hold is public the others
 *   come to the place to make the arrest.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { decodeBlueprint, type Blueprint } from "./map.ts";
import { applyPublic, type Frame, type PublicState } from "./protocol.ts";
import { Rng } from "./rng.ts";
import type { CatalogueEntry, PlayerView, RoomView, ThiefBriefing } from "./views.ts";

/** What the host knows (game.ts `truth()`), for an oracle bot. */
export interface Oracle {
  car: number;
  loot: { item: number; x: number; y: number; access: number; room: number }[];
}

export interface BotOptions {
  /** The WebSocket URL (`ws://127.0.0.1:PORT/_tvpipe/ws`). */
  url: string;
  WebSocket?: WebSocketFactory | undefined;
  room: string;
  key: string;
  name: string;
  /** The bot's seed. */
  seed?: number;
  /** Start the game when VIP and enough players are there. */
  autoStart?: boolean;
  /** As VIP, skip the tape and the scores. */
  autoSkip?: boolean;
  /** Never act (stands where it is: deadlines, drop-outs). */
  silent?: boolean;
  /** Never act in this role (a thief who stays put, guards who let the thief be). */
  idle?: "thief" | "guard" | undefined;
  /** Where the loot lies (the host's truth); without it the thief goes for what it has seen. */
  oracle?: (() => Oracle | null) | undefined;
  /** As thief: run for the car with this many seconds left (default 25). */
  margin?: number;
  /** As thief: at most this many items (default: until the slots are full). */
  greed?: number;
  /**
   * 0–1 (default 1): how quickly it reacts (up to 1.5 s late at 0), how
   * surely a guard holds when it can (and how often it tries when it
   * cannot: a miss), how thoroughly it patrols. Below 1 makes closer games.
   */
  skill?: number;
  /** Real ms between its actions at least (default 70: within the party's 20 messages a second). */
  gap?: number;
}

type Goal = { x: number; y: number; why: string };

export class Bot {
  readonly client: PartyClient;
  readonly name: string;
  /** Errors the host answered with (codes), refusals included. */
  errors: string[] = [];
  /** Frames this bot got (counts) and messages by type. */
  frames = 0;
  readonly msgs = new Map<string, number>();
  /** Every frame and message it got this game, for secrecy checks (tests set it to an array). */
  log: { type: string; data: unknown }[] | null = null;
  readonly #o: BotOptions;
  readonly #rng: Rng;
  #closed = false;
  #starting = false;
  #skipping = "";
  // the round
  #round = 0;
  #map: Blueprint | null = null;
  #bpRef: unknown = null;
  #pub: PublicState | null = null;
  #known = new Map<number, { x: number; y: number }>();
  #gone = new Set<number>();
  #tried = new Map<number, number>();
  #visited = new Set<number>();
  #goal: Goal | null = null;
  #goalAt = 0;
  #busy = false;
  #lastAct = 0;
  #lightTried = 0;

  constructor(o: BotOptions) {
    this.#o = o;
    this.name = o.name;
    this.#rng = new Rng(o.seed ?? 1);
    this.client = new PartyClient({ url: o.url, room: o.room, key: o.key, storage: memoryStorage(), WebSocket: o.WebSocket });
    this.client.on("view", () => this.#onView());
    this.client.on("msg", (type: string, data: unknown) => this.#onMsg(type, data));
  }

  async join(): Promise<void> {
    await this.client.join(this.name);
  }

  close(): void {
    this.#closed = true;
    this.client.close();
  }

  get room(): Partial<RoomView> {
    return ((this.client.view as { room?: unknown } | null)?.room ?? {}) as Partial<RoomView>;
  }
  get me(): Partial<PlayerView> {
    return ((this.client.view as { me?: unknown } | null)?.me ?? {}) as Partial<PlayerView>;
  }

  #onView(): void {
    if (this.#closed) return;
    const v = this.client.view as { roster?: { id: string; vip: boolean; connected: boolean }[] } | null;
    const room = this.room;
    const mine = v?.roster?.find((r) => r.id === this.client.you?.id);
    if (this.#o.autoStart && room.phase === "lobby" && mine?.vip && !this.#starting) {
      const ready = (v?.roster ?? []).filter((r) => r.connected).length;
      if (ready >= (room.minPlayers ?? 3)) {
        this.#starting = true;
        setTimeout(() => {
          this.client
            .act("start")
            .catch((e) => this.errors.push(String((e as { code?: string })?.code ?? e)))
            .finally(() => (this.#starting = false));
        }, 20);
      }
    }
    const at = `${room.round}:${room.phase}`;
    if (this.#o.autoSkip && mine?.vip && (room.phase === "tape" || room.phase === "scores") && this.#skipping !== at) {
      this.#skipping = at;
      setTimeout(() => this.client.act("skip").catch(() => {}), 30);
    }
    if (room.round !== this.#round) this.#newRound(room.round ?? 0);
    if (room.blueprint && room.blueprint !== this.#bpRef) {
      this.#bpRef = room.blueprint;
      this.#map = decodeBlueprint(room.blueprint);
    }
  }

  #newRound(n: number): void {
    this.#round = n;
    this.#bpRef = null;
    this.#map = null;
    this.#pub = null;
    this.#known.clear();
    this.#gone.clear();
    this.#tried.clear();
    this.#visited.clear();
    this.#goal = null;
    this.#lightTried = 0;
    this.#noticed.clear();
  }

  #onMsg(type: string, data: unknown): void {
    if (this.#closed) return;
    this.msgs.set(type, (this.msgs.get(type) ?? 0) + 1);
    this.log?.push({ type, data });
    if (type !== "f") return;
    this.frames++;
    const f = data as Frame;
    if (this.#map) {
      const next = applyPublic(this.#pub, f.pub, this.#map);
      if (next) this.#pub = next;
      else if (f.pub && f.pub.prev !== f.pub.seq && this.#pub?.seq !== f.pub.seq) {
        // A gap: ask for a keyframe (rarely: at most once a second).
        if (Date.now() - this.#lastResync > 1000) {
          this.#lastResync = Date.now();
          this.client.act("resync").catch(() => {});
        }
      }
    }
    for (const it of f.items ?? []) this.#known.set(it.item, { x: it.x, y: it.y });
    for (const e of f.empty ?? []) this.#gone.add(e.item);
    if (!this.#o.silent && this.room.phase === "heist" && this.#o.idle !== f.me?.role) this.#think(f);
  }

  #lastResync = 0;

  /** The bot's clock: heist time in ms (so a heist run faster than real time plays the same). */
  #now(f: Frame): number {
    return f.t * 1000;
  }

  #think(f: Frame): void {
    if (this.#busy || !this.#map) return;
    // Real time only for the party's message limit (20 a second).
    if (Date.now() - this.#lastAct < (this.#o.gap ?? 70)) return;
    const now = this.#now(f);
    const me = f.me;
    if (me.role === "thief") this.#thief(f, me.slots.length, me.free, now);
    else this.#guard(f, now);
  }

  #send(action: Record<string, unknown>): void {
    this.#busy = true;
    this.#lastAct = Date.now();
    this.client
      .act("h", action)
      .catch((e) => {
        // `over`: the heist ended while the action was on its way (expected).
        const code = String((e as { code?: string })?.code ?? e);
        if (code !== "over") this.errors.push(code);
      })
      .finally(() => (this.#busy = false));
  }

  /** Walks to a goal (again when stopped short of it, or every 3 s). */
  #walk(g: Goal, f: Frame, now: number): void {
    const same = this.#goal && this.#goal.why === g.why && Math.hypot(this.#goal.x - g.x, this.#goal.y - g.y) < 0.6;
    const idle = !f.me.moving && !f.me.busy;
    if (same && !(idle && now - this.#goalAt > 600) && now - this.#goalAt < 3000) return;
    this.#goal = g;
    this.#goalAt = now;
    this.#send({ a: "go", x: g.x, y: g.y });
  }

  #roomCentre(id: number): { x: number; y: number } {
    const r = this.#map!.rooms[id]!.rect;
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  /** The next room to look at: an unvisited one, the nearest first (less thorough with less skill: any room, by the rng). */
  #explore(f: Frame, now: number, prefix: string): void {
    const map = this.#map!;
    const here = map.roomAt[Math.floor(f.me.y) * map.w + Math.floor(f.me.x)] ?? -1;
    if (here >= 0) this.#visited.add(here);
    const g = this.#goal;
    const arrived = g && g.why.startsWith(prefix) && Math.hypot(f.me.x - g.x, f.me.y - g.y) < 1.5;
    const stale = g && now - this.#goalAt > 12_000;
    if (g && g.why.startsWith(prefix) && !arrived && !stale) return this.#walk(g, f, now);
    const all = map.rooms.filter((r) => r.kind !== "corridor");
    let rooms = all.filter((r) => !this.#visited.has(r.id));
    if (rooms.length === 0) {
      this.#visited.clear();
      rooms = all;
    }
    let r = this.#rng.pick(rooms);
    if (this.#rng.chance(this.#skill)) {
      // Thorough: the nearest unvisited of a few.
      const few = this.#rng.shuffle(rooms).slice(0, 3);
      few.sort((a, b) => {
        const ca = this.#roomCentre(a.id);
        const cb = this.#roomCentre(b.id);
        return Math.hypot(ca.x - f.me.x, ca.y - f.me.y) - Math.hypot(cb.x - f.me.x, cb.y - f.me.y);
      });
      r = few[0];
    } else r = this.#rng.pick(all);
    if (!r) return;
    const c = this.#roomCentre(r.id);
    this.#walk({ ...c, why: `${prefix}${r.id}` }, f, now);
  }

  get #skill(): number {
    const s = this.#o.skill ?? 1;
    return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 1;
  }

  /** How long (heist ms) the bot takes to react to something new: none at skill 1, 1.5 s at 0. */
  #reacted(key: string, now: number): boolean {
    const delay = (1 - this.#skill) * 1500;
    if (delay <= 0) return true;
    const at = this.#noticed.get(key) ?? now;
    this.#noticed.set(key, at);
    return now - at >= delay;
  }
  /** When it first noticed something (heist ms), by what. */
  readonly #noticed = new Map<string, number>();

  // -------------------------------------------------------------------------
  // The thief

  #thief(f: Frame, carried: number, free: number, now: number): void {
    const me = f.me;
    if (me.hold) {
      if (this.#reacted("held", now)) this.#send({ a: "wriggle" });
      return;
    }
    this.#noticed.delete("held");
    if (me.frozen || me.busy) return;
    const take = me.offers.find((o) => o.a === "take");
    const catalogue = (this.room.catalogue ?? []) as CatalogueEntry[];
    const fits = (item: number) => (catalogue[item]?.size === "large" ? 2 : 1) <= free;
    if (take && take.a === "take" && fits(take.item) && carried < (this.#o.greed ?? 4)) return this.#send({ a: "take", item: take.item });
    const briefing = this.me.briefing as ThiefBriefing | undefined;
    const car = this.#map!.spots[briefing?.car ?? -1];
    const late = f.left < (this.#o.margin ?? 25);
    const enough = free <= 0 || carried >= (this.#o.greed ?? 4);
    if (car && (late || enough)) {
      const r = car.rect;
      return this.#walk({ x: r.x + r.w / 2, y: r.y + r.h / 2, why: "car" }, f, now);
    }
    // Loot it knows of: the oracle's, else what it has seen.
    const truth = this.#o.oracle?.();
    const targets: { item: number; x: number; y: number }[] = [];
    if (truth) {
      for (const l of truth.loot) {
        const w = this.#map!.w;
        targets.push({ item: l.item, x: (l.access % w) + 0.5, y: Math.floor(l.access / w) + 0.5 });
      }
    } else for (const [item, p] of this.#known) targets.push({ item, x: p.x + 0.5, y: p.y + 0.5 });
    const open = targets.filter((t) => !this.#gone.has(t.item) && fits(t.item) && (this.#tried.get(t.item) ?? 0) < 3 && !(me.role === "thief" && me.slots.some((s) => s.item === t.item)));
    if (open.length > 0) {
      open.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y) || a.item - b.item);
      const t = open[0]!;
      const why = `item${t.item}`;
      // Arrived and nothing to take: try another side of it (seen items: the tile itself is not standable).
      if (this.#goal?.why === why && !me.moving && Math.hypot(me.x - t.x, me.y - t.y) < 1.6 && now - this.#goalAt > 800) {
        const n = (this.#tried.get(t.item) ?? 0) + 1;
        this.#tried.set(t.item, n);
        const [dx, dy] = [[0, 1], [1, 0], [0, -1], [-1, 0]][n % 4]!;
        this.#goal = null;
        return this.#walk({ x: t.x + dx!, y: t.y + dy!, why }, f, now);
      }
      return this.#walk({ x: t.x, y: t.y, why }, f, now);
    }
    if (carried > 0 && car) {
      const r = car.rect;
      return this.#walk({ x: r.x + r.w / 2, y: r.y + r.h / 2, why: "car" }, f, now);
    }
    this.#explore(f, now, "look");
  }

  // -------------------------------------------------------------------------
  // Guards

  #guard(f: Frame, now: number): void {
    const me = f.me;
    if (me.role !== "guard") return;
    if (me.frozen || me.busy) return;
    if (me.light === "off" && now - this.#lightTried > 2000) {
      this.#lightTried = now;
      return this.#send({ a: "flashlight", on: true });
    }
    const thief = f.others.find((o) => o.role === "thief");
    const sees = !!thief && this.#reacted("thief", now);
    if (!thief) this.#noticed.delete("thief");
    if (thief && sees && me.cooldown <= 0) {
      // Hold accuracy: a skilled guard holds when the HOLD button shows; a clumsy one hesitates, or tries too soon (a miss).
      if (me.canHold && this.#rng.chance(0.3 + 0.7 * this.#skill)) return this.#send({ a: "hold", target: thief.id });
      if (!me.canHold && this.#rng.chance((1 - this.#skill) * 0.15)) return this.#send({ a: "hold", target: thief.id });
    }
    // A public hold: come and make the arrest.
    const hold = this.#pub?.holds.find((h) => h.guard !== me.id);
    if (hold && this.#reacted(`hold${hold.t}`, now)) return this.#walk({ x: hold.x, y: hold.y, why: "arrest" }, f, now);
    if (thief && sees) return this.#walk({ x: thief.x, y: thief.y, why: "chase" }, f, now);
    this.#explore(f, now, "patrol");
  }
}

/** Bots named Bot1, Bot2, … that join (the first starts the game when `autoStart`). */
export async function bots(n: number, o: Omit<BotOptions, "name">, names?: string[]): Promise<Bot[]> {
  const out: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const b = new Bot({ ...o, name: names?.[i] ?? `Bot${i + 1}`, seed: (o.seed ?? 1) * 31 + i, autoStart: i === 0 && o.autoStart, autoSkip: i === 0 && o.autoSkip });
    await b.join();
    out.push(b);
  }
  return out;
}
