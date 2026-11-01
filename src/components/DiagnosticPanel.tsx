// P006 T011 — 诊断面板（项目书 §7.3、§8、§9.4）。
//
// 职责边界：只展示调用方给出的单时刻数值，不重算任何科学量、不碰 core。
// - 三类差异由调用方按核心定义给出（computeComparisonSeries /
//   ReferenceGroup），本组件只按三个独立字段、各自单位展示，绝不混淆：
//   meanGap（分子数）、driftCorrection（分子数/秒）、samplingError（分子数）。
// - CDF/DKW 参考带只出现在本组件的 CDF 一节：点态 95% 带，
//   ε=sqrt(ln(2/0.05)/(2M))，范围裁到 [0,1]；它不是全部时间的同时
//   置信带，不是 PMF 每根柱子的误差棒，不验证 PRNG 的真正独立性。
//   ε 本身是 §8 给出的展示公式，由已给的 M 直接算出，不是重算 CDF 距离。
// - 数值质量异常（尾界、质量亏缺、最小概率超出预算）时顶部出现明确
//   错误，相关结果不可导出为成功实验（§9.4）。
// - 每节都附数据表（§9.6“图表附数据表”），表格可局部横向滚动。

import type { ProbabilityDiagnostics } from "../domain/types";
import styles from "./DiagnosticPanel.module.css";

export type DiagnosticPanelStatus = "empty" | "running" | "ready" | "error";

export interface DiagnosticGroupData {
  group: "P" | "Q";
  /** CME 基准均值 B（分子数）。 */
  meanB: number;
  meanA: number;
  varianceA: number;
  /** 正向平均率（分子数/秒）。 */
  meanBirthRate: number;
  /** 反向平均率（分子数/秒）。 */
  meanDeathRate: number;
  /** 精确漂移（分子数/秒）。 */
  exactDrift: number;
  /** 在 CME 当前均值处计算的闭合漂移（分子数/秒）。 */
  closureDriftAtExactMean: number;
  /** 漂移修正（分子数/秒）。 */
  driftCorrection: number;
  /** CME 均值 − 闭合轨迹均值（分子数）。 */
  meanGap: number;
  /** SSA 经验均值 − CME 均值（分子数）。 */
  samplingError: number;
  sampleMeanB: number;
  /** CDF 距离 D（无量纲概率差）。 */
  cdfDistance: number;
  /** 已完成轨迹数 M。 */
  completed: number;
  /** 该时刻的参考 CDF（长度 = stateCount）。 */
  referenceCdf: readonly number[];
  /** 该时刻的经验 CDF（长度 = stateCount）。 */
  empiricalCdf: readonly number[];
  numerical: ProbabilityDiagnostics;
}

export interface DiagnosticPanelProps {
  status: DiagnosticPanelStatus;
  timeIndex: number;
  time: number;
  stateCount: number;
  groups: { P: DiagnosticGroupData; Q: DiagnosticGroupData } | null;
  /** 是否显示 DKW 参考带；调用方控制的切换，默认显示。 */
  showDkwBand?: boolean;
  /** RK4 最大步长（核心常量，调用方给出；默认 0.01）。 */
  rk4StepMax?: number;
  engineVersion?: string;
  errorMessage?: string | null;
}

/** 点态 95% DKW 参考带半宽（§8）：ε=sqrt(ln(2/0.05)/(2M))。 */
export function dkwEpsilon(completed: number): number | null {
  if (!Number.isInteger(completed) || completed <= 0) return null;
  return Math.sqrt(Math.log(2 / 0.05) / (2 * completed));
}

function formatValue(value: number): string {
  return value.toFixed(4);
}

function formatProb(value: number): string {
  return value.toFixed(6);
}

/** 小量（尾界、质量亏缺）用科学计数法，避免 toFixed 抹成 0。 */
function formatSmall(value: number): string {
  return Math.abs(value) < 0.001 && value !== 0
    ? value.toExponential(2)
    : value.toFixed(6);
}

function isFiniteGroup(group: DiagnosticGroupData): boolean {
  return [
    group.meanB,
    group.meanA,
    group.varianceA,
    group.meanBirthRate,
    group.meanDeathRate,
    group.exactDrift,
    group.closureDriftAtExactMean,
    group.driftCorrection,
    group.meanGap,
    group.samplingError,
    group.sampleMeanB,
    group.cdfDistance,
    group.numerical.cumulativeTailBound,
    group.numerical.probabilityMass,
    group.numerical.massDefect,
    group.numerical.minProbability,
    group.numerical.termsUsed,
  ].every((value) => Number.isFinite(value));
}

