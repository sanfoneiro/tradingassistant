import { describe, it, expect } from "vitest";
import {
  replaySignal,
  summariseReplays,
  fillPrice,
  type Bar,
  type Signal,
} from "./replay";

/**
 * This file is the instrument's calibration, and it matters more than most
 * tests here. Everything downstream — whether A grades beat C, whether the
 * vetoes earn their keep, what was left on the table — is this engine's
 * output. A replay that is quietly wrong would not fail loudly; it would
 * re-rank the whole method with confident numbers.
 *
 * So every case below has an answer known by construction.
 */

/** Bars from plain [o,h,l,c] rows, one session apart. */
const mk = (rows: [number, number, number, number][]): Bar[] =>
  rows.map(([o, h, l, c], i) => ({
    t: Date.UTC(2026, 0, 5 + i),
    o,
    h,
    l,
    c,
  }));

const LONG: Signal = {
  symbol: "TEST",
  side: "long",
  entryLow: 99,
  entryHigh: 100,
  stop: 95,
  target: 110,
};

const SHORT: Signal = {
  symbol: "TEST",
  side: "short",
  entryLow: 100,
  entryHigh: 101,
  stop: 105,
  target: 90,
};

describe("fillPrice — where a resting order actually fills", () => {
  it("long approaching from above fills at the top of the zone", () => {
    // opens at 103, dips to 99.5 — the first price touched inside is 100
    expect(fillPrice("long", mk([[103, 104, 99.5, 101]])[0], 99, 100)).toBe(100);
  });

  it("long that opens inside the zone fills at the open", () => {
    expect(fillPrice("long", mk([[99.5, 101, 99.2, 100]])[0], 99, 100)).toBe(99.5);
  });

  it("long that gaps clean through fills at the open, which is better", () => {
    expect(fillPrice("long", mk([[96, 97, 95.5, 96]])[0], 99, 100)).toBe(96);
  });

  it("long that never comes down does not fill", () => {
    expect(fillPrice("long", mk([[103, 105, 101, 104]])[0], 99, 100)).toBeNull();
  });

  it("a one-cent touch is a fill, by decision", () => {
    expect(fillPrice("long", mk([[103, 104, 99.99, 103]])[0], 99, 100)).toBe(100);
  });

  it("short approaching from below fills at the bottom of the zone", () => {
    expect(fillPrice("short", mk([[97, 100.5, 96, 99]])[0], 100, 101)).toBe(100);
  });

  it("short that gaps above fills at the open", () => {
    expect(fillPrice("short", mk([[104, 106, 103, 105]])[0], 100, 101)).toBe(104);
  });
});

describe("replaySignal — the four outcomes", () => {
  it("never triggered: price walks away and never comes back", () => {
    const bars = mk([
      [105, 107, 104, 106],
      [106, 109, 105, 108],
      [108, 112, 107, 111],
    ]);
    const r = replaySignal(LONG, bars);
    expect(r.resolution).toBe("never_triggered");
    expect(r.entryPrice).toBeNull();
    expect(r.rGross).toBeNull();
  });

  it("hit target: fills, then reaches 110 before 95", () => {
    const bars = mk([
      [103, 104, 99.5, 101], // fills at 100
      [101, 105, 100, 104],
      [104, 111, 103, 110], // target
    ]);
    const r = replaySignal(LONG, bars);
    expect(r.resolution).toBe("hit_target");
    expect(r.entryPrice).toBe(100);
    expect(r.exitPrice).toBe(110);
    expect(r.barsToTrigger).toBe(0);
    expect(r.barsHeld).toBe(2);
    // risked 5 to make 10
    expect(r.rGross).toBeCloseTo(2, 6);
  });

  it("hit stop: fills, then reaches 95 before 110", () => {
    const bars = mk([
      [103, 104, 99.5, 101],
      [100, 101, 94, 96], // stop
    ]);
    const r = replaySignal(LONG, bars);
    expect(r.resolution).toBe("hit_stop");
    expect(r.exitPrice).toBe(95);
    expect(r.rGross).toBeCloseTo(-1, 6);
  });

  it("ambiguous: one session covers both levels, so the order is unknowable", () => {
    const bars = mk([
      [103, 104, 99.5, 101],
      [100, 111, 94, 105], // range spans stop AND target
    ]);
    const r = replaySignal(LONG, bars);
    expect(r.resolution).toBe("ambiguous");
    expect(r.rGross).toBeNull(); // NOT counted as either
    expect(r.note).toMatch(/cannot say which came first/);
  });

  it("unresolved: fills, then goes nowhere inside the window", () => {
    const bars = mk([
      [103, 104, 99.5, 101],
      ...Array.from({ length: 5 }, () => [100, 101, 99, 100] as [number, number, number, number]),
    ]);
    const r = replaySignal(LONG, bars, { resolveWindow: 3 });
    expect(r.resolution).toBe("unresolved");
    expect(r.entryPrice).toBe(100);
    expect(r.rGross).toBeNull();
  });
});

