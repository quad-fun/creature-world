// Core data types for Creature World (Phase 1: text world, three creatures).
// All state is plain JSON so it can live in a single Redis key.

export type PlaceId = "fountain" | "workshop" | "bakery" | "pond" | "park" | "nests";
export type CatalogItemId = "bread" | "tea" | "mended-thing" | "trinket" | "potion" | "berries" | "fish" | "rod" | "kite" | "paint" | "seeds" | "umbrella";
/** A catalog id, or "x-<slug>" for an appraised visitor gift (resolved through items.ts itemDef). */
export type ItemId = string;
export type ItemKind = "toy" | "food" | "tool" | "art" | "wearable" | "curio";

/** An appraised, visitor-given item. Only these bounded, filtered fields ever reach a creature. */
export interface CustomItem {
  id: ItemId;
  name: string;
  kind: ItemKind;
  mood: number; // push per use, capped
  energy: number; // push per use, capped
  durability: number; // uses before it wears out, 1..10
  tags: string[]; // max 4 short words
  desc: string; // one neutral sentence written by the appraiser
  source: "model" | "rules";
  createdT: number;
  lastUsedT: number;
}
export type MoveKind =
  | "walk"
  | "speak"
  | "eat"
  | "buy_food"
  | "craft"
  | "sell"
  | "gift"
  | "rest"
  | "sleep"
  | "play"
  | "use"
  | "gather"
  | "post"
  | "make"
  | "discard"
  | "give_work"
  | "buy_slot"
  | "launch_site"
  | "propose_build"
  | "read_book"
  | "request_book"
  | "send_postcard"
  | "wait";

/** What a creature may propose to build. A fixed catalog (builder.ts); nothing else is buildable. */
export type BuildKind = "bench" | "garden" | "flowerbox" | "lantern" | "sign";
/** A small addition to a place. Pure data: kind, place id and one short checked label. */
export interface Build {
  id: number;
  kind: BuildKind;
  place: PlaceId;
  text?: string; // sign label; passed cleanBuildText
  by: string; // creature id
  cost: number; // coins paid (held while pending)
  status: "pending" | "active";
  createdT: number;
  expiresT: number; // pending: lapses; active: weathers away
}

export type WorkKind = "note" | "plan" | "journal" | "drawing";
/** A drawing is a short list of whitelisted shapes; the SVG is always rendered by the server (library.ts). */
export type Shape =
  | { t: "rect"; x: number; y: number; w: number; h: number; fill: string }
  | { t: "circle"; x: number; y: number; r: number; fill: string }
  | { t: "line"; x: number; y: number; x2: number; y2: number; stroke: string; sw: number }
  | { t: "path"; pts: number[]; stroke: string; sw: number };
/** A finished piece on a creature's shelf. All text was checked; shapes were sanitised. */
export interface Work {
  n: number; // unique per shelf owner, used in /c/[id]/w/[n]
  kind: WorkKind;
  title: string;
  body: string; // empty for drawings
  shapes?: Shape[];
  t: number; // world minute made
  ts: number; // real ms made (for the feed)
  by: string; // id of the creature that made it
  from?: string; // id of the creature that gave it to this shelf
}
export interface Site {
  title: string;
  tagline: string;
  t: number;
}

/**
 * Mood and energy (0..1) are the only core bars. Everything else is a named, temporary Influence
 * that pushes them. "need" influences (hunger, loneliness, boredom, comfort) always exist and their
 * level rises with time until relieved (comfort's level is discomfort). The others are events that
 * appear and then fade with a half-life.
 */
export type InfluenceKind = "hunger" | "loneliness" | "boredom" | "comfort" | "accomplishment" | "joy" | "fear";
export type NeedKind = "hunger" | "loneliness" | "boredom" | "comfort";

