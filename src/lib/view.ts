// Public, read-only projection of the world for the UI and the open read API.
import { activeInfluences, bondWord, energyWord, influenceWord, influenceWords, moodWord, moodWords } from "./affect";
import { interestWord, pursuitWord } from "./novelty";
import { itemDef } from "./items";
import { MAX_CREATURES, PLACES } from "./content";
import { config } from "./engine";
import { MODEL_ID, modelAvailable } from "./mind";
import { MAX_SLOTS, slotPrice } from "./library";
import { clockOf, describeActivity } from "./sim";
import type { Creature, World } from "./types";

const price = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && v ? Number(v) : d);

export function creatureView(w: World, c: Creature) {
  return {
    id: c.id,
    name: c.sheet.name,
    species: c.species,
    emoji: c.emoji,
    place: c.place,
    placeName: PLACES[c.place].name,
    activity: describeActivity(w, c),
    feeling: moodWords(c),
    needs: influenceWords(c),
    mood: { level: c.mood, word: moodWord(c.mood) },
    energy: { level: c.energy, word: energyWord(c.energy) },
    influences: activeInfluences(c).map((i) => ({
      kind: i.kind,
      label: i.label,
      word: influenceWord(i),
      source: i.source,
      level: i.level,
      effect: (i.mood < 0 ? "lowers" : "lifts") as "lowers" | "lifts",
    })),
    interests: c.interests.filter((i) => i.strength >= 0.15).map((i) => ({ topic: i.topic, word: interestWord(i.strength), strength: i.strength })),
    pursuit: c.pursuit ? { title: c.pursuit.title, word: pursuitWord(c.pursuit), progress: c.pursuit.progress, steps: c.pursuit.steps, setbacks: c.pursuit.setbacks } : null,
    coins: c.coins,
    shelf: c.shelf.map((k) => ({ n: k.n, kind: k.kind, title: k.title })),
    shelfSlots: c.shelfSlots,
    nextSlotPrice: c.shelfSlots < MAX_SLOTS ? slotPrice(c.shelfSlots) : null,
    site: c.site ? { title: c.site.title, tagline: c.site.tagline } : null,
    inventory: c.inventory.map((i) => itemDef(w, i).name),
    source: c.lastSource,
    callsToday: c.calls.n,
    goal: c.goal,
    bonds: Object.keys(w.creatures)
      .filter((id) => id !== c.id)
      .map((id) => ({ id, name: w.creatures[id].sheet.name, word: bondWord(c.bonds[id]) })),
    sheet: c.sheet,
    diary: c.diary.slice(-20).reverse(),
    memories: [...c.memories].sort((a, b) => b.salience - a.salience).slice(0, 12),
  };
}

export function publicView(w: World, storage: "redis" | "memory") {
  const clk = clockOf(w.t);
  const pin = price(process.env.MODEL_PRICE_IN, 0.1);
  const pout = price(process.env.MODEL_PRICE_OUT, 0.5);
  const cfg = config();
  return {
    clock: { day: clk.day, label: clk.label, period: clk.period, isNight: clk.isNight, t: w.t },
    places: Object.fromEntries(Object.entries(PLACES).map(([id, p]) => [id, { name: p.name, blurb: p.blurb }])),
    bakeryStock: w.bakeryStock,
    market: Object.fromEntries(Object.entries(w.market).map(([k, v]) => [k, Math.max(1, Math.round(itemDef(w, k).sell * v))])),
    creatures: Object.values(w.creatures).map((c) => creatureView(w, c)),
    feed: w.feed.slice(-80),
    board: [...w.board].reverse().slice(0, 20),
    event: w.event?.text ?? null,
    maxCreatures: MAX_CREATURES,
    stats: {
      mode: modelAvailable() ? ("model" as const) : ("rules" as const),
      model: MODEL_ID,
      modelCalls: w.stats.modelCalls,
      fallbacks: w.stats.fallbacks,
      inputTokens: w.stats.inputTokens,
      outputTokens: w.stats.outputTokens,
      estCostUsd: (w.stats.inputTokens * pin + w.stats.outputTokens * pout) / 1e6,
      errors: w.stats.errors,
      lastError: w.stats.lastError,
      paused: (w.stats.pausedUntilMs ?? 0) > Date.now(),
      dailyBudgetPerCreature: cfg.dailyCalls,
      timeScale: cfg.timeScale,
      storage,
    },
  };
}

export type PublicWorld = ReturnType<typeof publicView>;
export type CreatureView = ReturnType<typeof creatureView>;