describe("replaySignal — shorts run in the opposite direction", () => {
  it("a short that falls to its target wins", () => {
    const bars = mk([
      [97, 100.5, 96, 99], // fills at 100
      [99, 99.5, 89, 90], // target 90
    ]);
    const r = replaySignal(SHORT, bars);
    expect(r.resolution).toBe("hit_target");
    expect(r.entryPrice).toBe(100);
    expect(r.rGross).toBeCloseTo(2, 6); // risked 5 to make 10
  });

  it("a short that rallies to its stop loses", () => {
    const bars = mk([
      [97, 100.5, 96, 99],
      [100, 106, 99, 105], // stop 105
    ]);
    const r = replaySignal(SHORT, bars);
    expect(r.resolution).toBe("hit_stop");
    expect(r.rGross).toBeCloseTo(-1, 6);
  });

  it("a rising tape never fills a short waiting above — and that is not a loss", () => {
    const bars = mk([
      [95, 98, 94, 97],
      [97, 99, 96, 98],
    ]);
    expect(replaySignal(SHORT, bars).resolution).toBe("never_triggered");
  });
});

describe("windows", () => {
  it("a fill outside the trigger window does not count", () => {
    const bars = mk([
      [105, 107, 104, 106],
      [106, 108, 105, 107],
      [107, 108, 99, 100], // comes back on bar 3
    ]);
    expect(replaySignal(LONG, bars, { triggerWindow: 2 }).resolution).toBe(
      "never_triggered",
    );
    expect(replaySignal(LONG, bars, { triggerWindow: 3 }).triggerIdx).toBe(2);
  });

  it("can trigger and resolve inside the same session", () => {
    const bars = mk([[103, 111, 99.5, 110]]); // dips to the zone, then runs
    const r = replaySignal(LONG, bars);
    expect(r.resolution).toBe("hit_target");
    expect(r.barsHeld).toBe(0);
  });
});

describe("misparsed levels are refused, not computed", () => {
  it("a long whose stop sits above the fill is rejected", () => {
    const bars = mk([[103, 104, 99.5, 101]]);
    const r = replaySignal({ ...LONG, stop: 102 }, bars);
    expect(r.resolution).toBe("bad_input");
    expect(r.note).toMatch(/misparsed/);
  });

  it("a long whose target sits below the fill is rejected", () => {
    const bars = mk([[103, 104, 99.5, 101]]);
    const r = replaySignal({ ...LONG, target: 98 }, bars);
    expect(r.resolution).toBe("bad_input");
    expect(r.note).toMatch(/misparsed/);
  });

  /**
   * The one that actually bit: a trailing full stop in "$95.20." parsed to
   * NaN. Every comparison against NaN is false, so the replay sailed past the
   * stop check and reported a confident hit_stop with no entry price.
   */
  it("a NaN level is refused rather than compared", () => {
    const bars = mk([
      [103, 104, 99.5, 101],
      [100, 101, 94, 96],
    ]);
    for (const broken of [
      { ...LONG, entryHigh: NaN },
      { ...LONG, stop: NaN },
      { ...LONG, target: NaN },
    ]) {
      const r = replaySignal(broken, bars);
      expect(r.resolution).toBe("bad_input");
      expect(r.rGross).toBeNull();
      expect(r.note).toMatch(/not a number/);
    }
  });
});

