// P006 T010 — 分布舞台（项目书 §9.3、§9.6）。
//
// 职责边界：只展示调用方给出的单时刻切片，不重算概率、不切
// 时间主数组、不碰 core / 文件协议 / App / 全局 CSS。
// - P、Q 并排，两组共用 B 横轴与概率纵轴最大值（见 distributionData）。
// - 概率基准用空心轮廓柱，SSA 用半透明实柱；颜色不是唯一编码
//   （P 青 #007F86、Q 橙 #B95F10，另有轮廓/实心与文字图例区分）。
// - 空态、计算中态、错误态各自明确呈现，绝不把缺失画成 0 分布；
//   数据无效时同样显示错误态，不静默画错图。
// - 每张图都附一张数据表（§9.6“图表附数据表”），表格可局部横向滚动。
// - 悬停/聚焦某根柱子时在明细区显示该状态的 j、理论概率、
//   样本计数与样本概率；初始未悬停时只显示提示，不编造数值。

// CSS module 类型由 src/vite-env.d.ts（标准 Vite 脚手架，见 T010 报告
// 的范围偏差说明）通过 vite/client 提供；本文件不改构建配置。
import { useState } from "react";
import {
  buildDistributionChartData,
  type DistributionGroupSlice,
} from "./distributionData";
import styles from "./DistributionView.module.css";

export type DistributionViewStatus = "empty" | "running" | "ready" | "error";

export interface DistributionViewProps {
  status: DistributionViewStatus;
  /** 状态数 S：线性 N+1，二聚 N/2+1。 */
  stateCount: number;
  /** 时间游标：观测点索引 0..100（非计算参数，调用方传入）。 */
  timeIndex: number;
  /** timeIndex 对应的物理时间。 */
  time: number;
  /**
   * 两组在 timeIndex 处的单时刻切片；status 为 ready 时必须提供，
   * 否则按空态处理。切片由调用方从 RunResult 切出，本组件不切。
   */
  groups: { P: DistributionGroupSlice; Q: DistributionGroupSlice } | null;
  errorMessage?: string | null;
}

const GROUP_COLOR: Record<"P" | "Q", string> = {
  P: "#007f86",
  Q: "#b95f10",
};

const PLOT_X = 48;
const PLOT_Y = 16;
const PLOT_W = 560;
const PLOT_H = 200;
const BASELINE_Y = PLOT_Y + PLOT_H;

function formatProb(value: number): string {
  return value.toFixed(6);
}

function formatStat(value: number): string {
  return value.toFixed(4);
}

