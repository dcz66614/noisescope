// P006 T006 独立 oracle：xorshift32 随机流。
//
// 算法定义（项目书 §5.2）：32 位 xorshift，移位 13 / 17 / 5，
// 状态 0 时以 0x6d2b79f5 代替；开区间抽样为 (u32 + 0.5) / 2^32。
// 本 oracle 用 JS 位运算独立实现该定义，不导入生产 rng。
// 每轨迹种子派生的混合常数与盐值属于 T002/T003 冻结契约，
// 本文件只在测试中以冻结向量回归核对，不把它说成重新推导。

export const RNG_FALLBACK_STATE = 0x6d2b79f5;

/** 独立 xorshift32 流：返回每次的 uint32。 */
export class OracleXorShift32 {
  private state: number;

  constructor(seed: number) {
    const normalized = seed >>> 0;
    this.state = normalized === 0 ? RNG_FALLBACK_STATE : normalized;
  }

  nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  nextOpen01(): number {
    return (this.nextUint32() + 0.5) / 0x1_0000_0000;
  }
}

/** T003 冻结的每轨迹种子向量（契约回归用，非本任务推导）。 */
export const FROZEN_TRAJECTORY_SEEDS: ReadonlyArray<{
  baseSeed: number;
  group: "P" | "Q";
  trajectoryIndex: number;
  expected: number;
}> = [
  { baseSeed: 20261031, group: "P", trajectoryIndex: 0, expected: 775094953 },
  { baseSeed: 20261031, group: "Q", trajectoryIndex: 0, expected: 1547361516 },
  { baseSeed: 1, group: "P", trajectoryIndex: 0, expected: 1927456887 },
  { baseSeed: 42, group: "Q", trajectoryIndex: 3, expected: 1604414476 },
];

/** seed=1 时 xorshift32 前五项的冻结值（T003 证据）。 */
export const SEED_ONE_FIRST_FIVE: readonly number[] = [
  270369, 67634689, 2647435461, 307599695, 2398689233,
];

/**
 * 累积 PMF 初始抽样（定义级实现）：返回第一个使 u < 累积和的状态；
 * 浮点尾部在总和与 1 相差 1e-12 内时落到最后一个正概率状态。
 */
export function oracleSampleInitialState(
  pmf: readonly number[],
  uInitial: number,
): number {
  let cumulative = 0;
  let finalPositive = -1;
  for (let state = 0; state < pmf.length; state += 1) {
    const p = pmf[state]!;
    if (p > 0) finalPositive = state;
    cumulative += p;
    if (uInitial < cumulative) return state;
  }
  if (finalPositive >= 0 && Math.abs(cumulative - 1) <= 1e-12) {
    return finalPositive;
  }
  throw new RangeError("initial PMF must sum to one");
}
