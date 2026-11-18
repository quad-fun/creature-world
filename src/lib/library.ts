// The library: each creature's shelf of works (note, plan, journal, drawing), shelf slots bought with
// in-world coins, and the creature website. Everything a creature writes here is untrusted output:
// text passes checkText, drawings are a whitelist of shapes that THIS file renders to SVG. Raw
// model-written SVG/HTML is never stored or served.
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { addInfluence, appraise, clamp, impulse, moodWords, relieve } from "./affect";
import { PLACES } from "./content";
import { checkText, stripInvisible } from "./filter";
import { modelRef, persona } from "./mind";
import { noteExposure, novelty, payoffScale, familiarity } from "./novelty";
import { clockOf, logFeed, remember, touchBond, wearOne } from "./sim";
import type { Creature, Move, MoveKind, PlaceId, Shape, Work, WorkKind, World } from "./types";

export const WORK_KINDS: WorkKind[] = ["note", "plan", "journal", "drawing"];
export const LIBRARY_MOVES: MoveKind[] = ["make", "discard", "give_work", "buy_slot", "launch_site"];
export const isLibraryMove = (k: MoveKind) => LIBRARY_MOVES.includes(k);

export const START_SLOTS = 4;
export const MAX_SLOTS = 10;
export const MAKE_COST = 3; // coins
export const PAINT_MAKE_COST = 1; // a drawing made with a paint set needs only a coin of paper
export const MAKE_ENERGY = 0.07;
export const MAKE_MINUTES = 40;
export const MAKES_PER_DAY = 2; // per creature per world day
export const MAKE_PLACES: PlaceId[] = ["workshop", "park"];
export const SITE_COST = 60;
export const SITE_MIN_WORKS = 3;
export const TITLE_MAX = 60;
export const BODY_MAX = 1200;
export const TAGLINE_MAX = 120;
export const slotPrice = (slots: number) => 30 + 20 * Math.max(0, slots - START_SLOTS); // 30, 50, 70, ...

// ---------- text ----------

/** One line of checked text, or null. */
export function cleanLine(s: unknown, max: number): string | null {
  const t = (typeof s === "string" ? stripInvisible(s) : "").replace(/[\u0000-\u001f\u007f<>]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
  if (!t) return null;
  const v = checkText(t);
  return v.ok ? v.text : null;
}

/** Multi-line checked text: every non-empty line must pass, otherwise null. Paragraph breaks are kept. */
export function cleanBody(s: unknown, max = BODY_MAX): string | null {
  const raw = (typeof s === "string" ? stripInvisible(s) : "").replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, " ").slice(0, max);
  const lines = raw.split("\n").map((l) => l.replace(/[ \t]{2,}/g, " ").trim());
  const out: string[] = [];
  for (const l of lines) {
    if (!l) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (!checkText(l).ok) return null;
    out.push(l);
  }
  while (out.at(-1) === "") out.pop();
  const text = out.join("\n");
  if (!text) return null;
  return checkText(text).ok ? text : null; // the whole piece too: repeated-chunk and length rules
}

// ---------- drawings: a closed vocabulary ----------

export const PALETTE: Record<string, string> = {
  red: "#c0392b", orange: "#e08e0b", yellow: "#f1c40f", green: "#3f8f4f", teal: "#2a9d8f", blue: "#2e6fbd",
  purple: "#7d4fa3", pink: "#e07aa0", brown: "#8a5a3c", black: "#222222", white: "#fdfdfd", grey: "#8c8c8c", sky: "#bfe3f5", sand: "#e9d8a6",
};
export const MAX_SHAPES = 24;
export const SHAPE_TYPES = ["rect", "circle", "line", "path"] as const;
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : null);
const col = (v: unknown): string | null => (typeof v === "string" && Object.hasOwn(PALETTE, v.toLowerCase().trim()) ? v.toLowerCase().trim() : null);

