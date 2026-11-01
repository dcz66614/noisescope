// P006 T007 — 独立事件复验 verifyAudit（项目书 §5、§11.2）
//
// 本文件绝不调用 SSA 主循环（不 import core/ssa.ts 的任何主循环函数），
// 也不复用生产速率表：
// - 随机流：只复用经过独立黄金向量测试的 RNG 原语（core/rng.ts 的
//   deriveTrajectorySeed / XorShift32），按声明种子、组别、轨迹号
//   重新派生 trajectorySeed，并按“初始抽样 → 每事件先 uWaiting 后
//   uChoice → HORIZON 终止候选再抽两次”的完整顺序核对。
// - 速率：按本节数学契约独立求出（线性 kf·(N−B)、kb·B；
//   二聚 kf·A(A−1)/2、kb·B，其中 A=N−2B），不 import 生产速率函数，
//   避免同一错误同时通过生产路径和复验路径。
// - 判定：离散值与 PRNG 的 U 逐值严格相等；由 log 与浮点算术得到的
//   时间与速率用 abs(a−b) ≤ 1e-10 × max(1,|a|,|b|)；分支选择与状态
//   更新必须完全一致。事件前后链连续、时间严格递增、事件 ≤ T、
//   状态守恒、终止状态及 101 个 sampledB 全部核对。
// - 本复验只能证明所记录事件符合规格与声明伪随机流，不能证明
//   随机流来自真实自然随机源，也不能单凭一条轨迹证明总体分布正确。

import { createTrajectoryRng, deriveTrajectorySeed } from "../core/rng";
import {
  stateCountForModel,
  type AuditTrace,
  type GroupId,
  type ModelSpec,
  type ScenarioV1,
} from "../domain/types";
import { validateScenario } from "../domain/validate";

export interface AuditVerification {
  valid: boolean;
  checkedEvents: number;
  errors: string[];
}

export const MAX_EVENTS_PER_TRAJECTORY = 20_000; // §5：每条轨迹至多 20000 个实际事件
const RELATIVE_TOLERANCE = 1e-10;

/** 取消 / 超时不算验证失败，统一标“复验未完成”，不显示已验证。 */
export function incompleteVerification(
  reason: "cancelled" | "timeout",
): AuditVerification {
  return {
    valid: false,
    checkedEvents: 0,
    errors: [`复验未完成 (${reason})`],
  };
}

function close(a: number, b: number): boolean {
  return (
    Math.abs(a - b) <=
    RELATIVE_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))
  );
}

/** 独立速率公式（见文件头注释，不复用生产速率表）。 */
export function independentRates(
  model: ModelSpec,
  state: number,
): { birth: number; death: number; totalRate: number } {
  const stateCount = stateCountForModel(model);
  if (!Number.isInteger(state) || state < 0 || state >= stateCount) {
    throw new RangeError(`state must be an integer in [0, ${stateCount - 1}]`);
  }
  let birth: number;
  let death: number;
  if (model.id === "linear") {
    birth = model.forwardRate * (model.totalUnits - state);
    death = model.reverseRate * state;
  } else {
    const countA = model.totalUnits - 2 * state;
    birth = (model.forwardRate * countA * (countA - 1)) / 2;
    death = model.reverseRate * state;
  }
  // 边界上 A=0 时公式给出 -0，规范成 0；速率本身不为负。
  birth = birth === 0 ? 0 : Math.max(0, birth);
  death = death === 0 ? 0 : Math.max(0, death);
  return { birth, death, totalRate: birth + death };
}

/** 独立初始抽样：取满足 u < CDF(j) 的最小 j；仅因 1e-12 归一性偏差落到末端时选最后一个非零支持状态。 */
function independentInitialState(
  pmf: readonly number[],
  u: number,
): number {
  let cumulative = 0;
  let lastPositive = -1;
  for (let j = 0; j < pmf.length; j += 1) {
    const probability = pmf[j]!;
    if (probability > 0) {
      lastPositive = j;
    }
    cumulative += probability;
    if (u < cumulative) {
      return j;
    }
  }
  if (lastPositive >= 0 && Math.abs(cumulative - 1) <= 1e-12) {
    return lastPositive;
  }
  throw new RangeError("initial PMF does not cover the drawn u");
}

/** 独立重算 sampledB：右连续——事件发生在观测时刻时，观测取事件后状态。 */
function recomputeSampledB(
  scenario: ScenarioV1,
  initialState: number,
  events: AuditTrace["events"],
): number[] {
  const sampledB: number[] = [];
  let state = initialState;
  let eventIndex = 0;
  for (let t = 0; t < scenario.observations; t += 1) {
    const time =
      t === scenario.observations - 1
        ? scenario.horizon
        : (scenario.horizon * t) / (scenario.observations - 1);
    while (
      eventIndex < events.length &&
      events[eventIndex]!.timeAfter <= time
    ) {
      state = events[eventIndex]!.stateAfter;
      eventIndex += 1;
    }
    sampledB.push(state);
  }
  return sampledB;
}

