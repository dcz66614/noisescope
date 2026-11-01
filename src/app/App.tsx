// P006 T013 — 端到端集成（项目书 §9）。
//
// 打通真实链路：实验控制 → Worker（RUN/REPLAY）→ 结果 → 分布舞台 /
// 均值时间线 / 诊断面板 / 事件审计 / 文件交互。所有视图与导出共享
// 同一个 RunResult（同一 scenario/runId），不各自重算、不拼凑数据。
// 生产路径无 mock 完成入口：ExperimentControls 的 mock 按钮已在 T013
// 移除；reducer 的 MOCK_COMPLETE 死代码分支已在冻结前修复中删除，
// 生产 UI 不再派发它，isMockResult 在真实链路中恒为 false。
import { useEffect, useReducer, useRef } from "react";
import { ExperimentControls } from "../components/ExperimentControls";
import { DistributionView } from "../components/DistributionView";
import type { DistributionGroupSlice } from "../components/distributionData";
import { MeanTimeline } from "../components/MeanTimeline";
import { DiagnosticPanel } from "../components/DiagnosticPanel";
import type { DiagnosticGroupData } from "../components/DiagnosticPanel";
import { EventInspector } from "../components/EventInspector";
import { FileActions } from "../components/FileActions";
import type {
  EvidenceVerificationOutcome,
  ExportFile,
} from "../components/FileActions";
import {
  CancelledError,
  createWorkerClient,
  type SimulationWorkerClient,
} from "./workerClient";
import { computeComparisonSeries } from "../core/diagnostics";
import {
  serializeEvidence,
  verifyImportedEvidence,
} from "../io/evidence";
import { verifyAudit } from "../verify/replay";
import {
  stateCountForModel,
  type EvidenceV1,
  type GroupId,
  type RunResult,
  type ScenarioV1,
} from "../domain/types";
import {
  initialState,
  pmfMean,
  reducer,
  type AppAction,
  type RunStatus,
} from "./reducer";
import "../styles/tokens.css";
import "../styles/app.css";

// T001 smoke 测试仍导入此常量；标题文本与正式页眉一致，保留以不破坏骨架验收。
export const PLACEHOLDER_TITLE = "P006 反应骰 NoiseScope";

const STATUS_LABEL: Record<string, string> = {
  READY: "就绪",
  RUNNING: "运行中",
  COMPLETE: "已完成",
  STALE: "已过期",
  CANCELLED: "已取消",
  ERROR: "错误",
};

type ViewStatus = "empty" | "running" | "ready" | "error";

function toViewStatus(status: RunStatus): ViewStatus {
  if (status === "COMPLETE" || status === "STALE") return "ready";
  if (status === "RUNNING") return "running";
  if (status === "ERROR") return "error";
  return "empty";
}

/** 从 RunResult 切出单时刻分布切片（调用方切片，组件不重算）。 */
function sliceDistribution(
  result: RunResult,
  timeIndex: number,
): { P: DistributionGroupSlice; Q: DistributionGroupSlice } {
  const stateCount = result.stateCount;
  const offset = timeIndex * stateCount;
  const slice = (group: GroupId): DistributionGroupSlice => {
    const reference = result.reference[group];
    const sample = result.sample[group];
    return {
      group,
      referenceProb: Array.from(
        reference.pmf.subarray(offset, offset + stateCount),
      ),
      sampleCounts: Array.from(
        sample.counts.subarray(offset, offset + stateCount),
      ),
      completed: sample.completed,
      referenceMeanB: reference.meanB[timeIndex]!,
      sampleMeanB: sample.meanB[timeIndex]!,
      referenceVarianceB: reference.varianceB[timeIndex]!,
      sampleVarianceB: sample.varianceB[timeIndex]!,
    };
  };
  return { P: slice("P"), Q: slice("Q") };
}

/** 单时刻 CDF：参考累计概率与经验累计概率（调用方计算，面板只展示）。 */
function cdfArrays(
  referenceProb: readonly number[],
  sampleCounts: readonly number[],
  completed: number,
): { referenceCdf: number[]; empiricalCdf: number[] } {
  const referenceCdf: number[] = [];
  const empiricalCdf: number[] = [];
  let refSum = 0;
  let empSum = 0;
  for (let j = 0; j < referenceProb.length; j += 1) {
    refSum += referenceProb[j]!;
    empSum += completed > 0 ? sampleCounts[j]! / completed : 0;
    referenceCdf.push(refSum);
    empiricalCdf.push(empSum);
  }
  return { referenceCdf, empiricalCdf };
}

