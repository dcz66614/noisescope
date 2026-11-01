// P006 T006 独立数学验证：oracle 对照（G01–G05、闭合、RNG、单步）。
//
// 独立性：本文件比较生产结果与 tests/oracles/ 的独立推导；
// oracle 文件本身不导入任何生产代码（grep 可验证）。
// 黄金数值取自项目书 §13，容差按规格：G01 表 1e-12，分布/矩 1e-10，
// 闭合解析对照 1e-7。发现生产缺陷时本文件应失败并保留差值，
// 不得更换种子、不得改 oracle 去迁就生产结果。

import { describe, expect, it } from "vitest";
import type { ModelSpec, ScenarioV1 } from "../../src/domain/types";
import { makePreset } from "../../src/domain/presets";
import { solveReference } from "../../src/core/reference";
import { solveClosure, solveClosureWithMaxStep } from "../../src/core/closure";
import { reactionRates, simulateTrajectory } from "../../src/core/ssa";
import { XorShift32, deriveTrajectorySeed, createTrajectoryRng } from "../../src/core/rng";
import { sampleInitialState } from "../../src/core/ssa";
import type { RandomSource } from "../../src/core/rng";
import {
  linearOraclePmf,
  momentsFromPmf,
  linearClosureMean,
} from "../oracles/linear";
import {
  dimerStationaryPmf,
  dimerGeneratorRows,
  piTimesQ,
  dimerMomentsFromPmf,
} from "../oracles/stationary";
import { closureDriftOracle, dimerClosureMean } from "../oracles/closure";
import { oracleRates, oracleSingleStep } from "../oracles/event";
import {
  OracleXorShift32,
  FROZEN_TRAJECTORY_SEEDS,
  SEED_ONE_FIRST_FIVE,
  oracleSampleInitialState,
} from "../oracles/rng";

