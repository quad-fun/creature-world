// Admin gate: a shared secret in ADMIN_SECRET. Unset means the admin API is off (503), never open.
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time comparison (both sides hashed to equal length first). */
export function secretsMatch(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

export type AdminCheck = { ok: true } | { ok: false; status: 401 | 503 };

export function checkAdmin(req: Request): AdminCheck {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return { ok: false, status: 503 };
  const h = req.headers.get("authorization") ?? "";
  const given = h.startsWith("Bearer ") ? h.slice(7) : req.headers.get("x-admin-secret") ?? "";
  return secretsMatch(given, secret) ? { ok: true } : { ok: false, status: 401 };
}
