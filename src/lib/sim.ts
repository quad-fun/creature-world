// The authoritative world rules. Minds (model or rules) only *propose* moves;
// everything here validates and performs them. A model cannot change state any other way.
import { appraise, clamp, impulse, stepAffect } from "./affect";
import {
  BAKERY_MAX_STOCK,
  BREAD_PRICE,
  ITEMS,
  ITEM_IDS,
  PLACES,
  PLACE_IDS,
  SPECIES,
  travelMinutes,
} from "./content";
import type { Bond, Creature, ItemId, Move, MoveKind, PlaceId, World } from "./types";

export const STEP = 5; // world minutes per simulation step
export const MIN_DECISION_GAP = 10; // world minutes between mind calls per creature
const FEED_CAP = 250;
const MOVE_KINDS: MoveKind[] = ["walk", "speak", "eat", "buy_food", "craft", "sell", "gift", "rest", "sleep", "play", "post", "wait"];

// ---------- small helpers ----------

/** Seeded PRNG (mulberry32) stored in the world so runs are reproducible. */
export function rand(w: World): number {
  w.rng = (w.rng + 0x6d2b79f5) >>> 0;
  let t = w.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function pick<T>(w: World, xs: T[]): T {
  return xs[Math.floor(rand(w) * xs.length)];
}

export function clockOf(t: number) {
  const day = Math.floor(t / 1440) + 1;
  const m = ((t % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const period = hh < 6 ? "night" : hh < 12 ? "morning" : hh < 18 ? "afternoon" : hh < 22 ? "evening" : "night";
  return { day, hh, mm, label: `${pad(hh)}:${pad(mm)}`, isNight: hh >= 22 || hh < 6, period };
}

const clean = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);

export function logFeed(
  w: World,
  creature: string,
  kind: "move" | "say" | "feel" | "system" | "diary",
  text: string,
  why?: string,
  source?: "model" | "rules",
) {
  w.feed.push({ id: ++w.feedSeq, t: w.t, ts: Date.now(), creature, kind, text, why: why || undefined, source });
  if (w.feed.length > FEED_CAP) w.feed.splice(0, w.feed.length - FEED_CAP);
}

export function remember(w: World, c: Creature, text: string, salience: number) {
  c.memories.push({ t: w.t, text: clean(text, 220), valence: c.affect.valence, salience: clamp(salience, 0.05, 1) });
  if (c.memories.length > 80) {
    let worst = 0;
    let worstScore = Infinity;
    c.memories.forEach((m, i) => {
      const score = m.salience * Math.exp(-(w.t - m.t) / 2880);
      if (score < worstScore) {
        worstScore = score;
        worst = i;
      }
    });
    c.memories.splice(worst, 1);
  }
}

export function touchBond(c: Creature, otherId: string, d: Partial<Bond>) {
  const b = (c.bonds[otherId] ??= { familiarity: 0, trust: 0, fondness: 0 });
  b.familiarity = clamp(b.familiarity + (d.familiarity ?? 0), 0, 1);
  b.trust = clamp(b.trust + (d.trust ?? 0), 0, 1);
  b.fondness = clamp(b.fondness + (d.fondness ?? 0), 0, 1);
}

export const creaturesAt = (w: World, place: PlaceId, exceptId?: string) =>
  Object.values(w.creatures).filter((o) => o.place === place && o.id !== exceptId);

export function describeActivity(w: World, c: Creature): string {
  const a = c.activity;
  if (!a) return "idle";
  const m = a.move;
  switch (a.kind) {
    case "walk":
      return `walking to ${PLACES[m.place!].name}`;
    case "sleep":
      return "asleep";
    case "craft":
      return "crafting";
    case "eat":
      return "eating";
    case "sell":
      return "selling at the stall";
    case "play":
      return "playing";
    case "rest":
      return "resting";
    case "speak":
      return `talking to ${w.creatures[m.target ?? ""]?.sheet.name ?? "someone"}`;
    case "gift":
      return "handing over a gift";
    case "post":
      return "pinning a notice";
    case "buy_food":
      return "buying bread";
    default:
      return "lingering";
  }
}

// ---------- normalising and validating proposed moves ----------

const matchPlace = (s: string): PlaceId | undefined => {
  const x = s.toLowerCase().trim();
  return PLACE_IDS.find((p) => p === x || PLACES[p].name.toLowerCase().includes(x) || x.includes(p));
};
const matchItem = (s: string): ItemId | undefined => {
  const x = s.toLowerCase().trim();
  return ITEM_IDS.find((i) => i === x || ITEMS[i].name.toLowerCase() === x || x.includes(i));
};
const matchCreature = (w: World, s: string): string | undefined => {
  const x = s.toLowerCase().trim();
  return Object.values(w.creatures).find((o) => o.id === x || o.sheet.name.toLowerCase() === x)?.id;
};

/** Turn loosely-shaped model output into a Move, or null. Unknown fields are dropped. */
export function normalizeMove(w: World, raw: unknown): Move | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.do !== "string" || !MOVE_KINDS.includes(r.do as MoveKind)) return null;
  const m: Move = { do: r.do as MoveKind, why: clean(r.why, 200) };
  if (typeof r.place === "string") m.place = matchPlace(r.place);
  if (typeof r.target === "string") m.target = matchCreature(w, r.target);
  if (typeof r.item === "string") m.item = matchItem(r.item);
  if (typeof r.text === "string" && r.text.trim()) m.text = clean(r.text, 240);
  return m;
}