export function verifyAudit(
  scenarioInput: ScenarioV1,
  trace: AuditTrace,
): AuditVerification {
  const errors: string[] = [];
  const fail = (message: string): void => {
    errors.push(message);
  };

  let scenario: ScenarioV1;
  try {
    scenario = validateScenario(scenarioInput);
  } catch (error) {
    return {
      valid: false,
      checkedEvents: 0,
      errors: [`scenario: ${error instanceof Error ? error.message : "invalid scenario"}`],
    };
  }

  const group: GroupId = trace.group;
  if (group !== "P" && group !== "Q") {
    return { valid: false, checkedEvents: 0, errors: ["trace.group: EVIDENCE_MISMATCH"] };
  }
  if (
    !Number.isInteger(trace.trajectoryIndex) ||
    trace.trajectoryIndex < 0 ||
    trace.trajectoryIndex >= scenario.trajectoriesPerGroup
  ) {
    return { valid: false, checkedEvents: 0, errors: ["trace.trajectoryIndex: EVIDENCE_MISMATCH"] };
  }
  if (trace.events.length > MAX_EVENTS_PER_TRAJECTORY) {
    return {
      valid: false,
      checkedEvents: MAX_EVENTS_PER_TRAJECTORY,
      errors: ["events: BUDGET_EXCEEDED (per-trajectory event budget 20000)"],
    };
  }

  // 重新派生种子：不信任文件里的 trajectorySeed 以外的任何随机数。
  const expectedSeed = deriveTrajectorySeed(
    scenario.seed,
    group,
    trace.trajectoryIndex,
  );
  if (trace.initial.trajectorySeed !== expectedSeed) {
    fail("initial.trajectorySeed: EVIDENCE_MISMATCH");
  }
  const rng = createTrajectoryRng(
    scenario.seed,
    group,
    trace.trajectoryIndex,
  );
  const drawnInitial = rng.nextOpen01();
  if (trace.initial.uInitial !== drawnInitial) {
    fail("initial.uInitial: EVIDENCE_MISMATCH");
  }
  const pmf = scenario.initial[group];
  let state: number;
  try {
    state = independentInitialState(pmf, trace.initial.uInitial);
  } catch {
    fail("initial: EVIDENCE_MISMATCH (uInitial does not map to any state)");
    return { valid: false, checkedEvents: 0, errors };
  }
  if (trace.initial.initialState !== state) {
    fail("initial.initialState: EVIDENCE_MISMATCH");
  }

  let time = 0;
  let checkedEvents = 0;
  for (let i = 0; i < trace.events.length; i += 1) {
    const event = trace.events[i]!;
    const prefix = `events[${i}]`;
    if (event.index !== i) {
      fail(`${prefix}.index: EVIDENCE_MISMATCH`);
    }
    if (!close(event.timeBefore, time)) {
      fail(`${prefix}.timeBefore: EVIDENCE_MISMATCH`);
    }
    if (event.stateBefore !== state) {
      fail(`${prefix}.stateBefore: EVIDENCE_MISMATCH`);
    }
    let rates: { birth: number; death: number; totalRate: number };
    try {
      rates = independentRates(scenario.model, state);
    } catch {
      fail(`${prefix}.stateBefore: EVIDENCE_MISMATCH (state out of range)`);
      break;
    }
    if (!close(event.birth, rates.birth)) {
      fail(`${prefix}.birth: EVIDENCE_MISMATCH`);
    }
    if (!close(event.death, rates.death)) {
      fail(`${prefix}.death: EVIDENCE_MISMATCH`);
    }
    if (!close(event.totalRate, rates.totalRate)) {
      fail(`${prefix}.totalRate: EVIDENCE_MISMATCH`);
    }
    if (rates.totalRate === 0) {
      fail(`${prefix}: EVIDENCE_MISMATCH (event recorded at an absorbing state)`);
      break;
    }
    // 随机流顺序：先 uWaiting，后 uChoice；逐值严格相等。
    const uWaiting = rng.nextOpen01();
    const uChoice = rng.nextOpen01();
    if (event.uWaiting !== uWaiting) {
      fail(`${prefix}.uWaiting: EVIDENCE_MISMATCH`);
    }
    if (event.uChoice !== uChoice) {
      fail(`${prefix}.uChoice: EVIDENCE_MISMATCH`);
    }
    const waitingTime = -Math.log(uWaiting) / rates.totalRate;
    const candidateTime = time + waitingTime;
    if (!close(event.waitingTime, waitingTime)) {
      fail(`${prefix}.waitingTime: EVIDENCE_MISMATCH`);
    }
    if (!close(event.timeAfter, candidateTime)) {
      fail(`${prefix}.timeAfter: EVIDENCE_MISMATCH`);
    }
    if (event.timeAfter <= time) {
      fail(`${prefix}.timeAfter: EVIDENCE_MISMATCH (time must strictly increase)`);
    }
    if (event.timeAfter > scenario.horizon) {
      fail(`${prefix}.timeAfter: EVIDENCE_MISMATCH (event beyond horizon)`);
    }
    const reaction =
      uChoice * rates.totalRate < rates.birth ? "forward" : "reverse";
    if (event.reaction !== reaction) {
      fail(`${prefix}.reaction: EVIDENCE_MISMATCH`);
    }
    const expectedAfter = state + (reaction === "forward" ? 1 : -1);
    if (event.stateAfter !== expectedAfter) {
      fail(`${prefix}.stateAfter: EVIDENCE_MISMATCH`);
    }
    if (
      event.stateAfter < 0 ||
      event.stateAfter >= stateCountForModel(scenario.model)
    ) {
      fail(`${prefix}.stateAfter: EVIDENCE_MISMATCH (state out of range)`);
    }
    checkedEvents = i + 1;
    if (errors.length > 0) {
      // 第一个不一致事件之后不再用错误链继续推导，避免误报雪崩。
      break;
    }
    state = expectedAfter;
    time = candidateTime;
  }
  if (errors.length > 0) {
    return { valid: false, checkedEvents, errors };
  }

  // 终止记录：与当前（最后事件后）的时间、状态严格对应。
  const terminal = trace.terminal;
  if (terminal.reason === "ABSORBING") {
    const rates = independentRates(scenario.model, state);
    if (rates.totalRate !== 0) {
      fail("terminal: EVIDENCE_MISMATCH (absorbing claimed at a non-absorbing state)");
    }
    if (!close(terminal.time, time)) {
      fail("terminal.time: EVIDENCE_MISMATCH");
    }
    if (terminal.state !== state) {
      fail("terminal.state: EVIDENCE_MISMATCH");
    }
  } else if (terminal.reason === "HORIZON") {
    const rates = independentRates(scenario.model, state);
    if (rates.totalRate === 0) {
      fail("terminal: EVIDENCE_MISMATCH (horizon claimed at an absorbing state)");
    }
    const uWaiting = rng.nextOpen01();
    const uChoice = rng.nextOpen01();
    if (terminal.uWaiting !== uWaiting) {
      fail("terminal.uWaiting: EVIDENCE_MISMATCH");
    }
    if (terminal.uChoice !== uChoice) {
      fail("terminal.uChoice: EVIDENCE_MISMATCH");
    }
    const waitingTime = -Math.log(uWaiting) / rates.totalRate;
    const candidateTime = time + waitingTime;
    if (!close(terminal.totalRate, rates.totalRate)) {
      fail("terminal.totalRate: EVIDENCE_MISMATCH");
    }
    if (!close(terminal.waitingTime, waitingTime)) {
      fail("terminal.waitingTime: EVIDENCE_MISMATCH");
    }
    if (!close(terminal.candidateTime, candidateTime)) {
      fail("terminal.candidateTime: EVIDENCE_MISMATCH");
    }
    if (terminal.candidateTime <= scenario.horizon) {
      fail("terminal.candidateTime: EVIDENCE_MISMATCH (candidate must exceed horizon)");
    }
    if (!close(terminal.time, time)) {
      fail("terminal.time: EVIDENCE_MISMATCH");
    }
    if (terminal.state !== state) {
      fail("terminal.state: EVIDENCE_MISMATCH");
    }
  } else {
    fail("terminal.reason: EVIDENCE_MISMATCH (unknown terminal reason)");
  }
  if (errors.length > 0) {
    return { valid: false, checkedEvents, errors };
  }

  // 101 个 sampledB：独立重算，整数严格相等。
  if (trace.sampledB.length !== scenario.observations) {
    fail("sampledB: EVIDENCE_MISMATCH (length must be 101)");
    return { valid: false, checkedEvents, errors };
  }
  const recomputed = recomputeSampledB(scenario, trace.initial.initialState, trace.events);
  for (let t = 0; t < recomputed.length; t += 1) {
    if (trace.sampledB[t] !== recomputed[t]) {
      fail(`sampledB[${t}]: EVIDENCE_MISMATCH`);
      break;
    }
  }
  return { valid: errors.length === 0, checkedEvents, errors };
}
