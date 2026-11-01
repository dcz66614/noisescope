// P006 GPT 终审 Round 1 修复 — 证据流（项目书 §12.2）。
//
// 覆盖生产 UI 入口背后的同一函数链：序列化 → 解析 → SHA-256
// 检查 → Worker 完整重算（runScenario）→ compareEvidence →
// 审计轨迹 verifyAudit。篡改用例证明三层检查各自独立：
// 参考均值篡改只破哈希与重算比较（解析不重算参考）；
// 审计 sampledB 篡改只破审计复验与 sampledB 对照。
// 预算用例证明两层预算：每条轨迹 20_000、整次运行累计
// DEFAULT_EVENT_BUDGET（Worker 共享计数器与 simulateSampleGroup
// 累计计数均执行）。

import { describe, expect, it } from "vitest";
import {
  parseEvidence,
  serializeEvidence,
  verifyEvidenceHash,
  verifyImportedEvidence,
} from "../../src/io/evidence";
import { verifyAudit } from "../../src/verify/replay";
import {
  handleRequest,
  replayTrajectory,
  runScenario,
} from "../../src/workers/simulation.worker";
import {
  simulateSampleGroup,
  simulateTrajectory,
  SsaBudgetError,
} from "../../src/core/ssa";
import { createObservationTimes } from "../../src/core/ssa";
import { buildSmallRun, testMeta } from "../io/buildRun";

describe("证据流往返", () => {
  it("正常往返：哈希一致、完整重算一致、审计复验通过", async () => {
    const { result, audit } = buildSmallRun();
    const text = await serializeEvidence(result, audit, testMeta());
    const evidence = parseEvidence(text);
    expect(await verifyEvidenceHash(evidence)).toBe(true);
    const rerun = runScenario(evidence.scenario, 99);
    const rerunAudit = replayTrajectory(
      evidence.scenario,
      evidence.audit.group,
      evidence.audit.trajectoryIndex,
    );
    const auditVerification = verifyAudit(evidence.scenario, rerunAudit);
    expect(auditVerification.valid).toBe(true);
    const imported = await verifyImportedEvidence(
      evidence,
      rerun,
      rerunAudit,
    );
    expect(imported.valid).toBe(true);
    expect(imported.hashMatches).toBe(true);
    expect(imported.differences).toEqual([]);
  });

  it("篡改参考均值：解析通过、哈希失败、重算比较失败", async () => {
    const { result, audit } = buildSmallRun();
    const text = await serializeEvidence(result, audit, testMeta());
    const parsed = JSON.parse(text) as {
      payload: { reference: { P: { meanB: number[] } } };
    };
    parsed.payload.reference.P.meanB[0] =
      parsed.payload.reference.P.meanB[0]! + 0.1;
    const evidence = parseEvidence(JSON.stringify(parsed));
    expect(await verifyEvidenceHash(evidence)).toBe(false);
    const rerun = runScenario(evidence.scenario, 99);
    const rerunAudit = replayTrajectory(
      evidence.scenario,
      evidence.audit.group,
      evidence.audit.trajectoryIndex,
    );
    const imported = await verifyImportedEvidence(
      evidence,
      rerun,
      rerunAudit,
    );
    expect(imported.valid).toBe(false);
    expect(imported.hashMatches).toBe(false);
  });

  it("篡改审计 sampledB：审计复验失败、sampledB 对照失败", async () => {
    const { result, audit } = buildSmallRun();
    const text = await serializeEvidence(result, audit, testMeta());
    const parsed = JSON.parse(text) as {
      audit: { sampledB: number[] };
    };
    parsed.audit.sampledB[10] =
      parsed.audit.sampledB[10]! === 0 ? 1 : 0;
    const evidence = parseEvidence(JSON.stringify(parsed));
    const auditVerification = verifyAudit(evidence.scenario, evidence.audit);
    expect(auditVerification.valid).toBe(false);
    const rerun = runScenario(evidence.scenario, 99);
    const rerunAudit = replayTrajectory(
      evidence.scenario,
      evidence.audit.group,
      evidence.audit.trajectoryIndex,
    );
    const imported = await verifyImportedEvidence(
      evidence,
      rerun,
      rerunAudit,
    );
    expect(imported.valid).toBe(false);
    expect(
      imported.differences.some((d) => d.startsWith("audit.sampledB[10]")),
    ).toBe(true);
  });

  it("自带 valid 字段的证据文件直接拒绝，不静默剥离", async () => {
    const { result, audit } = buildSmallRun();
    const text = await serializeEvidence(result, audit, testMeta());
    const parsed = JSON.parse(text) as Record<string, unknown>;
    parsed["valid"] = true;
    expect(() => parseEvidence(JSON.stringify(parsed))).toThrow();
  });
});

