// P006 T012 — 文件交互测试（项目书 §9.2、§12）。
//
// 测试环境是 node（无 jsdom），用 renderToStaticMarkup 断言静态
// 标记；文件选择/点击落盘只断言按钮与门禁呈现，真实浏览器
// 落盘属 T013/T014 验收。导入与导出内容用纯函数断言，不靠
// 点击模拟：失败不回调的保证在组件注释与本测试的纯函数层
// 验证（parseImportText 失败时不返回场景）。

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FileActions,
  buildAuditCsv,
  buildExportFiles,
  canExportFiles,
  parseEvidenceText,
  parseImportText,
} from "../../src/components/FileActions";
import { serializeExperimentFile } from "../../src/io/scenario";
import { buildSmallRun, smallScenario } from "../io/buildRun";

function renderReady(extra: Record<string, unknown> = {}) {
  const { result, audit } = buildSmallRun();
  return {
    result,
    audit,
    html: renderToStaticMarkup(
      <FileActions
        status="ready"
        isMockResult={false}
        scenario={result.scenario}
        result={result}
        trace={audit}
        timeIndex={0}
        {...extra}
      />,
    ),
  };
}

describe("FileActions", () => {
  it("合法实验文本可解析，非法文本只返回错误、不返回场景", () => {
    const good = parseImportText(serializeExperimentFile(smallScenario()));
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.scenario.projectId).toBe("P006");
      expect(good.scenario.title).toBe("T007 最小证据");
    }
    const bad = parseImportText('{"schemaVersion": 99}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.length).toBeGreaterThan(0);
    }
    // 未知字段同样拒绝：失败时调用方收不到新场景，当前实验保留。
    const parsed = JSON.parse(
      serializeExperimentFile(smallScenario()),
    ) as Record<string, unknown>;
    parsed["extraField"] = 1;
    const unknown = parseImportText(JSON.stringify(parsed));
    expect(unknown.ok).toBe(false);
  });

  it("导出门禁：只有真实完成结果可导出，mock/空态/计算中均不可", () => {
    const { result } = buildSmallRun();
    expect(canExportFiles("ready", false, result)).toBe(true);
    expect(canExportFiles("ready", true, result)).toBe(false);
    expect(canExportFiles("empty", false, result)).toBe(false);
    expect(canExportFiles("running", false, result)).toBe(false);
    expect(canExportFiles("ready", false, null)).toBe(false);
  });

  it("导出文件清单含实验 JSON、分布/均值 CSV、分布 SVG、均值 SVG、审计 CSV", () => {
    const { result, audit } = buildSmallRun();
    const files = buildExportFiles(result, audit, 0);
    const names = files.map((file) => file.name);
    expect(names).toContain("noisescope-experiment.json");
    expect(names).toContain("noisescope-distribution.csv");
    expect(names).toContain("noisescope-means.csv");
    expect(names).toContain("noisescope-distribution-P-t000.svg");
    expect(names).toContain("noisescope-distribution-Q-t000.svg");
    expect(names).toContain("noisescope-means.svg");
    expect(names).toContain(
      `noisescope-audit-${audit.group}-${audit.trajectoryIndex}.csv`,
    );
    const distribution = files.find(
      (file) => file.name === "noisescope-distribution.csv",
    )!;
    expect(distribution.content).toContain(
      "group,time,state_b,cme_probability,ssa_count,sample_count,ssa_probability",
    );
    const experiment = files.find(
      (file) => file.name === "noisescope-experiment.json",
    )!;
    // 序列化格式（缩进）由 io 决定，测试只断言可重新解析且身份一致。
    const reparsed = parseImportText(experiment.content);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.scenario.projectId).toBe("P006");
    }
  });

  it("审计 CSV 全精度输出，不做舍入", () => {
    const { audit } = buildSmallRun();
    const csv = buildAuditCsv(audit);
    expect(csv).toContain(
      "index,time_before,state_before,birth,death,total_rate,u_waiting,u_choice,waiting_time,reaction,time_after,state_after",
    );
    if (audit.events.length > 0) {
      const first = audit.events[0]!;
      expect(csv).toContain(String(first.uWaiting));
      expect(csv).toContain(String(first.timeAfter));
    }
  });

  it("真实完成结果渲染全部保存按钮；mock 结果只显示不可导出", () => {
    const { html } = renderReady();
    expect(html).toContain("保存 noisescope-distribution.csv");
    expect(html).toContain("保存 noisescope-means.svg");
    const mock = renderReady({ isMockResult: true });
    expect(mock.html).toContain("开发 mock 结果不可导出为成功实验");
    expect(mock.html).not.toContain("保存 noisescope-distribution.csv");
  });

  it("证据区：接通导出回调时渲染证据导出按钮，未接通时不渲染", async () => {
    const { result, audit } = buildSmallRun();
    const withEvidence = renderToStaticMarkup(
      <FileActions
        status="ready"
        isMockResult={false}
        scenario={result.scenario}
        result={result}
        trace={audit}
        timeIndex={0}
        onExportEvidence={async () => ({
          name: "noisescope-evidence.json",
          content: "{}",
        })}
      />,
    );
    expect(withEvidence).toContain("保存 noisescope-evidence.json");
    expect(withEvidence).toContain("证据复验");
    const { html } = renderReady();
    expect(html).not.toContain("保存 noisescope-evidence.json");
    expect(html).toContain("证据复验");
  });

  it("证据解析：非法证据文本只返回错误，不返回证据对象", async () => {
    const { serializeEvidence } = await import("../../src/io/evidence");
    const { testMeta } = await import("../io/buildRun");
    const { result, audit } = buildSmallRun();
    const text = await serializeEvidence(result, audit, testMeta());
    const good = parseEvidenceText(text);
    expect(good.ok).toBe(true);
    const bad = parseEvidenceText('{"schemaVersion": 99}');
    expect(bad.ok).toBe(false);
  });

  it("空态不渲染保存按钮，导入区始终呈现且提示当前实验", () => {
    const html = renderToStaticMarkup(
      <FileActions
        status="empty"
        isMockResult={false}
        scenario={smallScenario()}
        result={null}
        trace={null}
        timeIndex={0}
      />,
    );
    expect(html).toContain("暂无可导出结果");
    expect(html).not.toContain("保存 noisescope-distribution.csv");
    expect(html).toContain("导入实验");
    expect(html).toContain("T007 最小证据");
  });
});
