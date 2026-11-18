"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Me = {
  balanceCents: number;
  ledger: { id: string; ts: number; delta: number; kind: string; ref: string; balanceAfter: number }[];
  testMode: boolean;
  provider: string;
  allowanceCents: number;
};
const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

export default function Account() {
  const [me, setMe] = useState<Me | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/credits/me");
    setMe(r.ok ? await r.json() : null);
    if (!r.ok) setMsg("Credits are not available right now.");
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const post = async (url: string, body?: unknown) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? "Done." : (j.error ?? "Something went wrong."));
    load();
  };
  return (
    <main>
      <p>
        <Link href="/">← town</Link>
      </p>
      <h1>Your account</h1>
      <p className="why">
        <strong>TEST MODE.</strong> No real money is involved. Credits here are fake, cannot be withdrawn or transferred, and creatures never see or touch them.
      </p>
      {me && (
        <>
          <h2>Balance: {usd(me.balanceCents)}</h2>
          <p>
            <button onClick={() => post("/api/credits/topup", { cents: 500 })}>Add $5.00 test credits</button>{" "}
            <button onClick={() => post("/api/credits/allowance")}>Claim daily {usd(me.allowanceCents)}</button>
          </p>
          <h3>Recent activity</h3>
          <ul>
            {me.ledger.map((e) => (
              <li key={e.id}>
                {new Date(e.ts).toLocaleString()} · {e.kind} · {e.ref} · {usd(e.delta)} (balance {usd(e.balanceAfter)})
              </li>
            ))}
            {!me.ledger.length && <li>Nothing yet.</li>}
          </ul>
        </>
      )}
      {msg && <p>{msg}</p>}
    </main>
  );
}
