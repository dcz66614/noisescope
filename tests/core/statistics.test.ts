import { describe, expect, it } from "vitest";
import { computeCdfDistance, computeComparisonSeries } from "../../src/core/diagnostics";
import { solveReference } from "../../src/core/reference";
import { makePreset } from "../../src/domain/presets";
import type { SampleGroup, ScenarioV1 } from "../../src/domain/types";

describe("reference statistics", () => {
  it("matches G01 initial moments, rates and drift corrections", () => {
    const scenario = makePreset("variance-split");
    const p = solveReference(scenario, "P");
    const q = solveReference(scenario, "Q");

    expect(p.meanB[0]).toBeCloseTo(5, 12);
    expect(q.meanB[0]).toBeCloseTo(5, 12);
    expect(p.meanA[0]).toBeCloseTo(10, 12);
    expect(q.meanA[0]).toBeCloseTo(10, 12);
    expect(p.varianceA[0]).toBeCloseTo(0, 12);
    expect(q.varianceA[0]).toBeCloseTo(100, 12);
    expect(p.meanBirthRate[0]).toBeCloseTo(0.9, 12);
    expect(q.meanBirthRate[0]).toBeCloseTo(1.9, 12);
    expect(p.meanDeathRate[0]).toBeCloseTo(1, 12);
    expect(q.meanDeathRate[0]).toBeCloseTo(1, 12);
    expect(p.exactDrift[0]).toBeCloseTo(-0.1, 12);
    expect(q.exactDrift[0]).toBeCloseTo(0.9, 12);
    expect(p.driftCorrection[0]).toBeCloseTo(0, 12);
    expect(q.driftCorrection[0]).toBeCloseTo(1, 12);
  });

  it("matches G02 analytic linear mean and variance split", () => {
    const scenario = makePreset("linear-control");
    const p = solveReference(scenario, "P");
    const q = solveReference(scenario, "Q");

    for (let index = 0; index < scenario.observations; index += 1) {
      const time = (scenario.horizon * index) / 100;
      const expectedMean = 12 - 2 * Math.exp(-0.25 * time);
      const expectedVarianceDifference = 100 * Math.exp(-0.5 * time);
      expect(p.meanB[index]).toBeCloseTo(expectedMean, 10);
      expect(q.meanB[index]).toBeCloseTo(expectedMean, 10);
      expect(q.varianceB[index]! - p.varianceB[index]!).toBeCloseTo(
        expectedVarianceDifference,
        10,
      );
      expect(p.driftCorrection[index]).toBeCloseTo(0, 10);
      expect(q.driftCorrection[index]).toBeCloseTo(0, 10);
    }
  });

  it("matches G04 stationary moments and correction", () => {
    const scenario: ScenarioV1 = {
      schemaVersion: 1,
      projectId: "P006",
      title: "G04",
      model: {
        id: "dimer",
        totalUnits: 4,
        forwardRate: 0.02,
        reverseRate: 0.02,
      },
      initial: {
        P: [0.1, 0.6, 0.3],
        Q: [0.1, 0.6, 0.3],
      },
      horizon: 20,
      observations: 101,
      trajectoriesPerGroup: 64,
      seed: 1,
      rngVersion: "xorshift32-v1",
    };
    const reference = solveReference(scenario, "P");
    expect(reference.meanB[100]).toBeCloseTo(1.2, 10);
    expect(reference.varianceB[100]).toBeCloseTo(0.36, 10);
    expect(reference.meanA[100]).toBeCloseTo(1.6, 10);
    expect(reference.varianceA[100]).toBeCloseTo(1.44, 10);
    expect(reference.exactDrift[100]).toBeCloseTo(0, 10);
    expect(reference.closureDriftAtExactMean[100]).toBeCloseTo(-0.0144, 10);
    expect(reference.driftCorrection[100]).toBeCloseTo(0.0144, 10);
  });

  it("computes empirical CDF distance and comparison units separately", () => {
    expect(computeCdfDistance([1, 1], [0.25, 0.75], 2)).toBeCloseTo(0.25);

    const scenario = makePreset("frozen");
    const reference = solveReference(scenario, "P");
    const stateCount = scenario.model.totalUnits / 2 + 1;
    const counts = new Uint32Array(reference.pmf.length);
    for (let timeIndex = 0; timeIndex < scenario.observations; timeIndex += 1) {
      counts[timeIndex * stateCount + 5] = 64;
    }
    const sample: SampleGroup = {
      counts,
      completed: 64,
      meanB: new Float64Array(scenario.observations).fill(5),
      varianceB: new Float64Array(scenario.observations),
      previewB: new Uint8Array(32 * scenario.observations),
      eventsExecuted: 0,
    };
    const comparison = computeComparisonSeries(reference, sample, stateCount);
    expect(comparison.meanGap[0]).toBeCloseTo(0);
    expect(comparison.samplingError[0]).toBeCloseTo(0);
    expect(comparison.cdfDistance[0]).toBeCloseTo(0);
    expect(comparison.driftCorrection).toBe(reference.driftCorrection);
  });
});
