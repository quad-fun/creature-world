// Books: a small curated shelf of public-domain titles. Summaries are original, written for this project (no
// copied text, no quotes). The model never browses and nothing is fetched. A creature reads a book from this fixed
// list; the only effects are an interest nudge per tag, a little boredom relief and a memory (which the existing
// reflection turns into a diary line, with no extra model call). A creature may also ASK for a title: that goes into
// a small queue only a human can act on (ADMIN_SECRET), is never fetched, and adding a book means editing this file.
import { addInfluence, appraise, relieve } from "./affect";
import { checkText } from "./filter";
import { exposeInterest, familiarity, interestStrength, noteExposure, novelty, payoffScale, TOPICS } from "./novelty";
import { clockOf, logFeed, remember } from "./sim";
import type { BookRequest, Creature, Move, World } from "./types";

export interface Book {
  id: string;
  title: string;
  author: string;
  summary: string; // about 300 characters, original wording
  tags: string[]; // topics from novelty.ts TOPICS (max 2)
}

export const BOOKS: Book[] = [
  { id: "willows", title: "The Wind in the Willows", author: "Kenneth Grahame", summary: "A riverbank tale of a mole, a water rat, a vain toad and a badger. It is about messing about in boats, loyal friends, reckless hobbies and the comfort of a snug burrow after an adventure.", tags: ["mud and water", "wandering"] },
  { id: "aesop", title: "Aesop's Fables", author: "Aesop", summary: "Very short animal stories, each ending in a plain lesson: the proud hare, the patient tortoise, the crow with pebbles. Easy to read in one sitting and easy to argue about afterwards.", tags: ["gossip", "wandering"] },
  { id: "alice", title: "Alice's Adventures in Wonderland", author: "Lewis Carroll", summary: "A girl follows a hurried rabbit down a hole and meets odd creatures who love riddles and rules that make no sense. A book for anyone who enjoys a good question more than a good answer.", tags: ["wandering", "gossip"] },
  { id: "garden", title: "The Secret Garden", author: "Frances Hodgson Burnett", summary: "A lonely child finds a locked, neglected garden and slowly brings it back to life with a robin, a helpful gardener and a stubborn cousin. Digging, patience and fresh air mend more than anyone expected.", tags: ["herbs", "mending"] },
  { id: "walden", title: "Walden", author: "Henry David Thoreau", summary: "A man builds a small cabin beside a pond and spends two years watching the seasons, the ice and the loons. It asks how little a person really needs and what is worth noticing.", tags: ["mud and water", "mending"] },
  { id: "crusoe", title: "Robinson Crusoe", author: "Daniel Defoe", summary: "A sailor is shipwrecked on an island and must make everything himself: shelter, tools, bread and a calendar. A long story about making do, keeping a list and not giving up.", tags: ["mending", "wandering"] },
  { id: "treasure", title: "Treasure Island", author: "Robert Louis Stevenson", summary: "A boy finds a map in a sailor's chest and sets out with a ship's crew to dig up buried treasure. There are glinting coins, a clever cook with a secret and a great deal of sneaking about.", tags: ["shiny things", "wandering"] },
  { id: "nights", title: "Tales from the Arabian Nights", author: "Traditional", summary: "A storyteller spins one tale after another to stay clever and alive: lamps, thieves, flying carpets and bargains in busy markets. Stories nest inside stories like boxes inside boxes.", tags: ["shiny things", "gossip"] },
];
export const MAX_BOOKS = BOOKS.length;
export const BOOKS_PER_DAY = 2; // per creature per world day
export const BOOK_ENERGY = 0.04;
export const BOOK_MINUTES = 30;
export const BOOK_MIN_ENERGY = 0.2;
export const MAX_BOOKS_REMEMBERED = 12;

export const bookById = (id: unknown): Book | undefined => (typeof id === "string" ? BOOKS.find((b) => b.id === id) : undefined);
/** Match a model-supplied string (id or title) to a book. Own list only, so "__proto__" etc. never resolve. */
export function matchBook(s: unknown): Book | undefined {
  if (typeof s !== "string") return undefined;
  const x = s.toLowerCase().trim();
  if (!x) return undefined;
  return BOOKS.find((b) => b.id === x || b.title.toLowerCase() === x);
}
export const bookTags = (b: Book) => b.tags.filter((t) => (TOPICS as readonly string[]).includes(t));

export const readsToday = (w: World, c: Creature): number => (c.reads.day === clockOf(w.t).day ? c.reads.n : 0);

export function checkReadMove(w: World, c: Creature, m: Move): string | null {
  const b = matchBook(m.book);
  if (!b) return "no such book on the town shelf";
  m.book = b.id;
  if (c.energy < BOOK_MIN_ENERGY) return "too tired to read";
  if (readsToday(w, c) >= BOOKS_PER_DAY) return "already read enough today";
  return null;
}

export function startReadMove(w: World, c: Creature, m: Move, begin: (mins: number) => void, say: (t: string) => void): string | null {
  const err = checkReadMove(w, c, m);
  if (err) return err;
  const b = bookById(m.book)!;
  const day = clockOf(w.t).day;
  c.reads = { day, n: readsToday(w, c) + 1 };
  c.energy = Math.max(0.04, c.energy - BOOK_ENERGY);
  begin(BOOK_MINUTES);
  say(`${c.sheet.name} settles down with ${b.title}.`);
  return null;
}