function scenarioWith(
  model: ModelSpec,
  initial: { P: number[]; Q: number[] },
  horizon: number,
  seed = 1,
): ScenarioV1 {
  return {
    schemaVersion: 1,
    projectId: "P006",
    title: "T006 oracle scenario",
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

class FixedRng implements RandomSource {
  private index = 0;
  constructor(private readonly values: readonly number[]) {}
  nextOpen01(): number {
    const value = this.values[this.index];
    if (value === undefined) throw new Error("test RNG exhausted");
    this.index += 1;
    return value;
  }
  nextUint32(): number {
    return Math.floor(this.nextOpen01() * 0x1_0000_0000) >>> 0;
  }
}

describe("T006 oracle: G01 dimer same-mean counterexample", () => {
  it("matches the §13 G01 table at t=0 to 1e-12", () => {
    const scenario = makePreset("variance-split");
    const p = solveReference(scenario, "P");
    const q = solveReference(scenario, "Q");
    const tol = 1e-12;
    expect(p.meanB[0]).toBeCloseTo(5, 12);
    expect(q.meanB[0]).toBeCloseTo(5, 12);
    expect(p.meanA[0]).toBeCloseTo(10, 12);
    expect(q.meanA[0]).toBeCloseTo(10, 12);
    expect(p.varianceB[0]).toBeCloseTo(0, 12);
    expect(q.varianceB[0]).toBeCloseTo(25, 12);
    expect(p.varianceA[0]).toBeCloseTo(0, 12);
    expect(q.varianceA[0]).toBeCloseTo(100, 12);
    expect(p.meanBirthRate[0]).toBeCloseTo(0.9, 12);
    expect(q.meanBirthRate[0]).toBeCloseTo(1.9, 12);
    expect(p.meanDeathRate[0]).toBeCloseTo(1, 12);
    expect(q.meanDeathRate[0]).toBeCloseTo(1, 12);
    expect(p.exactDrift[0]).toBeCloseTo(-0.1, 12);
    expect(q.exactDrift[0]).toBeCloseTo(0.9, 12);
    expect(p.closureDriftAtExactMean[0]).toBeCloseTo(-0.1, 12);
    expect(q.closureDriftAtExactMean[0]).toBeCloseTo(-0.1, 12);
    expect(p.driftCorrection[0]).toBeCloseTo(0, 12);
    expect(q.driftCorrection[0]).toBeCloseTo(1, 12);
    // 闭合漂移与漂移修正的独立公式核对
    const model = scenario.model;
    expect(p.closureDriftAtExactMean[0]).toBeCloseTo(
      closureDriftOracle(model, 5),
      12,
    );
    expect(q.driftCorrection[0]).toBeCloseTo(
      (model.forwardRate * q.varianceA[0]!) / 2,
      12,
    );
    expect(Math.abs(p.meanB[0]! - 5)).toBeLessThanOrEqual(tol);
  });
});

describe("T006 oracle: G02/G03 linear distribution", () => {
  it("matches G02 analytic mean and variance split at all observations", () => {
    const scenario = makePreset("linear-control");
    const p = solveReference(scenario, "P");
    const q = solveReference(scenario, "Q");
    for (let index = 0; index < 101; index += 1) {
      const time = (scenario.horizon * index) / 100;
      expect(p.meanB[index]).toBeCloseTo(12 - 2 * Math.exp(-0.25 * time), 10);
      expect(q.meanB[index]).toBeCloseTo(12 - 2 * Math.exp(-0.25 * time), 10);
      expect(q.varianceB[index]! - p.varianceB[index]!).toBeCloseTo(
        100 * Math.exp(-0.5 * time),
        10,
      );
      expect(p.driftCorrection[index]).toBeCloseTo(0, 10);
      expect(q.driftCorrection[index]).toBeCloseTo(0, 10);
    }
  });

  it("matches the linear binomial-convolution oracle at several times (1e-10)", () => {
    const model: ModelSpec = { id: "linear", totalUnits: 20, forwardRate: 0.15, reverseRate: 0.1 };
    const cases: Array<{ initial: number[]; times: number[] }> = [
      { initial: (() => { const v = new Array(21).fill(0); v[10] = 1; return v; })(), times: [0, 0.8, 2, 8] },
      { initial: (() => { const v = new Array(21).fill(0); v[0] = 0.5; v[20] = 0.5; return v; })(), times: [0, 2, 8] },
    ];
    for (const c of cases) {
      for (const t of c.times) {
        const scenario = scenarioWith(model, { P: c.initial, Q: c.initial }, t === 0 ? 0 : t);
        // horizon=0 时观测全部为 0；用 horizon=t 的最终观测点对照 oracle 在 t 处的值。
        const reference = solveReference(scenario, "P");
        const oracle = linearOraclePmf(model, c.initial, t);
        const prodFinal = reference.pmf.subarray(100 * 21, 101 * 21);
        expect(maxAbsDiff(prodFinal, oracle)).toBeLessThanOrEqual(1e-10);
        const prodMoments = {
          meanB: reference.meanB[100]!,
          varianceB: reference.varianceB[100]!,
        };
        const oracleMoments = momentsFromPmf(oracle, 1, 20);
        expect(Math.abs(prodMoments.meanB - oracleMoments.meanB)).toBeLessThanOrEqual(1e-10);
        expect(Math.abs(prodMoments.varianceB - oracleMoments.varianceB)).toBeLessThanOrEqual(1e-10);
        // 线性闭合解析式对照（初值均值由初始 PMF 独立求和）
        const initialMean = momentsFromPmf(c.initial, 1, 20).meanB;
        expect(reference.closureMeanB[100]).toBeCloseTo(
          linearClosureMean(model, initialMean, t),
          7,
        );
      }
    }
  });

  it("matches G03 exact distribution [81,108,54,12,1]/256 at t=ln(2)/2", () => {
    const t = Math.log(2) / 2;
    const model: ModelSpec = { id: "linear", totalUnits: 4, forwardRate: 1, reverseRate: 1 };
    const initial = [1, 0, 0, 0, 0];
    const expected = [81, 108, 54, 12, 1].map((v) => v / 256);
    const oracle = linearOraclePmf(model, initial, t);
    expect(maxAbsDiff(oracle, expected)).toBeLessThanOrEqual(1e-12);
    const oracleMoments = momentsFromPmf(oracle, 1, 4);
    expect(oracleMoments.meanB).toBeCloseTo(1, 12);
    expect(oracleMoments.varianceB).toBeCloseTo(0.75, 12);
    const scenario = scenarioWith(model, { P: initial, Q: initial }, t);
    const reference = solveReference(scenario, "P");
    const prodFinal = reference.pmf.subarray(100 * 5, 101 * 5);
    expect(maxAbsDiff(prodFinal, expected)).toBeLessThanOrEqual(1e-10);
    expect(reference.meanB[100]).toBeCloseTo(1, 10);
    expect(reference.varianceB[100]).toBeCloseTo(0.75, 10);
  });

  it("handles linear zero-rate and one-way-rate edges via the oracle", () => {
    // kf=kb=0：分布冻结
    const frozen: ModelSpec = { id: "linear", totalUnits: 4, forwardRate: 0, reverseRate: 0 };
    const initial = [0, 0.25, 0.5, 0.25, 0];
    expect(linearOraclePmf(frozen, initial, 3)).toEqual(initial);
    const frozenRef = solveReference(scenarioWith(frozen, { P: initial, Q: initial }, 3), "P");
    expect(maxAbsDiff(frozenRef.pmf.subarray(100 * 5, 101 * 5), initial)).toBeLessThanOrEqual(1e-10);
    // 单向率：kb=0 时全部质量最终流向 B=N（t 充分大时接近 1）
    const oneWay: ModelSpec = { id: "linear", totalUnits: 4, forwardRate: 1, reverseRate: 0 };
    const oracleLate = linearOraclePmf(oneWay, [1, 0, 0, 0, 0], 20);
    expect(oracleLate[4]).toBeGreaterThan(0.999999);
    const oneWayRef = solveReference(scenarioWith(oneWay, { P: [1, 0, 0, 0, 0], Q: [1, 0, 0, 0, 0] }, 20), "P");
    expect(maxAbsDiff(oneWayRef.pmf.subarray(100 * 5, 101 * 5), oracleLate)).toBeLessThanOrEqual(1e-10);
  });
});

describe("T006 oracle: G04 dimer stationary distribution", () => {
  it("matches the hand anchor [0.1, 0.6, 0.3] and pi Q = 0", () => {
    const model = { id: "dimer" as const, totalUnits: 4, forwardRate: 0.02, reverseRate: 0.02 };
    const pi = dimerStationaryPmf(model);
    expect(maxAbsDiff(pi, [0.1, 0.6, 0.3])).toBeLessThanOrEqual(1e-12);
    const rows = dimerGeneratorRows(model);
    // 手算 Q 矩阵核对
    expect(rows[0]).toEqual(expect.arrayContaining([expect.closeTo(-0.12, 12)]));
    expect(maxAbsDiff(rows[0]!, [-0.12, 0.12, 0])).toBeLessThanOrEqual(1e-12);
    expect(maxAbsDiff(rows[1]!, [0.02, -0.04, 0.02])).toBeLessThanOrEqual(1e-12);
    expect(maxAbsDiff(rows[2]!, [0, 0.04, -0.04])).toBeLessThanOrEqual(1e-12);
    const piQ = piTimesQ(pi, rows);
    expect(Math.max(...piQ.map(Math.abs))).toBeLessThanOrEqual(1e-12);
    const moments = dimerMomentsFromPmf(pi, 4);
    expect(moments.meanB).toBeCloseTo(1.2, 12);
    expect(moments.varianceB).toBeCloseTo(0.36, 12);
    expect(moments.meanA).toBeCloseTo(1.6, 12);
    expect(moments.varianceA).toBeCloseTo(1.44, 12);
    // 精确漂移 0、闭合漂移 -0.0144、修正 +0.0144（独立公式）
    expect(closureDriftOracle({ id: "dimer", totalUnits: 4, forwardRate: 0.02, reverseRate: 0.02 }, 1.2)).toBeCloseTo(-0.0144, 12);
    expect((0.02 * moments.varianceA) / 2).toBeCloseTo(0.0144, 12);
  });

  it("stays stationary in production when started from the oracle pi (T=20, 1e-10)", () => {
    const model: ModelSpec = { id: "dimer", totalUnits: 4, forwardRate: 0.02, reverseRate: 0.02 };
    const pi = dimerStationaryPmf(model);
    const scenario = scenarioWith(model, { P: [...pi], Q: [...pi] }, 20);
    const reference = solveReference(scenario, "P");
    for (let index = 0; index < 101; index += 1) {
      const slice = reference.pmf.subarray(index * 3, (index + 1) * 3);
      expect(maxAbsDiff(slice, pi)).toBeLessThanOrEqual(1e-10);
    }
    expect(reference.meanB[100]).toBeCloseTo(1.2, 10);
    expect(reference.varianceB[100]).toBeCloseTo(0.36, 10);
    expect(reference.exactDrift[100]).toBeCloseTo(0, 10);
    expect(reference.closureDriftAtExactMean[100]).toBeCloseTo(-0.0144, 10);
    expect(reference.driftCorrection[100]).toBeCloseTo(0.0144, 10);
  });

  it("gives pi Q = 0 for other dimer parameters", () => {
    for (const model of [
      { totalUnits: 20, forwardRate: 0.02, reverseRate: 0.2 },
      { totalUnits: 10, forwardRate: 0.05, reverseRate: 0.1 },
      { totalUnits: 40, forwardRate: 0.005, reverseRate: 1 },
    ]) {
      const pi = dimerStationaryPmf(model);
      expect(Math.abs(pi.reduce((a, b) => a + b, 0) - 1)).toBeLessThanOrEqual(1e-12);
      expect(Math.min(...pi)).toBeGreaterThan(0);
      const piQ = piTimesQ(pi, dimerGeneratorRows(model));
      expect(Math.max(...piQ.map(Math.abs))).toBeLessThanOrEqual(1e-10);
    }
  });
});

describe("T006 oracle: dimer closure Riccati analytic", () => {
  it("matches the analytic Riccati oracle over the plan grid (1e-7)", () => {
    const ns = [4, 20, 40];
    const kfs = [0, 0.005, 0.02, 0.05];
    const kbs = [0, 0.02, 0.2, 1];
    let worst = 0;
    let worstCase = "";
    for (const n of ns) {
      const jMax = n / 2;
      for (const kf of kfs) {
        for (const kb of kbs) {
          for (const b0 of [0, jMax / 2, jMax]) {
            const model: ModelSpec = { id: "dimer", totalUnits: n, forwardRate: kf, reverseRate: kb };
            const initial = new Array(jMax + 1).fill(0);
            // 以确定性初值构造均值为 b0 的初始 PMF（b0 取 0、jMax/2、jMax 均为整数）
            initial[b0] = 1;
            const scenario = scenarioWith(model, { P: initial, Q: initial }, 8);
            const prod = solveClosure(scenario, "P");
            for (let index = 0; index < 101; index += 1) {
              const time = (8 * index) / 100;
              const oracle = dimerClosureMean(model, b0, time);
              const diff = Math.abs(prod[index]! - oracle);
              if (diff > worst) {
                worst = diff;
                worstCase = `N=${n} kf=${kf} kb=${kb} b0=${b0} t=${time}`;
              }
              expect(diff).toBeLessThanOrEqual(1e-7);
            }
          }
        }
      }
    }
    // 报告最坏情形（测试通过时也记录在输出中，供审查查看）
    expect(worst).toBeLessThanOrEqual(1e-7);
    // eslint-disable-next-line no-console
    console.log(`T006 closure grid worst diff: ${worst} at ${worstCase}`);
  });

  it("is consistent when the RK4 step is halved (1e-7)", () => {
    const model: ModelSpec = { id: "dimer", totalUnits: 20, forwardRate: 0.02, reverseRate: 0.2 };
    const initial = new Array(11).fill(0);
    initial[5] = 1;
    const scenario = scenarioWith(model, { P: initial, Q: initial }, 8);
    const full = solveClosure(scenario, "P");
    const half = solveClosureWithMaxStep(scenario, "P", 0.005);
    expect(maxAbsDiff(full, half)).toBeLessThanOrEqual(1e-7);
  });
});

describe("T006 oracle: RNG stream and frozen seeds", () => {
  it("reproduces seed=1 first five values exactly", () => {
    const oracle = new OracleXorShift32(1);
    const prod = new XorShift32(1);
    for (const expected of SEED_ONE_FIRST_FIVE) {
      expect(oracle.nextUint32()).toBe(expected);
      expect(prod.nextUint32()).toBe(expected);
    }
  });

  it("matches the oracle stream exactly for several seeds over 1000 draws", () => {
    for (const seed of [1, 42, 20261031, 0, 0xffffffff]) {
      const oracle = new OracleXorShift32(seed);
      const prod = new XorShift32(seed);
      for (let i = 0; i < 1000; i += 1) {
        expect(prod.nextUint32()).toBe(oracle.nextUint32());
      }
    }
    // 开区间抽样恒在 (0,1) 内
    const oracle = new OracleXorShift32(7);
    const prod = createTrajectoryRng(7, "P", 0);
    for (let i = 0; i < 1000; i += 1) {
      const u = oracle.nextOpen01();
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
      const up = prod.nextOpen01();
      expect(up).toBeGreaterThan(0);
      expect(up).toBeLessThan(1);
    }
  });

  it("matches frozen trajectory-seed vectors", () => {
    for (const v of FROZEN_TRAJECTORY_SEEDS) {
      expect(deriveTrajectorySeed(v.baseSeed, v.group, v.trajectoryIndex)).toBe(v.expected);
    }
  });

  it("samples initial states identically to the oracle cumulative sampler", () => {
    const pmf = [0.1, 0.2, 0.4, 0.2, 0.1];
    for (const u of [0, 0.05, 0.1, 0.299, 0.3, 0.7, 0.899, 0.9, 0.999]) {
      const prod = sampleInitialState(pmf, new FixedRng([u]));
      expect(prod.initialState).toBe(oracleSampleInitialState(pmf, u));
      expect(prod.uInitial).toBe(u);
    }
  });
});

describe("T006 oracle: SSA single-step audit (G05)", () => {
  it("reproduces G05 forward and reverse steps exactly", () => {
    const model: ModelSpec = { id: "dimer", totalUnits: 20, forwardRate: 0.02, reverseRate: 0.2 };
    const initial = new Array(11).fill(0);
    initial[5] = 1;
    const oracle = oracleSingleStep(model, 5, Math.exp(-1.9), 0.4);
    expect(oracle.birth).toBeCloseTo(0.9, 12);
    expect(oracle.death).toBeCloseTo(1, 12);
    expect(oracle.totalRate).toBeCloseTo(1.9, 12);
    expect(oracle.waitingTime).toBeCloseTo(1, 12);
    expect(oracle.reaction).toBe("forward");
    expect(oracle.stateAfter).toBe(6);

    const run = (uChoice: number) =>
      simulateTrajectory({
        model,
        initialPmf: initial,
        horizon: 2,
        observationTimes: new Float64Array([0, 2]),
        baseSeed: 1,
        group: "P",
        trajectoryIndex: 0,
        rng: new FixedRng([0.5, Math.exp(-1.9), uChoice, Math.exp(-100), 0.5]),
      });
    const forward = run(0.4);
    expect(forward.trace.events).toHaveLength(1);
    const fe = forward.trace.events[0]!;
    expect(fe.birth).toBeCloseTo(0.9, 12);
    expect(fe.death).toBeCloseTo(1, 12);
    expect(fe.totalRate).toBeCloseTo(1.9, 12);
    expect(fe.waitingTime).toBeCloseTo(1, 12);
    expect(fe.reaction).toBe("forward");
    expect(fe.stateBefore).toBe(5);
    expect(fe.stateAfter).toBe(6);
    expect(fe.timeBefore).toBeCloseTo(0, 12);
    expect(fe.timeAfter).toBeCloseTo(1, 12);
    expect(Array.from(forward.sampledB)).toEqual([5, 6]);

    const reverse = run(0.5);
    const re = reverse.trace.events[0]!;
    expect(re.reaction).toBe("reverse");
    expect(re.stateAfter).toBe(4);
    expect(Array.from(reverse.sampledB)).toEqual([5, 4]);
    const oracleRev = oracleSingleStep(model, 5, Math.exp(-1.9), 0.5);
    expect(oracleRev.reaction).toBe("reverse");
    expect(oracleRev.stateAfter).toBe(4);
  });

  it("matches oracle rates at every state including boundaries", () => {
    const models: ModelSpec[] = [
      { id: "linear", totalUnits: 4, forwardRate: 1, reverseRate: 0.5 },
      { id: "dimer", totalUnits: 20, forwardRate: 0.02, reverseRate: 0.2 },
      { id: "dimer", totalUnits: 4, forwardRate: 0.02, reverseRate: 0.02 },
      { id: "linear", totalUnits: 2, forwardRate: 0, reverseRate: 0 },
    ];
    for (const model of models) {
      const maxState = model.id === "linear" ? model.totalUnits : Math.floor(model.totalUnits / 2);
      for (let j = 0; j <= maxState; j += 1) {
        const prod = reactionRates(model, j);
        const oracle = oracleRates(model, j);
        expect(prod.birth).toBeCloseTo(oracle.birth, 12);
        expect(prod.death).toBeCloseTo(oracle.death, 12);
        expect(prod.totalRate).toBeCloseTo(oracle.totalRate, 12);
        if (j === 0) expect(prod.death).toBe(0);
        if (j === maxState) expect(prod.birth).toBe(0);
        expect(prod.birth).toBeGreaterThanOrEqual(0);
        expect(prod.death).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
