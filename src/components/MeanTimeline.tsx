// P006 T011 — 均值时间线（项目书 §9.3、§9.6）。
//
// 职责边界：只展示调用方给出的序列，不重算任何科学量、不碰 core。
// - 序列由调用方从 RunResult 切出：参考均值、闭合均值、样本均值、
//   前 32 条轨迹中的最多 8 条 sampledB；本组件不切时间主数组。
// - 均值曲线用直线段连接观测点：连线只连接已给的观测值，不插值、
//   不平滑、不改动任何数值；单轨迹必须阶梯显示（见 stepPath）。
// - 闭合线：P、Q 闭合序列逐点相等（差 ≤ 1e-12）时只画一条共享灰色
//   虚线；否则画两条分别标注的灰色虚线。同均值两组的闭合相同，
//   因此默认实验只显示一条共享线，这不是“看起来相近”而是逐点相等。
// - P 青 #007F86 实线、Q 橙 #B95F10 点划线、闭合灰色虚线；颜色不是
//   唯一编码，另有文字图例与线型区分。
// - 空态、计算中态、错误态各自明确呈现，绝不把缺失画成 0 曲线；
//   数据无效时同样显示错误态，不静默画错图。
// - 每张图都附一张数据表（§9.6“图表附数据表”），表格可局部横向滚动。
// - CDF/DKW 参考带不在本组件：按 §8 与任务卡，它仅用于 CDF，
//   只在 DiagnosticPanel 的 CDF 一节出现。

import styles from "./MeanTimeline.module.css";

export type MeanTimelineStatus = "empty" | "running" | "ready" | "error";

export interface MeanTimelineProps {
  status: MeanTimelineStatus;
  /** 观测时刻数组；长度必须与各序列长度一致（规范为 101，但组件不硬编码）。 */
  times: readonly number[];
  /** CME 基准均值（B 分子数）。 */
  referenceMean: { P: readonly number[]; Q: readonly number[] };
  /** 闭合近似均值（B 分子数）。 */
  closureMean: { P: readonly number[]; Q: readonly number[] };
  /** SSA 经验均值（B 分子数）；为 null 时不画样本线。 */
  sampleMean?: { P: readonly number[]; Q: readonly number[] } | null;
  /** 单轨迹 sampledB：每组最多 8 条，每条长度与 times 一致；阶梯显示。 */
  preview?: {
    P: readonly (readonly number[])[];
    Q: readonly (readonly number[])[];
  } | null;
  /** 时间游标：观测点索引。 */
  timeIndex: number;
  showSample?: boolean;
  showPreview?: boolean;
  errorMessage?: string | null;
}

const GROUP_COLOR: Record<"P" | "Q", string> = {
  P: "#007f86",
  Q: "#b95f10",
};

const PLOT_X = 56;
const PLOT_Y = 16;
const PLOT_W = 560;
const PLOT_H = 220;
const BASELINE_Y = PLOT_Y + PLOT_H;

function formatValue(value: number): string {
  return value.toFixed(4);
}

function isFiniteSeries(series: readonly number[]): boolean {
  return series.every((value) => Number.isFinite(value));
}

/** 阶梯路径：每段先水平走到下一观测时刻，再垂直跳到下一观测值。 */
export function stepPath(
  values: readonly number[],
  xFor: (index: number) => number,
  yFor: (value: number) => number,
): string {
  if (values.length === 0) return "";
  let path = `M ${xFor(0).toFixed(2)},${yFor(values[0]!).toFixed(2)}`;
  for (let i = 0; i + 1 < values.length; i += 1) {
    path += ` L ${xFor(i + 1).toFixed(2)},${yFor(values[i]!).toFixed(2)}`;
    path += ` L ${xFor(i + 1).toFixed(2)},${yFor(values[i + 1]!).toFixed(2)}`;
  }
  return path;
}

function linePath(
  values: readonly number[],
  xFor: (index: number) => number,
  yFor: (value: number) => number,
): string {
  return values
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"} ${xFor(index).toFixed(2)},${yFor(value).toFixed(2)}`,
    )
    .join(" ");
}

