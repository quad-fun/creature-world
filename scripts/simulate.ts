// Offline simulation with rule-based minds only (no model, no network).
// Usage: npx tsx scripts/simulate.ts [days]
import { seedWorld } from "../src/lib/content";
import { applyRulesForTest } from "../test/helpers";
import { needLevel } from "../src/lib/affect";
import { clockOf, stepWorld } from "../src/lib/sim";

const days = Number(process.argv[2] ?? 5);
const w = seedWorld(0);
const stepsPerDay = 288;
const kinds: Record<string, Record<string, number>> = {};
let minFood = 1;
let starvedSteps = 0;

for (let i = 0; i < days * stepsPerDay; i++) {
  const need = stepWorld(w);
  for (const id of need) applyRulesForTest(w, w.creatures[id]);
  for (const c of Object.values(w.creatures)) {
    minFood = Math.min(minFood, 1 - needLevel(c, "hunger"));
    if (needLevel(c, "hunger") >= 0.99) starvedSteps++;
    const k = c.activity?.kind ?? "idle";
    (kinds[c.id] ??= {})[k] = (kinds[c.id][k] ?? 0) + 1;
  }
  if (i % (stepsPerDay / 4) === 0) {
    const clk = clockOf(w.t);
    const line = Object.values(w.creatures)
      .map((c) => `${c.sheet.name}@${c.place}[${c.activity?.kind ?? "idle"}] mood=${c.mood.toFixed(2)} en=${c.energy.toFixed(2)} hun=${needLevel(c, "hunger").toFixed(2)} lon=${needLevel(c, "loneliness").toFixed(2)} bor=${needLevel(c, "boredom").toFixed(2)} $${c.coins}`)
      .join(" | ");
    console.log(`D${clk.day} ${clk.label}  ${line}`);
  }
}

console.log("\nActivity share (steps):");
for (const [id, k] of Object.entries(kinds)) {
  const total = Object.values(k).reduce((a, b) => a + b, 0);
  console.log(id.padEnd(8), Object.entries(k).sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n} ${Math.round((100 * v) / total)}%`).join(", "));
}
console.log("\nmin food seen:", minFood.toFixed(2), "| steps at starvation:", starvedSteps);
for (const c of Object.values(w.creatures)) {
  console.log(`${c.sheet.name}: coins ${c.coins}, bonds`, Object.fromEntries(Object.entries(c.bonds).map(([k, b]) => [k, +(b.familiarity + b.fondness).toFixed(2)])), `diary ${c.diary.length}, memories ${c.memories.length}`);
}
console.log("feed entries:", w.feed.length, "| bakery stock:", w.bakeryStock, "| market:", w.market);