/** 从 RunResult 切出单时刻诊断数据（调用方计算三类差异，面板只展示）。 */
function diagnosticGroups(
  result: RunResult,
  timeIndex: number,
): { P: DiagnosticGroupData; Q: DiagnosticGroupData } {
  const stateCount = result.stateCount;
  const offset = timeIndex * stateCount;
  const build = (group: GroupId): DiagnosticGroupData => {
    const reference = result.reference[group];
    const sample = result.sample[group];
    const comparison = computeComparisonSeries(reference, sample, stateCount);
    const referenceProb = Array.from(
      reference.pmf.subarray(offset, offset + stateCount),
    );
    const sampleCounts = Array.from(
      sample.counts.subarray(offset, offset + stateCount),
    );
    const { referenceCdf, empiricalCdf } = cdfArrays(
      referenceProb,
      sampleCounts,
      sample.completed,
    );
    return {
      group,
      meanB: reference.meanB[timeIndex]!,
      meanA: reference.meanA[timeIndex]!,
      varianceA: reference.varianceA[timeIndex]!,
      meanBirthRate: reference.meanBirthRate[timeIndex]!,
      meanDeathRate: reference.meanDeathRate[timeIndex]!,
      exactDrift: reference.exactDrift[timeIndex]!,
      closureDriftAtExactMean: reference.closureDriftAtExactMean[timeIndex]!,
      driftCorrection: reference.driftCorrection[timeIndex]!,
      meanGap: comparison.meanGap[timeIndex]!,
      samplingError: comparison.samplingError[timeIndex]!,
      sampleMeanB: sample.meanB[timeIndex]!,
      cdfDistance: comparison.cdfDistance[timeIndex]!,
      completed: sample.completed,
      referenceCdf,
      empiricalCdf,
      numerical: reference.numerical[timeIndex]!,
    };
  };
  return { P: build("P"), Q: build("Q") };
}

/** previewB（轨迹主序，min(32,M)×101）取前 8 条，供均值时间线阶梯显示。 */
function previewRows(
  result: RunResult,
  group: GroupId,
): readonly (readonly number[])[] {
  const sample = result.sample[group];
  const timeCount = result.times.length;
  const rowCount = Math.min(8, Math.floor(sample.previewB.length / timeCount));
  const rows: number[][] = [];
  for (let i = 0; i < rowCount; i += 1) {
    rows.push(
      Array.from(sample.previewB.subarray(i * timeCount, (i + 1) * timeCount)),
    );
  }
  return rows;
}

