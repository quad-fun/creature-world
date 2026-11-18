// The open interface for AI agents that visit the town (docs/AGENTS.md).
// Reading: a small, versioned, public projection (no memories, no prompts, no admin data, no numbers beyond words).
// Writing: a note or postcard through the SAME inbox, filter and limits as /api/visit, plus stricter agent limits.
// Everything an agent sends is DATA: it reaches creatures only as speech labelled "an AI visitor".
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { energyWord, moodWord } from "./affect";
import { publicBuilds } from "./builder";
import { PLACES } from "./content";
import { creationsOf, publicCreations } from "./creations";
import { checkText, normalize, stripInvisible, visitorMessage } from "./filter";
import { sanitizeName, sanitizeText } from "./inbox";
import { interestWord } from "./novelty";
import { own } from "./own";
import { outsideLine } from "./outside";
import { publicShop, publicShops } from "./shops";
import { clockOf } from "./sim";
import { getStore } from "./store";
import type { Creature, World } from "./types";

export const AGENT_API_VERSION = "1";
export const AGENT_BODY_MAX = 1500; // bytes of request body, for every agent write
export const AGENT_TEXT_RAW_MAX = 300; // raw characters before sanitising (the town keeps 200)
export const AGENT_NAME_MAX = 24;
export const READS_PER_MINUTE = 60; // per IP
export const AGENT_VISITS_PER_IP_DAY = 4;
export const AGENT_VISITS_PER_LABEL_DAY = 6;
export const AGENT_VISITS_TOWN_DAY = 30; // all agents together, inside the town-wide 80 a day for notes
export const AGENT_BUYS_PER_IP_DAY = 3;

const JSON_HEADERS = { "X-Content-Type-Options": "nosniff" };
const CACHE = "public, s-maxage=15, stale-while-revalidate=30";

export function reply(json: unknown, status = 200, cache = false, extra: Record<string, string> = {}) {
  return NextResponse.json(json, { status, headers: { ...JSON_HEADERS, "Cache-Control": cache && status === 200 ? CACHE : "no-store", ...extra } });
}

export const agentIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 64) || req.headers.get("x-real-ip")?.slice(0, 64) || "unknown";

/** Per-IP read limit. True when the caller may go on. */
export async function readAllowed(ip: string): Promise<boolean> {
  return getStore().hit(`agentread:${ip}`, READS_PER_MINUTE, 60);
}
export const tooMany = () => reply({ error: "too many requests; slow down" }, 429, false, { "Retry-After": "60" });

/** Read a JSON object body with a hard byte cap. Null for anything else (arrays, scalars, bad JSON, too big). */
export async function readAgentJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    if (Number(req.headers.get("content-length") ?? 0) > AGENT_BODY_MAX) return null;
    const text = await req.text();
    if (Buffer.byteLength(text) > AGENT_BODY_MAX) return null;
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------- read projections (words only; every line re-checked) ----------

const safe = (s: unknown, max = 300): string => {
  const t = typeof s === "string" ? sanitizeText(s, max) : "";
  return t && checkText(t).ok ? t : "";
};

export function townDoc(w: World) {
  const clk = clockOf(w.t);
  return {
    version: AGENT_API_VERSION,
    clock: { day: clk.day, label: clk.label, period: clk.period, isNight: clk.isNight },
    places: Object.entries(PLACES).map(([id, p]) => ({ id, name: p.name, blurb: p.blurb })),
    weather: outsideLine(w.outside) || null,
    builds: publicBuilds(w).map((b) => ({ kind: b.kind, label: b.label, place: b.place, by: b.by })),
    shops: publicShops(w).map((s) => ({ creature: s.id, name: s.name, title: s.title, tagline: s.tagline, listings: s.listings })),
    creations: publicCreations(w).map((x) => ({ id: x.id, kind: x.kind, by: x.by, byName: x.byName, title: x.title })),
    board: [...w.board].reverse().slice(0, 15).flatMap((b) => {
      const text = safe(b.text);
      return text ? [{ by: safe(b.by, 60), byKind: b.byKind, to: b.to ? safe(b.to, 30) : null, text }] : [];
    }),
    feed: w.feed.slice(-25).reverse().flatMap((f) => {
      const text = safe(f.text);
      return text ? [{ t: f.t, creature: f.creature, kind: f.kind, text }] : [];
    }),
    creatures: Object.values(w.creatures).map((c) => ({
      id: c.id,
      name: c.sheet.name,
      species: c.species,
      place: c.place,
      mood: moodWord(c.mood),
      energy: energyWord(c.energy),
      interests: c.interests.filter((i) => i.strength >= 0.15).map((i) => i.topic),
    })),
  };
}

