// P006 T007 — CSV 导出底层（项目书 §12.3）
//
// 固定列，数据区不输出任意标题：
//   group,time,state_b,cme_probability,ssa_count,sample_count,ssa_probability
// 行顺序：时间升序 → 组别 P、Q → 状态 j 升序。
// ssa_count 是该状态的 SSA 计数，sample_count 是该组已完成轨迹数 M
// （ssa_probability 的分母），ssa_probability = ssa_count / sample_count。
// 数值用 String() 全精度输出，不做舍入，避免导出后再算对不上。
// 均值表用单独文件、单独列模式，绝不混入分布表。

import type { RunResult } from "../domain/types";

export const DISTRIBUTION_CSV_HEADER =
  "group,time,state_b,cme_probability,ssa_count,sample_count,ssa_probability";
export const MEANS_CSV_HEADER =
  "group,time,meanB_cme,varianceB_cme,meanB_ssa,varianceB_ssa";

export function exportDistributionCsv(result: RunResult): string {
  const lines: string[] = [DISTRIBUTION_CSV_HEADER];
  const stateCount = result.stateCount;
  for (let t = 0; t < result.times.length; t += 1) {
    for (const group of ["P", "Q"] as const) {
      const ref = result.reference[group];
      const sam = result.sample[group];
      const offset = t * stateCount;
      for (let j = 0; j < stateCount; j += 1) {
        const count = sam.counts[offset + j]!;
        const probability =
          sam.completed > 0 ? count / sam.completed : 0;
        lines.push(
          [
            group,
            String(result.times[t]),
            String(j),
            String(ref.pmf[offset + j]),
            String(count),
            String(sam.completed),
            String(probability),
          ].join(","),
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** 均值表（单独文件）：时间升序 → 组别 P、Q。 */
export function exportMeansCsv(result: RunResult): string {
  const lines: string[] = [MEANS_CSV_HEADER];
  for (let t = 0; t < result.times.length; t += 1) {
    for (const group of ["P", "Q"] as const) {
      const ref = result.reference[group];
      const sam = result.sample[group];
      lines.push(
        [
          group,
          String(result.times[t]),
          String(ref.meanB[t]),
          String(ref.varianceB[t]),
          String(sam.meanB[t]),
          String(sam.varianceB[t]),
        ].join(","),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
