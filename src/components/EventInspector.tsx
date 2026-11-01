// P006 T012 — 事件审计检查器（项目书 §9.5、§9.6）。
//
// 职责边界：只展示调用方注入的 AuditTrace，不生成随机数、不调用
// core/ssa、不碰 core/io/verify 的实现（仅作类型引用）、不改 App /
// 全局 CSS。重放不是重新随机抽另一条轨迹：本组件不派生种子、不抽
// 随机数；“重放此轨迹”只是调用方传入的 onReplay 回调，由调用方
// （T013 起接 Worker REPLAY）按已记录的种子与事件重算，组件只
// 展示回来的那条轨迹。
// - 轨迹选择：组别 P/Q + 轨迹号；轨迹号必须为 0 到 M-1 的整数，
//   否则显示错误且重放按钮禁用，不展示越界轨迹。
// - 初始化抽样单独成行：uInitial、initialState、trajectorySeed
//   单列显示，不混进事件表。
// - 终止记录单独成节：不是已发生事件；HORIZON 的终止候选
//   uWaiting/uChoice 单列显示，明确标注“未发生的候选”。
// - 精度：默认表格 6 位有效数字供阅读（§9.5 的 5—7 位区间内），
//   详情模式 15 位有效数字；每个数值单元格另带 data-full 属性，
//   存 String() 全精度值，显示截断不等于数据截断，导出不损失。
// - 组合数解释：二聚显示 A 与 A(A−1)/2 的当前整数值；线性显示
//   A 与“正向率 kf·A，无组合数”，不把线性画成二聚公式。
// - 计数图标：按真实最终状态画 B/A 图标（●/○），不是装饰性
//   随机碰撞；图标数量等于真实计数。
// - 观测上下文：给定观测点时显示该时刻状态与最近已发生事件。
// - 无效轨迹（序号断链、时间不递增、状态链断裂、越界、与所选
//   组别/轨迹号不符）一律显示错误态，不静默画错表。

import { useState } from "react";
import {
  stateCountForModel,
  type AuditTrace,
  type GroupId,
  type ModelSpec,
} from "../domain/types";
import type { AuditVerification } from "../verify/replay";
import styles from "./EventInspector.module.css";

export type EventInspectorStatus = "empty" | "running" | "ready" | "error";

export interface EventInspectorProps {
  status: EventInspectorStatus;
  /** 当前所选组别。 */
  group: GroupId;
  /** 当前所选轨迹号；必须为 0 到 trajectoriesPerGroup-1 的整数。 */
  trajectoryIndex: number;
  /** 每组轨迹数 M（规范 64–4096）。 */
  trajectoriesPerGroup: number;
  model: ModelSpec;
  horizon: number;
  /** 调用方注入的审计轨迹；status 为 ready 时应提供，否则按空态处理。 */
  trace: AuditTrace | null;
  /** 调用方注入的独立复验结果；为 null 时不显示“已验证”。 */
  verification: AuditVerification | null;
  /** 观测点索引 0..100；提供时显示该时刻的审计上下文。 */
  observationIndex?: number | null;
  errorMessage?: string | null;
  onSelectGroup?: (group: GroupId) => void;
  onSelectTrajectory?: (index: number) => void;
  /** 重放回调：由调用方接 Worker REPLAY，不在本组件内抽随机数。 */
  onReplay?: () => void;
}

/** 默认精度：6 位有效数字（§9.5 默认 5—7 位供阅读）。 */
export function formatDefault(value: number): string {
  if (value === 0) return "0";
  return value.toPrecision(6);
}

/** 详情精度：15 位有效数字。 */
export function formatDetail(value: number): string {
  if (value === 0) return "0";
  return value.toPrecision(15);
}

/**
 * 展示用轨迹校验：只核对记录内部链的连续性与所选身份，不重算
 * 随机流（随机流的逐值核对是 verify/replay 的职责，见 T007）。
 * 返回 null 表示可展示，否则返回错误文案。
 */
