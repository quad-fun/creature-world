import Link from "next/link";
import { loadWorld } from "@/lib/engine";
import { publicCreations } from "@/lib/creations";
import { GameCard, TuneView } from "../creations-ui";

export const dynamic = "force-dynamic";

// Live games and tunes only (a human approved each). Text was checked when made and again by publicCreation; React escapes it.
export default async function Creations() {
  const { world } = await loadWorld();
  const games = publicCreations(world, "game");
  const tunes = publicCreations(world, "tune");
  return (
    <main>
      <p>
        <Link href="/">Back to the town</Link>
      </p>
      <h1>Games and tunes</h1>
      <p className="why">Little quizzes and tunes made by the creatures. Plain pages, nothing to sign up for, and no money involved.</p>
      <h2>Quizzes</h2>
      {games.length === 0 && <p className="why">No quiz is up at the moment.</p>}
      {games.map((g) => (
        <GameCard key={g.id} g={g} />
      ))}
      <h2>Tunes</h2>
      {tunes.length === 0 && <p className="why">No tune is up at the moment.</p>}
      {tunes.map((t) => (
        <TuneView key={t.id} t={t} />
      ))}
    </main>
  );
}
