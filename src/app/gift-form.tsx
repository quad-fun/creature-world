"use client";

import { useState } from "react";

/** Give any small thing as free text. Pass `to` to fix the recipient (creature page), or `creatures` for a picker (town page). */
export function GiftForm({ to, creatures }: { to?: string; creatures?: { id: string; name: string; emoji: string }[] }) {
  const [target, setTarget] = useState(to ?? creatures?.[0]?.id ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState("");
  const send = async () => {
    setMsg("");
    const r = await fetch("/api/gift", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: target, name, description }),
    });
    const j = await r.json().catch(() => ({}));
    setMsg(j.message ?? j.error ?? "Something went wrong.");
    if (r.ok) {
      setName("");
      setDescription("");
    }
  };
  return (
    <div className="card">
      <b>Give a gift</b> <span className="why">(anything small: a yo-yo, a scarf, a jar of jam)</span>
      <div className="row" style={{ margin: "8px 0" }}>
        {!to && creatures && (
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {creatures.map((c) => (
              <option key={c.id} value={c.id}>
                {c.emoji} {c.name}
              </option>
            ))}
          </select>
        )}
        <input placeholder="gift name (24 characters)" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
      </div>
      <input placeholder="a short description (120 characters, English, no links)" value={description} maxLength={120} onChange={(e) => setDescription(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
      <div className="row">
        <button onClick={send} disabled={name.trim().length < 2}>
          Give it
        </button>
        <span className="why">{msg}</span>
      </div>
    </div>
  );
}
