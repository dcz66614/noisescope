// P006 T006 独立数学验证：概率与守恒不变式（实施计划 §8.4）。
//
// 检查的生产量：CME 概率质量、生成矩阵行和、矩恒等式、漂移修正恒等式、
// 种子不变性、P/Q 交换不变性、冻结 G06、时间边界与吸收、批大小不变性、
// 随机初始 PMF。不变式本身由规格定义；oracle 仅用于闭合漂移与平稳
// 分布的独立核对。本文件不修改任何生产代码。

import { describe, expect, it } from "vitest";
import type { ModelSpec, ScenarioV1 } from "../../src/domain/types";
import { makePreset } from "../../src/domain/presets";
import { solveReference } from "../../src/core/reference";
import { buildRates, generatorRows } from "../../src/core/generator";
import { solveClosure } from "../../src/core/closure";
import {
  createObservationTimes,
  simulateSampleGroup,
  simulateTrajectory,
} from "../../src/core/ssa";
import { closureDriftOracle, dimerClosureMean } from "../oracles/closure";
import { dimerStationaryPmf } from "../oracles/stationary";
import { linearOraclePmf, momentsFromPmf } from "../oracles/linear";

function scenarioWith(
  model: ModelSpec,
  initial: { P: number[]; Q: number[] },
  horizon: number,
  seed = 1,
): ScenarioV1 {
  return {
    schemaVersion: 1,
    projectId: "P006",
    title: "T006 invariants scenario",
    model,
    initial,
    horizon,
    observations: 101,
    trajectoriesPerGroup: 64,
    seed,
    rngVersion: "xorshift32-v1",
  };
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i += 1) {
    max = Math.max(max, Math.abs(a[i]! - b[i]!));
  }
  return max;
}

const REPRESENTATIVE: Array<{ model: ModelSpec; initial: { P: number[]; Q: number[] } }> = [
  {
    model: { id: "dimer", totalUnits: 20, forwardRate: 0.02, reverseRate: 0.2 },
    initial: {
      P: (() => { const v = new Array(11).fill(0); v[5] = 1; return v; })(),
      Q: (() => { const v = new Array(11).fill(0); v[0] = 0.5; v[10] = 0.5; return v; })(),
    },
  },
  {
    model: { id: "linear", totalUnits: 20, forwardRate: 0.15, reverseRate: 0.1 },
    initial: {
      P: (() => { const v = new Array(21).fill(0); v[10] = 1; return v; })(),
      Q: (() => { const v = new Array(21).fill(0); v[0] = 0.5; v[20] = 0.5; return v; })(),
    },
  },
  {
    model: { id: "dimer", totalUnits: 10, forwardRate: 0.05, reverseRate: 0.1 },
    initial: {
      P: [0.1, 0.2, 0.4, 0.2, 0.1, 0],
      Q: [0, 0, 0.5, 0.5, 0, 0],
    },
  },
  {
    model: { id: "linear", totalUnits: 6, forwardRate: 0.3, reverseRate: 0.05 },
    initial: {
      P: [0.2, 0.2, 0.2, 0.2, 0.1, 0.05, 0.05],
      Q: [1, 0, 0, 0, 0, 0, 0],
    },
  },
];

