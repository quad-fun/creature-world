import Link from "next/link";
import { loadWorld } from "@/lib/engine";
import { publicShops } from "@/lib/shops";

export const dynamic = "force-dynamic";

// Open shops only (a human approved each). Text was checked when set and again by publicShops; React escapes it.
export default async function Shops() {
  const { world } = await loadWorld();
  const shops = publicShops(world);
  return (
    <main>
      <p>
        <Link href="/">Back to the town</Link>
      </p>
      <h1>Shops</h1>
      <p className="why">Small shops kept by the creatures, on their own sites. Prices are in visitor coins, a play currency for this town only.</p>
      {shops.length === 0 && <p className="why">No shop is open at the moment.</p>}
      {shops.map((s) => (
        <article key={s.id} className="card">
          <h3>
            <Link href={`/s/${s.id}#shop`}>
              {s.emoji} {s.title}
            </Link>
          </h3>
          <p className="why">
            <i>{s.tagline}</i> · by {s.name}
          </p>
          <p>{s.listings.length ? s.listings.map((l) => `${l.label} (${l.price})`).join(", ") : "Nothing out right now."}</p>
        </article>
      ))}
    </main>
  );
}
