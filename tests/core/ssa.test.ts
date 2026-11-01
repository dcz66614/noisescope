import { describe, expect, it } from "vitest";
import type { ModelSpec } from "../../src/domain/types";
import type { RandomSource } from "../../src/core/rng";
import {
  createObservationTimes,
  reactionRates,
  simulateSampleGroup,
  simulateTrajectory,
  SsaBudgetError,
} from "../../src/core/ssa";

class SequenceRng implements RandomSource {
  private index = 0;

  constructor(private readonly values: readonly number[]) {}

  nextOpen01(): number {
    const value = this.values[this.index];
    if (value === undefined) {
      throw new Error("test RNG exhausted");
    }
    this.index += 1;
    return value;
  }

  nextUint32(): number {
    return Math.floor(this.nextOpen01() * 0x1_0000_0000) >>> 0;
  }
}

const linear: ModelSpec = {
  id: "linear",
  totalUnits: 2,
  forwardRate: 1,
  reverseRate: 1,
};

describe("SSA direct method", () => {
  it("computes legal boundary rates", () => {
    expect(reactionRates(linear, 0)).toEqual({
      birth: 2,
      death: 0,
      totalRate: 2,
    });
    expect(reactionRates(linear, 2)).toEqual({
      birth: 0,
      death: 2,
      totalRate: 2,
    });

    const dimer: ModelSpec = {
      id: "dimer",
      totalUnits: 10,
      forwardRate: 0.2,
      reverseRate: 0.3,
    };
    const dimerRates = reactionRates(dimer, 2);
    expect(dimerRates.birth).toBeCloseTo(3);
    expect(dimerRates.death).toBeCloseTo(0.6);
    expect(dimerRates.totalRate).toBeCloseTo(3.6);
  });

  it("samples right-continuously and preserves conservation and bounds", () => {
    const result = simulateTrajectory({
      model: linear,
      initialPmf: [1, 0, 0],
      horizon: 1,
      observationTimes: new Float64Array([0, 0.5, 1]),
      baseSeed: 1,
      group: "P",
      trajectoryIndex: 0,
      rng: new SequenceRng([
        0.25,
        Math.exp(-1),
        0.1,
        Math.exp(-10),
        0.9,
      ]),
    });

    expect(Array.from(result.sampledB)).toEqual([0, 1, 1]);
    expect(result.trace.events).toHaveLength(1);

    const event = result.trace.events[0]!;
    expect(event.timeAfter).toBeCloseTo(0.5);
    expect(event.timeAfter).toBeGreaterThan(event.timeBefore);
    expect(event.stateAfter).toBe(event.stateBefore + 1);
    expect(event.stateAfter).toBeGreaterThanOrEqual(0);
    expect(event.stateAfter).toBeLessThanOrEqual(linear.totalUnits);
    expect(event.birth + event.death).toBe(event.totalRate);
  });

  it("does not execute a candidate beyond the horizon", () => {
    const result = simulateTrajectory({
      model: linear,
      initialPmf: [0, 1, 0],
      horizon: 0.1,
      observationTimes: new Float64Array([0, 0.1]),
      baseSeed: 3,
      group: "Q",
      trajectoryIndex: 4,
      rng: new SequenceRng([0.5, Math.exp(-2), 0.25]),
    });

    expect(result.eventsExecuted).toBe(0);
    expect(Array.from(result.sampledB)).toEqual([1, 1]);
    expect(result.trace.terminal.reason).toBe("HORIZON");
    if (result.trace.terminal.reason === "HORIZON") {
      expect(result.trace.terminal.candidateTime).toBeGreaterThan(0.1);
      expect(result.trace.terminal.state).toBe(1);
    }
  });

  it("terminates immediately in an absorbing zero-rate state", () => {
    const frozen: ModelSpec = {
      id: "linear",
      totalUnits: 4,
      forwardRate: 0,
      reverseRate: 0,
    };
    const result = simulateTrajectory({
      model: frozen,
      initialPmf: [0, 0, 1, 0, 0],
      horizon: 8,
      observationTimes: createObservationTimes(8, 101),
      baseSeed: 9,
      group: "P",
      trajectoryIndex: 0,
    });

    expect(result.eventsExecuted).toBe(0);
    expect(new Set(result.sampledB)).toEqual(new Set([2]));
    expect(result.trace.terminal).toEqual({
      reason: "ABSORBING",
      time: 0,
      state: 2,
    });
  });

  it("enforces the event budget", () => {
    expect(() =>
      simulateTrajectory({
        model: linear,
        initialPmf: [1, 0, 0],
        horizon: 1,
        observationTimes: new Float64Array([0, 1]),
        baseSeed: 1,
        group: "P",
        trajectoryIndex: 0,
        maxEvents: 0,
      }),
    ).toThrow(SsaBudgetError);
  });

  it("is repeatable and preserves prefixes when M grows", () => {
    const options = {
      model: linear,
      initialPmf: [0.25, 0.5, 0.25],
      horizon: 2,
      observationTimes: createObservationTimes(2, 9),
      baseSeed: 20261031,
      group: "P" as const,
    };

    const small = simulateSampleGroup({ ...options, trajectories: 8 });
    const repeated = simulateSampleGroup({ ...options, trajectories: 8 });
    const large = simulateSampleGroup({ ...options, trajectories: 16 });

    expect(small).toEqual(repeated);
    expect(Array.from(large.previewB.slice(0, 8 * 9))).toEqual(
      Array.from(small.previewB),
    );

    for (let timeIndex = 0; timeIndex < 9; timeIndex += 1) {
      let total = 0;
      for (let state = 0; state <= linear.totalUnits; state += 1) {
        total += small.counts[timeIndex * 3 + state]!;
      }
      expect(total).toBe(8);
    }
  });

  it("is unchanged by external batching", () => {
    const times = createObservationTimes(1, 5);
    const full = Array.from({ length: 12 }, (_, trajectoryIndex) =>
      simulateTrajectory({
        model: linear,
        initialPmf: [0.5, 0, 0.5],
        horizon: 1,
        observationTimes: times,
        baseSeed: 77,
        group: "Q",
        trajectoryIndex,
      }).trace.sampledB,
    );

    const batched: number[][] = [];
    for (let start = 0; start < 12; start += 5) {
      for (
        let trajectoryIndex = start;
        trajectoryIndex < Math.min(start + 5, 12);
        trajectoryIndex += 1
      ) {
        batched.push(
          simulateTrajectory({
            model: linear,
            initialPmf: [0.5, 0, 0.5],
            horizon: 1,
            observationTimes: times,
            baseSeed: 77,
            group: "Q",
            trajectoryIndex,
          }).trace.sampledB,
        );
      }
    }

    expect(batched).toEqual(full);
  });
});