describe("T006 invariants: probability mass and generator rows", () => {
  it("keeps PMF mass, non-negativity and tail bounds within spec at all times", () => {
    for (const { model, initial } of REPRESENTATIVE) {
      const stateCount = model.id === "linear" ? model.totalUnits + 1 : Math.floor(model.totalUnits / 2) + 1;
      for (const group of ["P", "Q"] as const) {
        const reference = solveReference(scenarioWith(model, initial, 8), group);
        for (let index = 0; index < 101; index += 1) {
          const slice = reference.pmf.subarray(index * stateCount, (index + 1) * stateCount);
          let mass = 0;
          let min = Infinity;
          for (const p of slice) {
            mass += p;
            if (p < min) min = p;
          }
          expect(Math.abs(mass - 1)).toBeLessThanOrEqual(1e-10);
          expect(min).toBeGreaterThanOrEqual(-1e-12);
          const diag = reference.numerical[index]!;
          expect(Math.abs(diag.massDefect)).toBeLessThanOrEqual(1e-10);
          expect(diag.cumulativeTailBound).toBeLessThanOrEqual(1e-12);
          expect(diag.probabilityMass).toBeCloseTo(mass, 10);
        }
      }
    }
  });

  it("has generator row sums ~0 for every representative model", () => {
    for (const { model } of REPRESENTATIVE) {
      const rows = generatorRows(buildRates(model));
      for (const row of rows) {
        const sum = row.reduce((a, b) => a + b, 0);
        expect(Math.abs(sum)).toBeLessThanOrEqual(1e-12);
      }
    }
  });

  it("satisfies moment and drift-correction identities at all times", () => {
    for (const { model, initial } of REPRESENTATIVE) {
      const stoich = model.id === "linear" ? 1 : 2;
      for (const group of ["P", "Q"] as const) {
        const reference = solveReference(scenarioWith(model, initial, 8), group);
        for (let index = 0; index < 101; index += 1) {
          expect(reference.meanA[index]).toBeCloseTo(
            model.totalUnits - stoich * reference.meanB[index]!,
            10,
          );
          expect(reference.varianceA[index]).toBeCloseTo(
            stoich * stoich * reference.varianceB[index]!,
            10,
          );
          expect(reference.exactDrift[index]).toBeCloseTo(
            reference.meanBirthRate[index]! - reference.meanDeathRate[index]!,
            10,
          );
          expect(reference.closureDriftAtExactMean[index]).toBeCloseTo(
            closureDriftOracle(model, reference.meanB[index]!),
            10,
          );
          const expectedCorrection =
            model.id === "linear"
              ? 0
              : (model.forwardRate * reference.varianceA[index]!) / 2;
          expect(reference.driftCorrection[index]).toBeCloseTo(expectedCorrection, 10);
        }
      }
    }
  });
});