interface Projection {
  place: PlaceId;
  inv: ItemId[];
  coins: number;
  stock: number;
}

function takeItem(inv: ItemId[], want: ItemId | undefined, ok: (i: ItemId) => boolean): ItemId | undefined {
  const idx = inv.findIndex((i) => (want ? i === want : ok(i)));
  if (idx < 0) return undefined;
  const [item] = inv.splice(idx, 1);
  return ok(item) ? item : undefined;
}

/** Checks a move against a *projected* state so chains like walk -> craft are allowed. Mutates proj. */
function checkMove(w: World, c: Creature, m: Move, p: Projection): string | null {
  switch (m.do) {
    case "walk":
      if (!m.place) return "unknown place";
      if (m.place === p.place) return "already there";
      p.place = m.place;
      return null;
    case "speak": {
      const o = m.target ? w.creatures[m.target] : undefined;
      if (!o || o.id === c.id) return "unknown target";
      if (o.place !== p.place) return `${o.sheet.name} is not there`;
      if (o.activity?.kind === "sleep") return `${o.sheet.name} is asleep`;
      if (!m.text) return "nothing to say";
      return null;
    }
    case "eat": {
      const item = takeItem(p.inv, m.item, (i) => ITEMS[i].food > 0);
      if (!item) return "no food to eat";
      m.item = item;
      return null;
    }
    case "buy_food":
      if (p.place !== "bakery") return "not at the bakery";
      if (p.coins < BREAD_PRICE) return "not enough coins";
      if (p.stock <= 0) return "bakery is out of bread";
      p.coins -= BREAD_PRICE;
      p.stock -= 1;
      p.inv.push("bread");
      return null;
    case "craft":
      if (p.place !== "workshop") return "not at the workshop";
      if (c.drives.energy <= 0.12) return "too tired to craft";
      p.inv.push(SPECIES[c.species].craft);
      return null;
    case "sell": {
      if (p.place !== "fountain") return "not at the market stall";
      const item = takeItem(p.inv, m.item, (i) => ITEMS[i].sell > 0);
      if (!item) return "nothing to sell";
      m.item = item;
      p.coins += ITEMS[item].sell;
      return null;
    }
    case "gift": {
      const o = m.target ? w.creatures[m.target] : undefined;
      if (!o || o.id === c.id) return "unknown target";
      if (o.place !== p.place) return `${o.sheet.name} is not there`;
      const item = takeItem(p.inv, m.item, () => true);
      if (!item) return "nothing to give";
      m.item = item;
      return null;
    }
    case "post":
      if (!m.text) return "nothing to post";
      if (c.lastPostT !== undefined && w.t - c.lastPostT < 180) return "already posted recently";
      return null;
    case "sleep":
      return p.place === "nests" ? null : "can only sleep at the nests";
    case "play":
      return ["park", "pond", "fountain"].includes(p.place) ? null : "nowhere to play here";
    default:
      return null; // rest, wait
  }
}

export function validateMoves(w: World, c: Creature, raw: unknown[]): { moves: Move[]; rejected: string[] } {
  const moves: Move[] = [];
  const rejected: string[] = [];
  const proj: Projection = { place: c.place, inv: [...c.inventory], coins: c.coins, stock: w.bakeryStock };
  for (const r of raw.slice(0, 3)) {
    const m = normalizeMove(w, r);
    if (!m) {
      rejected.push("unrecognised move");
      break;
    }
    const err = checkMove(w, c, m, proj);
    if (err) {
      rejected.push(`${m.do}: ${err}`);
      break; // later moves depend on this one
    }
    moves.push(m);
  }
  return { moves, rejected };
}

// ---------- performing moves ----------

