// P006 T011 — 均值时间线与诊断测试（项目书 §7.3、§8、§9.3、§9.4）。
// 测试环境是 node（vitest.config.ts 未配 jsdom），因此用
// react-dom/server 的 renderToStaticMarkup 渲染组件并断言静态标记。
// 真实数值来源：核心 solveReference + 预置（测试导入生产代码做比较是
// 正确做法，与 T006 的 oracle 模式一致）；组件本身不碰 core。
// 交互点检（悬停、游标拖动）属 T013/T014 浏览器验收，不在本文件冒充。

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeanTimeline, stepPath } from "../../src/components/MeanTimeline";
import {
  DiagnosticPanel,
  dkwEpsilon,
  type DiagnosticGroupData,
} from "../../src/components/DiagnosticPanel";
import { solveReference } from "../../src/core/reference";
import { makePreset } from "../../src/domain/presets";
import type { ProbabilityDiagnostics } from "../../src/domain/types";

const goodNumerical: ProbabilityDiagnostics = {
  cumulativeTailBound: 1e-13,
  probabilityMass: 1,
  massDefect: 0,
  minProbability: 0,
  termsUsed: 19,
};

function cdfOf(prob: readonly number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const p of prob) {
    acc += p;
    out.push(acc);
  }
  return out;
}

function groupData(
  group: "P" | "Q",
  overrides: Partial<DiagnosticGroupData> = {},
): DiagnosticGroupData {
  return {
    group,
    meanB: 5,
    meanA: 10,
    varianceA: group === "P" ? 0 : 100,
    meanBirthRate: group === "P" ? 0.9 : 1.9,
    meanDeathRate: 1,
    exactDrift: group === "P" ? -0.1 : 0.9,
    closureDriftAtExactMean: group === "P" ? -0.1 : -0.1,
    driftCorrection: group === "P" ? 0 : 1,
    meanGap: 0.02,
    samplingError: 0.01,
    sampleMeanB: 5.01,
    cdfDistance: 0.03,
    completed: 512,
    referenceCdf: [0, 0.5, 1],
    empiricalCdf: [0, 0.48, 1],
    numerical: goodNumerical,
    ...overrides,
  };
}

function timelineProps(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready" as const,
    times: [0, 1, 2, 3],
    referenceMean: { P: [5, 5.1, 5.2, 5.3], Q: [5, 5.1, 5.2, 5.3] },
    closureMean: { P: [5, 5.05, 5.1, 5.15], Q: [5, 5.05, 5.1, 5.15] },
    sampleMean: { P: [5, 5.08, 5.18, 5.28], Q: [5, 5.12, 5.22, 5.32] },
    timeIndex: 2,
    ...overrides,
  };
}

describe("默认二聚 t=0：漂移与修正的显示来源", () => {
  it("P exactDrift −0.1、Q +0.9、Q driftCorrection 1.0、P 0，来自核心而非手写常量", () => {
    const scenario = makePreset("variance-split");
    const refP = solveReference(scenario, "P");
    const refQ = solveReference(scenario, "Q");
    expect(refP.exactDrift[0]).toBeCloseTo(-0.1, 12);
    expect(refQ.exactDrift[0]).toBeCloseTo(0.9, 12);
    expect(refP.driftCorrection[0]).toBeCloseTo(0, 12);
    expect(refQ.driftCorrection[0]).toBeCloseTo(1, 12);
    expect(refP.meanB[0]).toBeCloseTo(5, 12);
    expect(refQ.meanB[0]).toBeCloseTo(5, 12);
    expect(refP.meanA[0]).toBeCloseTo(10, 12);
    expect(refP.varianceA[0]).toBeCloseTo(0, 12);
    expect(refQ.varianceA[0]).toBeCloseTo(100, 12);
    expect(refP.meanBirthRate[0]).toBeCloseTo(0.9, 12);
    expect(refQ.meanBirthRate[0]).toBeCloseTo(1.9, 12);

    const html = renderToStaticMarkup(
      <DiagnosticPanel
        status="ready"
        timeIndex={0}
        time={0}
        stateCount={3}
        groups={{
          P: groupData("P", {
            meanB: refP.meanB[0]!,
            meanA: refP.meanA[0]!,
            varianceA: refP.varianceA[0]!,
            meanBirthRate: refP.meanBirthRate[0]!,
            meanDeathRate: refP.meanDeathRate[0]!,
            exactDrift: refP.exactDrift[0]!,
            closureDriftAtExactMean: refP.closureDriftAtExactMean[0]!,
            driftCorrection: refP.driftCorrection[0]!,
          }),
          Q: groupData("Q", {
            meanB: refQ.meanB[0]!,
            meanA: refQ.meanA[0]!,
            varianceA: refQ.varianceA[0]!,
            meanBirthRate: refQ.meanBirthRate[0]!,
            meanDeathRate: refQ.meanDeathRate[0]!,
            exactDrift: refQ.exactDrift[0]!,
            closureDriftAtExactMean: refQ.closureDriftAtExactMean[0]!,
            driftCorrection: refQ.driftCorrection[0]!,
          }),
        }}
      />,
    );
    expect(html).toContain("-0.1000");
    expect(html).toContain("0.9000");
    expect(html).toContain("1.0000");
    expect(html).toContain("exactDrift");
    expect(html).toContain("driftCorrection");
  });
});