describe("T006 invariants: seed, swap and frozen", () => {
  it("does not change CME, closure or theoretical initial statistics with the seed", () => {
    const { model, initial } = REPRESENTATIVE[0]!;
    const a = solveReference(scenarioWith(model, initial, 8, 1), "P");
    const b = solveReference(scenarioWith(model, initial, 8, 42), "P");
    expect(Array.from(a.pmf)).toEqual(Array.from(b.pmf));
    expect(Array.from(a.meanB)).toEqual(Array.from(b.meanB));
    expect(Array.from(a.closureMeanB)).toEqual(Array.from(b.closureMeanB));
    const closureA = solveClosure(scenarioWith(model, initial, 8, 1), "P");
    const closureB = solveClosure(scenarioWith(model, initial, 8, 999), "P");
    expect(Array.from(closureA)).toEqual(Array.from(closureB));
  });

  it("swaps CME, moments, closure and drift when P/Q initial PMFs are swapped", () => {
    const { model, initial } = REPRESENTATIVE[0]!;
    const swapped = { P: initial.Q, Q: initial.P };
    const origP = solveReference(scenarioWith(model, initial, 8), "P");
    const origQ = solveReference(scenarioWith(model, initial, 8), "Q");
    const swapP = solveReference(scenarioWith(model, swapped, 8), "P");
    const swapQ = solveReference(scenarioWith(model, swapped, 8), "Q");
    expect(Array.from(swapP.pmf)).toEqual(Array.from(origQ.pmf));
    expect(Array.from(swapQ.pmf)).toEqual(Array.from(origP.pmf));
    expect(Array.from(swapP.meanB)).toEqual(Array.from(origQ.meanB));
    expect(Array.from(swapQ.meanB)).toEqual(Array.from(origP.meanB));
    expect(Array.from(swapP.exactDrift)).toEqual(Array.from(origQ.exactDrift));
    expect(Array.from(swapQ.exactDrift)).toEqual(Array.from(origP.exactDrift));
    const closureOrigQ = solveClosure(scenarioWith(model, initial, 8), "Q");
    const closureSwapP = solveClosure(scenarioWith(model, swapped, 8), "P");
    expect(Array.from(closureSwapP)).toEqual(Array.from(closureOrigQ));
  });

  it("freezes everything for G06 zero rates (kf=kb=0)", () => {
    const scenario = makePreset("frozen");
    for (const group of ["P", "Q"] as const) {
      const reference = solveReference(scenario, group);
      const stateCount = 11;
      for (let index = 0; index < 101; index += 1) {
        const slice = reference.pmf.subarray(index * stateCount, (index + 1) * stateCount);
        expect(maxAbsDiff(slice, scenario.initial[group])).toBeLessThanOrEqual(1e-12);
        expect(reference.meanB[index]).toBeCloseTo(5, 12);
      }
      const sample = simulateSampleGroup({
        model: scenario.model,
        initialPmf: scenario.initial[group],
        horizon: scenario.horizon,
        observationTimes: createObservationTimes(scenario.horizon, 101),
        trajectories: 16,
        baseSeed: 1,
        group,
      });
      expect(sample.eventsExecuted).toBe(0);
      expect(sample.completed).toBe(16);
    }
    const rates = buildRates(scenario.model);
    expect(rates.maxExitRate).toBe(0);
  });

  it("keeps a stationary start stationary and matches the closure oracle there", () => {
    const model: ModelSpec = { id: "dimer", totalUnits: 20, forwardRate: 0.02, reverseRate: 0.2 };
    const pi = dimerStationaryPmf(model);
    const scenario = scenarioWith(model, { P: [...pi], Q: [...pi] }, 8);
    const reference = solveReference(scenario, "P");
    for (let index = 0; index < 101; index += 1) {
      const slice = reference.pmf.subarray(index * 11, (index + 1) * 11);
      expect(maxAbsDiff(slice, pi)).toBeLessThanOrEqual(1e-10);
      expect(reference.exactDrift[index]).toBeCloseTo(0, 10);
    }
    // 稳态处闭合均值不等于 CME 均值是预期的（方差修正非零），
    // 但闭合解析 oracle 与生产闭合在该初值下应一致。
    const m0 = momentsFromPmf(pi, 2, 20).meanB;
    const closure = solveClosure(scenario, "P");
    for (let index = 0; index < 101; index += 1) {
      const time = (8 * index) / 100;
      expect(closure[index]).toBeCloseTo(dimerClosureMean(model, m0, time), 7);
    }
  });
});

