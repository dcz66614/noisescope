// P006 T010 — 分布图纯绘图数据适配器（项目书 §9.3、§12.3）。
//
// 职责边界：只做“已给数据 → 绘图几何”的纯转换，不重算任何科学量。
// - 调用方（后续 T013 集成）负责在当前时间游标处从 RunResult 的
//   时间主数组中切出单时刻切片；本适配器不切时间主数组、不碰 core。
// - 理论概率直接取自切片 referenceProb；样本概率只由切片给出的
//   sampleCounts / completed 做显示归一化（count / completed），
//   与 T007 SVG 导出同一口径，不是重新推导 SSA 或 CME。
// - P、Q 共用一个纵轴最大值 sharedMax：取两组理论概率与样本概率
//   的全局最大值（全为 0 时取 1，避免除零），绝不各自独立缩放。

import type { GroupId } from "../domain/types";

/** 单组在单个观测时刻的分布切片（调用方已切好）。 */
export interface DistributionGroupSlice {
  group: GroupId;
  /** 长度必须等于 stateCount，理论概率（CME 基准）。 */
  referenceProb: readonly number[];
  /** 长度必须等于 stateCount，SSA 样本计数。 */
  sampleCounts: readonly number[];
  /** 已完成轨迹数；为 0 时样本概率全部为 0。 */
  completed: number;
  referenceMeanB: number;
  sampleMeanB: number;
  referenceVarianceB: number;
  sampleVarianceB: number;
}

export interface DistributionBarDatum {
  group: GroupId;
  j: number;
  referenceProb: number;
  sampleProb: number;
  sampleCount: number;
  /** 柱高占绘图区高度的比例（相对 sharedMax），两组可比。 */
  referenceHeightFraction: number;
  sampleHeightFraction: number;
}

export interface DistributionChartData {
  stateCount: number;
  /** 两组共用的纵轴最大值。 */
  sharedMax: number;
  bars: DistributionBarDatum[];
  groups: { P: DistributionGroupSlice; Q: DistributionGroupSlice };
}

/** 样本概率：count / completed；completed 为 0 时全部为 0。 */
export function sampleProbabilities(
  slice: DistributionGroupSlice,
): number[] {
  return slice.sampleCounts.map((count) =>
    slice.completed > 0 ? count / slice.completed : 0,
  );
}

function checkSlice(
  slice: DistributionGroupSlice,
  stateCount: number,
): void {
  if (!Number.isInteger(stateCount) || stateCount <= 0) {
    throw new RangeError("stateCount 必须是正整数");
  }
  if (
    slice.referenceProb.length !== stateCount ||
    slice.sampleCounts.length !== stateCount
  ) {
    throw new RangeError(
      `组 ${slice.group} 的分布长度与状态数不一致：` +
        `referenceProb=${slice.referenceProb.length}，` +
        `sampleCounts=${slice.sampleCounts.length}，stateCount=${stateCount}`,
    );
  }
  if (!Number.isInteger(slice.completed) || slice.completed < 0) {
    throw new RangeError(`组 ${slice.group} 的 completed 必须是非负整数`);
  }
  for (let j = 0; j < stateCount; j += 1) {
    const p = slice.referenceProb[j]!;
    const c = slice.sampleCounts[j]!;
    if (!Number.isFinite(p) || p < 0 || p > 1 + 1e-12) {
      throw new RangeError(`组 ${slice.group} 状态 ${j} 的理论概率无效：${p}`);
    }
    if (!Number.isInteger(c) || c < 0) {
      throw new RangeError(`组 ${slice.group} 状态 ${j} 的样本计数无效：${c}`);
    }
  }
  for (const value of [
    slice.referenceMeanB,
    slice.sampleMeanB,
    slice.referenceVarianceB,
    slice.sampleVarianceB,
  ]) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`组 ${slice.group} 的统计量必须有限`);
    }
  }
}

/**
 * 由两组单时刻切片构建绘图数据。任一切片无效即抛错，调用方
 * （DistributionView）据此显示错误态，绝不静默画错图。
 */
export function buildDistributionChartData(
  groups: { P: DistributionGroupSlice; Q: DistributionGroupSlice },
  stateCount: number,
): DistributionChartData {
  checkSlice(groups.P, stateCount);
  checkSlice(groups.Q, stateCount);
  const sampleP = sampleProbabilities(groups.P);
  const sampleQ = sampleProbabilities(groups.Q);
  const rawMax = Math.max(
    0,
    ...groups.P.referenceProb,
    ...groups.Q.referenceProb,
    ...sampleP,
    ...sampleQ,
  );
  const sharedMax = rawMax > 0 ? rawMax : 1;
  const bars: DistributionBarDatum[] = [];
  for (const [slice, sample] of [
    [groups.P, sampleP],
    [groups.Q, sampleQ],
  ] as const) {
    for (let j = 0; j < stateCount; j += 1) {
      bars.push({
        group: slice.group,
        j,
        referenceProb: slice.referenceProb[j]!,
        sampleProb: sample[j]!,
        sampleCount: slice.sampleCounts[j]!,
        referenceHeightFraction: slice.referenceProb[j]! / sharedMax,
        sampleHeightFraction: sample[j]! / sharedMax,
      });
    }
  }
  return { stateCount, sharedMax, bars, groups };
}