export function App() {
  const [state, baseDispatch] = useReducer(reducer, undefined, () =>
    initialState("variance-split"),
  );
  const { scenario, status } = state;
  const clientRef = useRef<SimulationWorkerClient | null>(null);
  const runTokenRef = useRef(0);
  const replayTokenRef = useRef(0);

  // Worker 客户端在挂载 effect 里创建（不在渲染期创建，避免
  // StrictMode 开发双渲染造出两个实例）；卸载时彻底释放。
  useEffect(() => {
    const client = createWorkerClient();
    client.onProgress((progress) => {
      baseDispatch({
        type: "RUN_PROGRESS",
        completedP: progress.completedP,
        completedQ: progress.completedQ,
        targetPerGroup: progress.targetPerGroup,
      });
    });
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, []);

  // 派发包装：RUN_REQUESTED/CANCEL 在 reducer 动作之外驱动 Worker；
  // 其余动作原样透传。运行快照取点击时刻的 state.scenario。
  const dispatch = (action: AppAction): void => {
    if (action.type === "RUN_REQUESTED") {
      if (state.status === "RUNNING") return;
      const snapshot: ScenarioV1 = state.scenario;
      const token = ++runTokenRef.current;
      baseDispatch(action);
      const client = clientRef.current;
      if (client === null) {
        baseDispatch({ type: "RUN_FAILED", message: "Worker 未初始化" });
        return;
      }
      void client
        .run(snapshot)
        .then((result) => {
          if (token !== runTokenRef.current) return;
          baseDispatch({ type: "RUN_COMPLETE", result });
        })
        .catch((error: unknown) => {
          if (token !== runTokenRef.current) return;
          if (error instanceof CancelledError) return;
          baseDispatch({
            type: "RUN_FAILED",
            message: error instanceof Error ? error.message : "运行失败",
          });
        });
      return;
    }
    if (action.type === "CANCEL") {
      clientRef.current?.cancel();
      baseDispatch(action);
      return;
    }
    baseDispatch(action);
  };

  const handleReplay = (): void => {
    const result = state.result;
    if (
      result === null ||
      state.auditLoading ||
      state.status === "RUNNING"
    ) {
      return;
    }
    const token = ++replayTokenRef.current;
    const group = state.auditGroup;
    const index = state.auditIndex;
    baseDispatch({ type: "REPLAY_REQUESTED" });
    const client = clientRef.current;
    if (client === null) {
      baseDispatch({ type: "REPLAY_FAILED", message: "Worker 未初始化" });
      return;
    }
    void client
      .replay(result.scenario, group, index)
      .then((trace) => {
        if (token !== replayTokenRef.current) return;
        // 独立复验（T007 verifyAudit）：不信任 Worker 回来的随机数，
        // 重新派生种子、重算等待与选择，逐值核对。
        const verification = verifyAudit(result.scenario, trace);
        baseDispatch({ type: "REPLAY_COMPLETE", trace, verification });
      })
      .catch((error: unknown) => {
        if (token !== replayTokenRef.current) return;
        if (error instanceof CancelledError) return;
        baseDispatch({
          type: "REPLAY_FAILED",
          message: error instanceof Error ? error.message : "重放失败",
        });
      });
  };

  /**
   * 证据导出（GPT 终审 Round 1 修复，项目书 §12.2）：
   * 审计轨迹取 Worker 对当前结果场景的 P/0 重放（确定性重算，
   * 不依赖用户是否做过审计重放），再序列化证据。导出门禁与
   * FileActions 的 canExport 一致：仅 COMPLETE 且非 mock 时
   * 按钮才出现；运行中/审计重放中调用即抛错，不静默出旧证据。
   */
  const handleExportEvidence = async (): Promise<ExportFile> => {
    if (result === null || status !== "COMPLETE" || state.isMockResult) {
      throw new Error("当前无可导出证据的真实完成结果");
    }
    if (state.auditLoading) {
      throw new Error("正在重放，请稍后再导出证据");
    }
    const client = clientRef.current;
    if (client === null) {
      throw new Error("Worker 未初始化");
    }
    const trace = await client.replay(result.scenario, "P", 0);
    const content = await serializeEvidence(result, trace, {
      createdAt: new Date().toISOString(),
      displayTitle: result.scenario.title,
      userAgent:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      platform:
        typeof navigator !== "undefined" ? navigator.platform : "unknown",
      dependencyVersions: {},
      elapsedMs: result.elapsedMs,
    });
    return { name: "noisescope-evidence.json", content };
  };

  /**
   * 证据复验（只读，项目书 §12.2 步骤 2、5）：
   * SHA-256 检查 + Worker 完整重算 + compareEvidence + 审计轨迹
   * verifyAudit，四者全部通过才 valid。关键：必须对导入的
   * evidence.audit 本身执行 verifyAudit（逐事件核对随机流与终止
   * 候选），不能只验重算的 rerunAudit——payload 哈希不覆盖 audit
   * 字段，只验重算轨迹会漏掉事件随机数被篡改但 sampledB 不变的
   * 证据（Round 2 B1）。无论通过与否都不派发
   * 任何 reducer 动作，当前实验、结果、审计一律不动；失败时
   * 调用方 FileActions 只显示错误，当前实验已保留。
   * 取消：client.cancel() 使在途 run/replay 以 CancelledError
   * 拒绝，本函数原样抛出，FileActions 据此显示“复验已取消”。
   */
  const handleVerifyEvidence = async (
    evidence: EvidenceV1,
  ): Promise<EvidenceVerificationOutcome> => {
    const client = clientRef.current;
    if (client === null) {
      throw new Error("Worker 未初始化");
    }
    const rerun = await client.run(evidence.scenario);
    const rerunAudit = await client.replay(
      evidence.scenario,
      evidence.audit.group,
      evidence.audit.trajectoryIndex,
    );
    const auditVerification = verifyAudit(evidence.scenario, rerunAudit);
    // 导入审计本身的独立复验：逐事件核对声明随机流，任何事件
    // 字段（uWaiting、uChoice、终止候选等）篡改都必须使复验失败，
    // 即使 sampledB 与重算一致也不得放行。
    const importedAuditVerification = verifyAudit(
      evidence.scenario,
      evidence.audit,
    );
    const imported = await verifyImportedEvidence(
      evidence,
      rerun,
      rerunAudit,
    );
    const differences = [
      ...importedAuditVerification.errors.map(
        (error) => `imported audit.${error}`,
      ),
      ...auditVerification.errors,
      ...imported.differences,
    ];
    return {
      valid:
        imported.valid &&
        auditVerification.valid &&
        importedAuditVerification.valid,
      hashMatches: imported.hashMatches,
      auditValid:
        auditVerification.valid && importedAuditVerification.valid,
      auditCheckedEvents: importedAuditVerification.checkedEvents,
      differences,
    };
  };

  /** 取消复验：terminate 在途 Worker，待定复验以取消拒绝，不动 App 状态。 */
  const handleCancelVerification = (): void => {
    clientRef.current?.cancel();
  };

  const handleExportFile = (file: ExportFile): void => {
    const blob = new Blob([file.content], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const result = state.result;
  // 项目书 §4：自定义两组初始均值不同时显示“非同均值实验”，不得
  // 继续使用默认教学结论。均值取当前草稿场景的 PMF 理论均值
  // （纯 UI 展示计算），容差 1e-9 只为抵消浮点求和噪声。
  const isNonEqualMean =
    Math.abs(pmfMean(scenario.initial.P) - pmfMean(scenario.initial.Q)) >
    1e-9;
  // 所有视图与导出共享同一结果场景；无结果时用当前草稿场景。
  const runScenario: ScenarioV1 = result !== null ? result.scenario : scenario;
  const stateCount =
    result !== null
      ? result.stateCount
      : stateCountForModel(scenario.model);
  const viewStatus = toViewStatus(status);
  const timeIndex = state.timeIndex;
  const time = result !== null ? result.times[timeIndex]! : 0;
  const distribution =
    result !== null ? sliceDistribution(result, timeIndex) : null;
  const diagnostics = result !== null ? diagnosticGroups(result, timeIndex) : null;
  const auditStatus: ViewStatus =
    status === "RUNNING"
      ? "running"
      : state.auditLoading
        ? "running"
        : state.auditError !== null
          ? "error"
          : state.trace !== null
            ? "ready"
            : "empty";
  const fileStatus: ViewStatus =
    status === "COMPLETE"
      ? "ready"
      : status === "RUNNING"
        ? "running"
        : status === "ERROR"
          ? "error"
          : "empty";

  return (
    <>
      <header className="noise-header">
        <h1>反应骰 NoiseScope</h1>
        <p>
          {isNonEqualMean
            ? "非同均值实验：两组初始均值不同，默认教学结论不适用 · 合成有限反应模型，无空间碰撞模拟"
            : "相同均值能预测相同未来吗 · 合成有限反应模型，无空间碰撞模拟"}
        </p>
      </header>

      <div className="noise-layout">
        <aside className="noise-panel" aria-label="实验控制栏">
          <details open>
            <summary>实验控制</summary>
            <ExperimentControls state={state} dispatch={dispatch} />
          </details>
        </aside>

        <main className="noise-stage">
          <section className="noise-panel" aria-label="运行状态">
            <p className="noise-status" data-status={status}>
              运行状态：{STATUS_LABEL[status] ?? status}
            </p>
            <p>
              当前预置：{scenario.title}
              {isNonEqualMean ? "（非同均值实验）" : ""}；模型：{scenario.model.id}；N ={" "}
              {scenario.model.totalUnits}；kf = {scenario.model.forwardRate}；
              kb = {scenario.model.reverseRate}；T = {scenario.horizon}；M ={" "}
              {scenario.trajectoriesPerGroup}；种子 = {scenario.seed}。
            </p>
            {result !== null && (
              <p data-run-id={result.runId}>
                已完成运行 runId = {result.runId}，对应场景：
                {result.scenario.title}；引擎版本 {result.engineVersion}。
              </p>
            )}
            {status === "RUNNING" && state.progress !== null && (
              <p role="status">
                运行进度：P {state.progress.completedP}/
                {state.progress.targetPerGroup}，Q{" "}
                {state.progress.completedQ}/{state.progress.targetPerGroup}。
              </p>
            )}
            {state.notice !== null && <p>{state.notice}</p>}
            {status === "STALE" && (
              <p className="noise-stale-note">
                旧结果已灰化：它对应旧输入，不是当前参数的结果；导出结果按钮已禁用。
              </p>
            )}
            {state.error !== null && (
              <div className="noise-alert" role="alert">
                {state.error}
                <button type="button" onClick={() => dispatch({ type: "CLEAR_ERROR" })}>
                  清除错误
                </button>
              </div>
            )}
          </section>

          <section className="noise-panel" aria-label="分布舞台">
            <label>
              时间游标（观测点 0 至 100，左右键可移动，不触发重跑）
              <input
                aria-label="时间游标"
                type="range"
                min={0}
                max={100}
                step={1}
                value={timeIndex}
                onChange={(e) =>
                  dispatch({
                    type: "SET_TIME_INDEX",
                    timeIndex: Number(e.target.value),
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Home") {
                    dispatch({ type: "SET_TIME_INDEX", timeIndex: 0 });
                  } else if (e.key === "End") {
                    dispatch({ type: "SET_TIME_INDEX", timeIndex: 100 });
                  }
                }}
              />
            </label>
            <p>当前观测点：{timeIndex}（共 101 个观测点）。</p>
            <DistributionView
              status={viewStatus}
              stateCount={stateCount}
              timeIndex={timeIndex}
              time={time}
              groups={distribution}
              errorMessage={state.error}
            />
          </section>

          <section className="noise-panel" aria-label="均值时间线">
            <MeanTimeline
              status={viewStatus}
              times={result !== null ? Array.from(result.times) : []}
              referenceMean={
                result !== null
                  ? {
                      P: Array.from(result.reference.P.meanB),
                      Q: Array.from(result.reference.Q.meanB),
                    }
                  : { P: [], Q: [] }
              }
              closureMean={
                result !== null
                  ? {
                      P: Array.from(result.reference.P.closureMeanB),
                      Q: Array.from(result.reference.Q.closureMeanB),
                    }
                  : { P: [], Q: [] }
              }
              sampleMean={
                result !== null
                  ? {
                      P: Array.from(result.sample.P.meanB),
                      Q: Array.from(result.sample.Q.meanB),
                    }
                  : null
              }
              preview={
                result !== null
                  ? { P: previewRows(result, "P"), Q: previewRows(result, "Q") }
                  : null
              }
              timeIndex={timeIndex}
              errorMessage={state.error}
            />
          </section>

          <section className="noise-panel" aria-label="解释栏">
            <DiagnosticPanel
              status={viewStatus}
              timeIndex={timeIndex}
              time={time}
              stateCount={stateCount}
              groups={diagnostics}
              engineVersion={result !== null ? result.engineVersion : "1.0.0"}
              errorMessage={state.error}
            />
          </section>
        </main>
      </div>

      <section className="noise-panel noise-audit" aria-label="事件审计抽屉">
        <EventInspector
          status={auditStatus}
          group={state.auditGroup}
          trajectoryIndex={state.auditIndex}
          trajectoriesPerGroup={runScenario.trajectoriesPerGroup}
          model={runScenario.model}
          horizon={runScenario.horizon}
          trace={state.trace}
          verification={state.verification}
          observationIndex={timeIndex}
          errorMessage={state.auditError}
          onSelectGroup={(group: GroupId) =>
            dispatch({
              type: "SELECT_AUDIT",
              group,
              index: state.auditIndex,
            })
          }
          onSelectTrajectory={(index: number) =>
            dispatch({
              type: "SELECT_AUDIT",
              group: state.auditGroup,
              index,
            })
          }
          onReplay={handleReplay}
        />
      </section>

      <section className="noise-panel" aria-label="文件交互区">
        <FileActions
          status={fileStatus}
          isMockResult={state.isMockResult}
          scenario={runScenario}
          result={result}
          trace={state.trace}
          timeIndex={timeIndex}
          errorMessage={state.error}
          onImportScenario={(imported: ScenarioV1) =>
            dispatch({ type: "IMPORT_SCENARIO", scenario: imported })
          }
          onExportFile={handleExportFile}
          onExportEvidence={handleExportEvidence}
          onVerifyEvidence={handleVerifyEvidence}
          onCancelVerification={handleCancelVerification}
        />
      </section>
    </>
  );
}
