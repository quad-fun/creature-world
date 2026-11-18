import Link from "next/link";
import { notFound } from "next/navigation";
import { loadWorld } from "@/lib/engine";
import { own } from "@/lib/own";
import { publicDiary, renderSvg } from "@/lib/library";
import { PRICE_MAX, VISITOR_DAILY_COINS, findReceipt, publicShop } from "@/lib/shops";

export const dynamic = "force-dynamic";

// A creature's website: one fixed, static template. Everything shown is already-checked text or a
// server-rendered whitelist drawing; React escapes the text. No scripts, forms, external links or images.
const SHOP_ERRORS: Record<string, string> = {
  coins: "Not enough visitor coins left today.",
  slow: "Slow down a little; try again later.",
  closed: "That shop is not open.",
  gone: "That listing is gone.",
  busy: "The shop has sold enough for today.",
};

export default async function SitePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ r?: string; e?: string }> }) {
  const { id } = await params;
  const q = await searchParams;
  const { world } = await loadWorld();
  const c = own(world.creatures, id);
  if (!c?.site) notFound();
  const diary = publicDiary(c);
  const shop = publicShop(world, c);
  const receipt = findReceipt(world, q.r);
  const err = typeof q.e === "string" && Object.hasOwn(SHOP_ERRORS, q.e) ? SHOP_ERRORS[q.e] : null;
  return (
    <main>
      <h1>
        {c.emoji} {c.site.title}
      </h1>
      <p className="why">
        <i>{c.site.tagline}</i> · by {c.sheet.name}
      </p>
      {shop && (
        <section id="shop">
          <h2>{shop.title}</h2>
          <p className="why">
            <i>{shop.tagline}</i>
          </p>
          {receipt && <p className="card">{receipt.text}</p>}
          {!receipt && typeof q.r === "string" && /^[a-f0-9]{12}$/.test(q.r) && <p className="why">Your purchase is on its way; reload in a moment for the receipt.</p>}
          {err && <p className="card">{err}</p>}
          {shop.listings.length === 0 && <p className="why">Nothing is out on the shop shelf right now.</p>}
          <ul className="plain">
            {shop.listings.map((l) => (
              <li key={l.id}>
                {l.label} <small className="clock">{l.kind}</small> · {l.price} visitor coins
                <form method="post" action="/api/shop/buy" style={{ display: "inline", marginLeft: 8 }}>
                  <input type="hidden" name="creature" value={shop.id} />
                  <input type="hidden" name="listing" value={l.id} />
                  <button type="submit">Buy</button>
                </form>
              </li>
            ))}
          </ul>
          <p className="why">
            Visitor coins are play money for this town only: {VISITOR_DAILY_COINS} a day each, prices 1 to {PRICE_MAX}. They are not real money and cannot be bought.
          </p>
        </section>
      )}
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
