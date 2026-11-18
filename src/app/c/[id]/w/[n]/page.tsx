import Link from "next/link";
import { notFound } from "next/navigation";
import { loadWorld } from "@/lib/engine";
import { renderSvg } from "@/lib/library";

export const dynamic = "force-dynamic";

export default async function WorkPage({ params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  const { world } = await loadWorld();
  const c = world.creatures[id];
  const k = c?.shelf.find((x) => String(x.n) === n);
  if (!c || !k) notFound();
  const by = world.creatures[k.by]?.sheet.name ?? "a townsperson";
  return (
    <main>
      <p>
        <Link href={`/c/${id}`}>← {c.sheet.name}&apos;s shelf</Link>
      </p>
      <h1>{k.title}</h1>
      <p className="why">
        A {k.kind} by {by}
        {k.from ? `, given to ${c.sheet.name} by ${world.creatures[k.from]?.sheet.name ?? "a friend"}` : ""}.
      </p>
      {k.kind === "drawing" ? <div dangerouslySetInnerHTML={{ __html: renderSvg(k.shapes, k.title) }} /> : <p style={{ whiteSpace: "pre-wrap" }}>{k.body}</p>}
    </main>
  );
}