describe("线性对照与共享闭合", () => {
  it("线性两组 driftCorrection 恒为 0，且 CME 均值重合", () => {
    const scenario = makePreset("linear-control");
    const refP = solveReference(scenario, "P");
    const refQ = solveReference(scenario, "Q");
    let maxCorrection = 0;
    let maxMeanDiff = 0;
    for (let i = 0; i < 101; i += 1) {
      maxCorrection = Math.max(
        maxCorrection,
        Math.abs(refP.driftCorrection[i]!),
        Math.abs(refQ.driftCorrection[i]!),
      );
      maxMeanDiff = Math.max(
        maxMeanDiff,
        Math.abs(refP.meanB[i]! - refQ.meanB[i]!),
      );
    }
    expect(maxCorrection).toBeLessThanOrEqual(1e-12);
    expect(maxMeanDiff).toBeLessThanOrEqual(1e-9);
  });

  it("默认二聚两组闭合逐点相等，时间线只画一条共享线", () => {
    const scenario = makePreset("variance-split");
    const refP = solveReference(scenario, "P");
    const refQ = solveReference(scenario, "Q");
    let maxDiff = 0;
    for (let i = 0; i < 101; i += 1) {
      maxDiff = Math.max(
        maxDiff,
        Math.abs(refP.closureMeanB[i]! - refQ.closureMeanB[i]!),
      );
    }
    expect(maxDiff).toBeLessThanOrEqual(1e-12);
    const times = Array.from({ length: 101 }, (_, i) => (8 * i) / 100);
    const html = renderToStaticMarkup(
      <MeanTimeline
        status="ready"
        times={times}
        referenceMean={{
          P: Array.from(refP.meanB),
          Q: Array.from(refQ.meanB),
        }}
        closureMean={{
          P: Array.from(refP.closureMeanB),
          Q: Array.from(refQ.closureMeanB),
        }}
        timeIndex={0}
      />,
    );
    expect(html).toContain('data-shared-closure="true"');
    expect(html).toContain('data-series="closure-shared"');
    expect(html).not.toContain('data-series="P-closure"');
    expect(html).not.toContain('data-series="Q-closure"');
    expect(html).toContain("闭合近似（P/Q 共享，灰色虚线）");
  });

  it("闭合不同时画两条分别标注的线", () => {
    const html = renderToStaticMarkup(
      <MeanTimeline
        {...timelineProps({
          closureMean: { P: [5, 5.05, 5.1, 5.15], Q: [5, 5.2, 5.4, 5.6] },
        })}
      />,
    );
    expect(html).toContain('data-shared-closure="false"');
    expect(html).toContain('data-series="P-closure"');
    expect(html).toContain('data-series="Q-closure"');
    expect(html).not.toContain('data-series="closure-shared"');
  });
});

