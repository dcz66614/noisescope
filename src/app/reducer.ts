// P006 T009 — 界面状态机（项目书 §9、实施计划 T009）。
//
// 职责边界：只管 UI 状态（场景草稿、运行状态、时间游标、错误、过期），
// 不算公式、不碰 Worker、不改 types.ts / core / workerClient。
// - 计算参数（模型、N、速率、T、M、种子、初始 PMF、预置）变更时，
//   若已有 COMPLETE 结果，旧结果立即过期为 STALE；编辑期间旧结果
//   仅作灰化快照，导出结果按钮由 App 按状态禁用。
// - 标题与时间游标是非计算参数：改动它们不改变运行状态、不使结果过期、
//   不触发重跑（重跑只由“运行实验”显式发起，后续任务接 Worker）。
// - 任何输入错误都只设 error，绝不丢弃原 scenario（原配置原样保留）。
// - 冻结前修复：MOCK_COMPLETE 死代码分支已删除；完成只能走 Worker 的
//   RUN_COMPLETE。isMockResult 字段保留作导出门禁输入，真实链路恒为 false。

import { makePreset } from "../domain/presets";
import {
  ScenarioValidationError,
  validateScenario,
} from "../domain/validate";
import {
  stateCountForModel,
  type AuditTrace,
  type GroupId,
  type ModelId,
  type PresetId,
  type RunResult,
  type ScenarioV1,
} from "../domain/types";
import type { AuditVerification } from "../verify/replay";

export type RunStatus =
  | "READY"
  | "RUNNING"
  | "COMPLETE"
  | "STALE"
  | "CANCELLED"
  | "ERROR";

export type PmfMode = "point" | "two-point";

export interface AppState {
  scenario: ScenarioV1;
  presetId: PresetId;
  status: RunStatus;
  /** 上一次真实/模拟完成时的场景快照；STALE 时用它说明旧结果对应旧输入。 */
  lastRunScenario: ScenarioV1 | null;
  /** 导出门禁输入：true 时不可导出。reducer 删除 MOCK_COMPLETE 后不再将其置 true，真实链路恒为 false。 */
  isMockResult: boolean;
  /** 时间游标：观测点索引 0..100，非计算参数。 */
  timeIndex: number;
  error: string | null;
  /** 操作结果文字，例如模型变更后 PMF 已重置的说明。 */
  notice: string | null;
  /** T013：Worker 真实运行结果；RUN_REQUESTED 时清空，STALE 时保留旧快照。 */
  result: RunResult | null;
  /** T013：RUNNING 时的 Worker 进度；完成/失败/取消时清空。 */
  progress: {
    completedP: number;
    completedQ: number;
    targetPerGroup: number;
  } | null;
  /** T013：审计轨迹（Worker REPLAY 返回，并经独立复验）。 */
  trace: AuditTrace | null;
  /** T013：审计轨迹的独立复验结果；为 null 时不显示“已验证”。 */
  verification: AuditVerification | null;
  /** T013：审计当前所选组别与轨迹号。 */
  auditGroup: GroupId;
  auditIndex: number;
  /** T013：是否正在重放轨迹。 */
  auditLoading: boolean;
  /** T013：重放失败时的错误文案。 */
  auditError: string | null;
}

export type AppAction =
  | { type: "SELECT_PRESET"; presetId: PresetId }
  | { type: "UPDATE_TITLE"; title: string }
  | { type: "SET_TIME_INDEX"; timeIndex: number }
  | {
      type: "UPDATE_MODEL";
      modelId: ModelId;
      totalUnits: number;
    }
  | {
      type: "UPDATE_RATES";
      forwardRate?: number;
      reverseRate?: number;
    }
  | { type: "UPDATE_HORIZON"; horizon: number }
  | { type: "UPDATE_TRAJECTORIES"; trajectoriesPerGroup: number }
  | { type: "UPDATE_SEED"; seed: number }
  | {
      type: "UPDATE_PMF";
      group: GroupId;
      mode: PmfMode;
      pointIndex?: number;
      lowIndex?: number;
      highIndex?: number;
      lowWeight?: number;
    }
  | { type: "RESTORE_PRESET_PMF" }
  | { type: "RUN_REQUESTED" }
  | { type: "RUN_COMPLETE"; result?: RunResult | null }
  | {
      type: "RUN_PROGRESS";
      completedP: number;
      completedQ: number;
      targetPerGroup: number;
    }
  | { type: "CANCEL" }
  | { type: "RUN_FAILED"; message: string }
  | { type: "CLEAR_ERROR" }
  | { type: "SELECT_AUDIT"; group: GroupId; index: number }
  | { type: "REPLAY_REQUESTED" }
  | {
      type: "REPLAY_COMPLETE";
      trace: AuditTrace;
      verification: AuditVerification;
    }
  | { type: "REPLAY_FAILED"; message: string }
  | { type: "IMPORT_SCENARIO"; scenario: ScenarioV1 };

