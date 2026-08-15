/**
 * The app gets deployed before Neon is attached, and agents can fail.
 * Neither should render a page full of confident zeros — that is the
 * same failure as a wrong price. Queries return null on error and the
 * UI says so out loud.
 */
export async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.error("query failed:", e);
    return null;
  }
}

export const dbConfigured = () => Boolean(process.env.DATABASE_URL);