function removeOne(inv: ItemId[], item: ItemId): boolean {
  const i = inv.indexOf(item);
  if (i < 0) return false;
  inv.splice(i, 1);
  return true;
}

/** Begin a move. Re-checks against the *actual* state. Returns an error string if it cannot start. */
export function startMove(w: World, c: Creature, m: Move): string | null {
  const name = c.sheet.name;
  const src = c.lastSource === "none" ? undefined : c.lastSource;
  const say = (text: string) => logFeed(w, c.id, "move", text, m.why, src);
  const begin = (mins: number) => {
    c.activity = { kind: m.do, until: w.t + mins, move: m };
  };

  switch (m.do) {
    case "walk": {
      if (!m.place) return "unknown place";
      const mins = travelMinutes(c.place, m.place);
      if (mins === 0) return "already there";
      begin(mins);
      say(`${name} walks to ${PLACES[m.place].name}.`);
      return null;
    }
    case "speak": {
      const o = m.target ? w.creatures[m.target] : undefined;
      if (!o || o.place !== c.place) return "they are not here";
      if (o.activity?.kind === "sleep") return `${o.sheet.name} is asleep`;
      const text = m.text ?? "";
      begin(3);
      logFeed(w, c.id, "say", `${name} to ${o.sheet.name}: “${text}”`, m.why, src);
      // listener
      o.heard.push({ t: w.t, from: name, text });
      if (o.heard.length > 6) o.heard.shift();
      const fit = appraise(o, [], text);
      const fond = o.bonds[c.id]?.fondness ?? 0;
      impulse(o, 0.05 + 0.12 * fond + fit * 0.5, 0.08);
      o.drives.social = clamp(o.drives.social + 0.08, 0, 1);
      touchBond(o, c.id, { familiarity: 0.03, fondness: fit >= 0 ? 0.02 : -0.01 });
      remember(w, o, `${name} said to me: “${text}”`, 0.35 + Math.abs(fit));
      // speaker
      c.drives.social = clamp(c.drives.social + 0.06, 0, 1);
      touchBond(c, o.id, { familiarity: 0.02, fondness: 0.01 });
      remember(w, c, `I said to ${o.sheet.name}: “${text}”`, 0.25);
      return null;
    }
    case "eat": {
      const item = m.item;
      if (!item || !removeOne(c.inventory, item)) return "nothing to eat";
      begin(10);
      say(`${name} eats ${ITEMS[item].name}.`);
      return null;
    }
    case "buy_food": {
      if (c.place !== "bakery") return "not at the bakery";
      if (c.coins < BREAD_PRICE) return "not enough coins";
      if (w.bakeryStock <= 0) return "the bakery is out of bread";
      c.coins -= BREAD_PRICE;
      w.bakeryStock -= 1;
      c.inventory.push("bread");
      begin(5);
      say(`${name} buys bread (${BREAD_PRICE} coins).`);
      return null;
    }
    case "craft": {
      if (c.place !== "workshop") return "not at the workshop";
      if (c.drives.energy <= 0.12) return "too tired to craft";
      begin(45);
      say(`${name} starts crafting.`);
      return null;
    }
    case "sell": {
      if (c.place !== "fountain") return "not at the market stall";
      const item = m.item;
      if (!item || ITEMS[item].sell <= 0 || !removeOne(c.inventory, item)) return "nothing to sell";
      begin(10);
      say(`${name} offers ${ITEMS[item].name} at the stall.`);
      return null;
    }
    case "gift": {
      const o = m.target ? w.creatures[m.target] : undefined;
      const item = m.item;
      if (!o || o.place !== c.place) return "they are not here";
      if (!item || !removeOne(c.inventory, item)) return "nothing to give";
      o.inventory.push(item);
      begin(2);
      say(`${name} gives ${o.sheet.name} ${ITEMS[item].name}.`);
      const fit = appraise(o, [...ITEMS[item].tags, "gift"]);
      impulse(o, 0.12 + fit * 0.6, 0.15);
      touchBond(o, c.id, { familiarity: 0.04, trust: 0.04, fondness: 0.05 + Math.max(0, fit) * 0.2 });
      touchBond(c, o.id, { familiarity: 0.03, trust: 0.02, fondness: 0.03 });
      impulse(c, 0.08);
      remember(w, o, `${name} gave me ${ITEMS[item].name}.`, 0.5 + Math.abs(fit));
      remember(w, c, `I gave ${o.sheet.name} ${ITEMS[item].name}.`, 0.4);
      return null;
    }
    case "post": {
      if (!m.text) return "nothing to post";
      if (c.lastPostT !== undefined && w.t - c.lastPostT < 180) return "already posted recently";
      begin(2);
      c.lastPostT = w.t;
      w.board.push({ id: ++w.boardSeq, t: w.t, ts: Date.now(), by: name, byKind: "creature", text: m.text });
      if (w.board.length > 60) w.board.splice(0, w.board.length - 60);
      logFeed(w, c.id, "say", `${name} pins a notice: \u201c${m.text}\u201d`, m.why, src);
      impulse(c, 0.05);
      remember(w, c, `I pinned a notice on the board: \u201c${m.text}\u201d`, 0.3);
      return null;
    }
    case "rest":
      begin(30);
      say(`${name} rests a while.`);
      return null;
    case "sleep": {
      if (c.place !== "nests") return "can only sleep at the nests";
      begin(600);
      say(`${name} curls up to sleep.`);
      return null;
    }
    case "play": {
      if (!["park", "pond", "fountain"].includes(c.place)) return "nowhere to play here";
      begin(30);
      say(`${name} plays.`);
      return null;
    }
    default:
      begin(15);
      say(`${name} lingers.`);
      return null;
  }
}

