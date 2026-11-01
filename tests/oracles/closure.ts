// P006 T006 独立 oracle：二聚闭合 Riccati 解析解。
//
// 独立推导（实施计划 §8.3）：令 a = N - 2b，方差置零闭合等价于
//   a' = -kf a^2 + (kf - kb) a + kb N。
// kf>0、kb>0 时，D = sqrt((kf-kb)^2 + 4 kf kb N)，
// r± = (kf-kb ± D) / (2 kf)，
// z(t) = (a0 - r+) / (a0 - r-) * e^{-Dt}，
// a(t) = (r+ - z r-) / (1 - z)，b(t) = (N - a(t)) / 2。
// 边界情形按计划单独处理；不调用生产 RK4。
// 本文件不导入任何生产代码。

export interface ClosureModel {
  totalUnits: number;
  forwardRate: number;
  reverseRate: number;
}

/** 闭合漂移公式本身（项目书 §7.2）：线性与二聚两种。 */
export function closureDriftOracle(
  model: { id: "linear" | "dimer"; totalUnits: number; forwardRate: number; reverseRate: number },
  meanB: number,
): number {
  if (model.id === "linear") {
    return model.forwardRate * model.totalUnits -
      (model.forwardRate + model.reverseRate) * meanB;
  }
  const a = model.totalUnits - 2 * meanB;
  return (model.forwardRate * a * (a - 1)) / 2 - model.reverseRate * meanB;
}

/**
 * 二聚闭合均值 b(t) 的解析 oracle。
 * b0 为理论初始均值；返回 b(t)。
 */
export function dimerClosureMean(
  model: ClosureModel,
  initialMeanB: number,
  time: number,
): number {
  const n = model.totalUnits;
  const kf = model.forwardRate;
  const kb = model.reverseRate;
  const b0 = initialMeanB;
  if (time === 0) return b0;
  if (kf === 0 && kb === 0) return b0;
  if (kf === 0 && kb > 0) return b0 * Math.exp(-kb * time);
  const a0 = n - 2 * b0;
  if (kb === 0 && kf > 0) {
    if (a0 === 0) return n / 2;
    // 逻辑斯蒂解：a(t) = a0 / (a0 + (1-a0) e^{-kf t})
    const a = a0 / (a0 + (1 - a0) * Math.exp(-kf * time));
    return (n - a) / 2;
  }
  // kf > 0 且 kb > 0 的一般情形
  const d = Math.sqrt((kf - kb) * (kf - kb) + 4 * kf * kb * n);
  const rPlus = (kf - kb + d) / (2 * kf);
  const rMinus = (kf - kb - d) / (2 * kf);
  const z = ((a0 - rPlus) / (a0 - rMinus)) * Math.exp(-d * time);
  const denom = 1 - z;
  if (!Number.isFinite(z) || Math.abs(denom) < 1e-14) {
    // 退化情形（D≈0 或 z≈1）：回到 t≈0 的极限 a0，不静默外推。
    return (n - a0) / 2;
  }
  const a = (rPlus - z * rMinus) / denom;
  return (n - a) / 2;
}

/** 线性闭合解析式（与 linear.ts 的实现各自独立书写，供交叉核对）。 */
export function linearClosureMeanOracle(
  model: ClosureModel,
  initialMeanB: number,
  time: number,
): number {
  const r = model.forwardRate + model.reverseRate;
  if (r === 0) return initialMeanB;
  const eq = (model.forwardRate * model.totalUnits) / r;
  return eq + (initialMeanB - eq) * Math.exp(-r * time);
}
