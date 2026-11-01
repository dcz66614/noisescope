// P006 T010 — 分布舞台测试（项目书 §9.3、§9.6）。
//
// 测试环境是 node（vitest.config.ts 未配 jsdom），因此用
// react-dom/server 的 renderToStaticMarkup 渲染组件并断言静态
// 标记：柱子的数据属性、共享纵轴、数据表、状态文案。
// 悬停交互本身（useState + onMouseEnter/onFocus）只断言初始
// 提示文案与可聚焦属性；真实浏览器点检属 T013/T014 验收。

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DistributionView } from "../../src/components/DistributionView";
import {
  buildDistributionChartData,
  sampleProbabilities,
  type DistributionGroupSlice,
} from "../../src/components/distributionData";

function slice(
  group: "P" | "Q",
  referenceProb: number[],
  sampleCounts: number[],
  completed: number,
  stats?: Partial<
    Pick<
      DistributionGroupSlice,
      | "referenceMeanB"
      | "sampleMeanB"
      | "referenceVarianceB"
      | "sampleVarianceB"
    >
  >,
): DistributionGroupSlice {
  return {
    group,
    referenceProb,
    sampleCounts,
    completed,
    referenceMeanB: stats?.referenceMeanB ?? 5,
    sampleMeanB: stats?.sampleMeanB ?? 5,
    referenceVarianceB: stats?.referenceVarianceB ?? 0,
    sampleVarianceB: stats?.sampleVarianceB ?? 0,
  };
}

/** 默认实验 t=0：P 点质量 j=5，Q 两端 j=0/j=10 各半，M=64。 */
function defaultGroups() {
  const pRef = new Array<number>(11).fill(0);
  pRef[5] = 1;
  const qRef = new Array<number>(11).fill(0);
  qRef[0] = 0.5;
  qRef[10] = 0.5;
  const pCounts = new Array<number>(11).fill(0);
  pCounts[5] = 64;
  const qCounts = new Array<number>(11).fill(0);
  qCounts[0] = 32;
  qCounts[10] = 32;
  return {
    P: slice("P", pRef, pCounts, 64, {
      referenceMeanB: 5,
      sampleMeanB: 5,
      referenceVarianceB: 0,
      sampleVarianceB: 0,
    }),
    Q: slice("Q", qRef, qCounts, 64, {
      referenceMeanB: 5,
      sampleMeanB: 5,
      referenceVarianceB: 25,
      sampleVarianceB: 25,
    }),
  };
}

function renderReady(groups = defaultGroups(), stateCount = 11) {
  return renderToStaticMarkup(
    <DistributionView
      status="ready"
      stateCount={stateCount}
      timeIndex={0}
      time={0}
      groups={groups}
    />,
  );
}