function finishActivity(w: World, c: Creature) {
  const a = c.activity;
  if (!a) return;
  const m = a.move;
  const name = c.sheet.name;
  c.activity = null;
  switch (a.kind) {
    case "walk":
      if (m.place) c.place = m.place;
      break;
    case "eat": {
      const item = m.item!;
      const before = c.drives.food;
      c.drives.food = clamp(before + ITEMS[item].food, 0, 1);
      const fit = appraise(c, ITEMS[item].tags);
      impulse(c, 0.06 + (c.drives.food - before) * 0.3 + fit * 0.5);
      remember(w, c, `I ate ${ITEMS[item].name}${before < 0.3 ? " and it was badly needed" : ""}.`, 0.2 + Math.abs(fit) + (before < 0.3 ? 0.2 : 0));
      break;
    }
    case "craft": {
      const item = SPECIES[c.species].craft;
      c.inventory.push(item);
      c.drives.energy = clamp(c.drives.energy - 0.08, 0, 1);
      c.drives.curiosity = clamp(c.drives.curiosity + 0.1, 0, 1);
      c.drives.comfort = clamp(c.drives.comfort + 0.03, 0, 1);
      const fit = appraise(c, ITEMS[item].tags);
      impulse(c, 0.05 + fit * 0.8, 0.05);
      logFeed(w, c.id, "move", `${name} finishes a ${ITEMS[item].name}.`);
      remember(w, c, `I made a ${ITEMS[item].name}.`, 0.3 + Math.max(0, fit));
      break;
    }
    case "sell": {
      const item = m.item!;
      const price = Math.max(1, Math.round(ITEMS[item].sell * (w.market[item] ?? 1)));
      c.coins += price;
      w.market[item] = Math.max(0.3, (w.market[item] ?? 1) - 0.12);
      impulse(c, 0.03 + price * 0.01);
      logFeed(w, c.id, "move", `${name} sells ${ITEMS[item].name} for ${price} coins.`);
      remember(w, c, `Sold ${ITEMS[item].name} for ${price} coins.`, 0.25);
      break;
    }
    case "rest":
      c.drives.energy = clamp(c.drives.energy + 0.1, 0, 1);
      c.drives.comfort = clamp(c.drives.comfort + 0.05, 0, 1);
      break;
    case "play": {
      c.drives.curiosity = clamp(c.drives.curiosity + 0.25, 0, 1);
      c.drives.comfort = clamp(c.drives.comfort + 0.05, 0, 1);
      const others = creaturesAt(w, c.place, c.id);
      if (others.length) {
        c.drives.social = clamp(c.drives.social + Math.min(0.3, 0.1 * others.length), 0, 1);
        for (const o of others) {
          touchBond(c, o.id, { familiarity: 0.02, fondness: 0.02 });
          touchBond(o, c.id, { familiarity: 0.02, fondness: 0.01 });
        }
      }
      impulse(c, 0.1, 0.05);
      remember(w, c, others.length ? `I played with ${others.map((o) => o.sheet.name).join(" and ")}.` : "I played on my own.", others.length ? 0.4 : 0.2);
      break;
    }
    case "sleep":
      c.sleptSinceReflect = true;
      impulse(c, 0.05);
      remember(w, c, "I woke up after sleeping.", 0.25);
      logFeed(w, c.id, "move", `${name} wakes up.`);
      break;
    default:
      break;
  }
}

// ---------- stepping the world ----------

const COMFORT_PLACE: Partial<Record<Creature["species"], PlaceId>> = { otter: "workshop", magpie: "fountain", toad: "pond" };

