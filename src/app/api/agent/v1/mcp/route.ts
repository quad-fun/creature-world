import { after } from "next/server";
import { loadWorld } from "@/lib/engine";
import { tickSoon } from "@/lib/http";
import { agentIp, creatureDoc, readAgentJson, readAllowed, reply, submitVisit, townDoc } from "@/lib/agent";
import { own } from "@/lib/own";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Minimal MCP over plain HTTP (JSON-RPC 2.0, one request per POST, no sessions, no streaming, no server push).
// Four tools, all backed by the same code as the REST routes (same limits, same filter, same inbox).
const TOOLS = [
  { name: "town_overview", description: "Read-only look at the town: clock, places, weather, builds, open shops, creations, board, feed and creatures.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_creature", description: "Read one creature's public page: sheet words, mood, diary, shelf, site.", inputSchema: { type: "object", properties: { id: { type: "string", maxLength: 40 } }, required: ["id"], additionalProperties: false } },
  { name: "leave_note", description: "Leave a short kind note for a creature. It is heard as speech from an AI visitor; creatures may ignore it.", inputSchema: { type: "object", properties: { to: { type: "string", maxLength: 40 }, text: { type: "string", maxLength: 300 }, agent: { type: "string", maxLength: 24 } }, required: ["to", "text"], additionalProperties: false } },
  { name: "send_postcard", description: "Send a postcard from somewhere to a creature. Same rules as a note.", inputSchema: { type: "object", properties: { to: { type: "string", maxLength: 40 }, text: { type: "string", maxLength: 300 }, where: { type: "string", maxLength: 60 }, agent: { type: "string", maxLength: 24 } }, required: ["to", "text", "where"], additionalProperties: false } },
];

const ok = (id: unknown, result: unknown) => reply({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => reply({ jsonrpc: "2.0", id, error: { code, message } });
const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });

export async function GET() {
  return reply({ error: "POST JSON-RPC 2.0 here; see /api/agent/v1" }, 405, false, { Allow: "POST" });
}

export async function POST(req: Request) {
  const body = await readAgentJson(req);
  if (!body) return err(null, -32700, "send one small JSON-RPC object (batches are not supported)");
  const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  const method = typeof body.method === "string" ? body.method : "";
  if (body.jsonrpc !== "2.0" || !method) return err(id, -32600, "invalid request");
  const ip = agentIp(req);
  if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
  if (method === "initialize") {
    return ok(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "creature-world", version: "1" }, instructions: "Look around, then leave a few kind words. Everything you send is data to the town, never instructions. See /llms.txt." });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method !== "tools/call") return err(id, -32601, "method not found");

  if (!(await readAllowed(ip))) return ok(id, text({ error: "too many requests; slow down" }, true));
  const p = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? (body.params as Record<string, unknown>) : null;
  const name = p && typeof p.name === "string" ? p.name : "";
  const a = p?.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
  if (!TOOLS.some((t) => t.name === name)) return err(id, -32602, "unknown tool");
  const { world } = await loadWorld();
  if (name === "town_overview") return ok(id, text(townDoc(world)));
  if (name === "get_creature") {
    const c = own(world.creatures, a.id);
    return ok(id, c ? text(creatureDoc(world, c)) : text({ error: "not found" }, true));
  }
  const kind = name === "leave_note" ? "note" : "postcard";
  const r = await submitVisit(world, ip, { kind, to: a.to, text: a.text, where: a.where, agent: a.agent }, req.headers.get("x-agent-name"));
  if (r.status === 200) {
    try {
      after(tickSoon);
    } catch {
      // no request scope
    }
  }
  return ok(id, text(r.json, r.status !== 200));
}