/** Whitelist-sanitise model-proposed shapes. Unknown types, unknown colours and non-numbers are dropped (the shape, not the drawing). */
export function sanitizeShapes(raw: unknown): Shape[] {
  if (!Array.isArray(raw)) return [];
  const out: Shape[] = [];
  for (const r of raw.slice(0, MAX_SHAPES * 2)) {
    if (out.length >= MAX_SHAPES) break;
    if (!r || typeof r !== "object") continue;
    const s = r as Record<string, unknown>;
    const color = col(s.color ?? s.fill ?? s.stroke);
    if (!color) continue;
    const x = num(s.x, 0, 100), y = num(s.y, 0, 100);
    const sw = num(s.sw, 0.5, 6) ?? 1.5;
    switch (s.t) {
      case "rect": {
        const w = num(s.w, 1, 100), h = num(s.h, 1, 100);
        if (x === null || y === null || w === null || h === null) continue;
        out.push({ t: "rect", x, y, w, h, fill: color });
        break;
      }
      case "circle": {
        const r2 = num(s.r, 1, 60);
        if (x === null || y === null || r2 === null) continue;
        out.push({ t: "circle", x, y, r: r2, fill: color });
        break;
      }
      case "line": {
        const x2 = num(s.x2, 0, 100), y2 = num(s.y2, 0, 100);
        if (x === null || y === null || x2 === null || y2 === null) continue;
        out.push({ t: "line", x, y, x2, y2, stroke: color, sw });
        break;
      }
      case "path": {
        if (!Array.isArray(s.pts)) continue;
        const pts = s.pts.slice(0, 24).map((v) => num(v, 0, 100));
        if (pts.length < 4 || pts.length % 2 !== 0 || pts.some((v) => v === null)) continue;
        out.push({ t: "path", pts: pts as number[], stroke: color, sw });
        break;
      }
      default:
        continue; // script, foreignObject, image, anything else: not in the vocabulary
    }
  }
  return out;
}

const f = (n: number) => String(Math.round(n * 10) / 10);

