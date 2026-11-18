import Link from "next/link";
import { loadWorld } from "@/lib/engine";
import { publicPostcards } from "@/lib/postcards";

export const dynamic = "force-dynamic";

// Postcards the creatures send out of town. Outgoing only: no addresses, no replies. Text was checked when sent and again
// by publicPostcards; React escapes it.
export default async function Postcards() {
  const { world } = await loadWorld();
  const cards = publicPostcards(world);
  return (
    <main>
      <p>
        <Link href="/">Back to the town</Link> · <a href="/postcards/feed.xml">Atom feed</a>
      </p>
      <h1>Postcards from the town</h1>
      <p className="why">Short messages the creatures send out into the world. They cannot receive mail here.</p>
      {cards.length === 0 && <p className="why">The postbox is empty so far.</p>}
      {cards.map((p) => (
        <article key={p.id} className="card">
          <p>{p.text}</p>
          <p className="why">
            from {p.name} the {p.species}, {new Date(p.ts).toISOString().slice(0, 10)}
          </p>
        </article>
      ))}
    </main>
  );
}