export function validateTraceForDisplay(
  trace: AuditTrace,
  expectedGroup: GroupId,
  expectedIndex: number,
  stateCount: number,
  horizon: number,
): string | null {
  if (trace.group !== expectedGroup) {
    return "轨迹组别与所选组别不符";
  }
  if (trace.trajectoryIndex !== expectedIndex) {
    return "轨迹号与所选轨迹号不符";
  }
  if (
    !Number.isInteger(trace.initial.initialState) ||
    trace.initial.initialState < 0 ||
    trace.initial.initialState >= stateCount
  ) {
    return "初始状态超出状态范围";
  }
  if (!Number.isFinite(trace.initial.uInitial)) {
    return "初始抽样 uInitial 不是有限数";
  }
  let state = trace.initial.initialState;
  let time = 0;
  for (let i = 0; i < trace.events.length; i += 1) {
    const event = trace.events[i]!;
    if (event.index !== i) return `事件序号断裂：events[${i}].index 不是 ${i}`;
    if (event.stateBefore !== state) {
      return `事件 ${i} 的状态链断裂：stateBefore 不是上一状态`;
    }
    if (event.timeBefore !== time) {
      return `事件 ${i} 的时间链断裂：timeBefore 不是上一事件时间`;
    }
    if (!(event.timeAfter > time)) {
      return `事件 ${i} 的时间不严格递增`;
    }
    if (event.timeAfter > horizon) {
      return `事件 ${i} 超出视界`;
    }
    if (
      !Number.isInteger(event.stateAfter) ||
      event.stateAfter < 0 ||
      event.stateAfter >= stateCount ||
      Math.abs(event.stateAfter - state) !== 1
    ) {
      return `事件 ${i} 的状态跳变非法`;
    }
    for (const value of [
      event.birth,
      event.death,
      event.totalRate,
      event.uWaiting,
      event.uChoice,
      event.waitingTime,
    ]) {
      if (!Number.isFinite(value)) return `事件 ${i} 含有非有限数值`;
    }
    state = event.stateAfter;
    time = event.timeAfter;
  }
  if (trace.terminal.state !== state) {
    return "终止状态与最后事件状态不符";
  }
  if (trace.terminal.time !== time) {
    return "终止时间与最后事件时间不符";
  }
  if (trace.sampledB.length !== 101) {
    return "sampledB 长度不是 101";
  }
  return null;
}

function reactionLabel(reaction: "forward" | "reverse"): string {
  return reaction === "forward" ? "正向" : "反向";
}