/**
 * A gap that carries price through the entry zone AND past the stop in one
 * move is a real outcome, not a parse error — it is what a resting order
 * through an event actually costs. FSLR did it: the 236-240 zone opened at
 * 224.10, already below its own 225 stop.
 */
describe("gapping clean through the entry and the stop", () => {
  it("is reported as gapped_through, not as a loss or a bad level", () => {
    // long zone 99-100, stop 95 — opens at 93, below both
    const bars = mk([[93, 94, 92, 93]]);
    const r = replaySignal(LONG, bars);
    expect(r.resolution).toBe("gapped_through");
    expect(r.entryPrice).toBe(93);
    expect(r.rGross).toBeNull(); // magnitude is unknowable from a daily bar
    expect(r.note).toMatch(/gapped through/);
  });

  it("does the same for a short that gaps up past its stop", () => {
    // short zone 100-101, stop 105 — opens at 108
    const bars = mk([[108, 109, 107, 108]]);
    const r = replaySignal(SHORT, bars);
    expect(r.resolution).toBe("gapped_through");
    expect(r.rGross).toBeNull();
  });

  it("is kept out of the win rate and counted on its own", () => {
    const s = summariseReplays([replaySignal(LONG, mk([[93, 94, 92, 93]]))]);
    expect(s.gappedThrough).toBe(1);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(s.winRate).toBeNull();
  });
});

describe("fees are charged in R", () => {
  it("a $4 round trip against a $76.27 budget costs about 0.05R", () => {
    const bars = mk([
      [103, 104, 99.5, 101],
      [104, 111, 103, 110],
    ]);
    const r = replaySignal(LONG, bars, { fees: 4, riskBudget: 76.27 });
    expect(r.rGross).toBeCloseTo(2, 6);
    expect(r.rNet).toBeCloseTo(2 - 4 / 76.27, 6);
    expect(r.rNet!).toBeLessThan(r.rGross!);
  });

  it("with no budget, net is null rather than silently equal to gross", () => {
    const bars = mk([
      [103, 104, 99.5, 101],
      [104, 111, 103, 110],
    ]);
    expect(replaySignal(LONG, bars, { fees: 4 }).rNet).toBeNull();
  });
});

describe("summariseReplays keeps the unknowables visible", () => {
  const bars = {
    win: mk([
      [103, 104, 99.5, 101],
      [104, 111, 103, 110],
    ]),
    loss: mk([
      [103, 104, 99.5, 101],
      [100, 101, 94, 96],
    ]),
    none: mk([[105, 107, 104, 106]]),
    amb: mk([
      [103, 104, 99.5, 101],
      [100, 111, 94, 105],
    ]),
  };

  it("excludes ambiguous and unfilled from the win rate, and reports them", () => {
    const rs = [
      replaySignal(LONG, bars.win),
      replaySignal(LONG, bars.win),
      replaySignal(LONG, bars.loss),
      replaySignal(LONG, bars.none),
      replaySignal(LONG, bars.amb),
    ];
    const s = summariseReplays(rs);
    expect(s.n).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.ambiguous).toBe(1);
    expect(s.neverTriggered).toBe(1);
    // 2 of the 3 that actually resolved — not 2 of 5
    expect(s.winRate).toBeCloseTo(2 / 3, 6);
    expect(s.totalR).toBeCloseTo(2 + 2 - 1, 6);
  });

  it("an empty book has no win rate rather than a zero one", () => {
    const s = summariseReplays([]);
    expect(s.winRate).toBeNull();
    expect(s.avgR).toBeNull();
  });
});
