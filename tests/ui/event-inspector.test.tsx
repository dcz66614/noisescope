// P006 T012 — 事件审计测试（项目书 §9.5、§9.6）。
//
// 测试环境是 node（无 jsdom），用 renderToStaticMarkup 断言静态
// 标记；交互回调（选组、选轨迹、重放）只断言按钮/控件的初始
// 呈现与禁用规则，真实浏览器点检属 T013/T014 验收。
// 夹具轨迹的数值由测试内公式算出（等待时间 = −ln u / 总速率），
// 不是随机编造；另有一组用核心真实产物（tests/io/buildRun）
// 证明组件能渲染 Worker/SSA 产出的真实轨迹。

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EventInspector,
  formatDefault,
  formatDetail,
  validateTraceForDisplay,
} from "../../src/components/EventInspector";
import type {
  AuditTrace,
  ModelSpec,
} from "../../src/domain/types";
import { buildSmallRun } from "../io/buildRun";

const model: ModelSpec = {
  id: "dimer",
  totalUnits: 20,
  forwardRate: 0.02,
  reverseRate: 0.2,
};
const HORIZON = 0.5;

/** 手算夹具：二聚 N=20，P 组 0 号，初始 B=5，2 个事件后视界终止。 */
function fixtureTrace(): AuditTrace {
  const waiting0 = -Math.log(0.5) / 1.9;
  const time1 = waiting0;
  const waiting1 = -Math.log(0.8) / 1.76;
  const time2 = time1 + waiting1;
  const terminalWaiting = -Math.log(0.9) / 1.9;
  return {
    group: "P",
    trajectoryIndex: 0,
    initial: { uInitial: 0.3, initialState: 5, trajectorySeed: 775094953 },
    events: [
      {
        index: 0,
        timeBefore: 0,
        stateBefore: 5,
        birth: 0.9,
        death: 1,
        totalRate: 1.9,
        uWaiting: 0.5,
        uChoice: 0.2,
        waitingTime: waiting0,
        reaction: "forward",
        timeAfter: time1,
        stateAfter: 6,
      },
      {
        index: 1,
        timeBefore: time1,
        stateBefore: 6,
        birth: 0.56,
        death: 1.2,
        totalRate: 1.76,
        uWaiting: 0.8,
        uChoice: 0.9,
        waitingTime: waiting1,
        reaction: "reverse",
        timeAfter: time2,
        stateAfter: 5,
      },
    ],
    terminal: {
      reason: "HORIZON",
      time: time2,
      state: 5,
      totalRate: 1.9,
      uWaiting: 0.9,
      uChoice: 0.1,
      waitingTime: terminalWaiting,
      candidateTime: time2 + terminalWaiting,
    },
    sampledB: new Array<number>(101).fill(5),
  };
}

function renderReady(trace = fixtureTrace(), extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <EventInspector
      status="ready"
      group="P"
      trajectoryIndex={0}
      trajectoriesPerGroup={64}
      model={model}
      horizon={HORIZON}
      trace={trace}
      verification={null}
      {...extra}
    />,
  );
}