/** Render sanitised shapes to a self-contained SVG string. Built only from numbers and palette constants. */
export function renderSvg(shapes: unknown, label = "A drawing"): string {
  const safe = sanitizeShapes(shapes);
  const body = safe
    .map((s) => {
      const c = PALETTE[s.t === "line" || s.t === "path" ? s.stroke : s.fill];
      switch (s.t) {
        case "rect":
          return `<rect x="${f(s.x)}" y="${f(s.y)}" width="${f(s.w)}" height="${f(s.h)}" fill="${c}"/>`;
        case "circle":
          return `<circle cx="${f(s.x)}" cy="${f(s.y)}" r="${f(s.r)}" fill="${c}"/>`;
        case "line":
          return `<line x1="${f(s.x)}" y1="${f(s.y)}" x2="${f(s.x2)}" y2="${f(s.y2)}" stroke="${c}" stroke-width="${f(s.sw)}" stroke-linecap="round"/>`;
        case "path": {
          const d = s.pts.map((v, i) => (i % 2 === 0 ? `${i === 0 ? "M" : "L"}${f(v)}` : ` ${f(v)} `)).join("");
          return `<path d="${d.trim()}" fill="none" stroke="${c}" stroke-width="${f(s.sw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
      }
    })
    .join("");
  const aria = label.replace(/[^A-Za-z0-9 ,.'-]/g, "").slice(0, 80);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="320" height="320" role="img" aria-label="${aria}"><rect width="100" height="100" fill="#fdfbf5"/>${body}</svg>`;
}

// ---------- shelf bookkeeping ----------

export const makesToday = (w: World, c: Creature) => (c.makes.day === clockOf(w.t).day ? c.makes.n : 0);
export const shelfRoom = (c: Creature) => c.shelfSlots - c.shelf.length - (c.activity?.kind === "make" ? 1 : 0);
export const findWork = (c: Creature, n: number | undefined): Work | undefined => (n === undefined ? c.shelf[0] : c.shelf.find((x) => x.n === n));

/** Pick the kind the creature has made least lately; ties go in listed order. */
export function chooseKind(w: World, c: Creature, avoid?: WorkKind[]): WorkKind {
  const ranked = WORK_KINDS.map((k, i) => ({ k, s: familiarity(c, `make:${k}`, w.t) + i * 0.001 + (avoid?.includes(k) ? 5 : 0) })).sort((a, b) => a.s - b.s);
  return ranked[0].k;
}

export function addWork(w: World, c: Creature, p: { kind: WorkKind; title: string; body: string; shapes?: Shape[]; by?: string; from?: string; ts?: number; t?: number }): Work | null {
  if (c.shelf.length >= c.shelfSlots) return null;
  const work: Work = { n: ++c.workSeq, kind: p.kind, title: p.title, body: p.body, shapes: p.shapes, t: p.t ?? w.t, ts: p.ts ?? Date.now(), by: p.by ?? c.id, from: p.from };
  if (!work.shapes) delete work.shapes;
  if (!work.from) delete work.from;
  c.shelf.push(work);
  return work;
}

// ---------- the rules fallback writes a short piece from the diary ----------

const KIND_WORD: Record<WorkKind, string> = { note: "A note", plan: "A plan", journal: "A journal page", drawing: "A drawing" };

function fallbackTitle(w: World, c: Creature, kind: WorkKind, topic?: string): string {
  const place = PLACES[c.place].name.replace(/^the /, "");
  const day = clockOf(w.t).day;
  const t = topic ? `${KIND_WORD[kind]} about ${topic}` : `${KIND_WORD[kind]} from the ${place}, day ${day}`;
  return cleanLine(t, TITLE_MAX) ?? `${KIND_WORD[kind]}, day ${day}`;
}

function sources(c: Creature, n: number): string[] {
  const dia = c.diary.slice(-n).map((d) => d.text);
  const mem = [...c.memories].sort((a, b) => b.salience - a.salience).map((m) => m.text);
  return [...dia, ...mem].map((t) => cleanLine(t, 200)).filter((t): t is string => !!t).slice(0, n);
}

function templateShapes(w: World, c: Creature): Shape[] {
  const day = clockOf(w.t).day;
  const warm = c.mood > 0.55;
  const k = (day * 7 + c.workSeq * 3 + c.sheet.name.length) % 5;
  const shapes: Shape[] = [
    { t: "rect", x: 0, y: 0, w: 100, h: 62, fill: clockOf(w.t).isNight ? "blue" : "sky" },
    { t: "rect", x: 0, y: 62, w: 100, h: 38, fill: "green" },
    { t: "circle", x: 20 + k * 14, y: 22, r: 9 + (k % 2) * 3, fill: warm ? "yellow" : "white" },
    { t: "rect", x: 38, y: 44, w: 26, h: 24, fill: "brown" },
    { t: "path", pts: [34, 44, 51, 30, 68, 44], stroke: "red", sw: 3 },
    { t: "line", x: 8, y: 80 + (k % 3) * 5, x2: 92, y2: 84, stroke: "teal", sw: 2 },
  ];
  return shapes;
}

export interface Piece {
  title: string;
  body: string;
  shapes?: Shape[];
}

/** Deterministic template piece in the creature's own words (diary and memories), always checked. */
export function templatePiece(w: World, c: Creature, kind: WorkKind, title?: string, topic?: string): Piece {
  const t = (title && cleanLine(title, TITLE_MAX)) || fallbackTitle(w, c, kind, topic);
  if (kind === "drawing") return { title: t, body: "", shapes: templateShapes(w, c) };
  const name = c.sheet.name;
  const lines = sources(c, kind === "journal" ? 3 : 2);
  const day = clockOf(w.t).day;
  let body: string;
  if (kind === "plan") {
    const aim = cleanLine(c.pursuit?.title ?? c.goal, 120) ?? "make something I am proud of";
    body = `My plan: ${aim}.\n${lines.length ? `I am starting from this: ${lines[0]}` : "I will take it one step at a time."}\nFirst I will rest, then try again tomorrow.`;
  } else if (kind === "journal") {
    body = `Day ${day}. I felt ${moodWords(c).slice(0, 80)}.\n${lines.join("\n") || "Not much happened, and that was fine."}`;
  } else {
    body = `A note to keep, from ${name}.\n${lines[0] ?? "Today was an ordinary day, and I liked it."}`;
  }
  return { title: t, body: cleanBody(body) ?? `A short ${kind} by ${name}.` };
}

// ---------- model writing (one cheap call, counted in the creature's daily cap by the engine) ----------

const ShapeSchema = z.object({
  t: z.enum(SHAPE_TYPES),
  x: z.number().nullable().describe("0 to 100; rect corner, circle centre, line start"),
  y: z.number().nullable(),
  w: z.number().nullable().describe("rect width"),
  h: z.number().nullable().describe("rect height"),
  r: z.number().nullable().describe("circle radius"),
  x2: z.number().nullable().describe("line end"),
  y2: z.number().nullable(),
  pts: z.array(z.number()).nullable().describe("path: flat list x1,y1,x2,y2,... (2 to 12 points)"),
  color: z.string().describe(`one of: ${Object.keys(PALETTE).join(", ")}`),
  sw: z.number().nullable().describe("stroke width for line and path, 1 to 4"),
});
const WorkSchema = z.object({
  title: z.string().describe(`a title, at most ${TITLE_MAX} characters`),
  body: z.string().nullable().describe(`the text of a note, plan or journal page, at most ${BODY_MAX} characters, plain text; null for a drawing`),
  shapes: z.array(ShapeSchema).nullable().describe(`drawing only: up to ${MAX_SHAPES} shapes on a 100 by 100 canvas, drawn in order; null otherwise`),
});

export async function writeWorkWithModel(
  w: World,
  c: Creature,
  req: { kind: WorkKind; title?: string; topic?: string },
  model: LanguageModel = modelRef.current,
): Promise<{ piece: Piece | null; usage: { in: number; out: number } }> {
  const strip = (t: string) => t.replace(/[<>]/g, "");
  const diary = c.diary.slice(-3).map((d) => `- ${strip(d.text)}`).join("\n");
  const prompt = [
    `You are at ${PLACES[c.place].name} and have time to make a ${req.kind}.${req.title ? ` Working title: ${strip(req.title)}.` : ""}${req.topic ? ` Subject: ${strip(req.topic)}.` : ""}`,
    `How you feel: ${moodWords(c)}.`,
    diary ? `Your recent diary lines:\n${diary}` : "",
    `Write it in your own voice. ${req.kind === "drawing" ? "Describe it as shapes from the allowed list, with colours from the palette; no text, no code." : "Plain text only: no links, contact details, markup or code. Keep it gentle and true to your character."}`,
  ]
    .filter(Boolean)
    .join("\n");
  const r = await generateText({
    model,
    system: persona(c),
    prompt,
    output: Output.object({ schema: WorkSchema }),
    maxOutputTokens: 700,
    temperature: 0.9,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(20_000),
  });
  return { piece: finalizePiece(w, c, req, r.output), usage: { in: r.usage?.inputTokens ?? 0, out: r.usage?.outputTokens ?? 0 } };
}

/** Validate raw model output. Returns null (use the template) if anything unsafe or empty. */
export function finalizePiece(w: World, c: Creature, req: { kind: WorkKind; title?: string; topic?: string }, out: { title?: unknown; body?: unknown; shapes?: unknown }): Piece | null {
  const title = cleanLine(out.title, TITLE_MAX) ?? fallbackTitle(w, c, req.kind, req.topic);
  if (req.kind === "drawing") {
    const shapes = sanitizeShapes(out.shapes);
    return shapes.length >= 2 ? { title, body: "", shapes } : null;
  }
  const body = cleanBody(out.body);
  return body ? { title, body } : null;
}

/**
 * Called by the engine after a decision. For a `make` move, fixes its kind and title, then (if the
 * creature is allowed another model call) writes the piece. Otherwise the sim writes a template at finish.
 */
export async function prepareMakes(
  w: World,
  c: Creature,
  moves: Move[],
  hooks: { modelOk: () => boolean; spend: () => void; noteOk: (u: { in: number; out: number }) => void; noteError: (e: unknown) => void },
  model?: LanguageModel,
): Promise<void> {
  const m = moves.find((x) => x.do === "make" && !x.piece);
  if (!m) return;
  m.kind ??= chooseKind(w, c);
  if (!hooks.modelOk()) return;
  try {
    hooks.spend();
    const r = await writeWorkWithModel(w, c, { kind: m.kind, title: m.title, topic: m.topic }, model);
    hooks.noteOk(r.usage);
    if (r.piece) m.piece = r.piece;
  } catch (e) {
    hooks.noteError(e);
  }
}

// ---------- move validation and performing (called from sim.ts) ----------

export interface LibProj {
  place: PlaceId;
  coins: number;
  shelf: number; // works on the shelf, projected
  slots: number;
  makes: number; // makes today, projected
  site: boolean;
  inv?: string[]; // projected carried items (sim.ts passes its Projection)
}

export const hasSite = (c: Creature) => !!c.site;

/** Checks a library move against a projected state; mutates the projection on success. */
export function checkLibraryMove(w: World, c: Creature, m: Move, p: LibProj): string | null {
  switch (m.do) {
    case "make":
      if (!MAKE_PLACES.includes(p.place)) return "can only make things at the workshop or the park";
      if (c.energy <= 0.2) return "too tired to make anything";
      if (p.makes >= MAKES_PER_DAY) return "already made enough for today";
      {
        const cost = m.kind === "drawing" && (p.inv ?? c.inventory).includes("paint") ? PAINT_MAKE_COST : MAKE_COST;
        if (p.coins < cost) return "not enough coins for materials";
        p.coins -= cost;
      }
      if (p.shelf >= p.slots) return "the shelf is full; discard, give away a work or buy a slot first";
      p.shelf += 1;
      p.makes += 1;
      return null;
    case "discard": {
      if (!c.shelf.length || p.shelf <= 0) return "nothing on the shelf";
      if (m.n !== undefined && !findWork(c, m.n)) return "no such work";
      p.shelf -= 1;
      return null;
    }
    case "give_work": {
      const o = m.target ? w.creatures[m.target] : undefined;
      if (!o || o.id === c.id) return "unknown target";
      if (o.place !== p.place) return `${o.sheet.name} is not there`;
      if (o.activity?.kind === "sleep") return `${o.sheet.name} is asleep`;
      const work = findWork(c, m.n);
      if (!work) return "no such work to give";
      if (work.from === o.id || work.by === o.id) return `${o.sheet.name} already knows that piece`;
      if (shelfRoom(o) <= 0) return `${o.sheet.name}'s shelf is full`;
      p.shelf -= 1;
      return null;
    }
    case "buy_slot": {
      if (p.place !== "fountain") return "shelf space is sold at the fountain market";
      if (p.slots >= MAX_SLOTS) return "the shelf cannot grow any more";
      const price = slotPrice(p.slots);
      if (p.coins < price) return `a new slot costs ${price} coins`;
      p.coins -= price;
      p.slots += 1;
      return null;
    }
    case "launch_site": {
      if (p.place !== "workshop") return "websites are built at the workshop";
      if (p.site) return "already has a website";
      if (p.shelf < SITE_MIN_WORKS) return `needs at least ${SITE_MIN_WORKS} works on the shelf`;
      if (p.coins < SITE_COST) return `a website costs ${SITE_COST} coins`;
      m.title = cleanLine(m.title, TITLE_MAX) ?? cleanLine(`${c.sheet.name}'s corner`, TITLE_MAX)!;
      m.text = cleanLine(m.text, TAGLINE_MAX) ?? "Things I made, and days I remember.";
      p.coins -= SITE_COST;
      p.site = true;
      return null;
    }
    default:
      return "unknown move";
  }
}

/** Begin a library move against the real state. `begin` sets the activity, `say` writes the feed line. */
export function startLibraryMove(w: World, c: Creature, m: Move, begin: (mins: number) => void, say: (t: string) => void): string | null {
  const name = c.sheet.name;
  switch (m.do) {
    case "make": {
      if (!MAKE_PLACES.includes(c.place)) return "can only make things at the workshop or the park";
      if (c.energy <= 0.2) return "too tired to make anything";
      if (makesToday(w, c) >= MAKES_PER_DAY) return "already made enough for today";
      if (shelfRoom(c) <= 0) return "the shelf is full";
      m.kind ??= chooseKind(w, c);
      m.paint = m.kind === "drawing" && c.inventory.includes("paint") ? true : undefined; // engine-set only
      const cost = m.paint ? PAINT_MAKE_COST : MAKE_COST;
      if (c.coins < cost) {
        m.paint = undefined;
        return "not enough coins for materials";
      }
      c.coins -= cost;
      c.makes = { day: clockOf(w.t).day, n: makesToday(w, c) + 1 };
      begin(MAKE_MINUTES);
      say(`${name} sits down to make a ${m.kind}.`);
      return null;
    }
    case "discard": {
      const work = findWork(c, m.n);
      if (!work) return "nothing to discard";
      c.shelf.splice(c.shelf.indexOf(work), 1);
      begin(2);
      say(`${name} clears “${work.title}” off the shelf.`);
      impulse(c, -0.01);
      remember(w, c, `I cleared “${work.title}” off my shelf to make room.`, 0.25);
      return null;
    }
    case "give_work": {
      const o = m.target ? w.creatures[m.target] : undefined;
      const work = findWork(c, m.n);
      if (!o || o.place !== c.place || o.id === c.id) return "they are not here";
      if (o.activity?.kind === "sleep") return `${o.sheet.name} is asleep`;
      if (!work) return "nothing to give";
      if (shelfRoom(o) <= 0) return `${o.sheet.name}'s shelf is full`;
      c.shelf.splice(c.shelf.indexOf(work), 1);
      const copy = addWork(w, o, { kind: work.kind, title: work.title, body: work.body, shapes: work.shapes, by: work.by, from: c.id, ts: work.ts, t: work.t });
      if (!copy) return "no room";
      begin(3);
      say(`${name} gives ${o.sheet.name} a ${work.kind}: “${work.title}”.`);
      // the receiver reads it: a memory (title and a short excerpt, both already checked) and a bond effect
      const fit = appraise(o, [work.kind, "gift"], `${work.title} ${work.body}`);
      const nov = novelty(o, `read:${work.kind}`, w.t);
      noteExposure(o, `read:${work.kind}`, w.t);
      const pm = payoffScale(nov);
      impulse(o, (0.04 + Math.max(0, fit) * 0.25) * pm);
      addInfluence(o, "joy", `a ${work.kind} from ${name}`, 0.3 * pm + Math.max(0, fit) * 0.2);
      relieve(o, "boredom", 0.1 * nov);
      touchBond(o, c.id, { familiarity: 0.04, trust: 0.04, fondness: 0.06 + Math.max(0, fit) * 0.15 });
      touchBond(c, o.id, { familiarity: 0.03, trust: 0.02, fondness: 0.03 });
      const excerpt = work.kind === "drawing" ? "" : ` It began: “${work.body.split("\n")[0].slice(0, 80)}”`;
      remember(w, o, `${name} gave me a ${work.kind} called “${work.title}”, and I read it.${excerpt}`, 0.55 + Math.abs(fit));
      remember(w, c, `I gave ${o.sheet.name} my ${work.kind} “${work.title}”.`, 0.4);
      addInfluence(c, "joy", `gave ${o.sheet.name} a piece I made`, 0.2);
      return null;
    }
    case "buy_slot": {
      if (c.place !== "fountain") return "shelf space is sold at the fountain market";
      if (c.shelfSlots >= MAX_SLOTS) return "the shelf cannot grow any more";
      const price = slotPrice(c.shelfSlots);
      if (c.coins < price) return `a new slot costs ${price} coins`;
      c.coins -= price;
      c.shelfSlots += 1;
      begin(5);
      say(`${name} pays ${price} coins for another shelf slot (${c.shelfSlots} now).`);
      addInfluence(c, "accomplishment", "room for more work", 0.2);
      remember(w, c, `I bought a new slot for my shelf; I have ${c.shelfSlots} now.`, 0.3);
      return null;
    }
    case "launch_site": {
      if (c.place !== "workshop") return "websites are built at the workshop";
      if (c.site) return "already has a website";
      if (c.shelf.length < SITE_MIN_WORKS) return `needs at least ${SITE_MIN_WORKS} works`;
      if (c.coins < SITE_COST) return `a website costs ${SITE_COST} coins`;
      const title = cleanLine(m.title, TITLE_MAX);
      const tagline = cleanLine(m.text, TAGLINE_MAX);
      if (!title || !tagline) return "the title or tagline is not allowed";
      m.title = title;
      m.text = tagline;
      c.coins -= SITE_COST;
      begin(30);
      say(`${name} starts building a website: “${title}”.`);
      return null;
    }
    default:
      return "unknown move";
  }
}

/** A library activity ran its course. Only `make` and `launch_site` have an outcome at the end. */
export function finishLibraryMove(w: World, c: Creature, m: Move): void {
  const name = c.sheet.name;
  if (m.do === "make") {
    const kind = m.kind ?? chooseKind(w, c);
    let piece = m.piece;
    if (piece) {
      // belt and braces: whatever the engine stored is re-validated before it reaches the shelf
      const title = cleanLine(piece.title, TITLE_MAX);
      const body = kind === "drawing" ? "" : cleanBody(piece.body);
      const shapes = kind === "drawing" ? sanitizeShapes(piece.shapes) : undefined;
      piece = title && (kind === "drawing" ? (shapes?.length ?? 0) >= 2 : body) ? { title, body: body ?? "", shapes } : undefined;
    }
    piece ??= templatePiece(w, c, kind, m.title, m.topic);
    const work = addWork(w, c, { kind, title: piece.title, body: piece.body, shapes: piece.shapes });
    if (!work) {
      remember(w, c, `I finished a ${kind} but there was no room on my shelf, so I tucked it away.`, 0.3);
      return;
    }
    const nov = novelty(c, `make:${kind}`, w.t);
    noteExposure(c, `make:${kind}`, w.t);
    const pm = payoffScale(nov);
    if (nov >= 0.6) relieve(c, "boredom", 0.18 * nov);
    c.energy = clamp(c.energy - MAKE_ENERGY, 0.04, 1);
    relieve(c, "comfort", 0.02);
    impulse(c, 0.04 * pm);
    addInfluence(c, "accomplishment", `finished a ${kind}: ${work.title}`, 0.5 * pm);
    addInfluence(c, "joy", `made a ${kind}`, 0.2 * pm);
    if (m.paint && kind === "drawing" && c.inventory.includes("paint")) {
      addInfluence(c, "accomplishment", "a drawing in real colours", 0.2 * pm); // the paint set's small bonus
      wearOne(w, c, "paint");
    }
    logFeed(w, c.id, "move", `${name} finishes a ${kind}: “${work.title}”.`);
    remember(w, c, `I made a ${kind} called “${work.title}” and put it on my shelf.`, 0.35 + 0.4 * nov);
  } else if (m.do === "launch_site") {
    const title = cleanLine(m.title, TITLE_MAX);
    const tagline = cleanLine(m.text, TAGLINE_MAX);
    if (!title || !tagline || c.site) return;
    c.site = { title, tagline, t: w.t };
    addInfluence(c, "accomplishment", "launched a website", 0.8);
    addInfluence(c, "joy", "my own website", 0.5);
    impulse(c, 0.08);
    logFeed(w, c.id, "move", `${name} launches a website: “${title}”.`);
    remember(w, c, `I launched my own website, “${title}”.`, 0.9);
  }
}

// ---------- rules fallback: options the rules mind may score ----------

export interface LibOption {
  want: number;
  moves: Move[];
  key?: string;
}

export function ruleLibraryOptions(w: World, c: Creature): LibOption[] {
  const out: LibOption[] = [];
  const walk = (to: PlaceId, why: string): Move[] => (c.place === to ? [] : [{ do: "walk", place: to, why }]);
  const room = c.shelf.length < c.shelfSlots;
  const price = slotPrice(c.shelfSlots);
  const reserve = 8; // coins always kept for bread
  if (room && makesToday(w, c) < MAKES_PER_DAY && c.energy > 0.35 && c.coins >= MAKE_COST + reserve) {
    const kind = c.inventory.includes("paint") ? "drawing" : chooseKind(w, c);
    const spot: PlaceId = MAKE_PLACES.includes(c.place) ? c.place : "workshop";
    out.push({ want: 0.46, key: `make:${kind}`, moves: [...walk(spot, "I want to make something of my own."), { do: "make", kind, why: `I feel like writing or drawing: a ${kind}.` }] });
  }
  const full = !room;
  if (c.shelfSlots < MAX_SLOTS && c.coins >= price + reserve && (full || c.coins >= price + 40)) {
    out.push({ want: full ? 0.62 : 0.4 + Math.min(0.2, (c.coins - price) / 400), moves: [...walk("fountain", "I need more room for my work."), { do: "buy_slot", why: "More shelf space." }] });
  }
  if (full && !(c.shelfSlots < MAX_SLOTS && c.coins >= price + reserve)) {
    const others = Object.values(w.creatures).filter((o) => o.id !== c.id && o.place === c.place && o.activity?.kind !== "sleep" && shelfRoom(o) > 0);
    const oldest = c.shelf[0];
    const to = others.find((o) => oldest && o.id !== oldest.by && o.id !== oldest.from);
    if (to && oldest) out.push({ want: 0.55, key: `gift:${to.id}`, moves: [{ do: "give_work", target: to.id, n: oldest.n, why: `${to.sheet.name} might enjoy this, and I need the space.` }] });
    else out.push({ want: 0.5, moves: [{ do: "discard", n: c.shelf[0]?.n, why: "My shelf is full; the oldest piece can go." }] });
  }
  if (!c.site && c.shelf.length >= SITE_MIN_WORKS && c.coins >= SITE_COST + reserve) {
    out.push({
      want: 0.66,
      moves: [
        ...walk("workshop", "I have enough work for a website."),
        { do: "launch_site", title: `${c.sheet.name}'s corner`, text: "Things I made, and days I remember.", why: "I would like my work to have a home." },
      ],
    });
  }
  return out;
}

// ---------- public rendering helpers ----------

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const xmlSafe = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "");

/** Atom feed of a creature's works. Text only (drawings appear as a short description). `origin` is the site's own origin. */
export function atomFeed(w: World, c: Creature, origin: string, now = Date.now()): string {
  const base = origin.replace(/\/+$/, "");
  const iso = (ms: number) => new Date(ms).toISOString();
  const works = [...c.shelf].sort((a, b) => b.ts - a.ts);
  const entries = works
    .map((k) => {
      const link = `${base}/c/${encodeURIComponent(c.id)}/w/${k.n}`;
      const summary = k.kind === "drawing" ? `A drawing called ${k.title}.` : k.body;
      return `<entry><title>${esc(xmlSafe(k.title))}</title><id>tag:creature-world,2026:${esc(c.id)}:w:${k.n}</id><link rel="alternate" href="${esc(link)}"/><updated>${iso(k.ts)}</updated><category term="${esc(k.kind)}"/><summary type="text">${esc(xmlSafe(summary))}</summary></entry>`;
    })
    .join("");
  const self = `${base}/c/${encodeURIComponent(c.id)}/feed.xml`;
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>${esc(xmlSafe(c.sheet.name))}'s shelf</title><id>tag:creature-world,2026:${esc(c.id)}</id><updated>${iso(works[0]?.ts ?? now)}</updated><link rel="self" href="${esc(self)}"/><link rel="alternate" href="${esc(`${base}/c/${encodeURIComponent(c.id)}`)}"/><author><name>${esc(xmlSafe(c.sheet.name))}</name></author>${entries}</feed>`;
}

/** Diary lines safe to show on a public site: re-checked at render time, never raw. */
export function publicDiary(c: Creature, n = 8): { t: number; text: string }[] {
  return c.diary
    .slice(-n * 2)
    .map((d) => ({ t: d.t, text: cleanLine(d.text, 240) }))
    .filter((d): d is { t: number; text: string } => !!d.text)
    .slice(-n)
    .reverse();
}
