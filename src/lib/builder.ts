// Guarded world-building. A creature (model or rules) may PROPOSE a small addition to a place. This module owns the
// whole schema: a fixed catalog of kinds, bounded text, costs, daily limits, caps, the human veto queue and decay.
// Builds are plain data (kind, place id, one short label). They add no mechanics, code or HTML: the only effect is a
// small, habituating comfort/joy push through novelty.ts when a creature notices one.
import { addInfluence, relieve } from "./affect";
import { PLACE_IDS, PLACES } from "./content";
import { checkText } from "./filter";
import { noteExposure, novelty, payoffScale } from "./novelty";
import type { Build, BuildKind, Creature, Move, PlaceId, World } from "./types";

export interface BuildDef {
  label: string; // what the world calls it
  cost: number; // in-world coins, held until a human decides (if one has to)
  auto: boolean; // may be approved without a human when no free text is attached
  needsText: boolean; // a sign must say something
  comfort: number; // relief of discomfort per notice, before habituation
  joy: number; // joy influence level per notice, before habituation
}

/** The whole catalog. Anything not listed here is not buildable. */
export const BUILD_CATALOG: Record<BuildKind, BuildDef> = {
  bench: { label: "bench", cost: 4, auto: true, needsText: false, comfort: 0.08, joy: 0.06 },
  garden: { label: "garden plot", cost: 5, auto: true, needsText: false, comfort: 0.03, joy: 0.14 },
  flowerbox: { label: "flower box", cost: 2, auto: true, needsText: false, comfort: 0.02, joy: 0.1 },
  lantern: { label: "lantern", cost: 3, auto: true, needsText: false, comfort: 0.04, joy: 0.08 },
  sign: { label: "painted sign", cost: 3, auto: false, needsText: true, comfort: 0, joy: 0.08 },
};
export const BUILD_KINDS = Object.keys(BUILD_CATALOG) as BuildKind[];
export const isBuildKind = (k: unknown): k is BuildKind => typeof k === "string" && Object.hasOwn(BUILD_CATALOG, k);

export const BUILDS_PER_DAY = 1; // proposals per creature per world day
export const MAX_ACTIVE_BUILDS = 12; // town wide
export const MAX_PENDING_BUILDS = 6; // town wide
export const MAX_BUILDS_PER_PLACE = 3;
export const BUILD_ENERGY = 0.06;
export const BUILD_MINUTES = 30;
export const BUILD_TEXT_MAX = 40;
export const BUILD_LIFETIME = 7 * 1440; // an approved build fades after a world week
export const PENDING_LIFETIME = 3 * 1440; // an unanswered proposal lapses (and is refunded) after three world days
export const MAX_NOTICED_PER_VISIT = 2;

export const buildsToday = (w: World, c: Creature): number => (c.buildsMade.day === Math.floor(w.t / 1440) + 1 ? c.buildsMade.n : 0);
export const activeBuilds = (w: World, place?: PlaceId): Build[] => w.builds.filter((b) => b.status === "active" && (!place || b.place === place));
export const pendingBuilds = (w: World): Build[] => w.builds.filter((b) => b.status === "pending");