export const PRESET_OPTIONS: ReadonlyArray<{
  id: PresetId;
  label: string;
}> = [
  { id: "variance-split", label: "同均值不同走势" },
  { id: "linear-control", label: "线性对照" },
  { id: "frozen", label: "零速率冻结" },
];

export function initialState(presetId: PresetId = "variance-split"): AppState {
  return {
    scenario: makePreset(presetId),
    presetId,
    status: "READY",
    lastRunScenario: null,
    isMockResult: false,
    timeIndex: 0,
    error: null,
    notice: null,
    result: null,
    progress: null,
    trace: null,
    verification: null,
    auditGroup: "P",
    auditIndex: 0,
    auditLoading: false,
    auditError: null,
  };
}

/** PMF 理论均值：Σ j·p[j]（纯 UI 展示计算，不是 core 公式）。 */
export function pmfMean(pmf: ReadonlyArray<number>): number {
  return pmf.reduce((sum, p, j) => sum + p * j, 0);
}

/** PMF 总体方差：Σ (j − mean)²·p[j]（纯 UI 展示计算）。 */
export function pmfVariance(pmf: ReadonlyArray<number>): number {
  const mean = pmfMean(pmf);
  return pmf.reduce((sum, p, j) => sum + p * (j - mean) * (j - mean), 0);
}

/**
 * 同均值规范初始分布（项目书 §9.2“恢复同均值预置”与模型/N 变更后
 * 重建合法预置 PMF 的同一规则）：P 集中于中点，Q 两端各半，
 * 两组理论均值相等（均为中点索引）。
 */
export function canonicalInitial(model: {
  id: ModelId;
  totalUnits: number;
}): { P: number[]; Q: number[] } {
  // stateCountForModel 只读 id/totalUnits；速率字段在此处无意义，填 0。
  const stateCount = stateCountForModel({
    ...model,
    forwardRate: 0,
    reverseRate: 0,
  });
  const mid = Math.floor((stateCount - 1) / 2);
  const point = new Array<number>(stateCount).fill(0);
  point[mid] = 1;
  const split = new Array<number>(stateCount).fill(0);
  split[0] = 0.5;
  split[stateCount - 1] = 0.5;
  return { P: point, Q: split };
}

function withError(state: AppState, error: string): AppState {
  return { ...state, error, notice: null };
}

/** 计算参数变更后的状态：已有完成结果则过期，否则保持原状态。 */
function expireIfComplete(state: AppState, scenario: ScenarioV1): AppState {
  return {
    ...state,
    scenario,
    status: state.status === "COMPLETE" ? "STALE" : state.status,
    isMockResult: state.status === "COMPLETE" ? state.isMockResult : false,
    error: null,
    notice: state.notice,
  };
}

/**
 * 用候选场景跑一次严格校验；校验通过返回新场景，失败返回带 error
 * 且原场景原样保留的新状态（输入错误不丢原配置）。
 */
function tryApply(
  state: AppState,
  candidate: unknown,
  notice: string | null = null,
  expire = true,
): AppState {
  try {
    const scenario = validateScenario(candidate);
    const next = expire
      ? expireIfComplete(state, scenario)
      : { ...state, scenario, error: null, notice };
    return { ...next, notice };
  } catch (err) {
    if (err instanceof ScenarioValidationError) {
      return withError(state, `${err.field || "scenario"}：${err.message}`);
    }
    return withError(state, err instanceof Error ? err.message : "输入无效");
  }
}