describe("DistributionView 状态", () => {
  it("空态不画柱子，只说明暂无结果", () => {
    const html = renderToStaticMarkup(
      <DistributionView
        status="empty"
        stateCount={11}
        timeIndex={0}
        time={0}
        groups={null}
      />,
    );
    expect(html).toContain("暂无运行结果");
    expect(html).not.toContain("data-kind=");
  });

  it("计算中态不展示部分结果", () => {
    const html = renderToStaticMarkup(
      <DistributionView
        status="running"
        stateCount={11}
        timeIndex={0}
        time={0}
        groups={null}
      />,
    );
    expect(html).toContain("计算中");
    expect(html).not.toContain("data-kind=");
  });

  it("错误态用 role=alert 呈现错误信息，不画柱子", () => {
    const html = renderToStaticMarkup(
      <DistributionView
        status="error"
        stateCount={11}
        timeIndex={0}
        time={0}
        groups={null}
        errorMessage="Worker 失败"
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Worker 失败");
    expect(html).not.toContain("data-kind=");
  });

  it("ready 但无切片时按空态处理", () => {
    const html = renderToStaticMarkup(
      <DistributionView
        status="ready"
        stateCount={11}
        timeIndex={0}
        time={0}
        groups={null}
      />,
    );
    expect(html).toContain("暂无运行结果");
    expect(html).not.toContain("data-kind=");
  });

  it("ready 但数据长度与状态数不一致时显示错误态，不画错图", () => {
    const groups = defaultGroups();
    const bad = { ...groups, P: slice("P", [1, 0], [64, 0], 64) };
    const html = renderReady(bad, 11);
    expect(html).toContain('role="alert"');
    expect(html).toContain("分布数据无效");
    expect(html).not.toContain("data-kind=");
  });

  it("时间游标越界时显示错误态", () => {
    const html = renderToStaticMarkup(
      <DistributionView
        status="ready"
        stateCount={11}
        timeIndex={101}
        time={8}
        groups={defaultGroups()}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("data-kind=");
  });
});

describe("DistributionView t=0 默认分布", () => {
  it("P 点质量与 Q 两端分布的柱子对应真实 j 与概率", () => {
    const html = renderReady();
    // P 组 j=5 理论概率 1、样本概率 1；Q 组 j=0/j=10 各 0.5。
    expect(html).toContain('data-group="P" data-j="5" data-kind="reference" data-prob="1"');
    expect(html).toContain('data-group="P" data-j="5" data-kind="sample" data-prob="1" data-count="64"');
    expect(html).toContain('data-group="Q" data-j="0" data-kind="reference" data-prob="0.5"');
    expect(html).toContain('data-group="Q" data-j="10" data-kind="sample" data-prob="0.5" data-count="32"');
    // 其余状态概率为 0，仍有柱子（不隐藏任何状态）。
    expect(html).toContain('data-group="P" data-j="0" data-kind="reference" data-prob="0"');
    expect(html).toContain('data-group="Q" data-j="5" data-kind="reference" data-prob="0"');
  });

  it("基准柱为空心轮廓、样本柱为半透明实柱", () => {
    const html = renderReady();
    expect(html).toContain('fill="none"');
    expect(html).toContain('fill-opacity="0.55"');
  });

  it("时间游标与统计量同步显示", () => {
    const html = renderReady();
    expect(html).toContain("时间 t = 0");
    expect(html).toContain("观测点 0 / 100");
    expect(html).toContain("已完成样本数 64");
  });

  it("每组都附数据表，含 j、理论概率、样本计数、样本概率", () => {
    const html = renderReady();
    expect(html).toContain("P 组分布数据表");
    expect(html).toContain("Q 组分布数据表");
    expect(html).toContain("理论概率");
    expect(html).toContain("样本计数");
    expect(html).toContain("样本概率");
  });

  it("初始悬停明细只显示提示，不编造数值", () => {
    const html = renderReady();
    expect(html).toContain("将鼠标悬停在柱子上或用键盘聚焦柱子");
  });

  it("柱子可键盘聚焦", () => {
    const html = renderReady();
    expect(html).toContain("tabindex=\"0\"");
  });
});

describe("DistributionView 共享纵轴", () => {
  it("两组最大值不同时共用全局最大值，不各自缩放", () => {
    const pRef = [0.8, 0.2];
    const qRef = [0.4, 0.6];
    const groups = {
      P: slice("P", pRef, [0, 0], 0),
      Q: slice("Q", qRef, [0, 0], 0),
    };
    const html = renderToStaticMarkup(
      <DistributionView
        status="ready"
        stateCount={2}
        timeIndex={50}
        time={4}
        groups={groups}
      />,
    );
    expect(html).toContain('data-shared-max="0.8"');
    // Q 组 0.4 的柱高应为绘图高度的一半（相对共享最大值）。
    expect(html).toContain(
      'data-group="Q" data-j="0" data-kind="reference" data-prob="0.4" data-height-fraction="0.5"',
    );
    expect(html).toContain(
      'data-group="P" data-j="0" data-kind="reference" data-prob="0.8" data-height-fraction="1"',
    );
  });

  it("样本概率由计数与已完成数算出，completed 为 0 时为 0", () => {
    const groups = {
      P: slice("P", [0.5, 0.5], [48, 16], 64),
      Q: slice("Q", [1, 0], [0, 0], 0),
    };
    const html = renderToStaticMarkup(
      <DistributionView
        status="ready"
        stateCount={2}
        timeIndex={10}
        time={0.8}
        groups={groups}
      />,
    );
    expect(html).toContain('data-group="P" data-j="0" data-kind="sample" data-prob="0.75" data-count="48"');
    expect(html).toContain('data-group="Q" data-j="0" data-kind="sample" data-prob="0" data-count="0"');
  });
});

describe("distributionData 纯适配器", () => {
  it("样本概率与共享最大值只来自切片，不重算科学量", () => {
    const groups = defaultGroups();
    expect(sampleProbabilities(groups.Q)).toEqual([
      0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5,
    ]);
    const chart = buildDistributionChartData(groups, 11);
    expect(chart.sharedMax).toBe(1);
    expect(chart.bars).toHaveLength(22);
  });

  it("负概率或非整数计数抛错，不静默画图", () => {
    const groups = defaultGroups();
    const badProb = { ...groups, P: slice("P", [-0.1, ...new Array(10).fill(0)], new Array(11).fill(0), 0) };
    expect(() => buildDistributionChartData(badProb, 11)).toThrow();
    const badCount = { ...groups, Q: slice("Q", new Array(11).fill(0), [1.5, ...new Array(10).fill(0)], 64) };
    expect(() => buildDistributionChartData(badCount, 11)).toThrow();
  });
});
