import { describe, expect, it } from "vitest";
import {
  closureDrift,
  solveClosure,
  solveClosureWithMaxStep,
} from "../../src/core/closure";
import { makePreset } from "../../src/domain/presets";
import type { ScenarioV1 } from "../../src/domain/types";

describe("mean closure", () => {
  it("uses the prescribed a(a-1) dimer drift without clipping", () => {
    expect(
      closureDrift(
        {
          id: "dimer",
          totalUnits: 4,
          forwardRate: 0.02,
          reverseRate: 0.02,
        },
        1.2,
      ),
    ).toBeCloseTo(-0.0144, 14);
  });

  it("matches the linear analytic mean", () => {
    const scenario = makePreset("linear-control");
    const closure = solveClosure(scenario, "P");
    for (let index = 0; index < closure.length; index += 1) {
      const time = (scenario.horizon * index) / 100;
      expect(closure[index]).toBeCloseTo(12 - 2 * Math.exp(-0.25 * time), 12);
    }
    expect(Array.from(solveClosure(scenario, "Q"))).toEqual(
      Array.from(closure),
    );
  });

  it("agrees with a half-step independent RK4 integration", () => {
    const scenario = makePreset("variance-split");
    const regular = solveClosureWithMaxStep(scenario, "P", 0.01);
    const refined = solveClosureWithMaxStep(scenario, "P", 0.005);
    let maximumDifference = 0;
    for (let index = 0; index < regular.length; index += 1) {
      maximumDifference = Math.max(
        maximumDifference,
        Math.abs(regular[index]! - refined[index]!),
      );
    }
    expect(maximumDifference).toBeLessThanOrEqual(1e-7);
  });

  it("keeps zero-rate closure finite and constant", () => {
    const scenario: ScenarioV1 = makePreset("frozen");
    const result = solveClosure(scenario, "P");
    expect(Array.from(result).every(Number.isFinite)).toBe(true);
    expect(Array.from(result).every((value) => value === result[0])).toBe(true);
  });
});