export function EventInspector(props: EventInspectorProps) {
  const {
    status,
    group,
    trajectoryIndex,
    trajectoriesPerGroup,
    model,
    horizon,
    trace,
    verification,
    observationIndex,
    errorMessage,
    onSelectGroup,
    onSelectTrajectory,
    onReplay,
  } = props;
  const [detail, setDetail] = useState(false);
  const format = detail ? formatDetail : formatDefault;
  const stateCount = stateCountForModel(model);

  const selectionValid =
    Number.isInteger(trajectoryIndex) &&
    trajectoryIndex >= 0 &&
    trajectoryIndex < trajectoriesPerGroup;

  let traceError: string | null = null;
  if (status === "ready" && trace !== null && selectionValid) {
    traceError = validateTraceForDisplay(
      trace,
      group,
      trajectoryIndex,
      stateCount,
      horizon,
    );
  }

  // 观测上下文：观测时刻 = horizon * index / 100（末点即视界）。
  let observationState: number | null = null;
  let observationEventIndex: number | null = null;
  let observationTime: number | null = null;
  if (
    trace !== null &&
    traceError === null &&
    observationIndex !== null &&
    observationIndex !== undefined &&
    Number.isInteger(observationIndex) &&
    observationIndex >= 0 &&
    observationIndex <= 100
  ) {
    observationTime = (horizon * observationIndex) / 100;
    observationState = trace.initial.initialState;
    for (const event of trace.events) {
      if (event.timeAfter <= observationTime) {
        observationState = event.stateAfter;
        observationEventIndex = event.index;
      } else {
        break;
      }
    }
  }

  const finalState =
    trace !== null && traceError === null ? trace.terminal.state : null;
  const countA =
    finalState === null
      ? null
      : model.id === "dimer"
        ? model.totalUnits - 2 * finalState
        : model.totalUnits - finalState;

  return (
    <section className={styles.stage} aria-label="事件审计">
      <h2 className={styles.title}>事件审计</h2>
      <p className={styles.note}>
        重放不是重新随机抽另一条轨迹：重放按已记录的种子与事件重算，
        返回的仍是所选组别与轨迹号的那条轨迹。
      </p>

      <div className={styles.controls}>
        <label>
          组别
          <select
            value={group}
            onChange={(event) =>
              onSelectGroup?.(event.target.value as GroupId)
            }
          >
            <option value="P">P 组</option>
            <option value="Q">Q 组</option>
          </select>
        </label>
        <label>
          轨迹号
          <input
            type="number"
            value={trajectoryIndex}
            min={0}
            max={trajectoriesPerGroup - 1}
            step={1}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value)) onSelectTrajectory?.(value);
            }}
          />
        </label>
        <span className={styles.range}>
          合法范围：0 到 {trajectoriesPerGroup - 1}
        </span>
        <button
          type="button"
          disabled={!selectionValid || status === "running"}
          onClick={() => onReplay?.()}
        >
          重放此轨迹
        </button>
        <button type="button" onClick={() => setDetail((value) => !value)}>
          {detail ? "切换为默认精度" : "切换为详情精度"}
        </button>
        <span className={styles.precisionNote}>
          {detail
            ? "详情精度：15 位有效数字"
            : "默认精度：6 位有效数字供阅读；导出不截断数值"}
        </span>
      </div>

      {!selectionValid && (
        <div className={styles.errorAlert} role="alert">
          轨迹号非法：必须为 0 到 {trajectoriesPerGroup - 1} 的整数。
        </div>
      )}
      {status === "empty" && (
        <p className={styles.statusNote}>
          暂无轨迹：选择组别和轨迹号，点击“重放此轨迹”。
        </p>
      )}
      {status === "running" && (
        <p className={styles.statusNote} role="status">
          重放中：此处不展示部分事件。
        </p>
      )}
      {status === "error" && (
        <div className={styles.errorAlert} role="alert">
          事件审计加载失败：{errorMessage ?? "未知错误"}
        </div>
      )}
      {status === "ready" && trace === null && selectionValid && (
        <p className={styles.statusNote}>
          暂无轨迹：选择组别和轨迹号，点击“重放此轨迹”。
        </p>
      )}
      {traceError !== null && (
        <div className={styles.errorAlert} role="alert">
          审计轨迹无效：{traceError}
        </div>
      )}

      {status === "ready" && trace !== null && traceError === null && (
        <>
          <section
            className={styles.initial}
            aria-label="初始化抽样"
            data-trajectory-seed={trace.initial.trajectorySeed}
          >
            <h3 className={styles.sectionTitle}>初始化抽样</h3>
            <p>
              uInitial：
              <span data-field="uInitial" data-full={String(trace.initial.uInitial)}>
                {format(trace.initial.uInitial)}
              </span>
              ；初始状态 B = {trace.initial.initialState}；轨迹种子 ={" "}
              {trace.initial.trajectorySeed}。
            </p>
            <p className={styles.note}>
              初始化抽样单独成行：它决定初始状态，不计入事件表。
            </p>
          </section>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                {group} 组轨迹 {trajectoryIndex} 事件表（共{" "}
                {trace.events.length} 个事件）
              </caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">时间</th>
                  <th scope="col">B 前 → 后</th>
                  <th scope="col">λ（正向率）</th>
                  <th scope="col">μ（反向率）</th>
                  <th scope="col">uWaiting</th>
                  <th scope="col">uChoice</th>
                  <th scope="col">τ（等待时间）</th>
                  <th scope="col">选择结果</th>
                  <th scope="col">组合数解释</th>
                </tr>
              </thead>
              <tbody>
                {trace.events.map((event) => {
                  const countABefore =
                    model.id === "dimer"
                      ? model.totalUnits - 2 * event.stateBefore
                      : model.totalUnits - event.stateBefore;
                  const combination =
                    model.id === "dimer"
                      ? `A=${countABefore}，A(A−1)/2=${(countABefore * (countABefore - 1)) / 2}`
                      : `A=${countABefore}（线性：正向率 kf·A，无组合数）`;
                  return (
                    <tr key={event.index}>
                      <td>{event.index}</td>
                      <td
                        data-field="timeAfter"
                        data-full={String(event.timeAfter)}
                      >
                        {format(event.timeAfter)}
                      </td>
                      <td>
                        {event.stateBefore} → {event.stateAfter}
                      </td>
                      <td data-field="birth" data-full={String(event.birth)}>
                        {format(event.birth)}
                      </td>
                      <td data-field="death" data-full={String(event.death)}>
                        {format(event.death)}
                      </td>
                      <td
                        data-field="uWaiting"
                        data-full={String(event.uWaiting)}
                      >
                        {format(event.uWaiting)}
                      </td>
                      <td
                        data-field="uChoice"
                        data-full={String(event.uChoice)}
                      >
                        {format(event.uChoice)}
                      </td>
                      <td
                        data-field="waitingTime"
                        data-full={String(event.waitingTime)}
                      >
                        {format(event.waitingTime)}
                      </td>
                      <td>{reactionLabel(event.reaction)}</td>
                      <td>{combination}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {trace.events.length === 0 && (
            <p className={styles.statusNote}>
              本轨迹在视界内没有已发生事件：只有初始化抽样与终止说明。
            </p>
          )}

          <section className={styles.terminal} aria-label="终止说明">
            <h3 className={styles.sectionTitle}>终止说明</h3>
            {trace.terminal.reason === "ABSORBING" ? (
              <p>
                吸收态终止：总速率 0，停在时间{" "}
                <span data-field="terminal-time" data-full={String(trace.terminal.time)}>
                  {format(trace.terminal.time)}
                </span>
                ，状态 B = {trace.terminal.state}，无后续事件。
              </p>
            ) : (
              <p>
                视界终止：最后状态 B = {trace.terminal.state}，时间{" "}
                <span data-field="terminal-time" data-full={String(trace.terminal.time)}>
                  {format(trace.terminal.time)}
                </span>
                。终止候选单独列出，它是未发生的候选，不是已发生事件：
                uWaiting ={" "}
                <span data-field="terminal-uWaiting" data-full={String(trace.terminal.uWaiting)}>
                  {format(trace.terminal.uWaiting)}
                </span>
                ，uChoice ={" "}
                <span data-field="terminal-uChoice" data-full={String(trace.terminal.uChoice)}>
                  {format(trace.terminal.uChoice)}
                </span>
                ，候选时间{" "}
                <span data-field="terminal-candidateTime" data-full={String(trace.terminal.candidateTime)}>
                  {format(trace.terminal.candidateTime)}
                </span>
                （超出视界 T = {horizon}，故不执行）。
              </p>
            )}
          </section>

          {finalState !== null && countA !== null && (
            <section className={styles.counts} aria-label="当前计数图标">
              <h3 className={styles.sectionTitle}>当前计数图标</h3>
              <p>
                当前状态 B = {finalState}，A = {countA}（图标按真实事件
                状态绘制，不是装饰性随机碰撞）。
              </p>
              <p data-b-count={finalState} data-a-count={countA}>
                <span aria-label={`B 分子 ${finalState} 个`}>
                  {"●".repeat(finalState)}
                </span>{" "}
                <span aria-label={`A 分子 ${countA} 个`}>
                  {"○".repeat(countA)}
                </span>
              </p>
              <p className={styles.note}>
                ● 表示 B 分子，○ 表示 A 分子；二聚中 A = N − 2B，
                线性中 A = N − B。
              </p>
            </section>
          )}

          {observationState !== null && observationTime !== null && (
            <p className={styles.observation} aria-live="polite">
              观测点 {observationIndex}（t = {format(observationTime)}
              ）时状态 B = {observationState}
              {observationEventIndex === null
                ? "；尚未发生事件，仍为初始状态"
                : `；最近已发生事件 #${observationEventIndex}`}。
              播放只沿既有事件记录移动，不触发新仿真。
            </p>
          )}

          <section className={styles.verification} aria-label="复验结果">
            <h3 className={styles.sectionTitle}>复验结果</h3>
            {verification === null ? (
              <p>复验未完成：未提供复验结果，不显示已验证。</p>
            ) : verification.valid ? (
              <p>
                复验通过：已核对 {verification.checkedEvents} 个事件。
              </p>
            ) : (
              <div role="alert">
                <p>复验未通过：</p>
                <ul>
                  {verification.errors.map((error, index) => (
                    <li key={index}>{error}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
