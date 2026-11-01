import { describe, expect, it } from "vitest";
import {
  createTrajectoryRng,
  deriveTrajectorySeed,
  XorShift32,
} from "../../src/core/rng";

describe("xorshift32-v1", () => {
  it("matches the fixed seed=1 sequence", () => {
    const rng = new XorShift32(1);
    expect(Array.from({ length: 5 }, () => rng.nextUint32())).toEqual([
      270369,
      67634689,
      2647435461,
      307599695,
      2398689233,
    ]);
  });

  it("returns uniforms strictly inside the unit interval", () => {
    const rng = new XorShift32(1);
    for (let index = 0; index < 20_000; index += 1) {
      const value = rng.nextOpen01();
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("derives independent deterministic per-trajectory streams", () => {
    const seeds = new Set<number>();
    for (const group of ["P", "Q"] as const) {
      for (let index = 0; index < 100; index += 1) {
        const seed = deriveTrajectorySeed(20261031, group, index);
        expect(seed).not.toBe(0);
        seeds.add(seed);

        const first = createTrajectoryRng(20261031, group, index);
        const second = createTrajectoryRng(20261031, group, index);
        expect(first.nextUint32()).toBe(second.nextUint32());
      }
    }
    expect(seeds.size).toBe(200);
  });

  it("matches the frozen trajectory seed derivation vectors", () => {
    expect(deriveTrajectorySeed(20261031, "P", 0)).toBe(775094953);
    expect(deriveTrajectorySeed(20261031, "Q", 0)).toBe(1547361516);
    expect(deriveTrajectorySeed(1, "P", 0)).toBe(1927456887);
    expect(deriveTrajectorySeed(42, "Q", 3)).toBe(1604414476);
  });
});