describe("导入审计事件字段篡改（Round 2 B1 回归）", () => {
  async function tamperedEvidence(
    mutate: (audit: {
      events: { uWaiting: number; uChoice: number }[];
      terminal: { uWaiting: number; candidateTime: number };
    }) => void,
  ) {
    const { result, audit } = buildSmallRun();
    expect(audit.events.length).toBeGreaterThan(0);
    const text = await serializeEvidence(result, audit, testMeta());
    const parsed = JSON.parse(text) as { audit: unknown };
    mutate(
      parsed.audit as {
        events: { uWaiting: number; uChoice: number }[];
        terminal: { uWaiting: number; candidateTime: number };
      },
    );
    return parseEvidence(JSON.stringify(parsed));
  }

  async function importedCheck(evidence: ReturnType<typeof parseEvidence>) {
    const rerun = runScenario(evidence.scenario, 99);
    const rerunAudit = replayTrajectory(
      evidence.scenario,
      evidence.audit.group,
      evidence.audit.trajectoryIndex,
    );
    return {
      importedAudit: verifyAudit(evidence.scenario, evidence.audit),
      imported: await verifyImportedEvidence(evidence, rerun, rerunAudit),
    };
  }

  it("篡改 events[0].uWaiting（sampledB 不动）：导入审计复验与导入比较均失败", async () => {
    const evidence = await tamperedEvidence((audit) => {
      audit.events[0]!.uWaiting += 0.1;
    });
    const { importedAudit, imported } = await importedCheck(evidence);
    expect(importedAudit.valid).toBe(false);
    expect(
      importedAudit.errors.some((e) => e.startsWith("events[0].uWaiting")),
    ).toBe(true);
    expect(imported.valid).toBe(false);
    expect(
      imported.differences.some((d) => d.includes("events[0].uWaiting")),
    ).toBe(true);
  });

  it("篡改 events[0].uChoice（sampledB 不动）：导入审计复验与导入比较均失败", async () => {
    const evidence = await tamperedEvidence((audit) => {
      audit.events[0]!.uChoice += 0.1;
    });
    const { importedAudit, imported } = await importedCheck(evidence);
    expect(importedAudit.valid).toBe(false);
    expect(
      importedAudit.errors.some((e) => e.startsWith("events[0].uChoice")),
    ).toBe(true);
    expect(imported.valid).toBe(false);
    expect(
      imported.differences.some((d) => d.includes("events[0].uChoice")),
    ).toBe(true);
  });

  it("篡改 terminal.uWaiting（HORIZON 终止候选，sampledB 不动）：导入审计复验与导入比较均失败", async () => {
    const evidence = await tamperedEvidence((audit) => {
      audit.terminal.uWaiting += 0.1;
    });
    const { importedAudit, imported } = await importedCheck(evidence);
    expect(importedAudit.valid).toBe(false);
    expect(
      importedAudit.errors.some((e) => e.startsWith("terminal.uWaiting")),
    ).toBe(true);
    expect(imported.valid).toBe(false);
    expect(
      imported.differences.some((d) => d.includes("terminal.uWaiting")),
    ).toBe(true);
  });

  it("篡改 terminal.candidateTime（sampledB 不动）：导入审计复验与导入比较均失败", async () => {
    const evidence = await tamperedEvidence((audit) => {
      audit.terminal.candidateTime += 0.5;
    });
    const { importedAudit, imported } = await importedCheck(evidence);
    expect(importedAudit.valid).toBe(false);
    expect(
      importedAudit.errors.some((e) => e.startsWith("terminal.candidateTime")),
    ).toBe(true);
    expect(imported.valid).toBe(false);
    expect(
      imported.differences.some((d) => d.includes("terminal.candidateTime")),
    ).toBe(true);
  });
});

describe("SSA 预算分层", () => {
  it("每条轨迹上限 20_000：极高速率下抛 SsaBudgetError", () => {
    const times = createObservationTimes(8, 101);
    expect(() =>
      simulateTrajectory({
        model: { id: "linear", totalUnits: 40, forwardRate: 1000, reverseRate: 1000 },
        initialPmf: Array.from({ length: 41 }, (_, j) => (j === 20 ? 1 : 0)),
        horizon: 8,
        observationTimes: times,
        baseSeed: 1,
        group: "P",
        trajectoryIndex: 0,
      }),
    ).toThrow(SsaBudgetError);
  });

  it("整组累计预算：simulateSampleGroup 超限抛 SsaBudgetError", () => {
    const times = createObservationTimes(8, 101);
    expect(() =>
      simulateSampleGroup({
        model: { id: "linear", totalUnits: 40, forwardRate: 1000, reverseRate: 1000 },
        initialPmf: Array.from({ length: 41 }, (_, j) => (j === 20 ? 1 : 0)),
        horizon: 8,
        observationTimes: times,
        trajectories: 2,
        baseSeed: 1,
        group: "P",
        totalEventBudget: 100,
      }),
    ).toThrow(SsaBudgetError);
  });

  it("Worker 整次运行累计预算：runScenario 超限以 ERROR 计，不发部分结果", () => {
    const { result } = buildSmallRun();
    // 小场景固定种子下总事件数确定大于 5，故 totalEventBudget=5
    // 必然超限；用 handleRequest 层验证错误以 ERROR 响应返回，
    // 而非 RESULT。
    const responses = handleRequest(
      { type: "RUN", runId: 7, scenario: result.scenario },
      { totalEventBudget: 5 },
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]!.type).toBe("ERROR");
  });
});