function buildPmf(
  stateCount: number,
  mode: PmfMode,
  pointIndex: number | undefined,
  lowIndex: number | undefined,
  highIndex: number | undefined,
  lowWeight: number | undefined,
): number[] | string {
  const pmf = new Array<number>(stateCount).fill(0);
  if (mode === "point") {
    if (pointIndex === undefined || !Number.isInteger(pointIndex)) {
      return "点质量索引必须是整数";
    }
    if (pointIndex < 0 || pointIndex >= stateCount) {
      return "点质量索引超出状态范围";
    }
    pmf[pointIndex] = 1;
    return pmf;
  }
  if (
    lowIndex === undefined ||
    highIndex === undefined ||
    lowWeight === undefined ||
    !Number.isInteger(lowIndex) ||
    !Number.isInteger(highIndex) ||
    typeof lowWeight !== "number" ||
    !Number.isFinite(lowWeight)
  ) {
    return "双点混合需要两个整数索引与一个有限权重";
  }
  if (lowIndex < 0 || lowIndex >= stateCount || highIndex < 0 || highIndex >= stateCount) {
    return "双点索引超出状态范围";
  }
  if (lowIndex === highIndex) {
    return "双点混合的两个索引必须不同，否则请用点质量";
  }
  if (lowWeight < 0 || lowWeight > 1) {
    return "双点权重必须在 0 与 1 之间";
  }
  pmf[lowIndex] = lowWeight;
  pmf[highIndex] = 1 - lowWeight;
  return pmf;
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SELECT_PRESET": {
      // 预置切换是计算参数变更：已有完成结果则过期；无结果时保持 READY。
      const scenario = makePreset(action.presetId);
      const next = expireIfComplete(state, scenario);
      return { ...next, presetId: action.presetId, notice: null };
    }
    case "UPDATE_TITLE": {
      // 标题是非计算参数：只改标题，状态、过期、快照一律不动。
      // 标题非法时报错且原场景原样保留；标题不使结果过期。
      return tryApply(state, { ...state.scenario, title: action.title }, null, false);
    }
    case "SET_TIME_INDEX": {
      // 时间游标是非计算参数：只改游标，状态一律不动。
      if (!Number.isInteger(action.timeIndex)) {
        return withError(state, "时间游标必须是整数观测点");
      }
      const clamped = Math.min(100, Math.max(0, action.timeIndex));
      return { ...state, timeIndex: clamped };
    }
    case "UPDATE_MODEL": {
      // 模型或 N 变更：重建合法预置 PMF，并在 notice 中说明已重置。
      // 二聚 kf 上限 0.05，线性 kf 上限 1：超限时钳制到上限并一并说明。
      const maxForward = action.modelId === "dimer" ? 0.05 : 1;
      const forwardRate = Math.min(state.scenario.model.forwardRate, maxForward);
      const clampedNote =
        forwardRate !== state.scenario.model.forwardRate
          ? `正向速率已钳制到 ${maxForward}。`
          : "";
      const model = {
        id: action.modelId,
        totalUnits: action.totalUnits,
        forwardRate,
        reverseRate: state.scenario.model.reverseRate,
      };
      const candidate = {
        ...state.scenario,
        model,
        initial: canonicalInitial(model),
      };
      return tryApply(
        state,
        candidate,
        `已重置初始分布为合法预置 PMF：P 集中于中点，Q 两端各半。${clampedNote}`,
      );
    }
    case "UPDATE_RATES": {
      return tryApply(state, {
        ...state.scenario,
        model: {
          ...state.scenario.model,
          forwardRate:
            action.forwardRate ?? state.scenario.model.forwardRate,
          reverseRate:
            action.reverseRate ?? state.scenario.model.reverseRate,
        },
      });
    }
    case "UPDATE_HORIZON": {
      return tryApply(state, { ...state.scenario, horizon: action.horizon });
    }
    case "UPDATE_TRAJECTORIES": {
      return tryApply(state, {
        ...state.scenario,
        trajectoriesPerGroup: action.trajectoriesPerGroup,
      });
    }
    case "UPDATE_SEED": {
      return tryApply(state, { ...state.scenario, seed: action.seed });
    }
    case "UPDATE_PMF": {
      const stateCount = stateCountForModel(state.scenario.model);
      const built = buildPmf(
        stateCount,
        action.mode,
        action.pointIndex,
        action.lowIndex,
        action.highIndex,
        action.lowWeight,
      );
      if (typeof built === "string") {
        return withError(state, built);
      }
      return tryApply(state, {
        ...state.scenario,
        initial: { ...state.scenario.initial, [action.group]: built },
      });
    }
    case "RESTORE_PRESET_PMF": {
      const candidate = {
        ...state.scenario,
        initial: canonicalInitial(state.scenario.model),
      };
      return tryApply(
        state,
        candidate,
        "已恢复同均值预置：P 集中于中点，Q 两端各半。",
      );
    }
    case "RUN_REQUESTED": {
      if (state.status === "RUNNING") {
        return state;
      }
      return {
        ...state,
        status: "RUNNING",
        error: null,
        notice: null,
        isMockResult: false,
        // 新运行开始：旧结果、旧进度、旧审计一律清空，运行中绝不展示部分结果。
        result: null,
        progress: null,
        trace: null,
        verification: null,
        auditLoading: false,
        auditError: null,
      };
    }
    case "RUN_PROGRESS": {
      if (state.status !== "RUNNING") {
        return state;
      }
      return {
        ...state,
        progress: {
          completedP: action.completedP,
          completedQ: action.completedQ,
          targetPerGroup: action.targetPerGroup,
        },
      };
    }
    case "RUN_COMPLETE": {
      // T013：Worker 真实完成。result 缺省时（旧调用）保持原有语义，
      // 仅置状态；有 result 时存入，供各视图与导出共享同一 scenario/runId。
      if (state.status !== "RUNNING") {
        return state;
      }
      const result = action.result ?? null;
      return {
        ...state,
        status: "COMPLETE",
        lastRunScenario: result !== null ? result.scenario : state.scenario,
        isMockResult: false,
        notice: null,
        result,
        progress: null,
      };
    }
    case "CANCEL": {
      if (state.status !== "RUNNING") {
        return state;
      }
      return {
        ...state,
        status: "CANCELLED",
        error: null,
        notice: null,
        progress: null,
        result: null,
      };
    }
    case "RUN_FAILED": {
      return {
        ...state,
        status: "ERROR",
        error: action.message,
        notice: null,
        progress: null,
        result: null,
      };
    }
    case "SELECT_AUDIT": {
      // 换选组别/轨迹号：旧轨迹属于另一条轨迹，清空，不展示错轨迹。
      if (
        state.auditGroup === action.group &&
        state.auditIndex === action.index
      ) {
        return state;
      }
      return {
        ...state,
        auditGroup: action.group,
        auditIndex: action.index,
        trace: null,
        verification: null,
        auditLoading: false,
        auditError: null,
      };
    }
    case "REPLAY_REQUESTED": {
      if (state.result === null || state.auditLoading) {
        return state;
      }
      return {
        ...state,
        auditLoading: true,
        auditError: null,
        trace: null,
        verification: null,
      };
    }
    case "REPLAY_COMPLETE": {
      if (!state.auditLoading) {
        return state;
      }
      return {
        ...state,
        auditLoading: false,
        trace: action.trace,
        verification: action.verification,
        auditError: null,
      };
    }
    case "REPLAY_FAILED": {
      return {
        ...state,
        auditLoading: false,
        trace: null,
        verification: null,
        auditError: action.message,
      };
    }
    case "IMPORT_SCENARIO": {
      // 导入的新实验取代当前实验：旧结果与审计随之失效，回到 READY。
      // presetId 尽量匹配同值预置；匹配不上时保持原 presetId。
      // 导入提示只由 FileActions 在文件区显示一次（它已含标题），
      // 这里不再另设 notice，避免状态栏与文件区重复播报同一提示。
      let presetId = state.presetId;
      for (const id of ["variance-split", "linear-control", "frozen"] as const) {
        if (
          JSON.stringify(makePreset(id)) === JSON.stringify(action.scenario)
        ) {
          presetId = id;
          break;
        }
      }
      return {
        ...state,
        scenario: action.scenario,
        presetId,
        status: "READY",
        lastRunScenario: null,
        isMockResult: false,
        result: null,
        progress: null,
        trace: null,
        verification: null,
        auditGroup: "P",
        auditIndex: 0,
        auditLoading: false,
        auditError: null,
        error: null,
        notice: null,
      };
    }
    case "CLEAR_ERROR": {
      return { ...state, error: null };
    }
    default: {
      return state;
    }
  }
}
