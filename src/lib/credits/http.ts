import { NextResponse } from "next/server";
import { accountFromRequest, setCookieHeader } from "./cookie";

/** Resolve the account (creating one if needed) and wrap JSON replies so the cookie is set when new. */
export function withAccount(req: Request) {
  let acct: { id: string; isNew: boolean };
  try {
    acct = accountFromRequest(req);
  } catch (e) {
    return { error: NextResponse.json({ error: "credits are not configured" }, { status: 503 }) };
  }
  const json = (body: unknown, status = 200) => {
    const res = NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
    if (acct.isNew) res.headers.append("set-cookie", setCookieHeader(acct.id));
    return res;
  };
  return { id: acct.id, json };
}