export function MeanTimeline(props: MeanTimelineProps) {
  const {
    status,
    times,
    referenceMean,
    closureMean,
    sampleMean = null,
    preview = null,
    timeIndex,
    showSample = true,
    showPreview = true,
    errorMessage = null,
  } = props;

  const count = times.length;
  const timeValid =
    Number.isInteger(timeIndex) &&
    timeIndex >= 0 &&
    timeIndex < count &&
    Number.isFinite(times[timeIndex] ?? NaN);
  const lengthsOk =
    count >= 2 &&
    referenceMean.P.length === count &&
    referenceMean.Q.length === count &&
    closureMean.P.length === count &&
    closureMean.Q.length === count &&
    (sampleMean === null ||
      (sampleMean.P.length === count && sampleMean.Q.length === count)) &&
    (preview === null ||
      (preview.P.every((row) => row.length === count) &&
        preview.Q.every((row) => row.length === count) &&
        preview.P.length <= 8 &&
        preview.Q.length <= 8));
  const valuesOk =
    isFiniteSeries(times) &&
    isFiniteSeries(referenceMean.P) &&
    isFiniteSeries(referenceMean.Q) &&
    isFiniteSeries(closureMean.P) &&
    isFiniteSeries(closureMean.Q) &&
    (sampleMean === null ||
      (isFiniteSeries(sampleMean.P) && isFiniteSeries(sampleMean.Q))) &&
    (preview === null ||
      (preview.P.every(isFiniteSeries) && preview.Q.every(isFiniteSeries)));

  let dataError: string | null = null;
  if (status === "ready") {
    if (!timeValid) dataError = "时间游标越界";
    else if (!lengthsOk) dataError = "均值序列长度与观测时刻不一致";
    else if (!valuesOk) dataError = "均值序列含非有限值";
  }

  if (status === "empty") {
    return (
      <section className={styles.stage} data-component="MeanTimeline">
        <h3 className={styles.title}>均值时间线</h3>
        <p className={styles.statusNote}>暂无运行结果</p>
      </section>
    );
  }
  if (status === "running") {
    return (
      <section className={styles.stage} data-component="MeanTimeline">
        <h3 className={styles.title}>均值时间线</h3>
        <p className={styles.statusNote}>计算中……不展示部分结果</p>
      </section>
    );
  }
  if (status === "error" || dataError !== null) {
    return (
      <section className={styles.stage} data-component="MeanTimeline">
        <h3 className={styles.title}>均值时间线</h3>
        <p className={styles.errorAlert} role="alert">
          {dataError ?? errorMessage ?? "均值时间线错误"}
        </p>
      </section>
    );
  }

  // 共享闭合判定：逐点相等（≤1e-12）才合并为一条线。
  const closureShared = closureMean.P.every(
    (value, index) => Math.abs(value - closureMean.Q[index]!) <= 1e-12,
  );
  const closureSeries = closureShared ? closureMean.P : null;

  const displayed: number[] = [
    ...referenceMean.P,
    ...referenceMean.Q,
    ...closureMean.P,
    ...closureMean.Q,
  ];
  if (sampleMean !== null && showSample) {
    displayed.push(...sampleMean.P, ...sampleMean.Q);
  }
  if (preview !== null && showPreview) {
    for (const row of [...preview.P, ...preview.Q]) displayed.push(...row);
  }
  const minValue = Math.min(0, ...displayed);
  const maxValue = Math.max(...displayed);
  const span = maxValue - minValue > 0 ? maxValue - minValue : 1;
  const yMin = minValue;
  const yMax = maxValue + span * 0.05;
  const tMin = times[0]!;
  const tMax = times[count - 1]!;
  const tSpan = tMax - tMin > 0 ? tMax - tMin : 1;
  const xFor = (index: number) =>
    PLOT_X + ((times[index]! - tMin) / tSpan) * PLOT_W;
  const yFor = (value: number) =>
    BASELINE_Y - ((value - yMin) / (yMax - yMin)) * PLOT_H;
  const cursorX = xFor(timeIndex);

  return (
    <section className={styles.stage} data-component="MeanTimeline">
      <h3 className={styles.title}>均值时间线</h3>
      <p className={styles.timeLine}>
        时间游标：观测点 {timeIndex}，t = {formatValue(times[timeIndex]!)}
      </p>
      <svg
        viewBox={`0 0 ${PLOT_X + PLOT_W + 16} ${BASELINE_Y + 32}`}
        role="img"
        aria-label="均值时间线"
        data-shared-closure={closureShared ? "true" : "false"}
      >
        <line
          x1={PLOT_X}
          y1={BASELINE_Y}
          x2={PLOT_X + PLOT_W}
          y2={BASELINE_Y}
          stroke="#172033"
        />
        <line
          x1={cursorX}
          y1={PLOT_Y}
          x2={cursorX}
          y2={BASELINE_Y}
          stroke="#172033"
          strokeDasharray="2 3"
          data-cursor="true"
        />
        {preview !== null && showPreview
          ? (["P", "Q"] as const).flatMap((group) =>
              preview[group].map((row, rowIndex) => (
                <path
                  key={`${group}-preview-${rowIndex}`}
                  d={stepPath(row, xFor, yFor)}
                  fill="none"
                  stroke={GROUP_COLOR[group]}
                  strokeWidth={1}
                  strokeOpacity={0.45}
                  data-series={`${group}-preview`}
                  data-trajectory={rowIndex}
                />
              )),
            )
          : null}
        {(["P", "Q"] as const).map((group) => (
          <path
            key={`${group}-reference`}
            d={linePath(referenceMean[group], xFor, yFor)}
            fill="none"
            stroke={GROUP_COLOR[group]}
            strokeWidth={2.5}
            strokeDasharray={group === "P" ? undefined : "8 3 2 3"}
            data-series={`${group}-reference`}
          />
        ))}
        {closureShared ? (
          <path
            key="closure-shared"
            d={linePath(closureSeries!, xFor, yFor)}
            fill="none"
            stroke="#6b7280"
            strokeWidth={2}
            strokeDasharray="6 4"
            data-series="closure-shared"
          />
        ) : (
          (["P", "Q"] as const).map((group) => (
            <path
              key={`${group}-closure`}
              d={linePath(closureMean[group], xFor, yFor)}
              fill="none"
              stroke="#6b7280"
              strokeWidth={2}
              strokeDasharray="6 4"
              data-series={`${group}-closure`}
            />
          ))
        )}
        {sampleMean !== null && showSample
          ? (["P", "Q"] as const).map((group) => (
              <path
                key={`${group}-sample`}
                d={linePath(sampleMean[group], xFor, yFor)}
                fill="none"
                stroke={GROUP_COLOR[group]}
                strokeWidth={1.5}
                strokeDasharray="3 3"
                data-series={`${group}-sample`}
              />
            ))
          : null}
      </svg>
      <ul className={styles.legend}>
        <li>P 参考均值（青色实线）</li>
        <li>Q 参考均值（橙色点划线）</li>
        {closureShared ? (
          <li>闭合近似（P/Q 共享，灰色虚线）</li>
        ) : (
          <>
            <li>P 闭合近似（灰色虚线）</li>
            <li>Q 闭合近似（灰色虚线）</li>
          </>
        )}
        {sampleMean !== null && showSample ? (
          <>
            <li>P 样本均值（青色短虚线）</li>
            <li>Q 样本均值（橙色短虚线）</li>
          </>
        ) : null}
        {preview !== null && showPreview ? (
          <li>单轨迹（细线，阶梯显示，非连续物理过程）</li>
        ) : null}
      </ul>
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              <th>观测点</th>
              <th>时间 t</th>
              <th>P 参考均值（分子数）</th>
              <th>Q 参考均值（分子数）</th>
              {closureShared ? (
                <th>闭合近似（P/Q 共享，分子数）</th>
              ) : (
                <>
                  <th>P 闭合均值（分子数）</th>
                  <th>Q 闭合均值（分子数）</th>
                </>
              )}
              {sampleMean !== null && showSample ? (
                <>
                  <th>P 样本均值（分子数）</th>
                  <th>Q 样本均值（分子数）</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {times.map((time, index) => (
              <tr key={index} data-time-index={index}>
                <td>{index}</td>
                <td>{formatValue(time)}</td>
                <td>{formatValue(referenceMean.P[index]!)}</td>
                <td>{formatValue(referenceMean.Q[index]!)}</td>
                {closureShared ? (
                  <td>{formatValue(closureSeries![index]!)}</td>
                ) : (
                  <>
                    <td>{formatValue(closureMean.P[index]!)}</td>
                    <td>{formatValue(closureMean.Q[index]!)}</td>
                  </>
                )}
                {sampleMean !== null && showSample ? (
                  <>
                    <td>{formatValue(sampleMean.P[index]!)}</td>
                    <td>{formatValue(sampleMean.Q[index]!)}</td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