/** Label text: short, plain, one line, checked. Returns null when it fails (never a rewrite of a hostile text). */
export function cleanBuildText(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t || t.length > BUILD_TEXT_MAX) return null;
  if (!/^[A-Za-z0-9 ,.'!?-]+$/.test(t)) return null; // no markup, quotes, slashes, braces, links, non-ASCII
  if (/\s{2,}/.test(t)) return null;
  const v = checkText(t);
  return v.ok ? t : null;
}

/** Will this proposal be approved on the spot? Only whitelisted kinds with no free text, and cheap. */
export const autoApprovable = (kind: BuildKind, text: string | undefined): boolean => BUILD_CATALOG[kind].auto && !text && BUILD_CATALOG[kind].cost <= 5;

export interface BuildProj {
  place: PlaceId;
  coins: number;
  builds: number;
}

/** Common checks, against live caps. Returns a reason or null. Used both when planning and when starting. */
function capsError(w: World, c: Creature, kind: BuildKind, place: PlaceId, text: string | undefined, buildsToday_: number, coins: number): string | null {
  const def = BUILD_CATALOG[kind];
  if (!PLACE_IDS.includes(place)) return "no such place";
  if (def.needsText && !text) return "a sign needs a short line of text";
  if (c.energy <= 0.3) return "too tired to build anything";
  if (buildsToday_ >= BUILDS_PER_DAY) return "already proposed something today";
  if (coins < def.cost) return "not enough coins for materials";
  if (activeBuilds(w, place).length + pendingBuilds(w).filter((b) => b.place === place).length >= MAX_BUILDS_PER_PLACE) return "that place has enough already";
  if (autoApprovable(kind, text)) {
    if (activeBuilds(w).length >= MAX_ACTIVE_BUILDS) return "the town has all the additions it can hold";
  } else if (pendingBuilds(w).length >= MAX_PENDING_BUILDS) return "too many proposals are waiting for an answer";
  return null;
}

/** Validate a proposed move against the projected state. Normalises the move (place defaults to here). Mutates proj. */
export function checkBuildMove(w: World, c: Creature, m: Move, p: BuildProj): string | null {
  if (!isBuildKind(m.build)) return "unknown kind of build";
  if (m.text !== undefined && !cleanBuildText(m.text)) return "that label is not allowed";
  const place = m.place ?? p.place;
  if (place !== p.place) return "can only build where I am";
  const err = capsError(w, c, m.build, place, m.text, p.builds, p.coins);
  if (err) return err;
  m.place = place;
  p.coins -= BUILD_CATALOG[m.build].cost;
  p.builds += 1;
  return null;
}

/** Perform the proposal against the real state. `begin` sets the activity. */
export function startBuildMove(w: World, c: Creature, m: Move, begin: (mins: number) => void, say: (t: string) => void, log: (t: string) => void): string | null {
  if (!isBuildKind(m.build)) return "unknown kind of build";
  const text = m.text === undefined ? undefined : (cleanBuildText(m.text) ?? undefined);
  if (m.text !== undefined && text === undefined) return "that label is not allowed";
  const place = m.place ?? c.place;
  if (place !== c.place) return "can only build where I am";
  const err = capsError(w, c, m.build, place, text, buildsToday(w, c), c.coins);
  if (err) return err;
  const def = BUILD_CATALOG[m.build];
  const auto = autoApprovable(m.build, text);
  c.coins -= def.cost;
  c.buildsMade = { day: Math.floor(w.t / 1440) + 1, n: buildsToday(w, c) + 1 };
  c.energy = Math.max(0.04, c.energy - BUILD_ENERGY);
  const b: Build = {
    id: ++w.buildSeq,
    kind: m.build,
    place,
    text,
    by: c.id,
    cost: def.cost,
    status: auto ? "active" : "pending",
    createdT: w.t,
    expiresT: w.t + (auto ? BUILD_LIFETIME : PENDING_LIFETIME),
  };
  w.builds.push(b);
  begin(BUILD_MINUTES);
  const what = `${def.label}${text ? ` saying “${text}”` : ""}`;
  if (auto) {
    say(`${c.sheet.name} puts up a ${what} at ${PLACES[place].name}.`);
    addInfluence(c, "accomplishment", `built a ${def.label}`, 0.3);
  } else {
    say(`${c.sheet.name} proposes a ${what} for ${PLACES[place].name}; it waits for the town's approval.`);
  }
  log(auto ? `I put up a ${what}.` : `I asked to put up a ${what}; I am waiting to hear.`);
  return null;
}

/** A creature at a place notices what has been built there: small comfort/joy, fading with repetition. */
export function noticeBuilds(w: World, c: Creature): void {
  const here = activeBuilds(w, c.place);
  if (!here.length) return;
  // the freshest-to-this-creature ones first, so novelty decides what catches the eye
  const ranked = [...here].sort((a, b) => novelty(c, `build:${b.id}`, w.t) - novelty(c, `build:${a.id}`, w.t)).slice(0, MAX_NOTICED_PER_VISIT);
  for (const b of ranked) {
    const key = `build:${b.id}`;
    const nov = novelty(c, key, w.t);
    const pm = payoffScale(nov) * (b.by === c.id ? 0.5 : 1);
    const def = BUILD_CATALOG[b.kind];
    if (def.comfort) relieve(c, "comfort", def.comfort * pm);
    if (def.joy) addInfluence(c, "joy", `the ${def.label} here`, def.joy * pm);
    if (nov >= 0.6) relieve(c, "boredom", 0.04 * nov);
    noteExposure(c, key, w.t);
  }
}

// ---------- the human queue and decay ----------

export type AdminAction = "approve" | "reject" | "remove";

const feed = (w: World, text: string, logFeed: (w: World, who: string, kind: "system", text: string) => void) => logFeed(w, "world", "system", text);

function drop(w: World, b: Build) {
  w.builds.splice(w.builds.indexOf(b), 1);
}

/**
 * Refund rule: ONLY a proposal that never went up (rejected or lapsed while pending) gets its coins back, in full and
 * at most once because the record is deleted at the same time. A build that stood and was removed or faded refunds nothing.
 */
function refund(w: World, b: Build) {
  const c = w.creatures[b.by];
  if (c) c.coins += b.cost;
}

export function adminAct(
  w: World,
  action: unknown,
  id: unknown,
  logFeed: (w: World, who: string, kind: "system", text: string) => void,
): { ok: true; message: string } | { ok: false; error: string; status: number } {
  if (action !== "approve" && action !== "reject" && action !== "remove") return { ok: false, error: "unknown action", status: 400 };
  if (typeof id !== "number" || !Number.isInteger(id)) return { ok: false, error: "id must be an integer", status: 400 };
  const b = w.builds.find((x) => x.id === id);
  if (!b) return { ok: false, error: "no such build", status: 404 };
  const name = `${BUILD_CATALOG[b.kind].label} at ${PLACES[b.place].name}`;
  if (action === "approve") {
    if (b.status !== "pending") return { ok: false, error: "not pending", status: 409 };
    if (activeBuilds(w).length >= MAX_ACTIVE_BUILDS) return { ok: false, error: "town is at its cap of active builds; remove one first", status: 409 };
    b.status = "active";
    b.expiresT = w.t + BUILD_LIFETIME;
    feed(w, `A ${name} was approved and now stands.`, logFeed);
    return { ok: true, message: "approved" };
  }
  if (action === "reject") {
    if (b.status !== "pending") return { ok: false, error: "not pending (use remove)", status: 409 };
    refund(w, b);
    drop(w, b);
    feed(w, `A proposed ${name} was turned down.`, logFeed);
    return { ok: true, message: "rejected and refunded" };
  }
  if (b.status !== "active") return { ok: false, error: "not active (use reject)", status: 409 };
  drop(w, b);
  feed(w, `The ${name} was taken down.`, logFeed);
  return { ok: true, message: "removed, no refund" };
}

/** Decay. Cheap: the list is at most MAX_ACTIVE + MAX_PENDING long. Call once per step or per day. */
export function sweepBuilds(w: World, logFeed: (w: World, who: string, kind: "system", text: string) => void): void {
  for (const b of [...w.builds]) {
    if (w.t < b.expiresT) continue;
    const name = `${BUILD_CATALOG[b.kind].label} at ${PLACES[b.place].name}`;
    if (b.status === "pending") {
      refund(w, b);
      feed(w, `A proposed ${name} lapsed without an answer.`, logFeed);
    } else feed(w, `The ${name} has weathered away.`, logFeed);
    drop(w, b);
  }
}

/** Public projection: active builds only, text already clean. */
export const publicBuilds = (w: World) => activeBuilds(w).map((b) => ({ id: b.id, kind: b.kind, label: BUILD_CATALOG[b.kind].label, place: b.place, text: b.text ?? null, by: w.creatures[b.by]?.sheet.name ?? "someone" }));

/** Admin projection. */
export const adminBuilds = (w: World) =>
  w.builds.map((b) => ({ id: b.id, kind: b.kind, place: b.place, text: b.text ?? null, by: b.by, cost: b.cost, status: b.status, createdT: b.createdT, expiresT: b.expiresT }));

/** Rules mind: a small chance to put up something cheap with no text (so it never needs the human queue). */
export function ruleBuildOption(w: World, c: Creature): { want: number; moves: Move[]; key: string } | null {
  if (c.energy <= 0.5 || buildsToday(w, c) >= BUILDS_PER_DAY || activeBuilds(w).length >= MAX_ACTIVE_BUILDS) return null;
  if (activeBuilds(w, c.place).length + pendingBuilds(w).filter((b) => b.place === c.place).length >= MAX_BUILDS_PER_PLACE) return null;
  if (c.place === "nests") return null;
  const have = new Set(activeBuilds(w, c.place).map((b) => b.kind));
  const kind = BUILD_KINDS.filter((k) => BUILD_CATALOG[k].auto && !have.has(k)).sort((a, b) => BUILD_CATALOG[a].cost - BUILD_CATALOG[b].cost)[0];
  if (!kind || c.coins < BUILD_CATALOG[kind].cost + 10) return null; // never from the last coins
  return { want: 0.3, moves: [{ do: "propose_build", build: kind, place: c.place, why: "The town could do with something here." }], key: `build:new` };
}
