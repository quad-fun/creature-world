// 10-day rules-mode measurements: variety, sell vs craft, hunger, hoarding.
// Works on any version of the world model (reads state defensively).
// Usage: npx tsx scripts/metrics.ts [days]
import { seedWorld } from "../src/lib/content";
import { applyRulesForTest } from "../test/helpers";
import { stepWorld } from "../src/lib/sim";
import { itemDef } from "../src/lib/items";

const days = Number(process.argv[2] ?? 10);
const w = seedWorld(0);
const hunger = (c: any): number => c.influences?.find((i: any) => i.kind === "hunger" && i.need)?.level ?? 1 - c.drives.food;
const sig = (c: any) => `${c.activity.kind}${c.activity.kind === "play" ? "@" + c.place : ""}`;

const per: Record<string, { kinds: Set<string>[]; counts: Record<string, number>; starve: number; starving: boolean; peakInv: number; maxHunger: number; moodSum: number; n: number }> = {};
for (const id of Object.keys(w.creatures)) per[id] = { kinds: [], counts: {}, starve: 0, starving: false, peakInv: 0, maxHunger: 0, moodSum: 0, n: 0 };
const seen = new Map<string, unknown>();
const floor: Record<string, number> = {};
const price = (k: string) => Math.max(1, Math.round(((itemDef(w, k) as any).sell || 0) * ((w.market as any)[k] ?? 1)));
const lastKind: Record<string, string> = {};
const run: Record<string, number> = {};
let maxRun = 0;

for (let i = 0; i < days * 288; i++) {
  for (const id of stepWorld(w)) applyRulesForTest(w, w.creatures[id]);
  const day = Math.floor(w.t / 1440);
  for (const k of Object.keys(w.market)) floor[k] = Math.min(floor[k] ?? 99, price(k));
  for (const c of Object.values(w.creatures) as any[]) {
    const p = per[c.id];
    (p.kinds[day] ??= new Set());
    if (c.activity && seen.get(c.id) !== c.activity) {
      seen.set(c.id, c.activity);
      const key = c.activity.kind === "sell" ? `sell:${c.activity.move.item}` : c.activity.kind === "walk" ? lastKind[c.id] : c.activity.kind;
      if (c.activity.kind !== "walk") { run[c.id] = key === lastKind[c.id] && key?.startsWith("sell:") ? (run[c.id] ?? 1) + 1 : 1; lastKind[c.id] = key; maxRun = Math.max(maxRun, key?.startsWith("sell:") ? run[c.id] : 0); }
      p.counts[c.activity.kind] = (p.counts[c.activity.kind] ?? 0) + 1;
      if (!["walk", "sleep", "buy_food", "eat", "wait"].includes(c.activity.kind)) p.kinds[day].add(sig(c));
    }
    const h = hunger(c);
    p.maxHunger = Math.max(p.maxHunger, h);
    if (h > 0.88 && !p.starving) p.starve++;
    p.starving = h > 0.88;
    p.peakInv = Math.max(p.peakInv, c.inventory.length);
    p.moodSum += c.mood?.level ?? c.mood;
    p.n++;
  }
}
let totalDistinct = 0;
let totalDays = 0;
for (const [id, p] of Object.entries(per)) {
  const ds = p.kinds.filter(Boolean).map((s) => s.size);
  totalDistinct += ds.reduce((a, b) => a + b, 0);
  totalDays += ds.length;
  const sell = p.counts.sell ?? 0;
  const craft = p.counts.craft ?? 0;
  console.log(
    `${id.padEnd(8)} distinct/day ${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(2)} | craft ${craft} sell ${sell} sell:craft ${(sell / Math.max(1, craft)).toFixed(2)} | gifts ${p.counts.gift ?? 0} speaks ${p.counts.speak ?? 0} plays ${p.counts.play ?? 0} | starvation events ${p.starve} (max hunger ${p.maxHunger.toFixed(2)}) | peak items ${p.peakInv} | mean mood ${(p.moodSum / p.n).toFixed(2)}`,
  );
}
console.log(`ALL distinct activities per creature-day: ${(totalDistinct / totalDays).toFixed(2)}`);
for (const c of Object.values(w.creatures) as any[]) console.log(`${c.id.padEnd(8)} coins ${c.coins} | shelf ${c.shelf?.length ?? 0}/${c.shelfSlots ?? 0} (works made ${c.workSeq ?? 0}) | site ${c.site ? c.site.title : "none"}`);
console.log(`builds standing ${(w.builds ?? []).length} (total ever ${w.buildSeq ?? 0}), pending ${(w.builds ?? []).filter((b: any) => b.status === "pending").length}`);
console.log(`postcards sent ${(w as any).postcardSeq ?? 0} (kept ${(w as any).postcards?.length ?? 0}); books read ${Object.values(w.creatures).map((c: any) => `${c.id}:${(c.booksRead ?? []).length} distinct`).join(", ")}; book requests ${(w as any).bookRequests?.length ?? 0}; weather ${(w as any).outside?.weather ?? "n/a"}`);
console.log(`market price floor (min coins seen): ${Object.entries(floor).map(([k, v]) => `${k} ${v}`).join(", ")}; longest same-item sell run ${maxRun}`);
console.log(`total sells ${Object.values(per).reduce((a, p) => a + (p.counts.sell ?? 0), 0)}, total starvation events ${Object.values(per).reduce((a, p) => a + p.starve, 0)}, teas bought ${(w.feed as any[]).filter((f) => /cup of tea/.test(f.text)).length} (feed window only)`);