export interface Influence {
  kind: InfluenceKind;
  label: string; // short noun for the UI, e.g. "hunger"
  source: string; // what caused it, in plain words
  level: number; // 0..1 intensity
  mood: number; // push on mood at level 1 (negative = lowers)
  energy: number; // push on energy at level 1
  need: boolean; // need influences persist and grow; others decay with halfLife and are removed when faint
  halfLife?: number; // world minutes (non-need)
}

/** Recent exposure to an activity, place or item: n decays with a half-life; used for novelty. */
export interface Exposure {
  n: number;
  t: number;
}

export interface Interest {
  topic: string;
  strength: number; // 0..1, grows with exposure, fades slowly without it
  t: number; // last exposure
}

export interface Pursuit {
  topic: string;
  title: string;
  steps: number; // steps needed
  progress: number;
  setbacks: number;
  startedT: number;
  lastStepT: number;
}

export interface Move {
  do: MoveKind;
  place?: PlaceId; // walk
  target?: string; // speak / gift: creature id
  item?: ItemId; // eat / sell / gift / use
  kind?: WorkKind; // make
  build?: BuildKind; // propose_build (text is an optional label)
  book?: string; // read_book: a book id from the curated library (books.ts); request_book uses title
  title?: string; // make / launch_site
  topic?: string; // make: optional subject
  n?: number; // discard / give_work: work number
  paint?: boolean; // set only by the engine when a drawing is made with a paint set; never from model output
  piece?: { title: string; body: string; shapes?: Shape[] }; // set only by the engine after writing; never from model output
  text?: string; // speak
  why: string;
}

export interface Activity {
  kind: MoveKind;
  until: number; // world minute when it finishes
  move: Move;
}

export interface Memory {
  t: number;
  text: string;
  valence: number; // how the creature felt when it was encoded, -1..1
  salience: number; // 0..1
}

export interface DiaryEntry {
  t: number;
  text: string;
}

export interface Bond {
  familiarity: number;
  trust: number;
  fondness: number;
}

export interface Sheet {
  name: string;
  temperament: string[];
  likes: string[];
  dislikes: string[];
  voice: string;
  locked: string[]; // never editable by the creature
  self: string; // rewritten by the creature during sleep, word-limited
}

export interface Creature {
  id: string;
  species: "otter" | "magpie" | "toad";
  emoji: string;
  sheet: Sheet;
  place: PlaceId;
  mood: number; // 0..1 core bar
  energy: number; // 0..1 core bar
  baseline: number; // temperament baseline mood, 0..1
  influences: Influence[];
  familiarity: Record<string, Exposure>; // "act:craft", "place:park", "item:trinket", "talk:pip", ...
  interests: Interest[]; // at most 4
  pursuit: Pursuit | null;
  lastPursuitEndT: number;
  /** The run of back-to-back stall sales of one item kind; cleared by doing anything else (see sellBlocked in sim.ts). */
  sellRun: { item: ItemId; n: number; t: number } | null;
  received: { from: string; item: ItemId; t: number }[]; // recent gifts, newest last (max 8)
  activity: Activity | null;
  queue: Move[];
  inventory: ItemId[];
  uses: Record<string, number>; // uses consumed on the current copy of a custom item
  coins: number;
  bonds: Record<string, Bond>;
  memories: Memory[];
  diary: DiaryEntry[];
  heard: { t: number; from: string; text: string }[]; // speech since last decision
  lastDecisionT: number;
  calls: { day: string; n: number };
  lastSource: "model" | "rules" | "none";
  sleptSinceReflect: boolean;
  goal: string; // a short standing intention the creature keeps across decisions
  shelf: Work[]; // finished works, limited by shelfSlots
  shelfSlots: number;
  workSeq: number;
  makes: { day: number; n: number }; // works started on this world day
  buildsMade: { day: number; n: number }; // build proposals on this world day
  gathers: { day: number; n: number }; // berry gatherings on this world day
  site: Site | null;
  reads: { day: number; n: number }; // books read on this world day
  booksRead: string[]; // recent book ids, newest last (max 12)
  cards: { day: number; n: number }; // postcards sent on this world day
  bookReqDay: number; // world day of the last book request (0 = never)
  lastPostT?: number; // world minute of the last notice pinned to the board
}