function stepCreature(w: World, c: Creature, dt: number) {
  const rates = SPECIES[c.species].rates;
  const asleep = c.activity?.kind === "sleep";
  const night = clockOf(w.t).isNight;
  const alone = creaturesAt(w, c.place, c.id).length === 0;

  if (asleep) {
    c.drives.energy = clamp(c.drives.energy + 0.0035 * dt, 0, 1);
    c.drives.food = clamp(c.drives.food - rates.food * 0.4 * dt, 0, 1);
    c.drives.comfort = clamp(c.drives.comfort + 0.002 * dt, 0, 1);
  } else {
    c.drives.food = clamp(c.drives.food - rates.food * dt, 0, 1);
    c.drives.energy = clamp(c.drives.energy - rates.energy * (night ? 1.5 : 1) * dt, 0, 1);
    c.drives.social = clamp(c.drives.social - rates.social * (alone ? 1 : 0.4) * dt, 0, 1);
    c.drives.curiosity = clamp(c.drives.curiosity - rates.curiosity * dt, 0, 1);
    let comfort = -rates.comfort;
    if (c.place === "nests") comfort += 0.0008;
    if (COMFORT_PLACE[c.species] === c.place) comfort += 0.001;
    c.drives.comfort = clamp(c.drives.comfort + comfort * dt, 0, 1);
  }
  stepAffect(c, dt);

  const a = c.activity;
  if (a) {
    if (a.kind === "sleep") {
      if (c.drives.energy >= 0.95 || c.drives.food < 0.12 || w.t >= a.until) {
        if (c.drives.food < 0.12) remember(w, c, "I woke up because my stomach hurt.", 0.5);
        finishActivity(w, c);
      }
    } else if (w.t >= a.until) {
      finishActivity(w, c);
    }
  }

  kickQueue(w, c);
}

/** Start the next queued move if the creature is free. A failed move cancels the rest of the chain. */
export function kickQueue(w: World, c: Creature) {
  while (!c.activity && c.queue.length) {
    const next = c.queue.shift()!;
    const err = startMove(w, c, next);
    if (err) {
      impulse(c, -0.04);
      remember(w, c, `I meant to ${next.do} but ${err}.`, 0.3);
      c.queue = []; // later moves depended on this one
      break;
    }
  }
}

export function needsDecision(w: World, c: Creature): boolean {
  return !c.activity && c.queue.length === 0 && w.t - c.lastDecisionT >= MIN_DECISION_GAP;
}

// ---------- daily town events: shared experiences that give creatures something to react to ----------

const EVENTS = [
  { name: "rain", text: "Rain drifts over the town all morning." },
  { name: "festival", text: "A small festival has filled the fountain square." },
  { name: "delivery", text: "A cart has delivered extra flour to the bakery." },
  { name: "quiet", text: "A quiet, ordinary day." },
];

function maybeEvent(w: World) {
  const clk = clockOf(w.t);
  if (clk.hh < 6 || (w.event?.day ?? 0) >= clk.day) return;
  const ev = EVENTS[Math.floor(rand(w) * EVENTS.length)];
  w.event = { day: clk.day, name: ev.name, text: ev.text };
  logFeed(w, "world", "system", ev.text);
  for (const c of Object.values(w.creatures)) {
    if (ev.name === "rain") {
      if (c.place !== "nests" && c.place !== "workshop") c.drives.comfort = clamp(c.drives.comfort - 0.08, 0, 1);
      impulse(c, appraise(c, ["rain"]) * 0.8);
    } else if (ev.name === "festival") {
      c.drives.social = clamp(c.drives.social + 0.1, 0, 1);
      if (c.place === "fountain") impulse(c, 0.1, 0.1);
    }
    remember(w, c, `Today: ${ev.text}`, 0.3);
  }
  if (ev.name === "delivery") w.bakeryStock = BAKERY_MAX_STOCK;
  if (ev.name === "festival") for (const k of Object.keys(w.market)) w.market[k] = 1;
}

/** Advance the whole world by one STEP. Returns ids of creatures that now need a decision. */
export function stepWorld(w: World): string[] {
  w.t += STEP;
  maybeEvent(w);
  if (w.t % 60 < STEP && w.bakeryStock < BAKERY_MAX_STOCK) w.bakeryStock += 1;
  for (const k of Object.keys(w.market)) w.market[k] = Math.min(1, w.market[k] + 0.015);
  const need: string[] = [];
  for (const c of Object.values(w.creatures)) {
    stepCreature(w, c, STEP);
    if (needsDecision(w, c)) need.push(c.id);
  }
  return need;
}