describe("均值时间线绘图语义", () => {
  it("单轨迹是阶梯路径：先水平后垂直，不画成连续斜线", () => {
    const path = stepPath([5, 6, 6], (i) => i * 10, (v) => v);
    expect(path).toBe(
      "M 0.00,5.00 L 10.00,5.00 L 10.00,6.00 L 20.00,6.00 L 20.00,6.00",
    );
    const html = renderToStaticMarkup(
      <MeanTimeline
        {...timelineProps({
          preview: { P: [[5, 6, 6, 6]], Q: [] },
        })}
      />,
    );
    expect(html).toContain('data-series="P-preview"');
    expect(html).toContain("阶梯显示，非连续物理过程");
  });

  it("均值曲线是观测点连线，样本线可开关", () => {
    const html = renderToStaticMarkup(
      <MeanTimeline {...timelineProps()} />,
    );
    expect(html).toContain('data-series="P-reference"');
    expect(html).toContain('data-series="Q-reference"');
    expect(html).toContain('data-series="P-sample"');
    const hidden = renderToStaticMarkup(
      <MeanTimeline {...timelineProps({ showSample: false })} />,
    );
    expect(hidden).not.toContain('data-series="P-sample"');
  });

  it("数据表含游标行数值，长度不一致时只报错误不画错图", () => {
    const html = renderToStaticMarkup(
      <MeanTimeline {...timelineProps()} />,
    );
    expect(html).toContain('data-time-index="2"');
    expect(html).toContain("5.2000");
    const bad = renderToStaticMarkup(
      <MeanTimeline
        {...timelineProps({
          referenceMean: { P: [5, 5.1], Q: [5, 5.1, 5.2, 5.3] },
        })}
      />,
    );
    expect(bad).toContain('role="alert"');
    expect(bad).not.toContain('data-series="P-reference"');
  });

  it("空态、计算中态、错误态文案清楚", () => {
    expect(
      renderToStaticMarkup(
        <MeanTimeline {...timelineProps({ status: "empty" })} />,
      ),
    ).toContain("暂无运行结果");
    expect(
      renderToStaticMarkup(
        <MeanTimeline {...timelineProps({ status: "running" })} />,
      ),
    ).toContain("计算中……不展示部分结果");
    const err = renderToStaticMarkup(
      <MeanTimeline
        {...timelineProps({ status: "error", errorMessage: " worker 失败" })}
      />,
    );
    expect(err).toContain('role="alert"');
  });
});

