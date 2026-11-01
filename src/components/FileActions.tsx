// P006 T012 — 文件交互（项目书 §9.2、§12）。
//
// 职责边界：只做导入导出按钮与文件内容组装，不改 core/io/verify
// 的实现（只 import 它们已有的导出函数）、不改全局 CSS、不碰
// App 状态。数据全部来自调用方注入的 scenario/result/trace，
// 本组件不生成随机数据、不重算概率。
// - 导入：实验文件文本经 io 的 parseExperimentFile 校验；非法
//   导入只显示错误，绝不调用 onImportScenario，因此调用方保留
//   的当前实验原样不动（“保留当前实验”由“失败不回调”保证，
//   不是事后恢复）。
// - 导出：结果导出仅当 status 为 ready、有结果且非开发 mock 时
//   可用；STALE/空态/计算中/错误态/mock 结果一律禁用导出按钮，
//   mock 结果不得导出为成功实验。数值用 String() 全精度输出，
//   显示精度截断不影响导出（见 EventInspector 的 data-full 与
//   本文件的 CSV/SVG 生成器——它们直接用 io 的全精度导出）。
// - 实际落盘由调用方通过 onExportFile 回调完成（浏览器里接
//   Blob 下载）；本组件只决定“导出什么、叫什么名、内容是
//   什么”，不在 node 测试环境里假装写盘。

import { useState } from "react";
import {
  exportDistributionCsv,
  exportMeansCsv,
} from "../io/csv";
import {
  parseExperimentFile,
  serializeExperimentFile,
} from "../io/scenario";
import {
  exportDistributionSvg,
  exportMeansSvg,
  svgFileName,
} from "../io/svg";
import { parseEvidence } from "../io/evidence";
import type {
  AuditTrace,
  EvidenceV1,
  RunResult,
  ScenarioV1,
} from "../domain/types";
import styles from "./FileActions.module.css";

export type FileActionsStatus = "empty" | "running" | "ready" | "error";

export interface ExportFile {
  name: string;
  content: string;
}

export interface FileActionsProps {
  status: FileActionsStatus;
  /** true 表示当前 COMPLETE 来自开发 mock，不可导出为成功实验。 */
  isMockResult: boolean;
  scenario: ScenarioV1 | null;
  result: RunResult | null;
  trace: AuditTrace | null;
  /** SVG 分布图的时间游标（观测点索引）。 */
  timeIndex: number;
  errorMessage?: string | null;
  /** 导入成功时调用；导入失败时绝不调用，当前实验因此保留。 */
  onImportScenario?: (scenario: ScenarioV1) => void;
  /** 导出文件时调用；调用方负责落盘（浏览器 Blob 下载等）。 */
  onExportFile?: (file: ExportFile) => void;
  /**
   * 导出证据 JSON 时调用（GPT 终审 Round 1 修复，项目书 §12.2）：
   * 调用方通过 Worker 重放取审计轨迹并序列化证据，返回可下载文件。
   * 未接通时证据导出按钮不渲染。
   */
  onExportEvidence?: () => Promise<ExportFile>;
  /**
   * 复验证据时调用：调用方做 SHA-256 检查、Worker 完整重算、
   * compareEvidence 与 verifyAudit，返回结论。本组件不持有重算
   * 结果，复验通过与否一律不替换当前实验（只读复验）。
   */
  onVerifyEvidence?: (
    evidence: EvidenceV1,
  ) => Promise<EvidenceVerificationOutcome>;
  /** 取消正在进行的复验时调用（调用方 terminate Worker，待定 Promise 以取消拒绝）。 */
  onCancelVerification?: () => void;
}

/**
 * 证据复验结论（调用方 App 组装，见 src/app/App.tsx）：
 * valid 为真当且仅当哈希一致、完整重算一致、重算审计轨迹复验
 * 通过、且导入审计轨迹本身的独立复验通过。
 */
export interface EvidenceVerificationOutcome {
  valid: boolean;
  hashMatches: boolean;
  auditValid: boolean;
  auditCheckedEvents: number;
  differences: string[];
}

/** 纯函数：解析证据文本；失败时返回错误，不返回证据对象。 */
export function parseEvidenceText(
  text: string,
): { ok: true; evidence: EvidenceV1 } | { ok: false; error: string } {
  try {
    return { ok: true, evidence: parseEvidence(text) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "证据文件无效",
    };
  }
}