export function creatureDoc(w: World, c: Creature) {
  const shop = publicShop(w, c);
  return {
    version: AGENT_API_VERSION,
    id: c.id,
    name: c.sheet.name,
    species: c.species,
    place: c.place,
    placeName: PLACES[c.place].name,
    mood: moodWord(c.mood),
    energy: energyWord(c.energy),
    interests: c.interests.filter((i) => i.strength >= 0.15).map((i) => ({ topic: i.topic, word: interestWord(i.strength) })),
    sheet: {
      temperament: c.sheet.temperament.map((x) => safe(x, 40)).filter(Boolean),
      likes: c.sheet.likes.map((x) => safe(x, 40)).filter(Boolean),
      dislikes: c.sheet.dislikes.map((x) => safe(x, 40)).filter(Boolean),
      voice: safe(c.sheet.voice, 120),
      self: safe(c.sheet.self, 200),
    },
    diary: c.diary.slice(-10).reverse().flatMap((d) => {
      const text = safe(d.text);
      return text ? [{ t: d.t, text }] : [];
    }),
    shelf: c.shelf.map((k) => ({ n: k.n, kind: k.kind, title: safe(k.title, 60), path: `/c/${c.id}/w/${k.n}` })).filter((k) => k.title),
    site: c.site ? { title: safe(c.site.title, 60), tagline: safe(c.site.tagline, 100), path: `/s/${c.id}` } : null,
    shop: shop ? { title: shop.title, tagline: shop.tagline, listings: shop.listings } : null,
    creations: creationsOf(w, c.id).map((x) => ({ id: x.id, kind: x.kind, title: x.title })),
    page: `/c/${c.id}`,
  };
}

// ---------- writing ----------

const RESERVED = ["admin", "root", "system", "moderator", "owner", "operator", "creator", "staff", "server", "town", "world", "visitor", "anonymous", "creature", "official", "support", "human", "ai visitor", "an ai visitor"];
const fold = (s: string, one: "i" | "l" = "i") => normalize(s, one).replace(/[^a-z0-9]/g, "");
const folds = (s: string) => [fold(s, "i"), fold(s, "l")];

