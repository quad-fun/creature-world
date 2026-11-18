import { advanceWorld } from "./engine";

export const clientIp = (req: Request) =>
  (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > 4000) return null;
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Nudge the world forward after responding so a drop-off is picked up quickly. */
export const tickSoon = async () => {
  try {
    await advanceWorld();
  } catch (e) {
    console.error("tick failed", e);
  }
};
