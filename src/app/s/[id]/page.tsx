import Link from "next/link";
import { notFound } from "next/navigation";
import { loadWorld } from "@/lib/engine";
import { publicDiary, renderSvg } from "@/lib/library";

export const dynamic = "force-dynamic";

// A creature's website: one fixed, static template. Everything shown is already-checked text or a
// server-rendered whitelist drawing; React escapes the text. No scripts, forms, external links or images.
export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { world } = await loadWorld();
  const c = world.creatures[id];
  if (!c?.site) notFound();
  const diary = publicDiary(c);
  return (
    <main>
      <h1>
        {c.emoji} {c.site.title}
      </h1>
      <p className="why">
        <i>{c.site.tagline}</i> · by {c.sheet.name}
      </p>
      <h2>Works</h2>
      {c.shelf.length === 0 && <p className="why">The shelf is being rearranged.</p>}
      {[...c.shelf].reverse().map((k) => (
        <article key={k.n}>
          <h3>
            <Link href={`/c/${id}/w/${k.n}`}>{k.title}</Link> <small className="clock">{k.kind}</small>
          </h3>
          {k.kind === "drawing" ? <div dangerouslySetInnerHTML={{ __html: renderSvg(k.shapes, k.title) }} /> : <p style={{ whiteSpace: "pre-wrap" }}>{k.body}</p>}
        </article>
      ))}
      <h2>From the diary</h2>
      {diary.length ? (
        <ul className="plain">
          {diary.map((d, i) => (
            <li key={i}>{d.text}</li>
          ))}
        </ul>
      ) : (
        <p className="why">No pages yet.</p>
      )}
      <p>
        <Link href={`/c/${id}`}>← about {c.sheet.name}</Link>
      </p>
    </main>
  );
}
