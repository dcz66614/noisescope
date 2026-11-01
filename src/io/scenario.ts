// P006 T007 — 实验文件格式入口（项目书 §12.1）
//
// 根对象就是 ScenarioV1；校验逻辑本身在 domain/validate.ts（T002），
// 本文件是 io 层的唯一文件格式入口，避免校验规则出现第二份实现。
// - .noisescope.json：UTF-8，最大 32 KiB；拒绝未知 schemaVersion、
//   非有限数、错误数组长度及额外字段（包括可执行语义的未知字段，
//   JSON 本身不承载函数，未知字段一律拒绝）。
// - 标题只当纯文本处理：原样保存，不做 HTML 转义以外的任何解释，
//   调用方展示时仍须按纯文本转义，绝不能把标题当 HTML/脚本执行。

export { parseScenario, serializeScenario } from "../domain/validate";
import {
  parseScenario,
  serializeScenario,
} from "../domain/validate";
import type { ScenarioV1 } from "../domain/types";

/**
 * 解析实验文件文本（§12.1）。超过 32 KiB 抛 FILE_TOO_LARGE，
 * JSON 解析失败或校验失败按 validateScenario 的 code 抛出。
 * 返回全新对象，不修改任何现有实验。
 */
export function parseExperimentFile(text: string): ScenarioV1 {
  return parseScenario(text);
}

/** 序列化实验文件文本（§12.1）：先校验，再输出根对象 JSON。 */
export function serializeExperimentFile(scenario: ScenarioV1): string {
  return serializeScenario(scenario);
}
