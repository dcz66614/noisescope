// P006 T006 独立数学验证：G07 固定种子统计门禁。
//
// 门禁（项目书 §13 G07、实施计划 §8.5）：固定种子 1、42、20261031，
// 对 G01、G02 各运行 M=4096/组，检查时间索引 0、10、25、50、75、100，
// 经验 CDF 距离 D 均 ≤ 0.06。共 2 模型 × 2 组 × 3 种子 × 6 时刻 = 72 个比较。
// D 由本文件独立计算（经验 CDF 与基准 CDF 的最大绝对差），
// 不调用生产 diagnostics 的 D 实现；采样与基准本身是被测系统。
// 本文件同时把每模型/组/种子/时刻的 D 保存到项目 07_evidence/
// 下的 T006-sampling-D.json（证据文件，不是生产代码）。
// 失败时不更换种子、不删除时刻、不调整门槛。

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioV1 } from "../../src/domain/types";
import { makePreset } from "../../src/domain/presets";
import { solveReference } from "../../src/core/reference";
import {
  createObservationTimes,
  simulateSampleGroup,
  simulateTrajectory,
} from "../../src/core/ssa";

/** 独立 CDF 距离：max_j |Fhat(j) - F(j)|。 */
export function independentCdfDistance(
  counts: ArrayLike<number>,
  probabilities: ArrayLike<number>,
  sampleCount: number,
): number {
  if (counts.length !== probabilities.length) {
    throw new RangeError("counts and probabilities must have equal lengths");
  }
  let empirical = 0;
  let reference = 0;
  let distance = 0;
  for (let j = 0; j < counts.length; j += 1) {
    empirical += counts[j]! / sampleCount;
    reference += probabilities[j]!;
    distance = Math.max(distance, Math.abs(empirical - reference));
  }
  return distance;
}

const TIME_INDICES = [0, 10, 25, 50, 75, 100];
const SEEDS = [1, 42, 20261031];
const M = 4096;
const GATE = 0.06;

describe("T006 sampling: G07 fixed-seed CDF gate (72 comparisons)", () => {
  it("keeps every D <= 0.06 and saves the full D table", () => {
    const presets: Array<{ name: string; scenario: ScenarioV1; stateCount: number }> = [
      { name: "G01-variance-split-dimer", scenario: makePreset("variance-split"), stateCount: 11 },
      { name: "G02-linear-control", scenario: makePreset("linear-control"), stateCount: 21 },
    ];
    const rows: Array<{
      model: string;
      group: "P" | "Q";
      seed: number;
      timeIndex: number;
      time: number;
      d: number;
      passes: boolean;
    }> = [];
    let worst = 0;
    let worstRow = "";
    for (const { name, scenario, stateCount } of presets) {
      const times = createObservationTimes(scenario.horizon, scenario.observations);
      for (const group of ["P", "Q"] as const) {
        const reference = solveReference(scenario, group);
        for (const seed of SEEDS) {
          const sample = simulateSampleGroup({
            model: scenario.model,
            initialPmf: scenario.initial[group],
            horizon: scenario.horizon,
            observationTimes: times,
            trajectories: M,
            baseSeed: seed,
            group,
          });
          expect(sample.completed).toBe(M);
          for (const timeIndex of TIME_INDICES) {
            const counts = sample.counts.subarray(
              timeIndex * stateCount,
              (timeIndex + 1) * stateCount,
            );
            const probabilities = reference.pmf.subarray(
              timeIndex * stateCount,
              (timeIndex + 1) * stateCount,
            );
            // counts 总和必须等于 M（采样完整性）
            let total = 0;
            for (const c of counts) total += c;
            expect(total).toBe(M);
            const d = independentCdfDistance(counts, probabilities, M);
            rows.push({
              model: name,
              group,
              seed,
              timeIndex,
              time: times[timeIndex]!,
              d,
              passes: d <= GATE,
            });
            if (d > worst) {
              worst = d;
              worstRow = `${name} ${group} seed=${seed} timeIndex=${timeIndex}`;
            }
            expect(d).toBeLessThanOrEqual(GATE);
          }
        }
      }
    }
    expect(rows).toHaveLength(72);
    // 保存证据：每模型/组/种子/时刻的 D
    const evidenceDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "07_evidence",
    );
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, "T006-sampling-D.json"),
      JSON.stringify(
        {
          gate: "G07",
          threshold: GATE,
          trajectoriesPerGroup: M,
          timeIndices: TIME_INDICES,
          seeds: SEEDS,
          comparisons: rows.length,
          worst: { d: worst, row: worstRow },
          rows,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    // eslint-disable-next-line no-console
    console.log(`T006 G07: 72 comparisons, worst D = ${worst} at ${worstRow}`);
  }, 300_000);

  it("is repeatable and preserves prefixes when M grows", () => {
    const scenario = makePreset("variance-split");
    const times = createObservationTimes(scenario.horizon, scenario.observations);
    const options = {
      model: scenario.model,
      initialPmf: scenario.initial.P,
      horizon: scenario.horizon,
      observationTimes: times,
      baseSeed: 42,
      group: "P" as const,
    };
    const small = simulateSampleGroup({ ...options, trajectories: 512 });
    const repeated = simulateSampleGroup({ ...options, trajectories: 512 });
    const large = simulateSampleGroup({ ...options, trajectories: 1024 });
    expect(small).toEqual(repeated);
    // previewB 只存前 32 条轨迹：M 增大时前 32 条不变
    expect(Array.from(large.previewB.slice(0, 32 * 101))).toEqual(
      Array.from(small.previewB),
    );
    // 逐条可复现性：同一轨迹重复计算结果完全相同
    const t100a = simulateTrajectory({ ...options, trajectoryIndex: 100 });
    const t100b = simulateTrajectory({ ...options, trajectoryIndex: 100 });
    expect(t100a).toEqual(t100b);
    const t511a = simulateTrajectory({ ...options, trajectoryIndex: 511 });
    const t511b = simulateTrajectory({ ...options, trajectoryIndex: 511 });
    expect(t511a).toEqual(t511b);
  });
});