describe("T006 invariants: time boundaries, absorbing states and batching", () => {
  it("executes an event exactly at T and takes the new value at the final observation", () => {
    const model: ModelSpec = { id: "linear", totalUnits: 2, forwardRate: 1, reverseRate: 1 };
    // 初始 B=0，λ=2；uWaiting=e^{-2} 给出 τ=1=T。
    const result = simulateTrajectory({
      model,
      initialPmf: [1, 0, 0],
      horizon: 1,
      observationTimes: new Float64Array([0, 1]),
      baseSeed: 1,
      group: "P",
      trajectoryIndex: 0,
      // 注意：生产实现在越界检查前同时抽等待与选择（终端记录也含二者），
      // 因此事件恰在 T 之后还需再提供一对终端候选抽样，否则是测试 RNG 耗尽，
      // 不是生产缺陷（与现有 ssa.test.ts 的 5 值序列同一模式）。
      rng: new (class {
        private values = [0.5, Math.exp(-2), 0.1, Math.exp(-10), 0.9];
        private index = 0;
        nextOpen01() { return this.values[this.index++]!; }
        nextUint32() { return Math.floor(this.nextOpen01() * 0x1_0000_0000) >>> 0; }
      })(),
    });
    expect(result.eventsExecuted).toBe(1);
    expect(Array.from(result.sampledB)).toEqual([0, 1]);
  });

  it("does not execute a candidate after T and takes the old value at the final observation", () => {
    const model: ModelSpec = { id: "linear", totalUnits: 2, forwardRate: 1, reverseRate: 1 };
    const result = simulateTrajectory({
      model,
      initialPmf: [0, 1, 0],
      horizon: 0.1,
      observationTimes: new Float64Array([0, 0.1]),
      baseSeed: 3,
      group: "Q",
      trajectoryIndex: 4,
      rng: new (class {
        private values = [0.5, Math.exp(-2), 0.25];
        private index = 0;
        nextOpen01() { return this.values[this.index++]!; }
        nextUint32() { return Math.floor(this.nextOpen01() * 0x1_0000_0000) >>> 0; }
      })(),
    });
    expect(result.eventsExecuted).toBe(0);
    expect(Array.from(result.sampledB)).toEqual([1, 1]);
    expect(result.trace.terminal.reason).toBe("HORIZON");
  });

  it("absorbs correctly at kf=0, j=0 and at kb=0, j=jMax", () => {
    const frozenLow: ModelSpec = { id: "dimer", totalUnits: 20, forwardRate: 0, reverseRate: 0.2 };
    const low = simulateTrajectory({
      model: frozenLow,
      initialPmf: (() => { const v = new Array(11).fill(0); v[0] = 1; return v; })(),
      horizon: 8,
      observationTimes: createObservationTimes(8, 101),
      baseSeed: 5,
      group: "P",
      trajectoryIndex: 0,
    });
    expect(low.eventsExecuted).toBe(0);
    expect(low.trace.terminal.reason).toBe("ABSORBING");

    const frozenHigh: ModelSpec = { id: "dimer", totalUnits: 20, forwardRate: 0.02, reverseRate: 0 };
    const high = simulateTrajectory({
      model: frozenHigh,
      initialPmf: (() => { const v = new Array(11).fill(0); v[10] = 1; return v; })(),
      horizon: 8,
      observationTimes: createObservationTimes(8, 101),
      baseSeed: 5,
      group: "P",
      trajectoryIndex: 0,
    });
    expect(high.eventsExecuted).toBe(0);
    expect(high.trace.terminal.reason).toBe("ABSORBING");
  });

  it("is unchanged by batching and preserves prefixes when M grows", () => {
    const model: ModelSpec = { id: "linear", totalUnits: 4, forwardRate: 0.5, reverseRate: 0.25 };
    const initial = [0.25, 0.5, 0.25, 0, 0];
    const times = createObservationTimes(2, 9);
    const options = { model, initialPmf: initial, horizon: 2, observationTimes: times, baseSeed: 20261031, group: "P" as const };
    const small = simulateSampleGroup({ ...options, trajectories: 8 });
    const repeated = simulateSampleGroup({ ...options, trajectories: 8 });
    const large = simulateSampleGroup({ ...options, trajectories: 16 });
    expect(small).toEqual(repeated);
    expect(Array.from(large.previewB.slice(0, 8 * 9))).toEqual(Array.from(small.previewB));
    // 逐条轨迹与群组结果一致（批处理不改变随机流）
    for (let i = 0; i < 8; i += 1) {
      const single = simulateTrajectory({ ...options, trajectoryIndex: i });
      expect(Array.from(single.sampledB)).toEqual(
        Array.from(small.previewB.slice(i * 9, (i + 1) * 9)),
      );
    }
  });

  it("passes the linear oracle for a random initial PMF", () => {
    const model: ModelSpec = { id: "linear", totalUnits: 6, forwardRate: 0.3, reverseRate: 0.05 };
    const initial = [0.2, 0.2, 0.2, 0.2, 0.1, 0.05, 0.05];
    for (const t of [0, 1, 4]) {
      const scenario = scenarioWith(model, { P: initial, Q: initial }, t);
      const reference = solveReference(scenario, "P");
      const oracle = linearOraclePmf(model, initial, t);
      const prodFinal = reference.pmf.subarray(100 * 7, 101 * 7);
      expect(maxAbsDiff(prodFinal, oracle)).toBeLessThanOrEqual(1e-10);
    }
  });
});
