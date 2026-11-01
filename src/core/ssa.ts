import type {
  AuditTrace,
  GroupId,
  InitialDraw,
  ModelSpec,
  ReactionEvent,
  SampleGroup,
  TerminalRecord,
} from "../domain/types";
import {
  createTrajectoryRng,
  deriveTrajectorySeed,
  type RandomSource,
} from "./rng";

/**
 * 预算分层（项目书 §5、§12.2；GPT 终审 Round 1 修复）：
 * - MAX_EVENTS_PER_TRAJECTORY = 20_000：每条轨迹的实际事件上限，
 *   与 src/verify/replay.ts 的同名预算一致，超限即 SsaBudgetError。
 * - DEFAULT_EVENT_BUDGET = 10_000_000：整次运行（P、Q 两组合计）
 *   的累计事件上限，由 Worker 执行；不是每条轨迹的预算。
 * 正常运行（M≤4096、T=8、低速率）事件量远低于两层上限。
 */
export const MAX_EVENTS_PER_TRAJECTORY = 20_000;
export const DEFAULT_EVENT_BUDGET = 10_000_000;

export class SsaBudgetError extends Error {
  readonly code = "BUDGET_EXCEEDED" as const;

  constructor(limit: number) {
    super(`SSA event budget exceeded: ${limit}`);
    this.name = "SsaBudgetError";
  }
}

export interface ReactionRates {
  birth: number;
  death: number;
  totalRate: number;
}

export interface SimulateTrajectoryOptions {
  model: ModelSpec;
  initialPmf: readonly number[];
  horizon: number;
  observationTimes: ArrayLike<number>;
  baseSeed: number;
  group: GroupId;
  trajectoryIndex: number;
  maxEvents?: number;
  rng?: RandomSource;
}

export interface SimulatedTrajectory {
  sampledB: Uint32Array;
  eventsExecuted: number;
  trace: AuditTrace;
}

export interface SimulateGroupOptions {
  model: ModelSpec;
  initialPmf: readonly number[];
  horizon: number;
  observationTimes: ArrayLike<number>;
  trajectories: number;
  baseSeed: number;
  group: GroupId;
  maxEvents?: number;
  /** 整组累计事件上限；默认 DEFAULT_EVENT_BUDGET，超限抛 SsaBudgetError。 */
  totalEventBudget?: number;
}

function assertObservationTimes(
  observationTimes: ArrayLike<number>,
  horizon: number,
): void {
  if (observationTimes.length === 0) {
    throw new RangeError("observationTimes must not be empty");
  }

  let previous = -Infinity;
  for (let index = 0; index < observationTimes.length; index += 1) {
    const time = observationTimes[index]!;
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      time > horizon ||
      time < previous
    ) {
      throw new RangeError(
        "observationTimes must be finite, nondecreasing, and within [0, horizon]",
      );
    }
    previous = time;
  }
}

function stateCount(model: ModelSpec): number {
  return model.id === "linear"
    ? model.totalUnits + 1
    : Math.floor(model.totalUnits / 2) + 1;
}

export function reactionRates(
  model: ModelSpec,
  state: number,
): ReactionRates {
  const maximumState = stateCount(model) - 1;
  if (!Number.isInteger(state) || state < 0 || state > maximumState) {
    throw new RangeError(`state must be an integer in [0, ${maximumState}]`);
  }

  let birth: number;
  if (model.id === "linear") {
    const countA = model.totalUnits - state;
    birth = model.forwardRate * countA;
  } else {
    const countA = model.totalUnits - 2 * state;
    birth = model.forwardRate * countA * (countA - 1) * 0.5;
  }

  const death = model.reverseRate * state;
  const safeBirth = birth > 0 ? birth : 0;
  const safeDeath = death > 0 ? death : 0;

  return {
    birth: safeBirth,
    death: safeDeath,
    totalRate: safeBirth + safeDeath,
  };
}

