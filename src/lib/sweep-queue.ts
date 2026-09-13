/**
 * What the sweep looks at, and in what order.
 *
 * Three sources, and they answer different questions:
 *
 *   explicit   symbols named on the command line — the operator asked for
 *              exactly these and gets exactly these, core list included or
 *              not. An override that quietly swept eight extra names would
 *              not be an override.
 *   core       the focus list. Swept EVERY run whatever the filter returned,
 *              because that is the entire promise of a focus list.
 *   base       the saved screen, or the whole bars store under --wide.
 *
 * Core goes first, and that ordering is load-bearing rather than cosmetic:
 * runs are capped (`--limit`, and CI is capped by the 5 req/min data plan),
 * and a focus list that lands past the cap on a busy week is a focus list
 * that silently did nothing. Putting it at the front means the cap eats the
 * wide tail, which is the part that can afford to wait a day.
 *
 * The cap still applies to the total. A limit below the core count therefore
 * DOES drop core names — it is an explicit instruction and is obeyed — but
 * `dropped` names them so the run can say so out loud instead of appearing
 * to have covered the list.
 */
export type QueuePlan = {
  queue: string[];
  /** Core names that made it in, in queue order. */
  core: string[];
  /** Core names the limit cut. Empty in every normal run. */
  dropped: string[];
};

export function buildQueue(p: {
  explicit?: string[];
  core?: string[];
  /** The saved screen, or the bars store under --wide. */
  base: string[];
  limit: number;
}): QueuePlan {
  const explicit = p.explicit ?? [];
  if (explicit.length)
    return { queue: explicit, core: [], dropped: [] };

  const core = p.core ?? [];
  const seen = new Set<string>();
  const queue: string[] = [];
  // Core first, then the base with duplicates dropped — a core name the
  // filter also returned is swept once, not twice.
  for (const s of [...core, ...p.base]) {
    if (seen.has(s)) continue;
    seen.add(s);
    queue.push(s);
  }

  const capped = queue.slice(0, Math.max(0, p.limit));
  const inQueue = new Set(capped);
  return {
    queue: capped,
    core: core.filter((s) => inQueue.has(s)),
    dropped: core.filter((s) => !inQueue.has(s)),
  };
}