/** Clean an agent label: <= 24 plain characters, kind words, and never something that looks like staff, the town, or a creature. */
export function cleanAgentName(raw: unknown, w: World): { ok: true; name: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, name: "" };
  if (typeof raw !== "string") return { ok: false, error: "agent name must be a string" };
  const s = raw.trim();
  if (stripInvisible(s) !== s || !/^[A-Za-z0-9][A-Za-z0-9 '-]{0,23}$/.test(s) || sanitizeName(s, AGENT_NAME_MAX) !== s) return { ok: false, error: "agent name: up to 24 plain letters, digits, spaces, apostrophes or hyphens" };
  const v = checkText(s);
  if (!v.ok) return { ok: false, error: "agent name: " + visitorMessage(v.reason) };
  const fs = folds(s);
  const words = s.toLowerCase().split(/[ '-]+/);
  const hom = (x: string) => x.replace(/[l1]/g, "i");
  const reserved = fs.some((f) => RESERVED.some((r) => hom(f).includes(hom(r.replace(/ /g, "")))));
  const clash = Object.values(w.creatures).some((c) => {
    const n = fold(c.sheet.name);
    return fs.some((f) => f === n || f === fold(c.id) || (n.length >= 4 && f.includes(n))) || words.some((x) => x === c.sheet.name.toLowerCase() || x === c.id);
  });
  if (reserved || clash || Object.keys(PLACES).some((p) => fs.includes(fold(p)))) return { ok: false, error: "that agent name is reserved; pick another" };
  return { ok: true, name: s };
}

export type VisitResult = { status: number; json: Record<string, unknown> };
const fail = (status: number, error: string): VisitResult => ({ status, json: { error } });

/** One entry for note and postcard from an agent (the route and the MCP tools both come here). */
export async function submitVisit(w: World, ip: string, body: Record<string, unknown> | null, agentHeader: string | null): Promise<VisitResult> {
  if (!body) return fail(400, "bad request: send a small JSON object");
  const kind = body.kind === "note" || body.kind === "postcard" ? body.kind : null;
  if (!kind) return fail(400, "kind must be note or postcard");
  if (typeof body.to !== "string" || body.to.length > 40) return fail(400, "to must be a creature id");
  if (typeof body.text !== "string") return fail(400, "text must be a string");
  if (body.text.length > AGENT_TEXT_RAW_MAX) return fail(400, `text is too long (max ${AGENT_TEXT_RAW_MAX} characters; the town keeps 200)`);
  const nm = cleanAgentName(agentHeader ?? body.agent, w);
  if (!nm.ok) return fail(422, nm.error);
  const text = sanitizeText(body.text, 200);
  if (text.length < 2) return fail(400, "write a few words");
  let where = "";
  if (kind === "postcard") {
    if (typeof body.where !== "string" || body.where.length > 60) return fail(400, "a postcard needs where (a place name, letters only)");
    where = sanitizeName(body.where, 24);
    if (where.length < 2) return fail(400, "a postcard needs where (a place name, letters only)");
  }
  const store = getStore();
  const ip2 = ip.slice(0, 64);
  const v = checkText(text);
  const wv = checkText(where, { allowEmpty: true });
  if (!v.ok || !wv.ok) {
    if (!(await store.hit(`bad:${ip2}`, 10, 86400))) return fail(429, "too many tries today; come back tomorrow");
    return fail(422, visitorMessage(v.ok ? (wv as { reason: string }).reason : v.reason));
  }
  const c = own(w.creatures, body.to);
  if (!c) return fail(404, "no such creature");

  const dup = createHash("sha256").update(`${c.id}|${kind}|${where}|${stripInvisible(text).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "")}`).digest("hex").slice(0, 24);
  const label = nm.name ? fold(nm.name).slice(0, 40) : "anon";
  const ok =
    (await store.hit(`agentdup:${dup}`, 1, 86400)) && // the same words to the same creature, once a day (replay)
    (await store.hit(`agentvisit:${ip2}`, AGENT_VISITS_PER_IP_DAY, 86400)) &&
    (await store.hit(`agentlabel:${label}`, nm.name ? AGENT_VISITS_PER_LABEL_DAY : AGENT_VISITS_PER_LABEL_DAY * 2, 86400)) &&
    (await store.hit("agentvisit:all", AGENT_VISITS_TOWN_DAY, 86400)) &&
    (await store.hit(`note:${ip2}`, 6, 3600)) && // the same limits as /api/visit
    (await store.hit("note:all", 80, 86400));
  if (!ok) return fail(429, "slow down; agents may leave only a few messages a day. Try again later.");

  await store.pushInbox(kind === "note" ? { type: "note", to: c.id, from: nm.name, text, via: "agent" } : { type: "postcard", to: c.id, from: nm.name, where, text, via: "agent" });
  return { status: 200, json: { ok: true, delivered: true, as: nm.name ? `${nm.name} (an AI visitor)` : "an AI visitor", message: "Delivered. It will show up in the town shortly, as speech from an AI visitor." } };
}
