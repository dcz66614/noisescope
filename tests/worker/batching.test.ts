// P006 T008 — 批处理与数据规模测试（项目书 §5、§11.4）
//
// batchSize 只改变进度切分，不改变计算顺序与随机消耗，
// 因此 batch=1/17/64 的结果必须逐值一致；M 增大时前 32 条
// preview 轨迹（previewB）也不变。峰值数据规模与 M 无关。

import { describe, expect, it } from "vitest";
import { simulateTrajectory, createObservationTimes } from "../../src/core/ssa";
import { validateScenario } from "../../src/domain/validate";
import type { ScenarioV1 } from "../../src/domain/types";
import {
  handleRequest,
  runScenario,
} from "../../src/workers/simulation.worker";
/** 最小场景（与 protocol.test.ts 内联定义相同，避免跨测试文件 import 导致重复注册）。 */
function smallScenario(): ScenarioV1 {
  return validateScenario({
    schemaVersion: 1,
    projectId: "P006",
    title: "T008 最小场景",
    model: { id: "dimer", totalUnits: 4, forwardRate: 0.02, reverseRate: 0.2 },
    initial: { P: [0, 1, 0], Q: [0.5, 0, 0.5] },
    horizon: 1,
    observations: 101,
    trajectoriesPerGroup: 64,
    seed: 20261031,
    rngVersion: "xorshift32-v1",
  });
}

function frozenLargeScenario(): ScenarioV1 {
  // 零速率冻结：SSA 每条轨迹立即吸收，4096 条/组也能快速跑完，
  // 正好证明峰值数据规模与 M 无关（不靠算力取巧）。
  return validateScenario({
    schemaVersion: 1,
    projectId: "P006",
    title: "T008 峰值规模",
    model: { id: "dimer", totalUnits: 20, forwardRate: 0, reverseRate: 0 },
    initial: {
      P: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      Q: [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5],
    },
    horizon: 8,
    observations: 101,
    trajectoriesPerGroup: 4096,
    seed: 20261031,
    rngVersion: "xorshift32-v1",
  });
}

describe("batching", () => {
  it("batch=1/17/64 的结果逐值一致（counts、均值、方差、preview、参考 PMF）", () => {
    const scenario = smallScenario();
    const runs = [1, 17, 64].map((batchSize) =>
      runScenario(scenario, batchSize, { batchSize }),
    );
    const [first, ...rest] = runs;
    for (const other of rest) {
      for (const group of ["P", "Q"] as const) {
        expect(Array.from(other.sample[group].counts)).toEqual(
          Array.from(first!.sample[group].counts),
        );
        expect(Array.from(other.sample[group].meanB)).toEqual(
          Array.from(first!.sample[group].meanB),
        );
        expect(Array.from(other.sample[group].varianceB)).toEqual(
          Array.from(first!.sample[group].varianceB),
        );
        expect(Array.from(other.sample[group].previewB)).toEqual(
          Array.from(first!.sample[group].previewB),
        );
        expect(Array.from(other.reference[group].pmf)).toEqual(
          Array.from(first!.reference[group].pmf),
        );
      }
      expect(other.stateCount).toBe(first!.stateCount);
      expect(other.status).toBe("COMPLETE");
    }
  });

  it("batch=17 时每组恰好发 4 次进度，且每次进度都不超 M", () => {
    const progresses: Array<{ completedP: number; completedQ: number }> = [];
    const result = runScenario(smallScenario(), 1, {
      batchSize: 17,
      onProgress: (p) => {
        progresses.push({ completedP: p.completedP, completedQ: p.completedQ });
      },
    });
    // ceil(64/17) = 4 批/组，共 8 次；P 先走完 4 批，Q 再走 4 批。
    expect(progresses).toHaveLength(8);
    for (const p of progresses) {
      expect(p.completedP).toBeLessThanOrEqual(64);
      expect(p.completedQ).toBeLessThanOrEqual(64);
    }
    expect(progresses[3]).toEqual({ completedP: 64, completedQ: 0 });
    expect(progresses[7]).toEqual({ completedP: 64, completedQ: 64 });
    expect(result.sample.P.completed).toBe(64);
    expect(result.sample.Q.completed).toBe(64);
  });

  it("M 从 64 增到 128 时，前 32 条 preview 轨迹不变", () => {
    const base = smallScenario();
    const larger = validateScenario({ ...base, trajectoriesPerGroup: 128 });
    const small = runScenario(base, 1);
    const large = runScenario(larger, 2);
    for (const group of ["P", "Q"] as const) {
      expect(Array.from(large.sample[group].previewB)).toEqual(
        Array.from(small.sample[group].previewB),
      );
    }
  });

  it("峰值数据规模与 M 无关：M=4096 时 counts/PMF 仍为 101*S，preview 为 32*101", () => {
    const result = runScenario(frozenLargeScenario(), 1, { batchSize: 64 });
    // dimer N=20 -> S = 11；101 * 11 = 1111；preview = min(32,4096) * 101。
    expect(result.stateCount).toBe(11);
    expect(result.times).toHaveLength(101);
    for (const group of ["P", "Q"] as const) {
      expect(result.reference[group].pmf).toHaveLength(1111);
      expect(result.sample[group].counts).toHaveLength(1111);
      expect(result.sample[group].completed).toBe(4096);
      expect(result.sample[group].previewB).toHaveLength(32 * 101);
      expect(result.sample[group].meanB).toHaveLength(101);
      // 每时刻 counts 行和 = M（不缓存轨迹也能对账）。
      for (let t = 0; t < 101; t += 1) {
        let rowSum = 0;
        for (let j = 0; j < 11; j += 1) {
          rowSum += result.sample[group].counts[t * 11 + j]!;
        }
        expect(rowSum).toBe(4096);
      }
    }
    // 结果对象里没有逐轨迹数组：只含 counts / 均值 / 方差 / preview / 事件数。
    expect(Object.keys(result.sample.P).sort()).toEqual([
      "completed",
      "counts",
      "eventsExecuted",
      "meanB",
      "previewB",
      "varianceB",
    ]);
  });

  it("REPLAY 与原轨迹的 101 采样值一致（P 组 0 号与 Q 组 5 号）", () => {
    const scenario = smallScenario();
    const times = createObservationTimes(scenario.horizon, scenario.observations);
    for (const [group, index] of [
      ["P", 0],
      ["Q", 5],
    ] as const) {
      const original = simulateTrajectory({
        model: scenario.model,
        initialPmf: scenario.initial[group],
        horizon: scenario.horizon,
        observationTimes: times,
        baseSeed: scenario.seed,
        group,
        trajectoryIndex: index,
      });
      const responses = handleRequest({
        type: "REPLAY",
        runId: 9,
        scenario,
        group,
        trajectoryIndex: index,
      });
      const traceMsg = responses[0];
      expect(traceMsg?.type).toBe("TRACE");
      if (traceMsg?.type === "TRACE") {
        expect(traceMsg.trace.sampledB).toEqual(Array.from(original.sampledB));
      }
    }
  });

  it("runScenario 不修改输入场景对象", () => {
    const scenario = smallScenario();
    const snapshot = JSON.stringify(scenario);
    runScenario(scenario, 1, { batchSize: 17 });
    expect(JSON.stringify(scenario)).toBe(snapshot);
  });
});
