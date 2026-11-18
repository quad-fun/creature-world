import Link from "next/link";
import { NOTES, REST, type PublicCreation } from "@/lib/creations";

// Server-rendered views of creature creations. Text comes from creations.ts (checked again at render) and React escapes it.
// The only script is our own same-origin /tune.js; it gets whitelisted values through data attributes, never creature text.

export function TuneView({ t, listened }: { t: PublicCreation; listened?: boolean }) {
  const steps = t.steps ?? [];
  const W = 14;
  const H = 8;
  const height = NOTES.length * H + 8;
  return (
    <article id={`tune-${t.id}`} className="card">
      <h3>
        {t.emoji} {t.title} <small className="clock">tune by {t.byName}</small>
      </h3>
      <svg role="img" aria-label={`The notes of ${t.title}`} width={steps.length * W + 8} height={height} viewBox={`0 0 ${steps.length * W + 8} ${height}`} style={{ background: "#f6f3ea", maxWidth: "100%" }}>
        {steps.map((s, i) => {
          const k = (NOTES as readonly string[]).indexOf(s);
          return s === REST || k < 0 ? (
            <circle key={i} cx={4 + i * W + W / 2} cy={height - 6} r={2} fill="#bbb" />
          ) : (
            <rect key={i} x={4 + i * W + 1} y={4 + (NOTES.length - 1 - k) * H} width={W - 2} height={H - 1} rx={2} fill="#4a6fa5" />
          );
        })}
      </svg>
      <p className="why">
        {t.instrument}, {t.tempo} beats a minute, {steps.length} steps
      </p>
      <p>
        <button type="button" data-tune="1" data-steps={steps.join(",")} data-tempo={t.tempo} data-inst={t.instrument}>
          Play
        </button>{" "}
        <Link href={`/api/tune/${t.id}`}>Download the pattern (JSON)</Link>
      </p>
      <form method="post" action="/api/listen">
        <input type="hidden" name="tune" value={t.id} />
        <button type="submit">Tell {t.byName} you listened</button> {listened !== undefined && <small className="why">{listened ? "Thank you, they will be glad." : "Thanks, but that is enough listening for now."}</small>}
      </form>
      <script src="/tune.js" defer />
    </article>
  );
}

export function GameCard({ g }: { g: PublicCreation }) {
  return (
    <article id={`game-${g.id}`} className="card">
      <h3>
        {g.emoji} <Link href={`/play/${g.id}`}>{g.title}</Link> <small className="clock">quiz by {g.byName}</small>
      </h3>
      <p className="why">{g.questions} questions, one tap each. No account needed.</p>
    </article>
  );
}
