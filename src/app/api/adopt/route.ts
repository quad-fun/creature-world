import { NextResponse, after } from "next/server";
import { MAX_CREATURES, SPECIES_EMOJI } from "@/lib/content";
import { loadWorld } from "@/lib/engine";
import { clientIp, readJson, tickSoon } from "@/lib/http";
import { checkAll, checkText, visitorMessage } from "@/lib/filter";
import { sanitizeList, sanitizeName, sanitizeText } from "@/lib/inbox";
import { getStore } from "@/lib/store";
import type { Creature } from "@/lib/types";

export const dynamic = "force-dynamic";

// One adoption per visitor per day, three town-wide per day, and the town holds at most MAX_CREATURES.
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const name = sanitizeName(body.name);
  const species = String(body.species ?? "") as Creature["species"];
  if (name.length < 2) return NextResponse.json({ error: "give your creature a name" }, { status: 400 });
  if (!(species in SPECIES_EMOJI)) return NextResponse.json({ error: "species must be otter, magpie or toad" }, { status: 400 });
  const temperament = sanitizeList(body.temperament, 3, 24);
  const likes = sanitizeList(body.likes, 5, 24);
  const dislikes = sanitizeList(body.dislikes, 3, 24);
  const voice = sanitizeText(body.voice, 120);
  if (!temperament.length || !likes.length) return NextResponse.json({ error: "add at least one temperament word and one like" }, { status: 400 });

  const bad = checkText(name).ok ? checkAll([...temperament, ...likes, ...dislikes, voice]) : { ok: false as const, reason: "unkind" as const };
  if (bad) return NextResponse.json({ error: visitorMessage(bad.reason) }, { status: 422 });

  const { world } = await loadWorld();
  if (Object.keys(world.creatures).length >= MAX_CREATURES) return NextResponse.json({ error: "the town is full for now" }, { status: 409 });
  if (Object.values(world.creatures).some((c) => c.sheet.name.toLowerCase() === name.toLowerCase()))
    return NextResponse.json({ error: "someone in town already has that name" }, { status: 409 });

  const store = getStore();
  const ok = (await store.hit(`adopt:${clientIp(req)}`, 1, 86400)) && (await store.hit("adopt:all", 3, 86400));
  if (!ok) return NextResponse.json({ error: "adoption limit reached; try tomorrow" }, { status: 429 });

  await store.pushInbox({ type: "adopt", name, species, temperament, likes, dislikes, voice });
  after(tickSoon);
  return NextResponse.json({ ok: true, message: `${name} is on the way to town.` });
}
