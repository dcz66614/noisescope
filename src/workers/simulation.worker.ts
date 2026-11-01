// P006 T008 — Worker 与运行协议（项目书 §11.4、§5）
//
// 职责：只做计算调度，不维护组件状态，不用共享内存，不开多 Worker 池，
// 不连后端。核心公式全部复用 core/ssa.ts 与 core/reference.ts，
// 本文件不重写任何速率、PMF、闭合公式。
//
// 协议（类型见 src/domain/types.ts，T002 冻结）：
// - RUN：批处理 SSA + 两组 CME 基准；P、Q 都完成 M 条后才发 RESULT。
// - REPLAY：按同一 per-trajectory 种子重算一条轨迹，返回 AuditTrace，
//   其 sampledB（101 个采样值）与原轨迹逐值一致。
// - PROGRESS：每完成最多 64 条轨迹至少发一次；completedP/Q 绝不超过 M。
// - ERROR：校验 / 预算 / 内部错误时只发 ERROR，不发部分 RESULT。
// - 取消：主线程 terminate 当前 Worker 并创建新实例实现（见 workerClient），
//   Worker 本身不处理取消消息；runId 严格单调由客户端保证，Worker 只回显。
//
// 批处理与结果不变性：轨迹按 trajectoryIndex 升序逐条计算，
// batchSize 只改变“每多少条发一次进度”的切分，不改变计算顺序、
// 求和顺序与随机消耗，因此 batch=1/17/64 的结果逐值一致，
// M 增大时已有轨迹前缀也不变（见项目书 §5、§11.2）。
//
// 峰值数据规模：不缓存全部轨迹。SSA 逐条聚合为 counts（101*S）、
// 均值/方差（101）与 preview（min(32,M)*101），与 M 无关；
// 参考 PMF 同样是 101*S。当前轨迹以外的轨迹不保留。

import { solveReference } from "../core/reference";
import {
  createObservationTimes,
  DEFAULT_EVENT_BUDGET,
  simulateTrajectory,
  SsaBudgetError,
} from "../core/ssa";
import {
  stateCountForModel,
  type AuditTrace,
  type ErrorCode,
  type GroupId,
  type RunResult,
  type SampleGroup,
  type ScenarioV1,
  type WorkerRequest,
  type WorkerResponse,
} from "../domain/types";
import {
  ScenarioValidationError,
  validateScenario,
} from "../domain/validate";

/** 默认批大小：项目书要求“每完成最多 64 条至少发一次进度”。 */
export const DEFAULT_BATCH_SIZE = 64;

export interface RunWorkerOptions {
  /** 每多少条轨迹发一次进度；必须为正整数，默认 64。 */
  batchSize?: number;
  /** 每条轨迹的 SSA 事件预算上限；默认 MAX_EVENTS_PER_TRAJECTORY（20_000）。 */
  maxEvents?: number;
  /** 整次运行（P、Q 两组合计）的累计事件上限；默认 DEFAULT_EVENT_BUDGET。 */
  totalEventBudget?: number;
  /** 收到一条进度时调用；Worker 消息层由它组装 PROGRESS。 */
  onProgress?: (progress: {
    runId: number;
    completedP: number;
    completedQ: number;
    targetPerGroup: number;
  }) => void;
}

function resolveBatchSize(batchSize: number | undefined): number {
  const value = batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("batchSize must be a positive safe integer");
  }
  return value;
}

function toErrorCode(error: unknown): ErrorCode {
  if (error instanceof ScenarioValidationError) {
    return error.code;
  }
  if (error instanceof SsaBudgetError) {
    return "BUDGET_EXCEEDED";
  }
  if (
    error instanceof RangeError ||
    error instanceof TypeError
  ) {
    return "INVALID_MODEL";
  }
  return "INTERNAL_ERROR";
}

/**
 * 批处理聚合一组的 SSA：逐条 simulateTrajectory，累计 counts / 和 /
 * 平方和 / preview / 事件数；不保留已算完的轨迹。
 * completed 计数在批边界处通过 onBatch 回调上报，且永不超过 M。
 */
