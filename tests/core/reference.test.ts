import { describe, expect, it } from "vitest";
import { buildRates, generatorRows } from "../../src/core/generator";
import {
  multiplyByUniformizedTransition,
  poissonTailBound,
  solveAtTime,
  uniformizationStep,
} from "../../src/core/uniformization";

function expectCloseArray(
  actual: ArrayLike<number>,
  expected: readonly number[],
  tolerance = 1e-10,
): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(Math.abs(actual[index]! - expected[index]!)).toBeLessThanOrEqual(
      tolerance,
    );
  }
}

describe("birth/death generator", () => {
  it("builds G04 dimer rates and zero-sum generator rows", () => {
    const rates = buildRates({
      id: "dimer",
      totalUnits: 4,
      forwardRate: 0.02,
      reverseRate: 0.02,
    });

    expectCloseArray(rates.birth, [0.12, 0.02, 0]);
    expectCloseArray(rates.death, [0, 0.02, 0.04]);
    expect(rates.maxExitRate).toBeCloseTo(0.12, 15);

    const rows = generatorRows(rates);
    expectCloseArray(rows[0]!, [-0.12, 0.12, 0]);
    expectCloseArray(rows[1]!, [0.02, -0.04, 0.02]);
    expectCloseArray(rows[2]!, [0, 0.04, -0.04]);

    for (const row of rows) {
      const rowSum = Array.from(row).reduce((sum, value) => sum + value, 0);
      expect(Math.abs(rowSum)).toBeLessThanOrEqual(1e-15);
    }
  });

  it("produces a row-stochastic uniformized transition", () => {
    const rates = buildRates({
      id: "linear",
      totalUnits: 4,
      forwardRate: 1,
      reverseRate: 1,
    });

    for (let state = 0; state < rates.birth.length; state += 1) {
      const basis = new Float64Array(rates.birth.length);
      basis[state] = 1;
      const row = multiplyByUniformizedTransition(basis, rates);
      const rowSum = Array.from(row).reduce(
        (sum, probability) => sum + probability,
        0,
      );

      expect(Math.abs(rowSum - 1)).toBeLessThanOrEqual(1e-15);
      expect(Math.min(...row)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("uniformization reference values", () => {
  it("matches G03 complete linear distribution", () => {
    const rates = buildRates({
      id: "linear",
      totalUnits: 4,
      forwardRate: 1,
      reverseRate: 1,
    });
    const initial = new Float64Array([1, 0, 0, 0, 0]);
    const result = solveAtTime(initial, rates, Math.log(2) / 2);

    expectCloseArray(
      result.probability,
      [81 / 256, 108 / 256, 54 / 256, 12 / 256, 1 / 256],
    );
    expect(Math.abs(result.diagnostics.massDefect)).toBeLessThanOrEqual(1e-10);
    expect(result.diagnostics.minProbability).toBeGreaterThanOrEqual(-1e-14);
    expect(result.diagnostics.cumulativeTailBound).toBeLessThanOrEqual(1e-12);
    expect(result.diagnostics.termsUsed).toBeGreaterThan(0);
  });

  it("keeps the G04 stationary distribution unchanged", () => {
    const rates = buildRates({
      id: "dimer",
      totalUnits: 4,
      forwardRate: 0.02,
      reverseRate: 0.02,
    });
    const stationary = new Float64Array([0.1, 0.6, 0.3]);
    const result = solveAtTime(stationary, rates, 20);

    expectCloseArray(result.probability, [0.1, 0.6, 0.3]);
    expect(Math.abs(result.diagnostics.massDefect)).toBeLessThanOrEqual(1e-10);
  });

  it("preserves a zero-rate distribution exactly", () => {
    const rates = buildRates({
      id: "linear",
      totalUnits: 4,
      forwardRate: 0,
      reverseRate: 0,
    });
    const initial = new Float64Array([0.1, 0.2, 0.3, 0.25, 0.15]);
    const result = uniformizationStep(initial, rates, 100);

    expect(Array.from(result.probability)).toEqual(Array.from(initial));
    expect(result.diagnostics.termsUsed).toBe(1);
    expect(result.diagnostics.cumulativeTailBound).toBe(0);
    expect(Math.abs(result.diagnostics.massDefect)).toBeLessThanOrEqual(1e-15);
  });

  it("only evaluates the geometric Poisson bound when n + 2 > z", () => {
    expect(poissonTailBound(0.1, 4, 2)).toBe(Number.POSITIVE_INFINITY);
    expect(poissonTailBound(0.1, 4, 3)).toBeCloseTo(0.5, 15);
  });
});
