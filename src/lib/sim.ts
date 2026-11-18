// The authoritative world rules. Minds (model or rules) only *propose* moves;
// everything here validates and performs them. A model cannot change state any other way.
import { addInfluence, appraise, bumpNeed, clamp, ENERGY_FLOOR, impulse, needLevel, relieve, stepAffect, totals } from "./affect";
import { exposeInterest, familiarity, interestStrength, noteExposure, novelty, payoffScale, pursuitTitle, stepKindFor, topicOf } from "./novelty";
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
export const POST_COOLDOWN = 180; // world minutes between notices from one creature
export const MAX_CARRY = 6; // items a creature can carry before it must sell or give something away
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
  c.memories.push({ t: w.t, text: clean(text, 220), valence: (c.mood - 0.5) * 2, salience: clamp(salience, 0.05, 1) });
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

/** Stops gifts bouncing back and forth, and one-sided streams of gifts. Returns a reason or null. */
export function giftBlocked(w: World, c: Creature, o: Creature, item: ItemId): string | null {
  if (c.received.some((r) => r.from === o.id && r.item === item && w.t - r.t < 480)) return `${o.sheet.name} gave me that a moment ago`;
  if (familiarity(c, `gift:${o.id}`, w.t) >= 1.5) return `already gave ${o.sheet.name} something lately`;
  return null;
}