describe("诊断面板：三类差异、CDF/DKW、数值质量", () => {
  it("meanGap 与 driftCorrection 是两个独立字段、单位不同", () => {
    const html = renderToStaticMarkup(
      <DiagnosticPanel
        status="ready"
        timeIndex={0}
        time={0}
        stateCount={3}
        groups={{ P: groupData("P"), Q: groupData("Q") }}
      />,
    );
    expect(html).toContain('data-difference="meanGap"');
    expect(html).toContain('data-difference="driftCorrection"');
    expect(html).toContain('data-difference="samplingError"');
    expect(html).toContain('data-unit="分子数/秒"');
    expect(html).toContain("CME 均值 − 闭合轨迹均值");
    expect(html).toContain("SSA 经验均值 − CME 均值");
    expect(html).toContain("driftCorrection 不是 meanGap");
  });

  it("DKW 带：M=512 时 ε=0.0600，上限裁到 1，且只在 CDF 一节", () => {
    const eps = dkwEpsilon(512);
    expect(eps).not.toBeNull();
    expect(eps!.toFixed(4)).toBe("0.0600");
    const html = renderToStaticMarkup(
      <DiagnosticPanel
        status="ready"
        timeIndex={0}
        time={0}
        stateCount={3}
        groups={{
          P: groupData("P", {
            referenceCdf: [0, 0.5, 0.98],
            empiricalCdf: [0, 0.48, 0.97],
          }),
          Q: groupData("Q"),
        }}
      />,
    );
    expect(html).toContain("点态 95% DKW 参考带半宽 ε = 0.0600");
    expect(html).toContain("1.000000");
    expect(html).toContain(
      Math.max(0, 0.98 - eps!).toFixed(6),
    );
    expect(html).toContain("仅用于 CDF");
    expect(html).toContain("不是 PMF 每根柱子的误差棒");
    const cdfSection = html.indexOf('data-section="cdf"');
    const dkwNote = html.indexOf("DKW 参考带半宽");
    expect(dkwNote).toBeGreaterThan(cdfSection);
  });

  it("showDkwBand=false 时不显示参考带列", () => {
    const html = renderToStaticMarkup(
      <DiagnosticPanel
        status="ready"
        timeIndex={0}
        time={0}
        stateCount={3}
        showDkwBand={false}
        groups={{ P: groupData("P"), Q: groupData("Q") }}
      />,
    );
    expect(html).not.toContain("DKW 参考带半宽");
    expect(html).not.toContain("参考带下限");
  });

  it("CDF 距离与数值质量正常显示；超预算时报明确错误且不可导出", () => {
    const html = renderToStaticMarkup(
      <DiagnosticPanel
        status="ready"
        timeIndex={0}
        time={0}
        stateCount={3}
        groups={{ P: groupData("P"), Q: groupData("Q") }}
      />,
    );
    expect(html).toContain("CDF 距离 D = 0.030000");
    expect(html).toContain("累计尾界");
    expect(html).toContain("1.00e-13");
    const bad = renderToStaticMarkup(
      <DiagnosticPanel
        status="ready"
        timeIndex={0}
        time={0}
        stateCount={3}
        groups={{
          P: groupData("P", {
            numerical: { ...goodNumerical, cumulativeTailBound: 1e-9 },
          }),
          Q: groupData("Q"),
        }}
      />,
    );
    expect(bad).toContain('role="alert"');
    expect(bad).toContain("数值质量异常，相关结果不可导出为成功实验");
  });

  it("空态、计算中态、数据无效时不展示数值", () => {
    expect(
      renderToStaticMarkup(
        <DiagnosticPanel
          status="empty"
          timeIndex={0}
          time={0}
          stateCount={3}
          groups={null}
        />,
      ),
    ).toContain("暂无运行结果");
    expect(
      renderToStaticMarkup(
        <DiagnosticPanel
          status="running"
          timeIndex={0}
          time={0}
          stateCount={3}
          groups={null}
        />,
      ),
    ).toContain("计算中……不展示部分结果");
    const bad = renderToStaticMarkup(
      <DiagnosticPanel
        status="ready"
        timeIndex={0}
        time={0}
        stateCount={3}
        groups={{
          P: groupData("P", { referenceCdf: [0, 0.5] }),
          Q: groupData("Q"),
        }}
      />,
    );
    expect(bad).toContain('role="alert"');
    expect(bad).not.toContain("此刻为什么不同");
  });

  it("t=0 默认分布的 CDF 表与 P/Q 初始值一致", () => {
    const scenario = makePreset("variance-split");
    const refP = solveReference(scenario, "P");
    const refQ = solveReference(scenario, "Q");
    const stateCount = 11;
    const sliceP = Array.from(refP.pmf.subarray(0, stateCount));
    const sliceQ = Array.from(refQ.pmf.subarray(0, stateCount));
    expect(sliceP[5]).toBeCloseTo(1, 12);
    expect(sliceQ[0]).toBeCloseTo(0.5, 12);
    expect(sliceQ[10]).toBeCloseTo(0.5, 12);
    const html = renderToStaticMarkup(
      <DiagnosticPanel
        status="ready"
        timeIndex={0}
        time={0}
        stateCount={stateCount}
        groups={{
          P: groupData("P", {
            referenceCdf: cdfOf(sliceP),
            empiricalCdf: cdfOf(sliceP),
            cdfDistance: 0,
          }),
          Q: groupData("Q", {
            referenceCdf: cdfOf(sliceQ),
            empiricalCdf: cdfOf(sliceQ),
            cdfDistance: 0,
          }),
        }}
      />,
    );
    expect(html).toContain("CDF 距离 D = 0.000000");
    expect(html).toContain("0.500000");
    expect(html).toContain("1.000000");
  });
});