export interface FeedEntry {
  id: number;
  t: number; // world minute
  ts: number; // real ms
  creature: string; // id or "world"
  kind: "move" | "say" | "feel" | "system" | "diary";
  text: string;
  why?: string;
  source?: "model" | "rules";
}

export interface Stats {
  modelCalls: number;
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
  consecutiveErrors: number;
  pausedUntilMs?: number; // circuit breaker: skip the model until then
  lastError?: string;
}

export interface BoardEntry {
  id: number;
  t: number;
  ts: number;
  by: string; // creature name or visitor name
  byKind: "creature" | "visitor";
  to?: string; // creature name a visitor note was addressed to
  text: string;
}

/** Things the outside world drops off. Applied to the world by the tick engine, under its lock. */
export type InboxItem =
  | { type: "note"; to: string; from: string; text: string }
  | { type: "treat"; to: string; from: string }
  | { type: "gift"; to: string; from: string; name: string; description: string }
  | { type: "postcard"; to: string; from: string; where: string; text: string }
  | {
      type: "adopt";
      name: string;
      species: Creature["species"];
      temperament: string[];
      likes: string[];
      dislikes: string[];
      voice: string;
    };

/** The world outside the town: a whitelisted weather condition and calendar facts. Pure data, never free text. */
export type Weather = "clear" | "rain" | "snow" | "wind" | "hot" | "cold" | "fog";
export type Season = "spring" | "summer" | "autumn" | "winter";
export interface Outside {
  date: string; // YYYY-MM-DD the facts are for
  weather: Weather;
  season: Season;
  holiday: string | null; // a label from our own fixed list (outside.ts), never from the network
  source: "seeded" | "live"; // live = the optional weather API answered
  by: "world" | "engine"; // who set it: the engine (real date) or stepWorld's own seeded fallback
  appliedDay: number; // world day whose mood nudges were already applied
}

/** A short, filtered public message a creature sends out of town. Outgoing only: no address, no recipient. */
export interface Postcard {
  id: number;
  t: number;
  ts: number;
  by: string; // creature id
  name: string; // creature name at the time
  species: Creature["species"];
  place: PlaceId;
  text: string; // at most 140 chars, passed checkText
}

/** A creature's wish for a book. Title only, filtered. A human decides; nothing is ever fetched. */
export interface BookRequest {
  id: number;
  title: string;
  by: string;
  t: number;
  status: "pending" | "approved";
}

/** A seed packet planted at the park. After one world day it becomes a garden build (builder.ts). Pure data. */
export interface Planting {
  by: string; // creature id
  place: PlaceId;
  t: number; // planted
  readyT: number;
}

export interface World {
  version: 1;
  t: number; // world minutes since start
  lastRealMs: number;
  rng: number;
  creatures: Record<string, Creature>;
  bakeryStock: number;
  items: Record<string, CustomItem>; // appraised custom items (also the appraisal cache), capped
  appraisals: { day: string; n: number }; // model appraisals made today (cost guard)
  market: Record<string, number>; // item -> saturation 0.3..1 (price multiplier)
  feed: FeedEntry[];
  feedSeq: number;
  stats: Stats;
  board: BoardEntry[];
  boardSeq: number;
  berries: number; // town-wide berry supply, regrows (goods.ts)
  plantings: Planting[]; // seeds in the ground, bounded (builder.ts)
  builds: Build[]; // pending and active, bounded by builder.ts caps
  buildSeq: number;
  outside?: Outside;
  postcards: Postcard[]; // newest last, capped
  postcardSeq: number;
  bookRequests: BookRequest[]; // capped
  bookSeq: number;
  event?: { day: number; name: string; text: string };
}