function simulateGroupBatched(
  scenario: ScenarioV1,
  group: GroupId,
  times: Float64Array,
  batchSize: number,
  maxEvents: number | undefined,
  onBatch: (completed: number) => void,
  /** 跨 P、Q 两组共享的累计预算计数器；超限即抛 SsaBudgetError。 */
  sharedBudget?: { limit: number; used: number },
): SampleGroup {
  const model = scenario.model;
  const stateCount = stateCountForModel(model);
  const timeCount = times.length;
  const trajectories = scenario.trajectoriesPerGroup;
  const counts = new Uint32Array(timeCount * stateCount);
  const meanB = new Float64Array(timeCount);
  const varianceB = new Float64Array(timeCount);
  const previewCount = Math.min(32, trajectories);
  const previewB = new Uint8Array(previewCount * timeCount);
  const sum = new Float64Array(timeCount);
  const sumSquares = new Float64Array(timeCount);
  let eventsExecuted = 0;

  for (let start = 0; start < trajectories; start += batchSize) {
    const end = Math.min(trajectories, start + batchSize);
    for (let trajectoryIndex = start; trajectoryIndex < end; trajectoryIndex += 1) {
      const result = simulateTrajectory({
        model,
        initialPmf: scenario.initial[group],
        horizon: scenario.horizon,
        observationTimes: times,
        baseSeed: scenario.seed,
        group,
        trajectoryIndex,
        ...(maxEvents === undefined ? {} : { maxEvents }),
      });
      eventsExecuted += result.eventsExecuted;
      if (sharedBudget !== undefined) {
        sharedBudget.used += result.eventsExecuted;
        if (sharedBudget.used > sharedBudget.limit) {
          throw new SsaBudgetError(sharedBudget.limit);
        }
      }
      for (let timeIndex = 0; timeIndex < timeCount; timeIndex += 1) {
        const state = result.sampledB[timeIndex]!;
        counts[timeIndex * stateCount + state] =
          counts[timeIndex * stateCount + state]! + 1;
        sum[timeIndex] = sum[timeIndex]! + state;
        sumSquares[timeIndex] = sumSquares[timeIndex]! + state * state;
        if (trajectoryIndex < previewCount) {
          previewB[trajectoryIndex * timeCount + timeIndex] = state;
        }
      }
    }
    // 批边界：completed 是已算完的条数，end <= trajectories，故永不超 M。
    onBatch(end);
  }

  for (let timeIndex = 0; timeIndex < timeCount; timeIndex += 1) {
    const mean = sum[timeIndex]! / trajectories;
    meanB[timeIndex] = mean;
    varianceB[timeIndex] = Math.max(
      0,
      sumSquares[timeIndex]! / trajectories - mean * mean,
    );
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

/**
 * 执行一次完整 RUN：校验 -> 两组 CME 基准 -> 两组批处理 SSA。
 * 只有 P、Q 都完成 M 条才返回；任何一步失败都抛错，由消息层转为 ERROR，
 * 绝不返回部分结果标 COMPLETE。
 */
export function runScenario(
  input: unknown,
  runId: number,
  options: RunWorkerOptions = {},
): RunResult {
  const scenario = validateScenario(input);
  const batchSize = resolveBatchSize(options.batchSize);
  const started = performance.now();
  const times = createObservationTimes(
    scenario.horizon,
    scenario.observations,
  );

  const referenceStarted = performance.now();
  const referenceP = solveReference(scenario, "P");
  const referenceQ = solveReference(scenario, "Q");
  const referenceMs = performance.now() - referenceStarted;

  const ssaStarted = performance.now();
  let completedP = 0;
  let completedQ = 0;
  const emit = (): void => {
    options.onProgress?.({
      runId,
      completedP,
      completedQ,
      targetPerGroup: scenario.trajectoriesPerGroup,
    });
  };
  // 整次运行累计预算：P、Q 两组共享同一计数器，超限即 ERROR，绝不发部分 RESULT。
  const sharedBudget = {
    limit: options.totalEventBudget ?? DEFAULT_EVENT_BUDGET,
    used: 0,
  };
  const sampleP = simulateGroupBatched(
    scenario,
    "P",
    times,
    batchSize,
    options.maxEvents,
    (completed) => {
      completedP = completed;
      emit();
    },
    sharedBudget,
  );
  const sampleQ = simulateGroupBatched(
    scenario,
    "Q",
    times,
    batchSize,
    options.maxEvents,
    (completed) => {
      completedQ = completed;
      emit();
    },
    sharedBudget,
  );
  const ssaMs = performance.now() - ssaStarted;

  // 双重门禁：即使上游循环有 bug，也绝不在一组未完成时发 RESULT。
  if (
    sampleP.completed !== scenario.trajectoriesPerGroup ||
    sampleQ.completed !== scenario.trajectoriesPerGroup
  ) {
    throw new Error("internal: run finished with an incomplete group");
  }

  return {
    runId,
    scenario,
    stateCount: stateCountForModel(scenario.model),
    times,
    reference: { P: referenceP, Q: referenceQ },
    sample: { P: sampleP, Q: sampleQ },
    engineVersion: "1.0.0",
    status: "COMPLETE",
    elapsedMs: performance.now() - started,
    timings: { referenceMs, ssaMs },
  };
}

/**
 * REPLAY：按同一 per-trajectory 种子重算一条轨迹。
 * 与 RUN 中的原轨迹共享 simulateTrajectory 与种子派生，
 * 故 sampledB（101 个采样值）逐值一致。
 */
export function replayTrajectory(
  input: unknown,
  group: GroupId,
  trajectoryIndex: number,
): AuditTrace {
  const scenario = validateScenario(input);
  if (
    !Number.isSafeInteger(trajectoryIndex) ||
    trajectoryIndex < 0 ||
    trajectoryIndex >= scenario.trajectoriesPerGroup
  ) {
    throw new RangeError(
      `trajectoryIndex must be an integer in [0, ${scenario.trajectoriesPerGroup})`,
    );
  }
  const times = createObservationTimes(
    scenario.horizon,
    scenario.observations,
  );
  return simulateTrajectory({
    model: scenario.model,
    initialPmf: scenario.initial[group],
    horizon: scenario.horizon,
    observationTimes: times,
    baseSeed: scenario.seed,
    group,
    trajectoryIndex,
  }).trace;
}

/**
 * 纯消息层：把一个 WorkerRequest 转成有序的 WorkerResponse 序列。
 * RUN：PROGRESS* + RESULT，或单个 ERROR；REPLAY：单个 TRACE 或 ERROR。
 * 本函数不依赖 Worker 全局对象，可在 Vitest 里直接测试协议；
 * 真实 Worker 入口在文件底部，只在 WorkerGlobalScope 里注册。
 */
export function handleRequest(
  request: WorkerRequest,
  options: RunWorkerOptions = {},
): WorkerResponse[] {
  const responses: WorkerResponse[] = [];
  try {
    if (request.type === "RUN") {
      const result = runScenario(request.scenario, request.runId, {
        ...options,
        onProgress: (progress) => {
          responses.push({ type: "PROGRESS", ...progress });
          options.onProgress?.(progress);
        },
      });
      responses.push({ type: "RESULT", runId: request.runId, result });
      return responses;
    }
    if (request.type === "REPLAY") {
      const trace = replayTrajectory(
        request.scenario,
        request.group,
        request.trajectoryIndex,
      );
      return [{ type: "TRACE", runId: request.runId, trace }];
    }
    return [
      {
        type: "ERROR",
        runId: (request as { runId?: number }).runId ?? 0,
        code: "INTERNAL_ERROR",
        message: `unknown request type: ${String(
          (request as { type?: unknown }).type,
        )}`,
      },
    ];
  } catch (error) {
    return [
      {
        type: "ERROR",
        runId: request.runId,
        code: toErrorCode(error),
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

// 真实 Worker 入口：仅在 Dedicated Worker 全局作用域里注册，
// 在 Node / Vitest 里 import 本文件时不注册、不发消息。
// 判别用 Worker 独有的 importScripts（主线程与 Node 全局都没有），
// 且不引用 WebWorker lib 里的 WorkerGlobalScope 类型——tsconfig 的
// lib 是 DOM（T001 锁定，T008 不改构建配置），引用它会使 typecheck 失败。
const workerScope = globalThis as unknown as {
  addEventListener?: (
    type: string,
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ) => void;
  postMessage?: (response: WorkerResponse) => void;
  importScripts?: unknown;
};
if (
  typeof workerScope.addEventListener === "function" &&
  typeof workerScope.postMessage === "function" &&
  typeof workerScope.importScripts === "function"
) {
  workerScope.addEventListener("message", (event) => {
    for (const response of handleRequest(event.data)) {
      workerScope.postMessage!(response);
    }
  });
}

export { DEFAULT_EVENT_BUDGET };
