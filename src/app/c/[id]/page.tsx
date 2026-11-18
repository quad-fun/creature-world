import Link from "next/link";
import { notFound } from "next/navigation";
import { loadWorld } from "@/lib/engine";
import { creatureView } from "@/lib/view";
import { GiftForm } from "../../gift-form";

export const dynamic = "force-dynamic";

function stamp(t: number) {
  const day = Math.floor(t / 1440) + 1;
  const m = t % 1440;
  return `D${day} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export default async function CreaturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { world } = await loadWorld();
  const base = world.creatures[id];
  if (!base) notFound();
  const c = creatureView(world, base);
  const recent = world.feed.filter((f) => f.creature === id).slice(-25).reverse();

  return (
    <main>
      <p>
        <Link href="/">← town</Link>
      </p>
      <h1>
        {c.emoji} {c.name} <span className="badge">{c.species}</span>
      </h1>
      <p className="clock">
        {c.placeName} · {c.activity} · feels {c.feeling} · {c.coins} coins · {c.callsToday} model calls today
      </p>

      <div className="bars">
        {[
          ["mood", c.mood],
          ["energy", c.energy],
        ].map(([k, v]) => {
          const x = v as { level: number; word: string };
          return (
            <div className="bar" key={k as string}>
              {k as string}: {x.word}
              <i>
                <span className={x.level < 0.3 ? "low" : ""} style={{ width: `${Math.round(x.level * 100)}%` }} />
              </i>
            </div>
          );
        })}
      </div>
      <p className="why">Carrying: {c.inventory.length ? c.inventory.join(", ") : "nothing"}.</p>
      <GiftForm to={id} />
      <p className="why">
        {c.influences.length ? `Influences: ${c.influences.map((i) => `${i.word} (${i.source}), ${i.effect} mood`).join("; ")}` : "No strong influences right now."}
        {c.interests.length > 0 && ` Interests: ${c.interests.map((i) => `${i.topic} (${i.word})`).join(", ")}.`}
        {c.pursuit && ` Project: ${c.pursuit.title}, ${c.pursuit.word}.`}
      </p>

      <div className="two">
        <div>
          <h2>Diary</h2>
          {c.diary.length ? (
            <ul className="plain">
              {c.diary.map((d, i) => (
                <li key={i}>
                  <small className="clock">{stamp(d.t)}</small> {d.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="why">Nothing yet. A diary entry is written after each night's sleep.</p>
          )}

          <h2>Memories carried</h2>
          <ul className="plain">
            {c.memories.map((m, i) => (
              <li key={i}>
                {m.text} <small className="clock">{stamp(m.t)} · weight {m.salience.toFixed(2)}</small>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2>Character sheet</h2>
          <p>
            <b>Temperament:</b> {c.sheet.temperament.join(", ")}
            <br />
            <b>Likes:</b> {c.sheet.likes.join(", ")}
            <br />
            <b>Dislikes:</b> {c.sheet.dislikes.join(", ")}
            <br />
            <b>Voice:</b> {c.sheet.voice}
          </p>
          <p>
            <b>Always true (locked):</b>
          </p>
          <ul className="plain">
            {c.sheet.locked.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p>
            <b>In their own words (rewritten during sleep):</b>
            <br />
            {c.sheet.self}
          </p>

          <h2>Relationships</h2>
          <ul className="plain">
            {c.bonds.map((b) => (
              <li key={b.id}>
                {b.name}: {b.word}
              </li>
            ))}
          </ul>

          <h2>Recent moves</h2>
          <div className="feed">
            <ul>
              {recent.map((f) => (
                <li key={f.id}>
                  <time>{stamp(f.t)}</time>
                  <div>
                    {f.text}
                    {f.why && <div className="why">{f.why}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </main>
  );
}