export function sampleInitialState(
  pmf: readonly number[],
  rng: RandomSource,
): { uInitial: number; initialState: number } {
  if (pmf.length === 0) {
    throw new RangeError("initial PMF must not be empty");
  }

  const uInitial = rng.nextOpen01();
  let cumulative = 0;
  let finalPositiveState = -1;

  for (let state = 0; state < pmf.length; state += 1) {
    const probability = pmf[state]!;
    if (!Number.isFinite(probability) || probability < 0) {
      throw new RangeError("initial PMF values must be finite and non-negative");
    }
    if (probability > 0) {
      finalPositiveState = state;
    }
    cumulative += probability;
    if (uInitial < cumulative) {
      return { uInitial, initialState: state };
    }
  }

  if (finalPositiveState >= 0 && Math.abs(cumulative - 1) <= 1e-12) {
    return { uInitial, initialState: finalPositiveState };
  }

  throw new RangeError("initial PMF must sum to one");
}

export function createObservationTimes(
  horizon: number,
  observations: number,
): Float64Array {
  if (!Number.isFinite(horizon) || horizon < 0) {
    throw new RangeError("horizon must be finite and non-negative");
  }
  if (!Number.isInteger(observations) || observations < 1) {
    throw new RangeError("observations must be a positive integer");
  }

  const times = new Float64Array(observations);
  if (observations === 1) {
    times[0] = 0;
    return times;
  }

  for (let index = 0; index < observations; index += 1) {
    times[index] = (horizon * index) / (observations - 1);
  }
  times[observations - 1] = horizon;
  return times;
}

export function simulateTrajectory(
  options: SimulateTrajectoryOptions,
): SimulatedTrajectory {
  const {
    model,
    initialPmf,
    horizon,
    observationTimes,
    baseSeed,
    group,
    trajectoryIndex,
  } = options;

  if (!Number.isFinite(horizon) || horizon < 0) {
    throw new RangeError("horizon must be finite and non-negative");
  }
  assertObservationTimes(observationTimes, horizon);

  const maximumState = stateCount(model) - 1;
  if (initialPmf.length !== maximumState + 1) {
    throw new RangeError("initial PMF length does not match the model state space");
  }

  const maxEvents = options.maxEvents ?? MAX_EVENTS_PER_TRAJECTORY;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 0) {
    throw new RangeError("maxEvents must be a non-negative safe integer");
  }

  const trajectorySeed = deriveTrajectorySeed(
    baseSeed,
    group,
    trajectoryIndex,
  );
  const rng =
    options.rng ??
    createTrajectoryRng(baseSeed, group, trajectoryIndex);
  const initialSample = sampleInitialState(initialPmf, rng);
  const initial: InitialDraw = {
    ...initialSample,
    trajectorySeed,
  };

  const sampledB = new Uint32Array(observationTimes.length);
  const events: ReactionEvent[] = [];
  let observationIndex = 0;
  let state = initial.initialState;
  let time = 0;

  const fillBefore = (exclusiveTime: number): void => {
    while (
      observationIndex < observationTimes.length &&
      observationTimes[observationIndex]! < exclusiveTime
    ) {
      sampledB[observationIndex] = state;
      observationIndex += 1;
    }
  };

  const fillRemaining = (): void => {
    while (observationIndex < observationTimes.length) {
      sampledB[observationIndex] = state;
      observationIndex += 1;
    }
  };

  while (true) {
    const rates = reactionRates(model, state);

    if (rates.totalRate === 0) {
      fillRemaining();
      const terminal: TerminalRecord = {
        reason: "ABSORBING",
        time,
        state,
      };
      return {
        sampledB,
        eventsExecuted: events.length,
        trace: {
          group,
          trajectoryIndex,
          initial,
          events,
          terminal,
          sampledB: Array.from(sampledB),
        },
      };
    }

    if (events.length >= maxEvents) {
      throw new SsaBudgetError(maxEvents);
    }

    const uWaiting = rng.nextOpen01();
    const uChoice = rng.nextOpen01();
    const waitingTime = -Math.log(uWaiting) / rates.totalRate;
    const candidateTime = time + waitingTime;

    if (candidateTime > horizon) {
      fillRemaining();
      const terminal: TerminalRecord = {
        reason: "HORIZON",
        time,
        state,
        totalRate: rates.totalRate,
        uWaiting,
        uChoice,
        waitingTime,
        candidateTime,
      };
      return {
        sampledB,
        eventsExecuted: events.length,
        trace: {
          group,
          trajectoryIndex,
          initial,
          events,
          terminal,
          sampledB: Array.from(sampledB),
        },
      };
    }

    fillBefore(candidateTime);

    const stateBefore = state;
    const reaction =
      uChoice * rates.totalRate < rates.birth ? "forward" : "reverse";
    state += reaction === "forward" ? 1 : -1;

    if (state < 0 || state > maximumState) {
      throw new Error("SSA reaction produced a state outside the model bounds");
    }

    const event: ReactionEvent = {
      index: events.length,
      timeBefore: time,
      stateBefore,
      birth: rates.birth,
      death: rates.death,
      totalRate: rates.totalRate,
      uWaiting,
      uChoice,
      waitingTime,
      reaction,
      timeAfter: candidateTime,
      stateAfter: state,
    };
    events.push(event);
    time = candidateTime;
  }
}