export function DistributionView(props: DistributionViewProps) {
  const { status, stateCount, timeIndex, time, groups, errorMessage } =
    props;
  const [hovered, setHovered] = useState<{ group: "P" | "Q"; j: number } | null>(
    null,
  );

  const timeValid =
    Number.isInteger(timeIndex) &&
    timeIndex >= 0 &&
    timeIndex <= 100 &&
    Number.isFinite(time);

  let chart = null;
  let dataError: string | null = null;
  if (status === "ready" && timeValid && groups !== null) {
    try {
      chart = buildDistributionChartData(groups, stateCount);
    } catch (err) {
      dataError = err instanceof Error ? err.message : "分布数据无效";
    }
  }

  const hoveredBar =
    chart !== null && hovered !== null
      ? chart.bars.find(
          (bar) => bar.group === hovered.group && bar.j === hovered.j,
        ) ?? null
      : null;

  return (
    <section
      className={styles.stage}
      aria-label="分布舞台"
      data-shared-max={chart !== null ? String(chart.sharedMax) : undefined}
    >
      <h2 className={styles.title}>分布舞台</h2>
      <p className={styles.timeLine}>
        时间 t = {time}（观测点 {timeIndex} / 100）；P、Q 两组共用 B 横轴与概率纵轴。
      </p>

      {status === "empty" && (
        <p className={styles.statusNote}>
          暂无运行结果：运行实验后，此处显示 P、Q 两组在当前时间游标处的分布。
        </p>
      )}
      {status === "running" && (
        <p className={styles.statusNote} role="status">
          计算中：分布图将在运行完成后更新，此处不展示部分结果。
        </p>
      )}
      {status === "error" && (
        <div className={styles.errorAlert} role="alert">
          分布数据加载失败：{errorMessage ?? "未知错误"}
        </div>
      )}
      {status === "ready" && !timeValid && (
        <div className={styles.errorAlert} role="alert">
          分布数据无效：时间游标必须为 0 到 100 的整数观测点。
        </div>
      )}
      {status === "ready" && timeValid && groups === null && (
        <p className={styles.statusNote}>
          暂无运行结果：运行实验后，此处显示 P、Q 两组在当前时间游标处的分布。
        </p>
      )}
      {dataError !== null && (
        <div className={styles.errorAlert} role="alert">
          分布数据无效：{dataError}
        </div>
      )}

      {chart !== null && (
        <>
          <div className={styles.charts}>
            {(["P", "Q"] as const).map((group) => {
              const slice = chart.groups[group];
              const color = GROUP_COLOR[group];
              const bars = chart.bars.filter((bar) => bar.group === group);
              const slot = PLOT_W / chart.stateCount;
              const refW = Math.max(1, slot * 0.38);
              const ticks = [0, chart.sharedMax / 2, chart.sharedMax];
              return (
                <div key={group} className={styles.chartPanel}>
                  <h3 className={styles.chartTitle}>
                    {group} 组分布（t = {time}）
                  </h3>
                  <p className={styles.stats}>
                    理论均值 {formatStat(slice.referenceMeanB)}；经验均值{" "}
                    {formatStat(slice.sampleMeanB)}；理论方差{" "}
                    {formatStat(slice.referenceVarianceB)}；经验方差{" "}
                    {formatStat(slice.sampleVarianceB)}；已完成样本数{" "}
                    {slice.completed}。
                  </p>
                  <svg
                    viewBox={`0 0 ${PLOT_X + PLOT_W + 16} ${BASELINE_Y + 36}`}
                    role="img"
                    aria-label={`${group} 组分布图，横轴为状态 B，纵轴为概率`}
                    className={styles.chart}
                  >
                    {ticks.map((tick) => (
                      <text
                        key={tick}
                        x={PLOT_X - 6}
                        y={BASELINE_Y - (tick / chart.sharedMax) * PLOT_H + 4}
                        textAnchor="end"
                        fontSize="11"
                      >
                        {formatProb(tick)}
                      </text>
                    ))}
                    <line
                      x1={PLOT_X}
                      y1={BASELINE_Y}
                      x2={PLOT_X + PLOT_W}
                      y2={BASELINE_Y}
                      stroke="#172033"
                    />
                    {bars.map((bar) => {
                      const x = PLOT_X + bar.j * slot;
                      const refH = bar.referenceHeightFraction * PLOT_H;
                      const samH = bar.sampleHeightFraction * PLOT_H;
                      return (
                        <g
                          key={bar.j}
                          tabIndex={0}
                          aria-label={`${group} 组状态 ${bar.j}：理论概率 ${formatProb(bar.referenceProb)}，样本计数 ${bar.sampleCount}，样本概率 ${formatProb(bar.sampleProb)}`}
                          onMouseEnter={() =>
                            setHovered({ group, j: bar.j })
                          }
                          onFocus={() => setHovered({ group, j: bar.j })}
                          onMouseLeave={() => setHovered(null)}
                          onBlur={() => setHovered(null)}
                        >
                          <rect
                            x={x}
                            y={BASELINE_Y - refH}
                            width={refW}
                            height={refH}
                            fill="none"
                            stroke={color}
                            strokeWidth="1.5"
                            data-group={group}
                            data-j={bar.j}
                            data-kind="reference"
                            data-prob={String(bar.referenceProb)}
                            data-height-fraction={String(
                              bar.referenceHeightFraction,
                            )}
                          />
                          <rect
                            x={x + refW}
                            y={BASELINE_Y - samH}
                            width={refW}
                            height={samH}
                            fill={color}
                            fillOpacity="0.55"
                            data-group={group}
                            data-j={bar.j}
                            data-kind="sample"
                            data-prob={String(bar.sampleProb)}
                            data-count={String(bar.sampleCount)}
                            data-height-fraction={String(
                              bar.sampleHeightFraction,
                            )}
                          />
                          <text
                            x={x + slot / 2}
                            y={BASELINE_Y + 16}
                            textAnchor="middle"
                            fontSize="11"
                          >
                            {bar.j}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                  <p className={styles.legend}>
                    空心轮廓柱：理论概率（CME 基准）；半透明实柱：SSA
                    样本概率；横轴：状态 B；纵轴：概率（两组共用最大值{" "}
                    {formatProb(chart.sharedMax)}）。
                  </p>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <caption>
                        {group} 组分布数据表（时间 t = {time}）
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">状态 B</th>
                          <th scope="col">理论概率</th>
                          <th scope="col">样本计数</th>
                          <th scope="col">样本概率</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bars.map((bar) => (
                          <tr key={bar.j}>
                            <td>{bar.j}</td>
                            <td>{formatProb(bar.referenceProb)}</td>
                            <td>{bar.sampleCount}</td>
                            <td>{formatProb(bar.sampleProb)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
          <div className={styles.hoverDetail} aria-live="polite">
            {hoveredBar !== null ? (
              <p>
                {hoveredBar.group} 组状态 {hoveredBar.j}：理论概率{" "}
                {formatProb(hoveredBar.referenceProb)}，样本计数{" "}
                {hoveredBar.sampleCount}，样本概率{" "}
                {formatProb(hoveredBar.sampleProb)}。
              </p>
            ) : (
              <p>
                将鼠标悬停在柱子上或用键盘聚焦柱子，查看该状态的明细。
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
