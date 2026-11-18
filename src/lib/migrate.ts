// Older saved worlds lack newer fields. Fill them in when a world is loaded. Idempotent.
import { clamp, ensureNeeds } from "./affect";
import { seedInterests } from "./novelty";
import { MAX_ACTIVE_BUILDS, MAX_PENDING_BUILDS, cleanBuildText, isBuildKind } from "./builder";
import { PLACE_IDS } from "./content";
import { checkText } from "./filter";
import { validOutside } from "./outside";
import type { Build, Creature, World } from "./types";

/** A stored build must fit the schema exactly; anything else (hand-edited or corrupt data) is dropped on load. */
function validBuild(b: unknown): b is Build {
  const x = b as Build;
  return (
    !!x && typeof x === "object" && Number.isInteger(x.id) && isBuildKind(x.kind) && PLACE_IDS.includes(x.place) && (x.status === "active" || x.status === "pending") &&
    typeof x.by === "string" && Number.isFinite(x.cost) && x.cost >= 0 && x.cost <= 10 && Number.isFinite(x.createdT) && Number.isFinite(x.expiresT) &&
    (x.text === undefined || cleanBuildText(x.text) !== null)
  );
}

const okLine = (t: unknown, max: number) => typeof t === "string" && t.length > 0 && t.length <= max && !/[<>\u0000-\u001f]/.test(t) && checkText(t).ok;
const validCard = (p: unknown) => {
  const x = p as World["postcards"][number];
  return !!x && typeof x === "object" && Number.isInteger(x.id) && Number.isFinite(x.t) && Number.isFinite(x.ts) && typeof x.by === "string" && okLine(x.name, 20) && ["otter", "magpie", "toad"].includes(x.species) && PLACE_IDS.includes(x.place) && okLine(x.text, 140);
};
const validReq = (r: unknown) => {
  const x = r as World["bookRequests"][number];
  return !!x && typeof x === "object" && Number.isInteger(x.id) && typeof x.by === "string" && Number.isFinite(x.t) && (x.status === "pending" || x.status === "approved") && okLine(x.title, 60) && /^[A-Za-z0-9 ,.'!?:;-]+$/.test(x.title);
};

type Legacy = Creature & {
  drives?: { food: number; energy: number; social: number; curiosity: number; comfort: number };
  affect?: { valence: number; arousal: number };
};

export function migrate(w: World): World {
  w.board ??= [];
  w.boardSeq ??= 0;
  w.items ??= {};
  w.builds = Array.isArray(w.builds) ? w.builds.filter(validBuild).slice(0, MAX_ACTIVE_BUILDS + MAX_PENDING_BUILDS) : [];
  w.buildSeq = Math.max(typeof w.buildSeq === "number" && Number.isFinite(w.buildSeq) ? w.buildSeq : 0, ...w.builds.map((b) => b.id));
  if (!validOutside(w.outside)) delete w.outside; // the engine or stepWorld rebuilds it
  w.postcards = Array.isArray(w.postcards) ? w.postcards.filter(validCard).slice(-40) : [];
  w.postcardSeq = Math.max(typeof w.postcardSeq === "number" && Number.isFinite(w.postcardSeq) ? w.postcardSeq : 0, ...w.postcards.map((p) => p.id));
  w.bookRequests = Array.isArray(w.bookRequests) ? w.bookRequests.filter(validReq).slice(-12) : [];
  w.bookSeq = Math.max(typeof w.bookSeq === "number" && Number.isFinite(w.bookSeq) ? w.bookSeq : 0, ...w.bookRequests.map((r) => r.id));
  w.appraisals ??= { day: "", n: 0 };
  for (const raw of Object.values(w.creatures)) {
    const c = raw as Legacy;
    c.goal ??= "";
    c.shelf ??= [];
    c.shelfSlots ??= 4;
    c.workSeq ??= c.shelf.reduce((m, x) => Math.max(m, x.n), 0);
    c.makes ??= { day: 0, n: 0 };
    c.site ??= null;
    c.buildsMade ??= { day: 0, n: 0 };
    c.reads ??= { day: 0, n: 0 };
    c.cards ??= { day: 0, n: 0 };
    c.bookReqDay = Number.isFinite(c.bookReqDay) ? c.bookReqDay : 0;
    c.booksRead = Array.isArray(c.booksRead) ? c.booksRead.filter((b) => typeof b === "string" && /^[a-z]{1,20}$/.test(b)).slice(-12) : [];
    if (c.drives || c.affect) {
      // old model: five drives plus valence/arousal and a slow mood -> mood, energy and influences
      const d = c.drives;
      const v = c.affect?.valence ?? 0;
      c.baseline = clamp(0.5 + (c.baseline ?? 0.1) / 2, 0.2, 0.8);
      c.mood = clamp(0.5 + v / 2, 0.1, 1);
      c.energy = clamp(d?.energy ?? 0.9, 0.04, 1);
      c.influences = [];
      ensureNeeds(c, d ? { hunger: 1 - d.food, loneliness: 1 - d.social, boredom: 1 - d.curiosity, comfort: 1 - d.comfort } : {});
      delete c.drives;
      delete c.affect;
    }
    if (typeof c.mood !== "number") c.mood = 0.55;
    if (typeof c.energy !== "number") c.energy = 0.9;
    if (typeof c.baseline !== "number") c.baseline = 0.55;
    ensureNeeds(c);
    c.familiarity ??= {};
    c.pursuit ??= null;
    c.lastPursuitEndT ??= -10000;
    c.received ??= [];
    c.uses ??= {};
    c.interests ??= seedInterests(c);
    for (const m of c.memories ?? []) if (typeof m.valence !== "number") m.valence = 0;
  }
  return w;
}