/** 数值质量预算（T007 证据口径）：超预算即异常，不可导出。 */
export function numericalQualityOk(
  numerical: ProbabilityDiagnostics,
): boolean {
  return (
    numerical.cumulativeTailBound <= 1e-12 &&
    Math.abs(numerical.massDefect) <= 1e-10 &&
    numerical.minProbability >= -1e-14
  );
}

export function DiagnosticPanel(props: DiagnosticPanelProps) {
  const {
    status,
    timeIndex,
    time,
    stateCount,
    groups,
    showDkwBand = true,
    rk4StepMax = 0.01,
    engineVersion = "1.0.0",
    errorMessage = null,
  } = props;

  if (status === "empty") {
    return (
      <section className={styles.stage} data-component="DiagnosticPanel">
        <h3 className={styles.title}>诊断</h3>
        <p className={styles.statusNote}>暂无运行结果</p>
      </section>
    );
  }
  if (status === "running") {
    return (
      <section className={styles.stage} data-component="DiagnosticPanel">
        <h3 className={styles.title}>诊断</h3>
        <p className={styles.statusNote}>计算中……不展示部分结果</p>
      </section>
    );
  }

  let dataError: string | null = null;
  if (status === "error") {
    dataError = errorMessage ?? "诊断错误";
  } else if (groups === null) {
    dataError = "诊断数据缺失";
  } else if (
    !Number.isInteger(timeIndex) ||
    timeIndex < 0 ||
    !Number.isFinite(time) ||
    !Number.isInteger(stateCount) ||
    stateCount <= 0 ||
    !isFiniteGroup(groups.P) ||
    !isFiniteGroup(groups.Q) ||
    groups.P.referenceCdf.length !== stateCount ||
    groups.P.empiricalCdf.length !== stateCount ||
    groups.Q.referenceCdf.length !== stateCount ||
    groups.Q.empiricalCdf.length !== stateCount ||
    !Number.isInteger(groups.P.completed) ||
    groups.P.completed < 0 ||
    !Number.isInteger(groups.Q.completed) ||
    groups.Q.completed < 0
  ) {
    dataError = "诊断数据无效";
  }

  if (dataError !== null) {
    return (
      <section className={styles.stage} data-component="DiagnosticPanel">
        <h3 className={styles.title}>诊断</h3>
        <p className={styles.errorAlert} role="alert">
          {dataError}
        </p>
      </section>
    );
  }

  const qualityOk =
    numericalQualityOk(groups!.P.numerical) &&
    numericalQualityOk(groups!.Q.numerical);

  return (
    <section className={styles.stage} data-component="DiagnosticPanel">
      <h3 className={styles.title}>诊断</h3>
      <p className={styles.timeLine}>
        观测点 {timeIndex}，t = {formatValue(time)}
      </p>
      {!qualityOk ? (
        <p className={styles.errorAlert} role="alert">
          数值质量异常，相关结果不可导出为成功实验
        </p>
      ) : null}

      <section data-section="why-different">
        <h4>此刻为什么不同</h4>
        {(["P", "Q"] as const).map((groupId) => {
          const group = groups![groupId];
          return (
            <div key={groupId} data-group={groupId}>
              <h5>组 {groupId}</h5>
              <div className={styles.tableWrap}>
                <table>
                  <tbody>
                    <tr>
                      <th>理论 mB</th>
                      <td>{formatValue(group.meanB)} 分子数</td>
                    </tr>
                    <tr>
                      <th>理论 mA</th>
                      <td>{formatValue(group.meanA)} 分子数</td>
                    </tr>
                    <tr>
                      <th>VarA</th>
                      <td>{formatValue(group.varianceA)} 分子数²</td>
                    </tr>
                    <tr>
                      <th>正向平均率</th>
                      <td>{formatValue(group.meanBirthRate)} 分子数/秒</td>
                    </tr>
                    <tr>
                      <th>反向平均率</th>
                      <td>{formatValue(group.meanDeathRate)} 分子数/秒</td>
                    </tr>
                    <tr>
                      <th>exactDrift</th>
                      <td>{formatValue(group.exactDrift)} 分子数/秒</td>
                    </tr>
                    <tr>
                      <th>closureDriftAtExactMean</th>
                      <td>
                        {formatValue(group.closureDriftAtExactMean)} 分子数/秒
                      </td>
                    </tr>
                    <tr>
                      <th>driftCorrection</th>
                      <td>{formatValue(group.driftCorrection)} 分子数/秒</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </section>

      <section data-section="three-differences">
        <h4>三类差异（不可混淆）</h4>
        {(["P", "Q"] as const).map((groupId) => {
          const group = groups![groupId];
          return (
            <div key={groupId} data-group={groupId}>
              <h5>组 {groupId}</h5>
              <div data-difference="meanGap" data-unit="分子数">
                <p>meanGap：CME 均值 − 闭合轨迹均值</p>
                <p>
                  {formatValue(group.meanGap)} 分子数
                </p>
              </div>
              <div data-difference="driftCorrection" data-unit="分子数/秒">
                <p>
                  driftCorrection：exactDrift − 在 CME
                  当前均值处计算的闭合漂移
                </p>
                <p>
                  {formatValue(group.driftCorrection)} 分子数/秒
                </p>
              </div>
              <div data-difference="samplingError" data-unit="分子数">
                <p>samplingError：SSA 经验均值 − CME 均值</p>
                <p>
                  {formatValue(group.samplingError)} 分子数
                </p>
              </div>
            </div>
          );
        })}
        <p className={styles.note}>
          driftCorrection 不是 meanGap，也不是 P、Q 均值曲线之间的距离。
        </p>
      </section>

      <section data-section="cdf">
        <h4>采样诊断（CDF）</h4>
        {(["P", "Q"] as const).map((groupId) => {
          const group = groups![groupId];
          const epsilon = dkwEpsilon(group.completed);
          return (
            <div key={groupId} data-group={groupId}>
              <h5>组 {groupId}</h5>
              <p>
                CDF 距离 D = {formatProb(group.cdfDistance)}，M ={" "}
                {group.completed}
              </p>
              {showDkwBand && epsilon !== null ? (
                <p>
                  点态 95% DKW 参考带半宽 ε = {epsilon.toFixed(4)}
                </p>
              ) : null}
              <div className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th>状态 j</th>
                      <th>参考 CDF</th>
                      <th>经验 CDF</th>
                      {showDkwBand && epsilon !== null ? (
                        <>
                          <th>参考带下限</th>
                          <th>参考带上限</th>
                        </>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {group.referenceCdf.map((refCdf, j) => {
                      const low =
                        epsilon === null
                          ? null
                          : Math.max(0, refCdf - epsilon);
                      const high =
                        epsilon === null
                          ? null
                          : Math.min(1, refCdf + epsilon);
                      return (
                        <tr key={j} data-state={j}>
                          <td>{j}</td>
                          <td>{formatProb(refCdf)}</td>
                          <td>{formatProb(group.empiricalCdf[j]!)}</td>
                          {showDkwBand && epsilon !== null ? (
                            <>
                              <td>{formatProb(low!)}</td>
                              <td>{formatProb(high!)}</td>
                            </>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
        <p className={styles.note}>
          点态 95% DKW 参考带仅用于 CDF；不是全部时间的同时置信带，不是
          PMF 每根柱子的误差棒，不验证 PRNG 的真正独立性。
        </p>
      </section>

      <section data-section="numerical-quality">
        <h4>数值质量</h4>
        <p>
          状态数 S = {stateCount}，RK4 最大步长 = {rk4StepMax}，运行版本 ={" "}
          {engineVersion}
        </p>
        {(["P", "Q"] as const).map((groupId) => {
          const numerical = groups![groupId].numerical;
          return (
            <div key={groupId} data-group={groupId}>
              <h5>组 {groupId}</h5>
              <div className={styles.tableWrap}>
                <table>
                  <tbody>
                    <tr>
                      <th>累计尾界</th>
                      <td>{formatSmall(numerical.cumulativeTailBound)}</td>
                    </tr>
                    <tr>
                      <th>概率质量</th>
                      <td>{formatSmall(numerical.probabilityMass)}</td>
                    </tr>
                    <tr>
                      <th>质量亏缺</th>
                      <td>{formatSmall(numerical.massDefect)}</td>
                    </tr>
                    <tr>
                      <th>最小概率</th>
                      <td>{formatSmall(numerical.minProbability)}</td>
                    </tr>
                    <tr>
                      <th>展开项数 termsUsed</th>
                      <td>{numerical.termsUsed}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </section>
    </section>
  );
}