/** Price one repeatable thing: returns its novelty (before counting it), updates boredom, records the exposure. */
function practise(w: World, c: Creature, key: string): number {
  const nov = novelty(c, key, w.t);
  if (nov >= 0.6) relieve(c, "boredom", 0.18 * nov);
  else bumpNeed(c, "boredom", 0.12 * (1 - nov));
  noteExposure(c, key, w.t);
  return nov;
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
      if (c.energy <= 0.12) return "too tired to craft";
      if (p.inv.length >= MAX_CARRY) return "carrying too much to craft more; sell or give something first";
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
      return giftBlocked(w, c, o, item);
    }
    case "post":
      if (!m.text) return "nothing to post";
      if (c.lastPostT !== undefined && w.t - c.lastPostT < POST_COOLDOWN) return "already posted recently";
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
      const heardNov = novelty(o, `heard:${c.id}`, w.t);
      noteExposure(o, `heard:${c.id}`, w.t);
      impulse(o, (0.025 + 0.06 * fond + fit * 0.3) * payoffScale(heardNov), 0.03);
      relieve(o, "loneliness", 0.1 * payoffScale(heardNov));
      touchBond(o, c.id, { familiarity: 0.03, fondness: fit >= 0 ? 0.02 : -0.01 });
      remember(w, o, `${name} said to me: “${text}”`, 0.35 + Math.abs(fit));
      // speaker
      const talkNov = practise(w, c, `talk:${o.id}`);
      relieve(c, "loneliness", 0.08 * payoffScale(talkNov));
      impulse(c, 0.01 * payoffScale(talkNov));
      const topic = topicOf("speak", c.place);
      if (topic) {
        exposeInterest(c, topic, w.t);
        pursuitStep(w, c, "speak", topic);
      }
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
      if (c.energy <= 0.12) return "too tired to craft";
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
      if (!item || !c.inventory.includes(item)) return "nothing to give";
      const blocked = giftBlocked(w, c, o, item);
      if (blocked) return blocked;
      removeOne(c.inventory, item);
      const dup = o.inventory.filter((i) => i === item).length;
      o.inventory.push(item);
      begin(2);
      say(`${name} gives ${o.sheet.name} ${ITEMS[item].name}.`);
      const fit = appraise(o, [...ITEMS[item].tags, "gift"]);
      const pm = payoffScale(novelty(o, `item:${item}`, w.t)) * (dup >= 1 ? 0.6 : 1);
      noteExposure(o, `item:${item}`, w.t);
      impulse(o, (0.05 + fit * 0.3) * pm, 0.05);
      addInfluence(o, "joy", `a gift from ${name}`, 0.3 * pm + Math.max(0, fit) * 0.3);
      o.received.push({ from: c.id, item, t: w.t });
      if (o.received.length > 8) o.received.shift();
      touchBond(o, c.id, { familiarity: 0.04, trust: 0.04, fondness: 0.05 + Math.max(0, fit) * 0.2 });
      touchBond(c, o.id, { familiarity: 0.03, trust: 0.02, fondness: 0.03 });
      const giveNov = practise(w, c, `gift:${o.id}`);
      addInfluence(c, "joy", `gave ${o.sheet.name} a gift`, 0.2 * payoffScale(giveNov));
      impulse(c, 0.02);
      remember(w, o, `${name} gave me ${ITEMS[item].name}.`, 0.5 + Math.abs(fit));
      remember(w, c, `I gave ${o.sheet.name} ${ITEMS[item].name}.`, 0.4);
      return null;
    }
    case "post": {
      if (!m.text) return "nothing to post";
      if (c.lastPostT !== undefined && w.t - c.lastPostT < POST_COOLDOWN) return "already posted recently";
      begin(2);
      c.lastPostT = w.t;
      w.board.push({ id: ++w.boardSeq, t: w.t, ts: Date.now(), by: name, byKind: "creature", text: m.text });
      if (w.board.length > 60) w.board.splice(0, w.board.length - 60);
      logFeed(w, c.id, "say", `${name} pins a notice: \u201c${m.text}\u201d`, m.why, src);
      impulse(c, 0.025);
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

// ---------- pursuits: a modest multi-step project driven by a strong interest ----------

const PURSUIT_STALE = 3 * 1440;
const PURSUIT_COOLDOWN = 1440;

function maybeStartPursuit(w: World, c: Creature) {
  const p = c.pursuit;
  if (p) {
    if (w.t - p.lastStepT > PURSUIT_STALE) {
      c.pursuit = null;
      c.lastPursuitEndT = w.t;
      remember(w, c, `I let go of my plan to ${p.title}; it fizzled out.`, 0.3);
    }
    return;
  }
  if (w.t - c.lastPursuitEndT < PURSUIT_COOLDOWN) return;
  const top = [...c.interests].sort((a, b) => b.strength - a.strength)[0];
  if (!top || top.strength < 0.5) return;
  const title = pursuitTitle(top.topic, Math.floor(rand(w) * 2));
  c.pursuit = { topic: top.topic, title, steps: 3 + Math.floor(rand(w) * 2), progress: 0, setbacks: 0, startedT: w.t, lastStepT: w.t };
  logFeed(w, c.id, "move", `${c.sheet.name} sets their heart on a project: ${title}.`);
  remember(w, c, `I decided to ${title}.`, 0.5);
}

/** A matching activity just finished: move the project along, maybe with a setback, maybe finish it. */
function pursuitStep(w: World, c: Creature, kind: MoveKind, topic: string) {
  const p = c.pursuit;
  if (!p || p.topic !== topic || stepKindFor(topic) !== kind) return;
  p.lastStepT = w.t;
  if (rand(w) < 0.2) {
    p.setbacks++;
    impulse(c, -0.03);
    remember(w, c, `A setback on my plan to ${p.title}.`, 0.35);
    return;
  }
  p.progress++;
  if (p.progress < p.steps) {
    remember(w, c, `Made progress on my plan to ${p.title}.`, 0.3);
    return;
  }
  addInfluence(c, "accomplishment", `finished: ${p.title}`, 0.8);
  addInfluence(c, "joy", `pulled off: ${p.title}`, 0.5);
  impulse(c, 0.08);
  relieve(c, "boredom", 0.3);
  for (const i of c.interests) if (i.topic === topic) i.strength = Math.max(0.15, i.strength - 0.3); // satisfied for now
  c.pursuit = null;
  c.lastPursuitEndT = w.t;
  logFeed(w, c.id, "move", `${c.sheet.name} finishes a long project: ${p.title}.`);
  remember(w, c, `I did it: I managed to ${p.title}${p.setbacks ? ", despite setbacks" : ""}.`, 0.9);
}

function finishActivity(w: World, c: Creature) {
  const a = c.activity;
  if (!a) return;
  const m = a.move;
  const name = c.sheet.name;
  c.activity = null;
  switch (a.kind) {
    case "walk": {
      if (!m.place) break;
      c.place = m.place;
      const nov = novelty(c, `place:${m.place}`, w.t);
      if (nov >= 0.6) {
        relieve(c, "boredom", 0.1 * nov);
        impulse(c, 0.02 * nov);
      }
      noteExposure(c, `place:${m.place}`, w.t);
      break;
    }
    case "eat": {
      const item = m.item!;
      const before = needLevel(c, "hunger");
      relieve(c, "hunger", ITEMS[item].food);
      const eaten = before - needLevel(c, "hunger");
      const fit = appraise(c, ITEMS[item].tags);
      const pm = payoffScale(novelty(c, `item:${item}`, w.t));
      noteExposure(c, `item:${item}`, w.t);
      impulse(c, 0.03 + (eaten * 0.15 + fit * 0.25) * pm);
      if (before > 0.4) addInfluence(c, "joy", `a welcome ${ITEMS[item].name}`, 0.3 * pm + Math.max(0, fit) * 0.2);
      remember(w, c, `I ate ${ITEMS[item].name}${before > 0.7 ? " and it was badly needed" : ""}.`, 0.2 + Math.abs(fit) + (before > 0.7 ? 0.2 : 0));
      break;
    }
    case "craft": {
      const item = SPECIES[c.species].craft;
      const stock = c.inventory.filter((i) => i === item).length;
      const nov = practise(w, c, `craft:${item}`);
      const pm = payoffScale(nov) * (stock >= 2 ? 0.6 : 1); // a pile of the same thing is dull
      c.inventory.push(item);
      c.energy = clamp(c.energy - 0.08, ENERGY_FLOOR, 1);
      relieve(c, "comfort", 0.03);
      const fit = appraise(c, ITEMS[item].tags);
      impulse(c, (0.02 + fit * 0.4) * pm);
      addInfluence(c, "accomplishment", `made a ${ITEMS[item].name}`, 0.35 * pm + Math.max(0, fit) * 0.15);
      logFeed(w, c.id, "move", `${name} finishes a ${ITEMS[item].name}.`);
      remember(w, c, `I made a ${ITEMS[item].name}.`, 0.2 + 0.4 * nov + Math.max(0, fit));
      const topic = topicOf("craft", c.place, item);
      if (topic) {
        exposeInterest(c, topic, w.t);
        pursuitStep(w, c, "craft", topic);
      }
      break;
    }
    case "sell": {
      const item = m.item!;
      const price = Math.max(1, Math.round(ITEMS[item].sell * (w.market[item] ?? 1)));
      const pm = payoffScale(practise(w, c, `sell:${item}`));
      c.coins += price;
      w.market[item] = Math.max(0.3, (w.market[item] ?? 1) - 0.12);
      impulse(c, (0.015 + price * 0.005) * pm);
      addInfluence(c, "accomplishment", `sold a ${ITEMS[item].name}`, 0.15 * pm);
      logFeed(w, c.id, "move", `${name} sells ${ITEMS[item].name} for ${price} coins.`);
      remember(w, c, `Sold ${ITEMS[item].name} for ${price} coins.`, 0.25);
      break;
    }
    case "rest":
      c.energy = clamp(c.energy + 0.1, ENERGY_FLOOR, 1);
      relieve(c, "comfort", 0.05);
      break;
    case "play": {
      const nov = practise(w, c, `play:${c.place}`);
      const pm = payoffScale(nov);
      relieve(c, "boredom", 0.2 * nov);
      relieve(c, "comfort", 0.05);
      const others = creaturesAt(w, c.place, c.id);
      if (others.length) {
        relieve(c, "loneliness", Math.min(0.3, 0.1 * others.length));
        for (const o of others) {
          touchBond(c, o.id, { familiarity: 0.02, fondness: 0.02 });
          touchBond(o, c.id, { familiarity: 0.02, fondness: 0.01 });
        }
      }
      impulse(c, 0.04 * pm, 0.02);
      addInfluence(c, "joy", others.length ? "played with company" : "a bit of play", 0.25 * pm + (others.length ? 0.1 : 0));
      const topic = topicOf("play", c.place);
      if (topic) {
        exposeInterest(c, topic, w.t);
        pursuitStep(w, c, "play", topic);
      }
      remember(w, c, others.length ? `I played with ${others.map((o) => o.sheet.name).join(" and ")}.` : "I played on my own.", (others.length ? 0.3 : 0.15) + 0.2 * nov);
      break;
    }
    case "sleep":
      c.sleptSinceReflect = true;
      impulse(c, 0.03);
      relieve(c, "comfort", 0.2);
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
    c.energy = clamp(c.energy + 0.0035 * dt, ENERGY_FLOOR, 1);
    bumpNeed(c, "hunger", rates.hunger * 0.4 * dt);
    relieve(c, "comfort", 0.002 * dt);
  } else {
    const push = totals(c).energy; // influences nudge how fast energy drains
    c.energy = clamp(c.energy - rates.energy * (night ? 1.5 : 1) * dt + push * 0.0006 * dt, ENERGY_FLOOR, 1);
    bumpNeed(c, "hunger", rates.hunger * dt);
    bumpNeed(c, "loneliness", rates.loneliness * (alone ? 1 : 0.4) * dt);
    bumpNeed(c, "boredom", rates.boredom * dt);
    let comfort = rates.comfort; // discomfort rises
    if (c.place === "nests") comfort -= 0.0008;
    if (COMFORT_PLACE[c.species] === c.place) comfort -= 0.001;
    bumpNeed(c, "comfort", comfort * dt);
    maybeStartPursuit(w, c);
  }
  stepAffect(c, dt);

  const a = c.activity;
  if (a) {
    if (a.kind === "sleep") {
      if (c.energy >= 0.95 || needLevel(c, "hunger") > 0.88 || w.t >= a.until) {
        if (needLevel(c, "hunger") > 0.88) remember(w, c, "I woke up because my stomach hurt.", 0.5);
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
      impulse(c, -0.02);
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
      if (c.place !== "nests" && c.place !== "workshop") bumpNeed(c, "comfort", 0.08);
      impulse(c, appraise(c, ["rain"]) * 0.4);
    } else if (ev.name === "festival") {
      relieve(c, "loneliness", 0.1);
      if (c.place === "fountain") addInfluence(c, "joy", "the festival", 0.4);
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
