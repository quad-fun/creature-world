"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PublicWorld } from "@/lib/view";

const ORDER = ["workshop", "fountain", "bakery", "nests", "park", "pond"];

function stamp(t: number) {
  const day = Math.floor(t / 1440) + 1;
  const m = t % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `D${day} ${hh}:${mm}`;
}

function VisitForm({ creatures }: { creatures: { id: string; name: string; emoji: string }[] }) {
  const [to, setTo] = useState(creatures[0]?.id ?? "");
  const [from, setFrom] = useState("");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const send = async (kind: "note" | "treat") => {
    setMsg("");
    const r = await fetch("/api/visit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, to, from, text }),
    });
    const j = await r.json().catch(() => ({}));
    setMsg(j.message ?? j.error ?? "Something went wrong.");
    if (r.ok && kind === "note") setText("");
  };
  return (
    <div className="card">
      <div className="row">
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          {creatures.map((c) => (
            <option key={c.id} value={c.id}>
              {c.emoji} {c.name}
            </option>
          ))}
        </select>
        <input placeholder="your name (optional)" value={from} maxLength={20} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <textarea placeholder="Say something to them (200 characters, no links)" value={text} maxLength={200} rows={2} onChange={(e) => setText(e.target.value)} style={{ width: "100%", margin: "8px 0" }} />
      <div className="row">
        <span>
          <button onClick={() => send("note")} disabled={text.trim().length < 2}>
            Leave a note
          </button>{" "}
          <button onClick={() => send("treat")}>Give a loaf of bread</button>
        </span>
        <span className="why">{msg}</span>
      </div>
    </div>
  );
}

export function Town({ initial }: { initial: PublicWorld }) {
  const [w, setW] = useState(initial);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/world", { cache: "no-store" });
        if (r.ok && alive) setW(await r.json());
      } catch {
        /* keep the last view */
      }
    };
    const id = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const s = w.stats;
  const byId = Object.fromEntries(w.creatures.map((c) => [c.id, c]));
  const feed = [...w.feed].reverse();

  return (
    <main>
      <div className="top">
        <h1>Creature World</h1>
        <div className="clock">
          Day {w.clock.day} · {w.clock.label} · {w.clock.period}
          {" "}
          <span className={`badge ${s.mode === "model" ? "ok" : "warn"}`}>{s.mode === "model" ? s.model : "rules only"}</span>
        </div>
      </div>
      {s.storage === "memory" && (
        <div className="note">Running with in-memory state. On Vercel, add the Upstash Redis integration so the town persists between requests.</div>
      )}

      {w.event && <div className="note" style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Today in town: {w.event}</div>}

      <h2>The town</h2>
      <div className="map">
        {ORDER.map((id) => {
          const p = w.places[id];
          const here = w.creatures.filter((c) => c.place === id);
          return (
            <div className="place" key={id}>
              <b>{p.name.replace("the ", "")}</b>
              <small>
                {id === "bakery" ? `${w.bakeryStock} loaves left` : id === "fountain" ? `stall: ${Object.entries(w.market).map(([k, v]) => `${k.replace("-", " ")} ${v}`).join(", ")}` : p.blurb}
              </small>
              {here.map((c) => (
                <span key={c.id} className={`chip ${c.activity === "asleep" ? "asleep" : ""}`}>
                  {c.emoji} {c.name}
                </span>
              ))}
            </div>
          );
        })}
      </div>

      <h2>Creatures</h2>
      <div className="cards">
        {w.creatures.map((c) => (
          <div className="card" key={c.id}>
            <h3>
              {c.emoji} {c.name}
            </h3>
            <div className="sub">
              {c.species} · {c.placeName} · {c.activity}
            </div>
            <div className="row">
              <span>Feels</span>
              <span>{c.feeling}</span>
            </div>
            <div className="row">
              <span>Needs</span>
              <span>{c.needs.length ? c.needs.join(", ") : "nothing pressing"}</span>
            </div>
            <div className="row">
              <span>Carrying</span>
              <span>{c.inventory.length ? c.inventory.join(", ") : "nothing"} · {c.coins} coins</span>
            </div>
            <div className="bars">
              {[
                ["mood", c.mood],
                ["energy", c.energy],
              ].map(([k, v]) => {
                const x = v as { level: number; word: string };
                return (
                  <div className="bar" key={k as string}>
                    {k as string}
                    <i>
                      <span className={x.level < 0.3 ? "low" : ""} style={{ width: `${Math.round(x.level * 100)}%` }} />
                    </i>
                  </div>
                );
              })}
            </div>
            {c.influences.length > 0 && (
              <div className="row">
                <span>Influences</span>
                <span>{c.influences.map((i) => `${i.word} (${i.source})`).join(" · ")}</span>
              </div>
            )}
            {c.pursuit && (
              <div className="row">
                <span>Project</span>
                <span>{c.pursuit.title} · {c.pursuit.word}</span>
              </div>
            )}
            <div className="row">
              <span>Friends</span>
              <span>{c.bonds.map((b) => `${b.name}: ${b.word}`).join(" · ")}</span>
            </div>
            {c.goal && (
              <div className="row">
                <span>Intends</span>
                <span>{c.goal}</span>
              </div>
            )}
            <div className="why">
              {c.diary[0] ? `“${c.diary[0].text}”` : "No diary yet. Entries appear after a night's sleep."}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <Link href={`/c/${c.id}`}>diary, memories, sheet →</Link>
              <span className="badge">{c.source === "model" ? "model" : c.source === "rules" ? "rules" : "new"}</span>
            </div>
          </div>
        ))}
      </div>

      <h2>Notice board</h2>
      <div className="feed">
        <ul>
          {w.board.length === 0 && <li><time /> <div className="why">Nothing pinned yet.</div></li>}
          {w.board.map((b) => (
            <li key={b.id}>
              <time>{stamp(b.t)}</time>
              <div>
                <b>{b.by}</b>
                {b.byKind === "visitor" && <span className="tag">visitor{b.to ? ` to ${b.to}` : ""}</span>}: {b.text}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <h2>Visit the town</h2>
      <VisitForm creatures={w.creatures.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji }))} />
      <p className="why">
        Notes reach a creature as speech, never as orders. {w.creatures.length < w.maxCreatures ? <Link href="/adopt">Adopt a creature of your own →</Link> : "The town is full for now."}
      </p>

      <h2>What is happening</h2>
      <div className="feed">
        <ul>
          {feed.map((f) => (
            <li key={f.id}>
              <time>{stamp(f.t)}</time>
              <div>
                <div className={f.kind === "say" ? "say" : ""}>
                  {f.creature !== "world" && byId[f.creature] ? `${byId[f.creature].emoji} ` : ""}
                  {f.text}
                  {f.source && <span className="tag">{f.source}</span>}
                </div>
                {f.why && <div className="why">{f.why}</div>}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <footer>
        <span>
          {s.modelCalls} model calls · {s.fallbacks} rule fallbacks · {(s.inputTokens + s.outputTokens).toLocaleString()} tokens · est. ${s.estCostUsd.toFixed(4)}
        </span>
        <span>
          budget {s.dailyBudgetPerCreature} calls/creature/day · world runs {s.timeScale}x
        </span>
        {s.paused && <span>model paused after repeated errors</span>}
        {s.lastError && <span>last error: {s.lastError}</span>}
        <span>
          Creatures are software with modelled feelings, not conscious beings. <a href="/api/world">read API</a>
        </span>
      </footer>
    </main>
  );
}
