// Core data types for Creature World (Phase 1: text world, three creatures).
// All state is plain JSON so it can live in a single Redis key.

export type PlaceId = "fountain" | "workshop" | "bakery" | "pond" | "park" | "nests";
export type DriveName = "food" | "energy" | "social" | "curiosity" | "comfort";
export type ItemId = "bread" | "mended-thing" | "trinket" | "potion";
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
  | "post"
  | "wait";

/** 0..1 per drive. 1 = fully satisfied, 0 = badly unmet (uniform for every drive). */
export type Drives = Record<DriveName, number>;

export interface Move {
  do: MoveKind;
  place?: PlaceId; // walk
  target?: string; // speak / gift: creature id
  item?: ItemId; // eat / sell / gift
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
  valence: number; // affect when it was encoded
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
  drives: Drives;
  affect: { valence: number; arousal: number };
  mood: number; // slow average of valence
  baseline: number; // temperament baseline valence
  activity: Activity | null;
  queue: Move[];
  inventory: ItemId[];
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
  | {
      type: "adopt";
      name: string;
      species: Creature["species"];
      temperament: string[];
      likes: string[];
      dislikes: string[];
      voice: string;
    };

export interface World {
  version: 1;
  t: number; // world minutes since start
  lastRealMs: number;
  rng: number;
  creatures: Record<string, Creature>;
  bakeryStock: number;
  market: Record<string, number>; // item -> saturation 0.3..1 (price multiplier)
  feed: FeedEntry[];
  feedSeq: number;
  stats: Stats;
  board: BoardEntry[];
  boardSeq: number;
  event?: { day: number; name: string; text: string };
}
