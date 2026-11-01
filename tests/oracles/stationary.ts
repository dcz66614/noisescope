// P006 T006 独立 oracle：二聚平稳分布。
//
// 独立推导（实施计划 §8.2）：细致平衡给出未归一化权重
//   w_j = N! / ((N-2j)! j!) * (kf / (2 kb))^j，
// 归一化得 π。对数阶乘实现，避免直接阶乘溢出。
// 生成矩阵 Q 由速率公式独立构造（birth = kf*A(A-1)/2，
// death = kb*j，A = N-2j），仅用于验证 πQ ≈ 0，不调用生产
// generator / uniformization。本文件不导入任何生产代码。

import { logFactorial } from "./linear";

export interface DimerModel {
  totalUnits: number;
  forwardRate: number;
  reverseRate: number;
}

export function dimerStateCount(totalUnits: number): number {
  return Math.floor(totalUnits / 2) + 1;
}

/** 二聚平稳分布 oracle：kf、kb 均须为正。 */
export function dimerStationaryPmf(model: DimerModel): number[] {
  const { totalUnits: n, forwardRate: kf, reverseRate: kb } = model;
  if (!(kf > 0 && kb > 0)) {
    throw new RangeError("stationary oracle requires kf > 0 and kb > 0");
  }
  const count = dimerStateCount(n);
  const logRatio = Math.log(kf / (2 * kb));
  const logWeights: number[] = [];
  let maxLog = -Infinity;
  for (let j = 0; j < count; j += 1) {
    const lw =
      logFactorial(n) - logFactorial(n - 2 * j) - logFactorial(j) +
      j * logRatio;
    logWeights.push(lw);
    if (lw > maxLog) maxLog = lw;
  }
  const weights = logWeights.map((lw) => Math.exp(lw - maxLog));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

/** 独立构造的二聚生成矩阵行：rows[j][j-1]=death，[j][j]=-(birth+death)，[j][j+1]=birth。 */
export function dimerGeneratorRows(model: DimerModel): number[][] {
  const count = dimerStateCount(model.totalUnits);
  const rows: number[][] = [];
  for (let j = 0; j < count; j += 1) {
    const a = model.totalUnits - 2 * j;
    const birth = j === count - 1 ? 0 : (model.forwardRate * a * Math.max(0, a - 1)) / 2;
    const death = j === 0 ? 0 : model.reverseRate * j;
    const row = new Array<number>(count).fill(0);
    row[j] = -(birth + death);
    if (j + 1 < count) row[j + 1] = birth;
    if (j > 0) row[j - 1] = death;
    rows.push(row);
  }
  return rows;
}

/** 计算 πQ（行向量左乘），用于验证 πQ ≈ 0。 */
export function piTimesQ(pi: readonly number[], rows: readonly number[][]): number[] {
  const count = pi.length;
  const out = new Array<number>(count).fill(0);
  for (let j = 0; j < count; j += 1) {
    for (let k = 0; k < count; k += 1) {
      out[k] = out[k]! + pi[j]! * rows[j]![k]!;
    }
  }
  return out;
}

/** 由 PMF 独立求和得到的二聚矩（stoichiometry = 2）。 */
export function dimerMomentsFromPmf(
  pmf: readonly number[],
  totalUnits: number,
): { meanB: number; varianceB: number; meanA: number; varianceA: number } {
  let meanB = 0;
  let second = 0;
  for (let j = 0; j < pmf.length; j += 1) {
    meanB += j * pmf[j]!;
    second += j * j * pmf[j]!;
  }
  const varianceB = second - meanB * meanB;
  return {
    meanB,
    varianceB,
    meanA: totalUnits - 2 * meanB,
    varianceA: 4 * varianceB,
  };
}
