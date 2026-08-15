import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { makeToken, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const expected = process.env.APP_PASSWORD;
  if (!expected)
    return NextResponse.json({ error: "no password configured" }, { status: 500 });

  const { password } = await req.json().catch(() => ({ password: "" }));
  const given = String(password ?? "");

  const ok =
    given.length === expected.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(expected));

  if (!ok) return NextResponse.json({ error: "nope" }, { status: 401 });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, makeToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 3600,
  });
  return res;
}
