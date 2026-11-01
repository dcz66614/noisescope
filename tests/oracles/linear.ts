// P006 T006 独立 oracle：线性完整分布。
//
// 独立推导（项目书 §6 实施计划 §8.1，不复制生产实现）：
// 线性模型中每个分子独立地在 A/B 间切换，单分子转移速率为
// kf（A->B）、kb（B->A）。对初始 B 数 k，在时刻 t：
//   仍为 B 的初始分子数 X ~ Bin(k, q + (1-q) e^{-rt})，
//   由 A 转来的分子数 Y ~ Bin(N-k, q (1-e^{-rt}))，
// 其中 r = kf+kb，q = kf/r（r>0）。X、Y 独立，B(t)=X+Y。
// 二项 PMF 由对数阶乘独立计算；概率 0/1 单独处理，避免 0^0。
// 本文件不导入任何生产代码（src/core、src/domain 均不导入）。

export interface LinearModel {
  totalUnits: number;
  forwardRate: number;
  reverseRate: number;
}

const LOG_FACT_CACHE: number[] = [0];

export function logFactorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError("logFactorial requires a non-negative integer");
  }
  while (LOG_FACT_CACHE.length <= n) {
    const k = LOG_FACT_CACHE.length;
    LOG_FACT_CACHE.push(LOG_FACT_CACHE[k - 1]! + Math.log(k));
  }
  return LOG_FACT_CACHE[n]!;
}

/** 独立二项 PMF：P(K=k) = C(n,k) p^k (1-p)^(n-k)。 */
export function binomialPmf(n: number, p: number): number[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError("n must be a non-negative integer");
  }
  if (!(p >= 0 && p <= 1)) {
    throw new RangeError("p must be in [0, 1]");
  }
  const pmf = new Array<number>(n + 1).fill(0);
  if (p === 0) {
    pmf[0] = 1;
    return pmf;
  }
  if (p === 1) {
    pmf[n] = 1;
    return pmf;
  }
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  for (let k = 0; k <= n; k += 1) {
    pmf[k] =
      Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) +
        k * logP + (n - k) * logQ);
  }
  return pmf;
}

function convolve(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      out[i + j] = out[i + j]! + a[i]! * b[j]!;
    }
  }
  return out;
}

/**
 * 线性完整分布 oracle：按初始 PMF 混合各初始态的二项卷积。
 * r = 0 时返回初始分布的副本。
 */
export function linearOraclePmf(
  model: LinearModel,
  initialPmf: readonly number[],
  time: number,
): number[] {
  const n = model.totalUnits;
  if (initialPmf.length !== n + 1) {
    throw new RangeError("initial PMF length must be N+1 for linear model");
  }
  if (!Number.isFinite(time) || time < 0) {
    throw new RangeError("time must be finite and non-negative");
  }
  const r = model.forwardRate + model.reverseRate;
  if (r === 0) {
    return [...initialPmf];
  }
  const q = model.forwardRate / r;
  const decay = Math.exp(-r * time);
  const out = new Array<number>(n + 1).fill(0);
  for (let k = 0; k <= n; k += 1) {
    const weight = initialPmf[k]!;
    if (weight === 0) continue;
    const stay = q + (1 - q) * decay;
    const arrive = q * (1 - decay);
    const conv = convolve(binomialPmf(k, stay), binomialPmf(n - k, arrive));
    for (let j = 0; j <= n; j += 1) {
      out[j] = out[j]! + weight * conv[j]!;
    }
  }
  return out;
}

/** 由 PMF 独立求和得到的矩（不调用生产 moments）。 */
export function momentsFromPmf(
  pmf: readonly number[],
  stoichiometry: 1 | 2,
  totalUnits: number,
): { meanB: number; varianceB: number; meanA: number; varianceA: number } {
  let meanB = 0;
  let second = 0;
  for (let j = 0; j < pmf.length; j += 1) {
    meanB += j * pmf[j]!;
    second += j * j * pmf[j]!;
  }
  const varianceB = second - meanB * meanB;
  const meanA = totalUnits - stoichiometry * meanB;
  return {
    meanB,
    varianceB,
    meanA,
    varianceA: stoichiometry * stoichiometry * varianceB,
  };
}

/** 线性闭合解析式：m(t) = eq + (m0-eq) e^{-rt}；r=0 时为常数。 */
export function linearClosureMean(
  model: LinearModel,
  initialMeanB: number,
  time: number,
): number {
  const r = model.forwardRate + model.reverseRate;
  if (r === 0) return initialMeanB;
  const eq = (model.forwardRate * model.totalUnits) / r;
  return eq + (initialMeanB - eq) * Math.exp(-r * time);
}