describe("EventInspector", () => {
  it("默认精度在 5—7 位有效数字内，详情精度为 15 位", () => {
    expect(formatDefault(0.123456789)).toBe("0.123457");
    expect(formatDetail(0.123456789)).toBe("0.123456789000000");
    expect(formatDefault(0)).toBe("0");
  });

  it("初始化抽样单独成行，uInitial、初始状态、轨迹种子单列", () => {
    const html = renderReady();
    expect(html).toContain("初始化抽样");
    expect(html).toContain('data-field="uInitial"');
    expect(html).toContain('data-full="0.3"');
    expect(html).toContain("初始状态 B = 5");
    expect(html).toContain("775094953");
  });

  it("事件表显示时间、j 前后、λ、μ、uWaiting、uChoice、τ、选择结果", () => {
    const html = renderReady();
    expect(html).toContain("5 → 6");
    expect(html).toContain("6 → 5");
    expect(html).toContain("正向");
    expect(html).toContain("反向");
    expect(html).toContain('data-field="uWaiting"');
    expect(html).toContain('data-field="uChoice"');
    // 全精度属性不被显示截断影响：uWaiting=0.5 的全精度仍是 0.5，
    // 用第二事件的 0.8 与等待时间全精度核对 data-full 存在。
    expect(html).toContain('data-full="0.8"');
  });

  it("组合数解释显示二聚 A 与 A(A−1)/2 的当前整数值", () => {
    const html = renderReady();
    // 事件 0：B=5 时 A=20−2×5=10，A(A−1)/2=45；事件 1：B=6 时 A=8，=28。
    expect(html).toContain("A=10，A(A−1)/2=45");
    expect(html).toContain("A=8，A(A−1)/2=28");
  });

  it("终止候选单独成节，不是已发生事件，且 uWaiting/uChoice 单列", () => {
    const html = renderReady();
    expect(html).toContain("终止说明");
    expect(html).toContain("未发生的候选，不是已发生事件");
    expect(html).toContain('data-field="terminal-uWaiting"');
    expect(html).toContain('data-field="terminal-uChoice"');
    expect(html).toContain('data-field="terminal-candidateTime"');
    // 候选时间超出视界 0.5：事件表只含 2 个事件，候选不在其中。
    expect(html).toContain("共 2 个事件");
  });

  it("当前计数图标按真实最终状态绘制", () => {
    const html = renderReady();
    expect(html).toContain("当前计数图标");
    expect(html).toContain('data-b-count="5"');
    expect(html).toContain('data-a-count="10"');
  });

  it("观测上下文显示该时刻状态与最近已发生事件", () => {
    const html = renderReady(fixtureTrace(), { observationIndex: 100 });
    expect(html).toContain("观测点 100");
    expect(html).toContain("状态 B = 5");
    expect(html).toContain("最近已发生事件 #1");
  });

  it("复验为 null 时不显示已验证；复验通过/失败分别呈现", () => {
    expect(renderReady()).toContain("复验未完成：未提供复验结果，不显示已验证");
    const passed = renderReady(fixtureTrace(), {
      verification: { valid: true, checkedEvents: 2, errors: [] },
    });
    expect(passed).toContain("复验通过：已核对 2 个事件");
    const failed = renderReady(fixtureTrace(), {
      verification: {
        valid: false,
        checkedEvents: 0,
        errors: ["events[0].uWaiting: EVIDENCE_MISMATCH"],
      },
    });
    expect(failed).toContain("复验未通过");
    expect(failed).toContain("EVIDENCE_MISMATCH");
  });

  it("任意合法轨迹号可查看：轨迹号 63 合法，64 非法且重放禁用", () => {
    const legal = renderReady(fixtureTrace(), { trajectoryIndex: 63 });
    // 轨迹号与夹具不符时应显示无效（不是静默画错表）。
    expect(legal).toContain("审计轨迹无效");
    const illegal = renderToStaticMarkup(
      <EventInspector
        status="ready"
        group="P"
        trajectoryIndex={64}
        trajectoriesPerGroup={64}
        model={model}
        horizon={HORIZON}
        trace={null}
        verification={null}
      />,
    );
    expect(illegal).toContain("轨迹号非法");
    expect(illegal).toContain("disabled");
  });

  it("状态链断裂的轨迹显示错误态，不画错表", () => {
    const broken = fixtureTrace();
    broken.events[1]!.stateBefore = 99;
    expect(
      validateTraceForDisplay(broken, "P", 0, 11, HORIZON),
    ).toContain("状态链断裂");
    expect(renderReady(broken)).toContain("审计轨迹无效");
  });

  it("空态、计算中态、错误态各自清楚", () => {
    const empty = renderToStaticMarkup(
      <EventInspector
        status="empty"
        group="P"
        trajectoryIndex={0}
        trajectoriesPerGroup={64}
        model={model}
        horizon={HORIZON}
        trace={null}
        verification={null}
      />,
    );
    expect(empty).toContain("暂无轨迹");
    const running = renderToStaticMarkup(
      <EventInspector
        status="running"
        group="P"
        trajectoryIndex={0}
        trajectoriesPerGroup={64}
        model={model}
        horizon={HORIZON}
        trace={null}
        verification={null}
      />,
    );
    expect(running).toContain("重放中：此处不展示部分事件");
  });

  it("能渲染核心真实产物的轨迹（非手算夹具）", () => {
    const { audit } = buildSmallRun();
    const html = renderToStaticMarkup(
      <EventInspector
        status="ready"
        group={audit.group}
        trajectoryIndex={audit.trajectoryIndex}
        trajectoriesPerGroup={64}
        model={{ id: "dimer", totalUnits: 4, forwardRate: 0.02, reverseRate: 0.2 }}
        horizon={1}
        trace={audit}
        verification={null}
      />,
    );
    expect(html).toContain("初始化抽样");
    expect(html).toContain(String(audit.initial.trajectorySeed));
    expect(
      html.includes("视界终止") || html.includes("吸收态终止"),
    ).toBe(true);
  });
});
