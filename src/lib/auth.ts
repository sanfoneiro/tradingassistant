import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

const COOKIE = "ta_session";

function secret() {
  return process.env.SESSION_SECRET ?? "";
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function makeToken() {
  const payload = String(Date.now());
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token || !secret()) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload);
  if (sig.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  // 30-day session
  const age = Date.now() - Number(payload);
  return age >= 0 && age < 30 * 24 * 3600 * 1000;
}

export async function isAuthed(): Promise<boolean> {
  // No password configured = open app. Fine for first local run, and the
  // README says to set one before the first deploy.
  if (!process.env.APP_PASSWORD) return true;
  const jar = await cookies();
  return verifyToken(jar.get(COOKIE)?.value);
}

export const SESSION_COOKIE = COOKIE;

/** Bearer auth for the scheduled agents hitting /api/ingest. */
export function checkIngestToken(header: string | null): boolean {
  const token = process.env.INGEST_TOKEN;
  if (!token) return false; // no token set = refuse writes, don't run open
  if (!header?.startsWith("Bearer ")) return false;
  const given = header.slice(7);
  if (given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}
