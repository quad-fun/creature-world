import Link from "next/link";
import { notFound } from "next/navigation";
import { loadWorld } from "@/lib/engine";
import { findCreation, normalizeGame, parseAnswers, questionAt, resultLine, scoreGame } from "@/lib/creations";

export const dynamic = "force-dynamic";

// A quiz, played with plain HTML forms and no scripts. The answers so far travel in the URL (?a=012). Each question is a
// GET form; the last one posts to /api/game/answer, which counts the play. Scoring is done here and there from the stored
// game; the correct answers are never sent to the browser while a question is shown. Showing a result never changes the world.
export default async function Play({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ a?: string; n?: string; e?: string }> }) {
  const { id } = await params;
  const q = await searchParams;
  const { world } = await loadWorld();
  const x = findCreation(world, id, "game");
  const g = x && normalizeGame({ questions: x.questions, results: x.results });
  const maker = x && world.creatures[x.by];
  if (!x || !g || !maker) notFound();
  const joined = (typeof q.a === "string" ? q.a : "") + (typeof q.n === "string" ? q.n : "");
  const answers = parseAnswers(joined, g.questions) ?? [];
  const total = g.questions.length;
  const done = answers.length >= total;
  const score = done ? scoreGame(g.questions, answers) : 0;
  const cur = done ? null : questionAt(g, answers.length);
  const so = answers.join("");
  return (
    <main>
      <p>
        <Link href={`/s/${maker.id}`}>Back to {maker.sheet.name}&apos;s site</Link> · <Link href="/creations">All games and tunes</Link>
      </p>
      <h1>
        {maker.emoji} {x.title}
      </h1>
      <p className="why">A quiz by {maker.sheet.name}. Just for fun: no accounts, no prizes.</p>
      {done ? (
        <section>
          <h2>
            You scored {score} of {total}
          </h2>
          <p>{resultLine(g.results, score, total)}</p>
          {q.e === "slow" && <p className="why">That was a lot of quizzes for one day, so this one did not count with {maker.sheet.name}. The score is still yours.</p>}
          <p>
            <Link href={`/play/${x.id}`}>Play again</Link>
          </p>
        </section>
      ) : (
        cur && (
          <section>
            <h2>
              Question {answers.length + 1} of {total}
            </h2>
            <p>{cur.prompt}</p>
            <form method={answers.length + 1 === total ? "post" : "get"} action={answers.length + 1 === total ? "/api/game/answer" : `/play/${x.id}`}>
              {answers.length + 1 === total && <input type="hidden" name="game" value={x.id} />}
              <input type="hidden" name="a" value={so} />
              <ul className="plain">
                {cur.options.map((o, i) => (
                  <li key={i}>
                    <button type="submit" name="n" value={i}>
                      {o}
                    </button>
                  </li>
                ))}
              </ul>
            </form>
          </section>
        )
      )}
    </main>
  );
}
