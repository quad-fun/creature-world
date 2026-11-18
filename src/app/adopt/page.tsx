"use client";

import Link from "next/link";
import { useState } from "react";

export default function Adopt() {
  const [f, setF] = useState({ name: "", species: "otter", temperament: "", likes: "", dislikes: "", voice: "" });
  const [msg, setMsg] = useState("");
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  const submit = async () => {
    setMsg("");
    const r = await fetch("/api/adopt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...f, temperament: list(f.temperament), likes: list(f.likes), dislikes: list(f.dislikes) }),
    });
    const j = await r.json().catch(() => ({}));
    setMsg(j.message ?? j.error ?? "Something went wrong.");
  };

  return (
    <main>
      <p>
        <Link href="/">← town</Link>
      </p>
      <h1>Adopt a creature</h1>
      <p className="why">
        Describe who they are. They arrive at the nests and live their own life from there. You can visit them, leave notes and bread, and read their diary, but you cannot control them. Their feelings are modelled, not real.
      </p>
      <div className="form">
        <label>
          Name
          <input value={f.name} maxLength={20} onChange={set("name")} />
        </label>
        <label>
          Species
          <select value={f.species} onChange={set("species")}>
            <option value="otter">otter (crafts mended things)</option>
            <option value="magpie">magpie (crafts shiny trinkets)</option>
            <option value="toad">toad (brews herbal potions)</option>
          </select>
        </label>
        <label>
          Temperament (up to 3, comma separated)
          <input value={f.temperament} placeholder="curious, stubborn, kind" onChange={set("temperament")} />
        </label>
        <label>
          Likes (up to 5)
          <input value={f.likes} placeholder="bread, rain, shiny, quiet" onChange={set("likes")} />
        </label>
        <label>
          Dislikes (up to 3)
          <input value={f.dislikes} placeholder="crowds, hurry" onChange={set("dislikes")} />
        </label>
        <label>
          Voice
          <input value={f.voice} maxLength={120} placeholder="Short sentences. Dry humour." onChange={set("voice")} />
        </label>
        <div>
          <button onClick={submit}>Adopt</button> <span className="why">{msg}</span>
        </div>
      </div>
    </main>
  );
}
