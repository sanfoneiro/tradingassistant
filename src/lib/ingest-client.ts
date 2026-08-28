import { readFileSync } from "fs";
import { join } from "path";

/**
 * The write path, for scripts that run outside the app.
 *
 * Extracted so there is ONE definition of how a job authenticates. The token
 * resolution order below cost real time to get right, and a second copy of it
 * is a second thing to drift.
 */

export const APP_URL =
  process.env.APP_URL?.trim() || "https://project-alr3f.vercel.app";

/**
 * Token resolution, in the order that actually works.
 *
 * `.agent-token` is the project's convention — the skills read it from there —
 * and it is gitignored. It wins locally because a stale INGEST_TOKEN in a
 * `vercel env pull`-generated .env will otherwise shadow it and produce a 401
 * that looks like a server fault. In CI there is no such file and the
 * environment variable is the only source.
 */
export function resolveToken(): { token: string; source: string } {
  try {
    const fromFile = readFileSync(join(process.cwd(), ".agent-token"), "utf8").trim();
    if (fromFile) return { token: fromFile, source: ".agent-token" };
  } catch {
    /* not present — expected in CI */
  }
  const fromEnv = process.env.INGEST_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "INGEST_TOKEN env var" };
  return { token: "", source: "nowhere" };
}

export function makeClient(token: string) {
  async function api(path: string, init?: RequestInit) {
    const res = await fetch(`${APP_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  return {
    api,
    post: (body: unknown) =>
      api("/api/ingest", { method: "POST", body: JSON.stringify(body) }),
  };
}