export function simulateSampleGroup(
  options: SimulateGroupOptions,
): SampleGroup {
  const {
    model,
    initialPmf,
    horizon,
    observationTimes,
    trajectories,
    baseSeed,
    group,
    maxEvents,
  } = options;

  if (!Number.isSafeInteger(trajectories) || trajectories < 0) {
    throw new RangeError("trajectories must be a non-negative safe integer");
  }

  const stateCountValue = stateCount(model);
  const timeCount = observationTimes.length;
  const counts = new Uint32Array(timeCount * stateCountValue);
  const meanB = new Float64Array(timeCount);
  const varianceB = new Float64Array(timeCount);
  const previewCount = Math.min(32, trajectories);
  const previewB = new Uint8Array(previewCount * timeCount);
  const sum = new Float64Array(timeCount);
  const sumSquares = new Float64Array(timeCount);
  let eventsExecuted = 0;
  const totalBudget = options.totalEventBudget ?? DEFAULT_EVENT_BUDGET;

  for (
    let trajectoryIndex = 0;
    trajectoryIndex < trajectories;
    trajectoryIndex += 1
  ) {
    const result = simulateTrajectory({
      model,
      initialPmf,
      horizon,
      observationTimes,
      baseSeed,
      group,
      trajectoryIndex,
      ...(maxEvents === undefined ? {} : { maxEvents }),
    });

    eventsExecuted += result.eventsExecuted;
    if (eventsExecuted > totalBudget) {
      throw new SsaBudgetError(totalBudget);
    }

    for (let timeIndex = 0; timeIndex < timeCount; timeIndex += 1) {
      const state = result.sampledB[timeIndex]!;
      const countIndex = timeIndex * stateCountValue + state;
      counts[countIndex] = counts[countIndex]! + 1;
      sum[timeIndex] = sum[timeIndex]! + state;
      sumSquares[timeIndex] = sumSquares[timeIndex]! + state * state;
      if (trajectoryIndex < previewCount) {
        previewB[trajectoryIndex * timeCount + timeIndex] = state;
      }
    }
  }

  if (trajectories > 0) {
    for (let timeIndex = 0; timeIndex < timeCount; timeIndex += 1) {
      const mean = sum[timeIndex]! / trajectories;
      meanB[timeIndex] = mean;
      varianceB[timeIndex] = Math.max(
        0,
        sumSquares[timeIndex]! / trajectories - mean * mean,
      );
    }
  }

  return {
    counts,
    completed: trajectories,
    meanB,
    varianceB,
    previewB,
    eventsExecuted,
  };
}
