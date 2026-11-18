// Account identity: an opaque random account id in a signed httpOnly cookie. No passwords, emails or wallets.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "cw_acct";
const DEV_SECRET = "dev-only-credits-secret-not-for-production";

export function secret(env: Record<string, string | undefined> = process.env): string {
  if (env.CREDITS_SECRET) return env.CREDITS_SECRET;
  if (env.VERCEL_ENV === "production") throw new Error("CREDITS_SECRET is required in production");
  return DEV_SECRET;
}

const mac = (id: string, key: string) => createHmac("sha256", key).update(id).digest("base64url");

export const newAccountId = () => "a_" + randomBytes(12).toString("base64url");

export function sign(id: string, key = secret()): string {
  return `${id}.${mac(id, key)}`;
}

/** Returns the account id, or null if the value is malformed or the signature does not match. */
export function verify(value: string | null | undefined, key = secret()): string | null {
  if (!value) return null;
  const i = value.lastIndexOf(".");
  if (i < 3) return null;
  const id = value.slice(0, i);
  if (!/^a_[A-Za-z0-9_-]{8,40}$/.test(id)) return null;
  const a = Buffer.from(value.slice(i + 1));
  const b = Buffer.from(mac(id, key));
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

export function readCookie(header: string | null, name = COOKIE): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function setCookieHeader(id: string, env: Record<string, string | undefined> = process.env): string {
  const secure = env.VERCEL_ENV ? "; Secure" : "";
  return `${COOKIE}=${sign(id, secret(env))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`;
}

/** Existing account from the request cookie, or a fresh id (isNew) that the caller must set on the response. */
export function accountFromRequest(req: Request): { id: string; isNew: boolean } {
  const id = verify(readCookie(req.headers.get("cookie")));
  return id ? { id, isNew: false } : { id: newAccountId(), isNew: true };
}
