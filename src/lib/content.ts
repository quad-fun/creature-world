// Static content: places, items, species and the three starting creatures.
import type { Creature, DriveName, ItemId, PlaceId, World } from "./types";

export const PLACES: Record<PlaceId, { name: string; x: number; y: number; blurb: string }> = {
  fountain: { name: "the fountain", x: 5, y: 5, blurb: "A market stall sits beside the fountain; the town buys crafted things here." },
  workshop: { name: "the workshop", x: 2, y: 3, blurb: "Benches, tools and good light. Crafting happens here." },
  bakery: { name: "the bakery", x: 8, y: 3, blurb: "Sells bread for 2 coins while the stock lasts." },
  pond: { name: "the pond", x: 8, y: 8, blurb: "Quiet, muddy and cool." },
  park: { name: "the park", x: 4, y: 8, blurb: "Open grass and benches. Good for play and wandering." },
  nests: { name: "the nests", x: 1, y: 7, blurb: "Warm beds. The only place to really sleep." },
};
export const PLACE_IDS = Object.keys(PLACES) as PlaceId[];

export function travelMinutes(a: PlaceId, b: PlaceId): number {
  if (a === b) return 0;
  const pa = PLACES[a];
  const pb = PLACES[b];
  return 3 * (Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y));
}

export const ITEMS: Record<ItemId, { name: string; tags: string[]; food: number; sell: number }> = {
  bread: { name: "bread", tags: ["food", "bread", "warm"], food: 0.5, sell: 0 },
  "mended-thing": { name: "mended thing", tags: ["mending", "useful"], food: 0, sell: 4 },
  trinket: { name: "shiny trinket", tags: ["shiny", "small"], food: 0, sell: 3 },
  potion: { name: "herbal potion", tags: ["herb", "strange"], food: 0, sell: 5 },
};
export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

export const BREAD_PRICE = 2;
export const BAKERY_MAX_STOCK = 6;
export const MAX_CREATURES = 6;
export const SPECIES_EMOJI = { otter: "🦦", magpie: "🐦‍⬛", toad: "🐸" } as const;

export const SPECIES = {
  otter: {
    // satisfaction lost per world minute while awake
    rates: { food: 0.0012, energy: 0.001, social: 0.0008, curiosity: 0.0007, comfort: 0.0004 } as Record<DriveName, number>,
    craft: "mended-thing" as ItemId,
  },
  magpie: {
    rates: { food: 0.0013, energy: 0.0011, social: 0.0011, curiosity: 0.0013, comfort: 0.0004 } as Record<DriveName, number>,
    craft: "trinket" as ItemId,
  },
  toad: {
    rates: { food: 0.0009, energy: 0.0008, social: 0.0005, curiosity: 0.0006, comfort: 0.0006 } as Record<DriveName, number>,
    craft: "potion" as ItemId,
  },
};

function fresh(): Creature["drives"] {
  return { food: 0.8, energy: 0.9, social: 0.7, curiosity: 0.7, comfort: 0.8 };
}

export function base(
  id: string,
  species: Creature["species"],
  emoji: string,
  place: PlaceId,
  baseline: number,
  sheet: Creature["sheet"],
): Creature {
  return {
    id,
    species,
    emoji,
    sheet,
    place,
    drives: fresh(),
    affect: { valence: baseline, arousal: 0.3 },
    mood: baseline,
    baseline,
    activity: null,
    queue: [],
    inventory: [],
    coins: 6,
    bonds: {},
    memories: [],
    diary: [],
    heard: [],
    lastDecisionT: -1000,
    calls: { day: "", n: 0 },
    lastSource: "none",
    sleptSinceReflect: false,
    goal: "",
  };
}

export function seedCreatures(): Record<string, Creature> {
  return {
    moss: base("moss", "otter", "🦦", "workshop", 0.2, {
      name: "Moss",
      temperament: ["patient", "nosy", "bad at goodbyes"],
      likes: ["mending", "rain", "small gifts", "bread", "tea"],
      dislikes: ["loud places", "being rushed", "waste"],
      voice: "Short sentences. Dry humour. Never uses exclamation marks.",
      locked: ["Moss never lies about what something cost.", "Moss never leaves the town."],
      self: "I like fixing things that other people have given up on.",
    }),
    pip: base("pip", "magpie", "🐦‍⬛", "fountain", 0.25, {
      name: "Pip",
      temperament: ["restless", "charming", "collector"],
      likes: ["shiny", "gossip", "bread", "small bargains", "gift"],
      dislikes: ["boredom", "silence", "being ignored"],
      voice: "Quick chatter, fond of puns and exclamations, always a bit too much.",
      locked: ["Pip never steals; Pip only trades or asks.", "Pip always says out loud when something is borrowed."],
      self: "I notice small bright things, and I like telling people about them.",
    }),
    bramble: base("bramble", "toad", "🐸", "pond", 0.1, {
      name: "Bramble",
      temperament: ["slow", "deep-thinking", "secretly sentimental"],
      likes: ["herb", "quiet", "mud", "questions", "mending"],
      dislikes: ["hurry", "crowds", "dry places", "loud"],
      voice: "Unhurried and formal. Pauses written as '...'. Dry, gentle wit.",
      locked: ["Bramble keeps every promise.", "Bramble will not harm another creature."],
      self: "I think best when nothing is asking me for an answer.",
    }),
  };
}

export function seedWorld(nowMs: number): World {
  return {
    version: 1,
    t: 7 * 60, // start at 07:00 on day 1
    lastRealMs: nowMs,
    rng: 123456789,
    creatures: seedCreatures(),
    bakeryStock: BAKERY_MAX_STOCK,
    market: { "mended-thing": 1, trinket: 1, potion: 1 },
    feed: [
      {
        id: 1,
        t: 7 * 60,
        ts: nowMs,
        creature: "world",
        kind: "system",
        text: "Morning in the town. Moss, Pip and Bramble wake up.",
      },
    ],
    feedSeq: 1,
    stats: { modelCalls: 0, fallbacks: 0, inputTokens: 0, outputTokens: 0, errors: 0, consecutiveErrors: 0 },
    board: [],
    boardSeq: 0,
  };
}
