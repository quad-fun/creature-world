import { NextResponse, after } from "next/server";
import { randomBytes } from "node:crypto";
import { loadWorld } from "@/lib/engine";
import { clientIp, readJson, tickSoon } from "@/lib/http";
import { getStore } from "@/lib/store";
import { PLAYS_PER_CREATION_DAY, PLAYS_PER_IP_DAY, findCreation, normalizeGame, parseAnswers, resultLine, scoreGame } from "@/lib/creations";
import { utcDayStr } from "@/lib/shops";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Finish a quiz. The page carries the answers so far in a hidden field; the last button posts here. The score is computed
// HERE from the stored game (the page never holds the right answers). A counted play is queued; the world applies it under
// its lock. No accounts, no coins. A form post is answered with a 303 to the result page; JSON gets the score.
async function parse(req: Request): Promise<{ body: Record<string, unknown> | null; form: boolean }> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      if (Number(req.headers.get("content-length") ?? 0) > 2000) return { body: null, form: true };
      const text = await req.text();
      if (text.length > 1000) return { body: null, form: true };
      const p = new URLSearchParams(text);
      return { body: { game: Number(p.get("game")), a: (p.get("a") ?? "") + (p.get("n") ?? "") }, form: true };
    } catch {
      return { body: null, form: true };
    }
  }
  const b = await readJson(req);
  return { body: b ? { game: b.game, a: b.a } : null, form: false };
}

export async function POST(req: Request) {
  const { body, form } = await parse(req);
  if (!body || typeof body.game !== "number" || !Number.isInteger(body.game) || body.game < 1 || body.game > 1e9 || typeof body.a !== "string") return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { world } = await loadWorld();
  const x = findCreation(world, body.game, "game");
  const g = x && normalizeGame({ questions: x.questions, results: x.results });
  if (!x || !g) return NextResponse.json({ error: "no such game" }, { status: 404 });
  const answers = parseAnswers(body.a, g.questions);
  if (!answers || answers.length !== g.questions.length) return NextResponse.json({ error: "answer every question" }, { status: 400 });
  const score = scoreGame(g.questions, answers);
  const of = g.questions.length;
  const store = getStore();
  const ip = clientIp(req);
  const day = utcDayStr();
  // rate limits: per visitor (IP) per day, per game per day, and a short window against double submits
  const counted =
    (await store.hit(`gplay2:${ip}:${x.id}`, 1, 20)) &&
    (await store.hit(`gplay:${ip}:${day}`, PLAYS_PER_IP_DAY, 86400)) &&
    (await store.hit(`gplayg:${x.id}:${day}`, PLAYS_PER_CREATION_DAY * 3, 86400));
  let token: string | null = null;
  if (counted) {
    token = randomBytes(6).toString("hex");
    await store.pushInbox({ type: "creation_play", id: x.id, token, score, of });
    try {
      after(tickSoon);
    } catch {
      // no request scope (tests, scripts): the next tick applies it
    }
  }
  const result = body.a as string;
  if (form) return NextResponse.redirect(new URL(`/play/${x.id}?a=${result}${counted ? "" : "&e=slow"}`, req.url), 303);
  return NextResponse.json({ ok: true, score, of, message: resultLine(g.results, score, of), counted });
}