export type ImportParseResult =
  | { ok: true; scenario: ScenarioV1 }
  | { ok: false; error: string };

/** 纯函数：解析导入文本；失败时返回错误，不返回任何场景。 */
export function parseImportText(text: string): ImportParseResult {
  try {
    return { ok: true, scenario: parseExperimentFile(text) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "导入文件无效",
    };
  }
}

/** 审计事件表 CSV：全精度 String() 输出，不做舍入。 */
export function buildAuditCsv(trace: AuditTrace): string {
  const lines = [
    "index,time_before,state_before,birth,death,total_rate,u_waiting,u_choice,waiting_time,reaction,time_after,state_after",
  ];
  for (const event of trace.events) {
    lines.push(
      [
        String(event.index),
        String(event.timeBefore),
        String(event.stateBefore),
        String(event.birth),
        String(event.death),
        String(event.totalRate),
        String(event.uWaiting),
        String(event.uChoice),
        String(event.waitingTime),
        event.reaction,
        String(event.timeAfter),
        String(event.stateAfter),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 组装全部可导出文件。result 为 null 时返回空数组（调用方仍需
 * 按 canExport 禁用按钮，本函数不代替门禁）。
 */
export function buildExportFiles(
  result: RunResult,
  trace: AuditTrace | null,
  timeIndex: number,
): ExportFile[] {
  const files: ExportFile[] = [
    {
      name: "noisescope-experiment.json",
      content: serializeExperimentFile(result.scenario),
    },
    { name: "noisescope-distribution.csv", content: exportDistributionCsv(result) },
    { name: "noisescope-means.csv", content: exportMeansCsv(result) },
    {
      name: svgFileName("distribution", "P", timeIndex),
      content: exportDistributionSvg(result, "P", timeIndex),
    },
    {
      name: svgFileName("distribution", "Q", timeIndex),
      content: exportDistributionSvg(result, "Q", timeIndex),
    },
    { name: "noisescope-means.svg", content: exportMeansSvg(result) },
  ];
  if (trace !== null) {
    files.push({
      name: `noisescope-audit-${trace.group}-${trace.trajectoryIndex}.csv`,
      content: buildAuditCsv(trace),
    });
  }
  return files;
}

/** 导出门禁：只有真实完成结果可导出；mock、空态、计算中、错误态均不可。 */
export function canExportFiles(
  status: FileActionsStatus,
  isMockResult: boolean,
  result: RunResult | null,
): boolean {
  return status === "ready" && !isMockResult && result !== null;
}

export function FileActions(props: FileActionsProps) {
  const {
    status,
    isMockResult,
    scenario,
    result,
    trace,
    timeIndex,
    errorMessage,
    onImportScenario,
    onExportFile,
    onExportEvidence,
    onVerifyEvidence,
    onCancelVerification,
  } = props;
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  // 证据导出/复验的本地状态（不碰 App 状态；复验只读，永不替换当前实验）。
  const [evidenceText, setEvidenceText] = useState("");
  const [evidenceExporting, setEvidenceExporting] = useState(false);
  const [evidenceExportError, setEvidenceExportError] = useState<string | null>(null);
  const [evidenceExportNotice, setEvidenceExportNotice] = useState<string | null>(null);
  const [evidenceVerifying, setEvidenceVerifying] = useState(false);
  const [evidenceResult, setEvidenceResult] = useState<
    | { kind: "passed"; outcome: EvidenceVerificationOutcome }
    | { kind: "failed"; outcome: EvidenceVerificationOutcome }
    | { kind: "parseError"; error: string }
    | { kind: "cancelled" }
    | null
  >(null);

  const canExport = canExportFiles(status, isMockResult, result);
  const exportFiles =
    result !== null ? buildExportFiles(result, trace, timeIndex) : [];

  const handleImportText = () => {
    const parsed = parseImportText(importText);
    if (!parsed.ok) {
      // 失败不调用 onImportScenario：调用方保留当前实验。
      setImportError(parsed.error);
      setImportNotice(null);
      return;
    }
    setImportError(null);
    setImportNotice(`已导入实验：${parsed.scenario.title}`);
    onImportScenario?.(parsed.scenario);
  };

  const handleExportEvidence = () => {
    if (onExportEvidence === undefined || evidenceExporting) return;
    setEvidenceExporting(true);
    setEvidenceExportError(null);
    setEvidenceExportNotice(null);
    void onExportEvidence()
      .then((file) => {
        onExportFile?.(file);
        setEvidenceExportNotice(`证据 JSON 已导出：${file.name}`);
      })
      .catch((error: unknown) => {
        setEvidenceExportError(
          error instanceof Error ? error.message : "证据导出失败",
        );
      })
      .finally(() => setEvidenceExporting(false));
  };

  /** 证据复验入口：解析 → 调用方完整重算 → 结论；任何失败都不回调、不替换当前实验。 */
  const handleVerifyEvidenceText = (text: string) => {
    const parsed = parseEvidenceText(text);
    if (!parsed.ok) {
      setEvidenceResult({ kind: "parseError", error: parsed.error });
      return;
    }
    if (onVerifyEvidence === undefined) {
      setEvidenceResult({
        kind: "parseError",
        error: "当前页面未接通证据复验通道，无法复验",
      });
      return;
    }
    setEvidenceVerifying(true);
    setEvidenceResult(null);
    void onVerifyEvidence(parsed.evidence)
      .then((outcome) => {
        setEvidenceResult(
          outcome.valid
            ? { kind: "passed", outcome }
            : { kind: "failed", outcome },
        );
      })
      .catch((error: unknown) => {
        // 取消复验与失败严格区分：取消是用户主动中断，不是证据造假。
        if (
          error instanceof Error &&
          (error.name === "CancelledError" || error.message === "cancelled")
        ) {
          setEvidenceResult({ kind: "cancelled" });
        } else {
          setEvidenceResult({
            kind: "failed",
            outcome: {
              valid: false,
              hashMatches: false,
              auditValid: false,
              auditCheckedEvents: 0,
              differences: [
                error instanceof Error ? error.message : "复验失败",
              ],
            },
          });
        }
      })
      .finally(() => setEvidenceVerifying(false));
  };

  const handleCancelVerification = () => {
    onCancelVerification?.();
    // 取消结果由 onVerifyEvidence 的 CancelledError 回调落定；
    // 若调用方未接通取消，仍先显示取消，避免按钮卡死在复验中。
    if (onCancelVerification === undefined) {
      setEvidenceVerifying(false);
      setEvidenceResult({ kind: "cancelled" });
    }
  };

  return (
    <section className={styles.stage} aria-label="文件交互">
      <h2 className={styles.title}>导入与导出</h2>

      <section className={styles.importSection} aria-label="导入实验">
        <h3 className={styles.sectionTitle}>导入实验</h3>
        <p className={styles.note}>
          导入文件为实验 JSON（§12.1，根对象就是 ScenarioV1）。
          非法导入只显示错误，不替换当前实验。
        </p>
        <label>
          粘贴实验文件文本
          <textarea
            className={styles.textarea}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder="粘贴 .noisescope.json 文本"
          />
        </label>
        <div>
          <label className={styles.fileLabel}>
            选择实验文件
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file === undefined) return;
                void file.text().then((text) => {
                  const parsed = parseImportText(text);
                  if (!parsed.ok) {
                    setImportError(parsed.error);
                    setImportNotice(null);
                    return;
                  }
                  setImportError(null);
                  setImportNotice(`已导入实验：${parsed.scenario.title}`);
                  onImportScenario?.(parsed.scenario);
                });
              }}
            />
          </label>
          <button type="button" onClick={handleImportText}>
            导入粘贴的实验文本
          </button>
        </div>
        {importError !== null && (
          <div className={styles.errorAlert} role="alert">
            导入失败，当前实验已保留：{importError}
          </div>
        )}
        {importNotice !== null && (
          <p className={styles.notice} role="status">
            {importNotice}
          </p>
        )}
        <p className={styles.note}>
          当前实验：
          {scenario !== null ? scenario.title : "暂无实验"}
        </p>
      </section>

      <section className={styles.exportSection} aria-label="导出">
        <h3 className={styles.sectionTitle}>导出</h3>
        {status === "error" && (
          <div className={styles.errorAlert} role="alert">
            导出不可用：{errorMessage ?? "未知错误"}
          </div>
        )}
        {!canExport && status !== "error" && (
          <p className={styles.statusNote}>
            {isMockResult
              ? "开发 mock 结果不可导出为成功实验。"
              : "暂无可导出结果：运行实验并得到真实完成结果后，此处可导出。"}
          </p>
        )}
        {canExport && (
          <>
            <p className={styles.note}>
              导出数值不截断：CSV/SVG 均用全精度数值生成，与显示精度无关。
            </p>
            <ul className={styles.fileList}>
              {exportFiles.map((file) => (
                <li key={file.name}>
                  <button
                    type="button"
                    onClick={() => onExportFile?.(file)}
                    data-export-name={file.name}
                  >
                    保存 {file.name}
                  </button>
                </li>
              ))}
            </ul>
            {onExportEvidence !== undefined && (
              <div>
                <p className={styles.note}>
                  证据 JSON（§12.2）：含场景、结果 payload、审计轨迹与
                  payload SHA-256；导出门禁与上方导出一致（仅真实完成
                  结果可导出）。
                </p>
                <button
                  type="button"
                  onClick={handleExportEvidence}
                  disabled={evidenceExporting}
                  data-export-evidence
                >
                  {evidenceExporting ? "正在导出证据…" : "保存 noisescope-evidence.json"}
                </button>
                {evidenceExportError !== null && (
                  <div className={styles.errorAlert} role="alert">
                    证据导出失败：{evidenceExportError}
                  </div>
                )}
                {evidenceExportNotice !== null && (
                  <p className={styles.notice} role="status">
                    {evidenceExportNotice}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <section className={styles.importSection} aria-label="证据复验">
        <h3 className={styles.sectionTitle}>证据复验</h3>
        <p className={styles.note}>
          导入证据 JSON（§12.2）后做 SHA-256 检查、Worker 完整重算与
          compareEvidence、审计轨迹 verifyAudit；三者全部通过才算
          复验通过。复验是只读的：通过与否一律不替换当前实验，
          失败时当前实验已保留；如需使用该证据的场景，请另行导入
          实验 JSON。
        </p>
        <label>
          粘贴证据文件文本
          <textarea
            className={styles.textarea}
            value={evidenceText}
            onChange={(event) => setEvidenceText(event.target.value)}
            placeholder="粘贴 noisescope-evidence.json 文本"
          />
        </label>
        <div>
          <label className={styles.fileLabel}>
            选择证据文件
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file === undefined) return;
                void file.text().then((text) => {
                  setEvidenceText(text);
                  handleVerifyEvidenceText(text);
                });
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => handleVerifyEvidenceText(evidenceText)}
            disabled={evidenceVerifying}
          >
            {evidenceVerifying ? "正在复验…" : "导入并复验证据"}
          </button>
          {evidenceVerifying && (
            <button type="button" onClick={handleCancelVerification}>
              取消复验
            </button>
          )}
        </div>
        {evidenceVerifying && (
          <p className={styles.notice} role="status">
            正在复验：完整重算进行中，当前实验不受影响。
          </p>
        )}
        {evidenceResult !== null && evidenceResult.kind === "passed" && (
          <p className={styles.notice} role="status">
            证据复验通过：哈希一致，完整重算一致，审计轨迹已核对{" "}
            {evidenceResult.outcome.auditCheckedEvents} 个事件；
            当前实验未被替换。
          </p>
        )}
        {evidenceResult !== null && evidenceResult.kind === "failed" && (
          <div className={styles.errorAlert} role="alert">
            证据复验失败，当前实验已保留：
            {evidenceResult.outcome.differences.slice(0, 10).join("；") ||
              "复验未通过"}
          </div>
        )}
        {evidenceResult !== null && evidenceResult.kind === "parseError" && (
          <div className={styles.errorAlert} role="alert">
            证据解析失败，当前实验已保留：{evidenceResult.error}
          </div>
        )}
        {evidenceResult !== null && evidenceResult.kind === "cancelled" && (
          <p className={styles.notice} role="status">
            复验已取消，当前实验已保留。
          </p>
        )}
      </section>
    </section>
  );
}