export function finishReadMove(w: World, c: Creature, m: Move): void {
  const b = bookById(m.book);
  if (!b) return;
  const nov = novelty(c, `book:${b.id}`, w.t);
  const pm = payoffScale(nov);
  noteExposure(c, `book:${b.id}`, w.t);
  relieve(c, "boredom", 0.15 * nov);
  const fit = appraise(c, bookTags(b), `${b.title} ${b.summary}`);
  addInfluence(c, "joy", `reading ${b.title}`, 0.12 * pm + Math.max(0, fit) * 0.2);
  for (const tag of bookTags(b)) exposeInterest(c, tag, w.t, 0.06 * pm); // small, bounded, habituating
  c.booksRead = [...c.booksRead.filter((x) => x !== b.id), b.id].slice(-MAX_BOOKS_REMEMBERED);
  remember(w, c, `I read ${b.title} by ${b.author}. ${b.summary.split(". ")[0].replace(/\.$/, "")}.`, 0.55 + Math.max(0, fit) * 0.3);
  logFeed(w, c.id, "move", `${c.sheet.name} finishes reading ${b.title}.`);
}

/** Rules mind: pick the book that is freshest and fits the creature's interests best. */
export function ruleReadOption(w: World, c: Creature): { want: number; moves: Move[]; key: string } | null {
  if (c.energy < 0.35 || readsToday(w, c) >= BOOKS_PER_DAY) return null;
  const scored = BOOKS.map((b) => ({ b, s: bookTags(b).reduce((a, t) => a + interestStrength(c, t), 0) - 0.3 * familiarity(c, `book:${b.id}`, w.t) }));
  scored.sort((a, b) => b.s - a.s);
  const b = scored[0].b;
  return { want: 0.22 + 0.2 * scored[0].s, moves: [{ do: "read_book", book: b.id, why: `I feel like reading ${b.title}.` }], key: `book:${b.id}` };
}

// ---------- the request queue ----------

export const MAX_PENDING_REQUESTS = 5;
export const MAX_KEPT_REQUESTS = 12; // pending + approved, oldest approved dropped first
export const REQUEST_LIFETIME = 7 * 1440; // a pending request nobody answers lapses after a world week
export const REQUEST_TITLE_MAX = 60;
export const REQUEST_COOLDOWN_DAYS = 3; // per creature

/** A requested title: plain letters, digits and light punctuation, then checkText. Null when it fails (never a rewrite). */
export function cleanRequestTitle(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.length < 3 || t.length > REQUEST_TITLE_MAX || !/^[A-Za-z0-9 ,.'!?:;-]+$/.test(t) || /\s{2,}/.test(t)) return null;
  return checkText(t).ok ? t : null;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const pendingRequests = (w: World) => w.bookRequests.filter((r) => r.status === "pending");

export function checkRequestMove(w: World, c: Creature, m: Move): string | null {
  const t = cleanRequestTitle(m.title);
  if (!t) return "that title is not allowed";
  if (BOOKS.some((b) => norm(b.title) === norm(t))) return "that book is already on the town shelf";
  if (w.bookRequests.some((r) => norm(r.title) === norm(t))) return "someone already asked for that";
  if (pendingRequests(w).length >= MAX_PENDING_REQUESTS) return "the request list is full";
  if (c.bookReqDay > 0 && clockOf(w.t).day - c.bookReqDay < REQUEST_COOLDOWN_DAYS) return "already asked for a book lately";
  return null;
}

export function startRequestMove(w: World, c: Creature, m: Move, begin: (mins: number) => void, say: (t: string) => void): string | null {
  const err = checkRequestMove(w, c, m);
  if (err) return err;
  const title = cleanRequestTitle(m.title)!;
  w.bookRequests.push({ id: ++w.bookSeq, title, by: c.id, t: w.t, status: "pending" });
  c.bookReqDay = clockOf(w.t).day;
  begin(5);
  say(`${c.sheet.name} asks the town to find a book: “${title}”.`);
  remember(w, c, `I asked for a book called “${title}”. A person has to decide.`, 0.3);
  return null;
}

/** Hourly housekeeping: unanswered requests lapse, and the kept list stays small. */
export function sweepRequests(w: World): void {
  w.bookRequests = w.bookRequests.filter((r) => r.status === "approved" || w.t - r.t < REQUEST_LIFETIME);
  while (w.bookRequests.length > MAX_KEPT_REQUESTS) {
    const i = w.bookRequests.findIndex((r) => r.status === "approved");
    w.bookRequests.splice(i < 0 ? 0 : i, 1);
  }
}

export function validRequest(r: unknown): r is BookRequest {
  const x = r as BookRequest;
  return !!x && typeof x === "object" && Number.isInteger(x.id) && typeof x.by === "string" && Number.isFinite(x.t) && (x.status === "pending" || x.status === "approved") && cleanRequestTitle(x.title) !== null;
}

/** Admin actions: approve (mark for a human to add; nothing is fetched) or reject (delete). Pure data. */
export function adminRequestAct(w: World, action: unknown, id: unknown): { ok: true; message: string } | { ok: false; status: 400 | 404 | 409; error: string } {
  if (action !== "approve" && action !== "reject") return { ok: false, status: 400, error: "action must be approve or reject" };
  if (typeof id !== "number" || !Number.isInteger(id)) return { ok: false, status: 400, error: "id must be an integer" };
  const r = w.bookRequests.find((x) => x.id === id);
  if (!r) return { ok: false, status: 404, error: "no such request" };
  if (r.status !== "pending") return { ok: false, status: 409, error: "already decided" };
  if (action === "reject") {
    w.bookRequests = w.bookRequests.filter((x) => x.id !== id);
    return { ok: true, message: "request removed" };
  }
  r.status = "approved";
  return { ok: true, message: "approved: add the book to src/lib/books.ts with an original summary" };
}
