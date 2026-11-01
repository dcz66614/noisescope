// P006 T006 独立 oracle：SSA 单步事件审计。
//
// 独立推导（项目书 §5.1、§13 G05）：在状态 j，
//   线性：λ = kf (N-j)，μ = kb j；
//   二聚：λ = kf A(A-1)/2（A = N-2j），μ = kb j。
// 直接法：给定 uWaiting，τ = -ln(uWaiting) / (λ+μ)；
// 给定 uChoice，uChoice*(λ+μ) < λ 为正向，否则反向。
// 本文件不导入任何生产代码。

export interface EventModel {
  id: "linear" | "dimer";
  totalUnits: number;
  forwardRate: number;
  reverseRate: number;
}

export interface OracleRates {
  birth: number;
  death: number;
  totalRate: number;
}

export function oracleRates(model: EventModel, state: number): OracleRates {
  const maxState =
    model.id === "linear"
      ? model.totalUnits
      : Math.floor(model.totalUnits / 2);
  if (!Number.isInteger(state) || state < 0 || state > maxState) {
    throw new RangeError(`state must be an integer in [0, ${maxState}]`);
  }
  let birth: number;
  if (model.id === "linear") {
    birth = model.forwardRate * (model.totalUnits - state);
  } else {
    const a = model.totalUnits - 2 * state;
    birth = (model.forwardRate * a * Math.max(0, a - 1)) / 2;
  }
  const death = model.reverseRate * state;
  const safeBirth = birth > 0 ? birth : 0;
  const safeDeath = death > 0 ? death : 0;
  return { birth: safeBirth, death: safeDeath, totalRate: safeBirth + safeDeath };
}

/** 等待时间：τ = -ln(uWaiting) / totalRate；totalRate=0 时为无穷（吸收）。 */
export function oracleWaitingTime(uWaiting: number, totalRate: number): number {
  if (!(uWaiting > 0 && uWaiting < 1)) {
    throw new RangeError("uWaiting must be in the open interval (0, 1)");
  }
  if (totalRate === 0) return Number.POSITIVE_INFINITY;
  return -Math.log(uWaiting) / totalRate;
}

/** 反应选择：uChoice*totalRate < birth 为正向，否则反向。 */
export function oracleChooseReaction(
  uChoice: number,
  rates: OracleRates,
): "forward" | "reverse" {
  if (!(uChoice >= 0 && uChoice < 1)) {
    throw new RangeError("uChoice must be in [0, 1)");
  }
  return uChoice * rates.totalRate < rates.birth ? "forward" : "reverse";
}

/** 单步审计：返回等待时间、反应方向与新状态。 */
export function oracleSingleStep(
  model: EventModel,
  state: number,
  uWaiting: number,
  uChoice: number,
): {
  birth: number;
  death: number;
  totalRate: number;
  waitingTime: number;
  reaction: "forward" | "reverse";
  stateAfter: number;
} {
  const rates = oracleRates(model, state);
  const waitingTime = oracleWaitingTime(uWaiting, rates.totalRate);
  const reaction = oracleChooseReaction(uChoice, rates);
  return {
    ...rates,
    waitingTime,
    reaction,
    stateAfter: reaction === "forward" ? state + 1 : state - 1,
  };
}
