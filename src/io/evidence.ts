// P006 T007 — 证据文件格式（项目书 §12.2）
//
// 契约要点（不要把本文件宣称为 RFC 8785 完整实现或数字签名）：
// - 哈希只覆盖 payload：SHA-256(canonicalJson(payload) 的 UTF-8 字节)。
//   canonicalJson 递归按对象键 Unicode 码点序排序，数组顺序保留，
//   数值用 JSON.stringify 的有限数格式，-0 规范成 0，拒绝
//   undefined / NaN / Infinity / bigint / 函数 / symbol。
//   哈希一致只说明“结果 payload 哈希一致”，不证明整个文件真实；
//   scenario、audit、meta 另由结构检查、随机流审计和完整重算核查。
// - meta 只用于追溯，不参与科学相等判断。
// - 导入文件自带的 valid / PASS / passed 字段一律不接受（直接拒绝，
//   不静默剥离后放行）。
// - 诊断预算（独立检查，耗尽仍为 BUDGET_EXCEEDED，不混作篡改）：
//   cumulativeTailBound ≤ 1e-12，|massDefect| ≤ 1e-10，
//   minProbability ≥ -1e-14；termsUsed 不作为跨环境相等判据。
// - 科学比较：times 与科学浮点数组最大绝对差 ≤ 1e-9；
//   stateCount、completed、全部 counts 严格相等；
//   哈希、审计、参考数组、样本计数差异统一 EVIDENCE_MISMATCH。

import {
  stateCountForModel,
  type AuditTrace,
  type EvidenceComparison,
  type EvidenceMetaV1,
  type EvidencePayloadV1,
  type EvidenceReferenceGroup,
  type EvidenceSampleGroup,
  type EvidenceV1,
  type GroupId,
  type RunResult,
  type ScenarioV1,
} from "../domain/types";
import { validateScenario } from "../domain/validate";

export const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024; // §12.2：8 MiB
export const EVIDENCE_TOLERANCE = 1e-9;
export const TAIL_BOUND_BUDGET = 1e-12;
export const MASS_DEFECT_BUDGET = 1e-10;
export const MIN_PROBABILITY_FLOOR = -1e-14;

export class EvidenceError extends Error {
  readonly code: string;
  readonly field: string;

  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = "EvidenceError";
    this.code = code;
    this.field = field;
  }
}

function fail(code: string, field: string, message: string): never {
  throw new EvidenceError(code, field, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 按 Unicode 码点比较两个字符串（不用默认 UTF-16 码元序）。 */
function compareCodePoints(a: string, b: string): number {
  const aPoints = Array.from(a);
  const bPoints = Array.from(b);
  const length = Math.min(aPoints.length, bPoints.length);
  for (let i = 0; i < length; i += 1) {
    const diff =
      aPoints[i]!.codePointAt(0)! - bPoints[i]!.codePointAt(0)!;
    if (diff !== 0) {
      return diff;
    }
  }
  return aPoints.length - bPoints.length;
}

/**
 * canonicalJson：递归按键码点序排序；数组顺序保留；-0 规范成 0；
 * 拒绝 undefined / NaN / Infinity / bigint / 函数 / symbol。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalJson rejects non-finite numbers");
    }
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(
    `canonicalJson rejects values of type ${typeof value}`,
  );
}

/** SHA-256（UTF-8 输入），返回 64 位小写十六进制。走 WebCrypto，浏览器与 Node 24 均可用。 */
export async function sha256HexUtf8(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto subtle is unavailable in this environment");
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function payloadSha256(
  payload: EvidencePayloadV1,
): Promise<string> {
  return sha256HexUtf8(canonicalJson(payload));
}

/** 从完整 RunResult 抽取科学 payload；丢弃 previewB、事件总数、耗时等非科学字段。 */
export function evidencePayloadFromRunResult(
  result: RunResult,
): EvidencePayloadV1 {
  const reference = {} as Record<GroupId, EvidenceReferenceGroup>;
  const sample = {} as Record<GroupId, EvidenceSampleGroup>;
  for (const group of ["P", "Q"] as const) {
    const ref = result.reference[group];
    reference[group] = {
      pmf: Array.from(ref.pmf),
      meanB: Array.from(ref.meanB),
      varianceB: Array.from(ref.varianceB),
      meanA: Array.from(ref.meanA),
      varianceA: Array.from(ref.varianceA),
      meanBirthRate: Array.from(ref.meanBirthRate),
      meanDeathRate: Array.from(ref.meanDeathRate),
      exactDrift: Array.from(ref.exactDrift),
      closureDriftAtExactMean: Array.from(ref.closureDriftAtExactMean),
      driftCorrection: Array.from(ref.driftCorrection),
      closureMeanB: Array.from(ref.closureMeanB),
      numerical: ref.numerical.map((d) => ({ ...d })),
    };
    const sam = result.sample[group];
    sample[group] = {
      counts: Array.from(sam.counts),
      completed: sam.completed,
      meanB: Array.from(sam.meanB),
      varianceB: Array.from(sam.varianceB),
    };
  }
  return {
    stateCount: result.stateCount,
    times: Array.from(result.times),
    reference,
    sample,
  };
}

function validateMeta(meta: unknown): EvidenceMetaV1 {
  if (!isRecord(meta)) {
    fail("INVALID_SCHEMA", "meta", "meta must be an object");
  }
  if (typeof meta.createdAt !== "string" || Number.isNaN(Date.parse(meta.createdAt))) {
    fail("INVALID_SCHEMA", "meta.createdAt", "meta.createdAt must be an ISO 8601 string");
  }
  for (const field of ["displayTitle", "userAgent", "platform"] as const) {
    if (typeof meta[field] !== "string") {
      fail("INVALID_SCHEMA", `meta.${field}`, `meta.${field} must be a string`);
    }
  }
  if (!isRecord(meta.dependencyVersions)) {
    fail("INVALID_SCHEMA", "meta.dependencyVersions", "meta.dependencyVersions must be an object");
  }
  for (const [key, value] of Object.entries(meta.dependencyVersions)) {
    if (typeof value !== "string") {
      fail("INVALID_SCHEMA", `meta.dependencyVersions.${key}`, "dependency version values must be strings");
    }
  }
  if (!isFiniteNumber(meta.elapsedMs) || (meta.elapsedMs as number) < 0) {
    fail("INVALID_SCHEMA", "meta.elapsedMs", "meta.elapsedMs must be a finite non-negative number");
  }
  return meta as unknown as EvidenceMetaV1;
}

function validateAuditShape(audit: unknown): AuditTrace {
  if (!isRecord(audit)) {
    fail("INVALID_SCHEMA", "audit", "audit must be a single trace object, not an array");
  }
  if (audit.group !== "P" && audit.group !== "Q") {
    fail("INVALID_SCHEMA", "audit.group", "audit.group must be P or Q");
  }
  if (
    typeof audit.trajectoryIndex !== "number" ||
    !Number.isInteger(audit.trajectoryIndex) ||
    audit.trajectoryIndex < 0
  ) {
    fail("INVALID_SCHEMA", "audit.trajectoryIndex", "audit.trajectoryIndex must be a non-negative integer");
  }
  if (!Array.isArray(audit.sampledB) || audit.sampledB.length !== 101) {
    fail("INVALID_SCHEMA", "audit.sampledB", "audit.sampledB must have length 101");
  }
  if (!isRecord(audit.initial) || !Array.isArray(audit.events) || !isRecord(audit.terminal)) {
    fail("INVALID_SCHEMA", "audit", "audit must contain initial, events and terminal");
  }
  return audit as unknown as AuditTrace;
}

/**
 * 序列化证据（仅一个审计轨迹）。meta 由调用方提供环境追溯信息；
 * 本函数不把 meta、scenario、audit 纳入 payload 哈希。
 */
export async function serializeEvidence(
  result: RunResult,
  audit: AuditTrace,
  meta: EvidenceMetaV1,
): Promise<string> {
  if (result.status !== "COMPLETE") {
    fail("INVALID_SCHEMA", "result.status", "only a COMPLETE result may be serialized as evidence");
  }
  const validatedAudit = validateAuditShape(audit);
  const validatedMeta = validateMeta(meta);
  if (
    validatedAudit.trajectoryIndex >= result.scenario.trajectoriesPerGroup
  ) {
    fail("INVALID_SCHEMA", "audit.trajectoryIndex", "audit trajectoryIndex is out of range for the scenario");
  }
  const payload = evidencePayloadFromRunResult(result);
  const evidence: EvidenceV1 = {
    schemaVersion: 1,
    engineVersion: "1.0.0",
    scenario: validateScenario(result.scenario),
    payload,
    audit: validatedAudit,
    meta: validatedMeta,
    payloadSha256: await payloadSha256(payload),
  };
  return JSON.stringify(evidence, null, 2);
}

/** 由 counts 重算样本矩（总体方差，分母 M），与生产采样同一公式。 */
export function recomputeSampleMoments(
  counts: readonly number[],
  stateCount: number,
  completed: number,
): { meanB: number[]; varianceB: number[] } {
  const meanB: number[] = [];
  const varianceB: number[] = [];
  for (let t = 0; t < 101; t += 1) {
    let sum = 0;
    let sumSquares = 0;
    for (let j = 0; j < stateCount; j += 1) {
      const count = counts[t * stateCount + j]!;
      sum += j * count;
      sumSquares += j * j * count;
    }
    const mean = completed > 0 ? sum / completed : 0;
    meanB.push(mean);
    varianceB.push(
      completed > 0 ? Math.max(0, sumSquares / completed - mean * mean) : 0,
    );
  }
  return { meanB, varianceB };
}

function checkFloatArray(
  value: unknown,
  length: number,
  field: string,
): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    fail("INVALID_SCHEMA", field, `${field} must be an array of length ${length}`);
  }
  for (let i = 0; i < value.length; i += 1) {
    if (!isFiniteNumber(value[i])) {
      fail("INVALID_SCHEMA", `${field}[${i}]`, `${field}[${i}] must be a finite number`);
    }
  }
  return value as number[];
}

/**
 * 解析证据文本：只做结构、预算与矩重算检查，不验证哈希、不做完整重算。
 * 哈希与完整重算由 verifyEvidenceHash / verifyImportedEvidence 另行执行，
 * 调用方在全部通过前不得把解析结果提交为当前实验。
 */
export function parseEvidence(text: string): EvidenceV1 {
  if (typeof text !== "string") {
    fail("INVALID_SCHEMA", "", "evidence text must be a string");
  }
  if (new TextEncoder().encode(text).length > MAX_EVIDENCE_FILE_BYTES) {
    fail("FILE_TOO_LARGE", "", `evidence file must be at most ${MAX_EVIDENCE_FILE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("INVALID_SCHEMA", "", "evidence text is not valid JSON");
  }
  if (!isRecord(parsed)) {
    fail("INVALID_SCHEMA", "", "evidence must be an object");
  }
  // 导入文件自带的 PASS/valid 字段不接受：直接拒绝，不静默剥离。
  for (const banned of ["valid", "PASS", "passed"]) {
    if (banned in parsed) {
      fail("INVALID_SCHEMA", banned, `imported evidence must not carry a ${banned} field`);
    }
  }
  if (parsed.schemaVersion === undefined) {
    fail("INVALID_SCHEMA", "schemaVersion", "schemaVersion is required");
  }
  if (typeof parsed.schemaVersion !== "number" || !Number.isFinite(parsed.schemaVersion)) {
    fail("INVALID_SCHEMA", "schemaVersion", "schemaVersion must be a finite number");
  }
  if (parsed.schemaVersion !== 1) {
    fail("VERSION_UNSUPPORTED", "schemaVersion", `unsupported evidence schemaVersion: ${parsed.schemaVersion}`);
  }
  if (parsed.engineVersion !== "1.0.0") {
    fail("VERSION_UNSUPPORTED", "engineVersion", `unsupported engineVersion: ${String(parsed.engineVersion)}`);
  }
  let scenario: ScenarioV1;
  try {
    scenario = validateScenario(parsed.scenario);
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      throw error;
    }
    fail("INVALID_SCHEMA", "scenario", "scenario is invalid");
  }
  if (!isRecord(parsed.payload)) {
    fail("INVALID_SCHEMA", "payload", "payload must be an object");
  }
  const payload = parsed.payload;
  const stateCount = stateCountForModel(scenario.model);
  if (payload.stateCount !== stateCount) {
    fail("EVIDENCE_MISMATCH", "payload.stateCount", `payload.stateCount must be ${stateCount}, got ${String(payload.stateCount)}`);
  }
  const times = checkFloatArray(payload.times, 101, "payload.times");
  for (let i = 1; i < times.length; i += 1) {
    if (times[i]! < times[i - 1]!) {
      fail("INVALID_SCHEMA", "payload.times", "payload.times must be nondecreasing");
    }
  }
  if (!isRecord(payload.reference) || !isRecord(payload.sample)) {
    fail("INVALID_SCHEMA", "payload", "payload must contain reference and sample for both groups");
  }
  for (const group of ["P", "Q"] as const) {
    const ref = (payload.reference as Record<string, unknown>)[group];
    const sam = (payload.sample as Record<string, unknown>)[group];
    if (!isRecord(ref) || !isRecord(sam)) {
      fail("INVALID_SCHEMA", `payload.${group}`, `payload reference/sample for group ${group} must be objects`);
    }
    checkFloatArray(ref.pmf, 101 * stateCount, `payload.reference.${group}.pmf`);
    for (const field of [
      "meanB", "varianceB", "meanA", "varianceA",
      "meanBirthRate", "meanDeathRate", "exactDrift",
      "closureDriftAtExactMean", "driftCorrection", "closureMeanB",
    ] as const) {
      checkFloatArray(ref[field], 101, `payload.reference.${group}.${field}`);
    }
    if (!Array.isArray(ref.numerical) || ref.numerical.length !== 101) {
      fail("INVALID_SCHEMA", `payload.reference.${group}.numerical`, "numerical must be an array of length 101");
    }
    for (let t = 0; t < 101; t += 1) {
      const diag = (ref.numerical as unknown[])[t];
      if (!isRecord(diag)) {
        fail("INVALID_SCHEMA", `payload.reference.${group}.numerical[${t}]`, "diagnostic must be an object");
      }
      for (const field of ["cumulativeTailBound", "probabilityMass", "massDefect", "minProbability"] as const) {
        if (!isFiniteNumber(diag[field])) {
          fail("INVALID_SCHEMA", `payload.reference.${group}.numerical[${t}].${field}`, "diagnostic values must be finite numbers");
        }
      }
      if (!Number.isInteger(diag.termsUsed) || (diag.termsUsed as number) < 0) {
        fail("INVALID_SCHEMA", `payload.reference.${group}.numerical[${t}].termsUsed`, "termsUsed must be a non-negative integer");
      }
      // 诊断预算独立检查：耗尽仍为 BUDGET_EXCEEDED，不混作数据篡改。
      if ((diag.cumulativeTailBound as number) > TAIL_BOUND_BUDGET) {
        fail("BUDGET_EXCEEDED", `payload.reference.${group}.numerical[${t}].cumulativeTailBound`, "cumulative tail bound exceeds 1e-12");
      }
      if (Math.abs(diag.massDefect as number) > MASS_DEFECT_BUDGET) {
        fail("BUDGET_EXCEEDED", `payload.reference.${group}.numerical[${t}].massDefect`, "mass defect exceeds 1e-10");
      }
      if ((diag.minProbability as number) < MIN_PROBABILITY_FLOOR) {
        fail("BUDGET_EXCEEDED", `payload.reference.${group}.numerical[${t}].minProbability`, "min probability below -1e-14");
      }
    }
    if (!Array.isArray(sam.counts) || sam.counts.length !== 101 * stateCount) {
      fail("INVALID_SCHEMA", `payload.sample.${group}.counts`, `counts must be an array of length ${101 * stateCount}`);
    }
    for (let i = 0; i < sam.counts.length; i += 1) {
      const count = (sam.counts as unknown[])[i];
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        fail("INVALID_SCHEMA", `payload.sample.${group}.counts[${i}]`, "counts must be non-negative integers");
      }
    }
    if (
      typeof sam.completed !== "number" ||
      !Number.isInteger(sam.completed) ||
      sam.completed < 0
    ) {
      fail("INVALID_SCHEMA", `payload.sample.${group}.completed`, "completed must be a non-negative integer");
    }
    if (sam.completed !== scenario.trajectoriesPerGroup) {
      fail("EVIDENCE_MISMATCH", `payload.sample.${group}.completed`, `completed must equal trajectoriesPerGroup ${scenario.trajectoriesPerGroup}`);
    }
    for (let t = 0; t < 101; t += 1) {
      let rowSum = 0;
      for (let j = 0; j < stateCount; j += 1) {
        rowSum += (sam.counts as number[])[t * stateCount + j]!;
      }
      if (rowSum !== sam.completed) {
        fail("EVIDENCE_MISMATCH", `payload.sample.${group}.counts row ${t}`, `counts row sum must equal completed ${sam.completed}, got ${rowSum}`);
      }
    }
    const storedMean = checkFloatArray(sam.meanB, 101, `payload.sample.${group}.meanB`);
    const storedVariance = checkFloatArray(sam.varianceB, 101, `payload.sample.${group}.varianceB`);
    const recomputed = recomputeSampleMoments(sam.counts as number[], stateCount, sam.completed as number);
    for (let t = 0; t < 101; t += 1) {
      if (Math.abs(recomputed.meanB[t]! - storedMean[t]!) > EVIDENCE_TOLERANCE) {
        fail("EVIDENCE_MISMATCH", `payload.sample.${group}.meanB[${t}]`, "sample mean does not match counts recomputation");
      }
      if (Math.abs(recomputed.varianceB[t]! - storedVariance[t]!) > EVIDENCE_TOLERANCE) {
        fail("EVIDENCE_MISMATCH", `payload.sample.${group}.varianceB[${t}]`, "sample variance does not match counts recomputation");
      }
    }
  }
  const audit = validateAuditShape(parsed.audit);
  const meta = validateMeta(parsed.meta);
  if (
    typeof parsed.payloadSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.payloadSha256)
  ) {
    fail("INVALID_SCHEMA", "payloadSha256", "payloadSha256 must be 64 lowercase hexadecimal characters");
  }
  return {
    schemaVersion: 1,
    engineVersion: "1.0.0",
    scenario,
    payload: payload as unknown as EvidencePayloadV1,
    audit,
    meta,
    payloadSha256: parsed.payloadSha256,
  };
}

/** 仅核对 payload 哈希；返回 false 表示哈希不一致（调用方按 EVIDENCE_MISMATCH 处理）。 */
export async function verifyEvidenceHash(evidence: EvidenceV1): Promise<boolean> {
  return (await payloadSha256(evidence.payload)) === evidence.payloadSha256;
}

function compareFloatArrays(
  label: string,
  expected: ArrayLike<number>,
  actual: ArrayLike<number>,
  differences: string[],
): number {
  let maxError = 0;
  if (expected.length !== actual.length) {
    differences.push(`${label}: EVIDENCE_MISMATCH (length ${expected.length} vs ${actual.length})`);
    return Number.POSITIVE_INFINITY;
  }
  for (let i = 0; i < expected.length; i += 1) {
    const error = Math.abs(expected[i]! - actual[i]!);
    maxError = Math.max(maxError, error);
    if (error > EVIDENCE_TOLERANCE) {
      differences.push(`${label}[${i}]: EVIDENCE_MISMATCH`);
    }
  }
  return maxError;
}

/**
 * 完整重算比较（§12.2 步骤 5）：不比较 meta，不比较 termsUsed，
 * numerical 的其它诊断字段仍按 1e-9 比较且各自满足预算。
 * 本函数不修改任何输入；调用方在 matches 为真之前不得提交 rerun。
 */
export function compareEvidence(
  evidence: EvidenceV1,
  rerun: RunResult,
): EvidenceComparison {
  const differences: string[] = [];
  const payload = evidence.payload;
  if (payload.stateCount !== rerun.stateCount) {
    differences.push("payload.stateCount: EVIDENCE_MISMATCH");
  }
  let referenceMaxAbsError = compareFloatArrays(
    "payload.times",
    payload.times,
    Array.from(rerun.times),
    differences,
  );
  for (const group of ["P", "Q"] as const) {
    const ref = payload.reference[group];
    const rerunRef = rerun.reference[group];
    const fields = [
      "pmf", "meanB", "varianceB", "meanA", "varianceA",
      "meanBirthRate", "meanDeathRate", "exactDrift",
      "closureDriftAtExactMean", "driftCorrection", "closureMeanB",
    ] as const;
    for (const field of fields) {
      referenceMaxAbsError = Math.max(
        referenceMaxAbsError,
        compareFloatArrays(
          `payload.reference.${group}.${field}`,
          ref[field],
          Array.from(rerunRef[field]),
          differences,
        ),
      );
    }
    for (let t = 0; t < 101; t += 1) {
      const diag = ref.numerical[t]!;
      const rerunDiag = rerunRef.numerical[t]!;
      for (const field of ["cumulativeTailBound", "probabilityMass", "massDefect", "minProbability"] as const) {
        const error = Math.abs(diag[field] - rerunDiag[field]);
        if (error > EVIDENCE_TOLERANCE) {
          differences.push(`payload.reference.${group}.numerical[${t}].${field}: EVIDENCE_MISMATCH`);
        }
        // termsUsed 明确不作为跨环境相等判据，此处不比较。
      }
      if (rerunDiag.cumulativeTailBound > TAIL_BOUND_BUDGET) {
        differences.push(`rerun.reference.${group}.numerical[${t}].cumulativeTailBound: BUDGET_EXCEEDED`);
      }
      if (Math.abs(rerunDiag.massDefect) > MASS_DEFECT_BUDGET) {
        differences.push(`rerun.reference.${group}.numerical[${t}].massDefect: BUDGET_EXCEEDED`);
      }
      if (rerunDiag.minProbability < MIN_PROBABILITY_FLOOR) {
        differences.push(`rerun.reference.${group}.numerical[${t}].minProbability: BUDGET_EXCEEDED`);
      }
    }
    const sam = payload.sample[group];
    const rerunSam = rerun.sample[group];
    if (sam.completed !== rerunSam.completed) {
      differences.push(`payload.sample.${group}.completed: EVIDENCE_MISMATCH`);
    }
    let countsMatch = sam.counts.length === rerunSam.counts.length;
    if (countsMatch) {
      for (let i = 0; i < sam.counts.length; i += 1) {
        if (sam.counts[i] !== rerunSam.counts[i]) {
          countsMatch = false;
          differences.push(`payload.sample.${group}.counts[${i}]: EVIDENCE_MISMATCH`);
        }
      }
    } else {
      differences.push(`payload.sample.${group}.counts: EVIDENCE_MISMATCH (length mismatch)`);
    }
    compareFloatArrays(
      `payload.sample.${group}.meanB`,
      sam.meanB,
      Array.from(rerunSam.meanB),
      differences,
    );
    compareFloatArrays(
      `payload.sample.${group}.varianceB`,
      sam.varianceB,
      Array.from(rerunSam.varianceB),
      differences,
    );
    void countsMatch;
  }
  const sampleCountsMatch =
    ["P", "Q"].every(
      (group) =>
        payload.sample[group as GroupId].completed ===
          rerun.sample[group as GroupId].completed &&
        payload.sample[group as GroupId].counts.length ===
          rerun.sample[group as GroupId].counts.length &&
        payload.sample[group as GroupId].counts.every(
          (count, i) =>
            count === rerun.sample[group as GroupId].counts[i],
        ),
    );
  return {
    matches: differences.length === 0,
    referenceMaxAbsError: Number.isFinite(referenceMaxAbsError)
      ? referenceMaxAbsError
      : Number.POSITIVE_INFINITY,
    sampleCountsMatch,
    differences,
  };
}

/**
 * 导入全流程的纯比较部分（§12.2 步骤 2、5）：哈希 + 完整重算比较 +
 * 导入 audit 与重算 audit 的逐字段比较（group、trajectoryIndex、
 * initial、events 全字段、terminal、sampledB）。随机流审计本身由
 * verifyAudit（src/verify/replay.ts）另行执行，两者不可互相替代；
 * 调用方须把三者全部通过后才提交，任一步失败都保留当前实验。
 * 注意：payload 哈希不覆盖 audit 字段，因此只比 sampledB 或只验
 * 哈希都不足以发现事件随机数篡改——事件字段必须逐项比对。
 */
function closeNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
}

function compareAuditTraces(
  imported: AuditTrace,
  rerun: AuditTrace,
  differences: string[],
): void {
  if (imported.group !== rerun.group) {
    differences.push("audit.group: EVIDENCE_MISMATCH");
  }
  if (imported.trajectoryIndex !== rerun.trajectoryIndex) {
    differences.push("audit.trajectoryIndex: EVIDENCE_MISMATCH");
  }
  if (imported.initial.trajectorySeed !== rerun.initial.trajectorySeed) {
    differences.push("audit.initial.trajectorySeed: EVIDENCE_MISMATCH");
  }
  if (imported.initial.uInitial !== rerun.initial.uInitial) {
    differences.push("audit.initial.uInitial: EVIDENCE_MISMATCH");
  }
  if (imported.initial.initialState !== rerun.initial.initialState) {
    differences.push("audit.initial.initialState: EVIDENCE_MISMATCH");
  }
  if (imported.events.length !== rerun.events.length) {
    differences.push("audit.events: EVIDENCE_MISMATCH (length mismatch)");
  } else {
    for (let i = 0; i < imported.events.length; i += 1) {
      const a = imported.events[i]!;
      const b = rerun.events[i]!;
      const prefix = `audit.events[${i}]`;
      if (a.index !== b.index) {
        differences.push(`${prefix}.index: EVIDENCE_MISMATCH`);
      }
      if (!closeNumber(a.timeBefore, b.timeBefore)) {
        differences.push(`${prefix}.timeBefore: EVIDENCE_MISMATCH`);
      }
      if (a.stateBefore !== b.stateBefore) {
        differences.push(`${prefix}.stateBefore: EVIDENCE_MISMATCH`);
      }
      if (!closeNumber(a.birth, b.birth)) {
        differences.push(`${prefix}.birth: EVIDENCE_MISMATCH`);
      }
      if (!closeNumber(a.death, b.death)) {
        differences.push(`${prefix}.death: EVIDENCE_MISMATCH`);
      }
      if (!closeNumber(a.totalRate, b.totalRate)) {
        differences.push(`${prefix}.totalRate: EVIDENCE_MISMATCH`);
      }
      if (a.uWaiting !== b.uWaiting) {
        differences.push(`${prefix}.uWaiting: EVIDENCE_MISMATCH`);
      }
      if (a.uChoice !== b.uChoice) {
        differences.push(`${prefix}.uChoice: EVIDENCE_MISMATCH`);
      }
      if (!closeNumber(a.waitingTime, b.waitingTime)) {
        differences.push(`${prefix}.waitingTime: EVIDENCE_MISMATCH`);
      }
      if (a.reaction !== b.reaction) {
        differences.push(`${prefix}.reaction: EVIDENCE_MISMATCH`);
      }
      if (!closeNumber(a.timeAfter, b.timeAfter)) {
        differences.push(`${prefix}.timeAfter: EVIDENCE_MISMATCH`);
      }
      if (a.stateAfter !== b.stateAfter) {
        differences.push(`${prefix}.stateAfter: EVIDENCE_MISMATCH`);
      }
    }
  }
  if (imported.terminal.reason !== rerun.terminal.reason) {
    differences.push("audit.terminal.reason: EVIDENCE_MISMATCH");
  } else if (
    imported.terminal.reason === "HORIZON" &&
    rerun.terminal.reason === "HORIZON"
  ) {
    const a = imported.terminal;
    const b = rerun.terminal;
    if (!closeNumber(a.time, b.time)) {
      differences.push("audit.terminal.time: EVIDENCE_MISMATCH");
    }
    if (a.state !== b.state) {
      differences.push("audit.terminal.state: EVIDENCE_MISMATCH");
    }
    if (!closeNumber(a.totalRate, b.totalRate)) {
      differences.push("audit.terminal.totalRate: EVIDENCE_MISMATCH");
    }
    if (a.uWaiting !== b.uWaiting) {
      differences.push("audit.terminal.uWaiting: EVIDENCE_MISMATCH");
    }
    if (a.uChoice !== b.uChoice) {
      differences.push("audit.terminal.uChoice: EVIDENCE_MISMATCH");
    }
    if (!closeNumber(a.waitingTime, b.waitingTime)) {
      differences.push("audit.terminal.waitingTime: EVIDENCE_MISMATCH");
    }
    if (!closeNumber(a.candidateTime, b.candidateTime)) {
      differences.push("audit.terminal.candidateTime: EVIDENCE_MISMATCH");
    }
  } else if (
    imported.terminal.reason === "ABSORBING" &&
    rerun.terminal.reason === "ABSORBING"
  ) {
    if (!closeNumber(imported.terminal.time, rerun.terminal.time)) {
      differences.push("audit.terminal.time: EVIDENCE_MISMATCH");
    }
    if (imported.terminal.state !== rerun.terminal.state) {
      differences.push("audit.terminal.state: EVIDENCE_MISMATCH");
    }
  }
}

export async function verifyImportedEvidence(
  evidence: EvidenceV1,
  rerun: RunResult,
  rerunAudit: AuditTrace,
): Promise<{
  valid: boolean;
  hashMatches: boolean;
  comparison: EvidenceComparison;
  differences: string[];
}> {
  const hashMatches = await verifyEvidenceHash(evidence);
  const comparison = compareEvidence(evidence, rerun);
  const differences = [...comparison.differences];
  if (!hashMatches) {
    differences.unshift("payloadSha256: EVIDENCE_MISMATCH");
  }
  compareAuditTraces(evidence.audit, rerunAudit, differences);
  if (rerunAudit.sampledB.length !== evidence.audit.sampledB.length) {
    differences.push("audit.sampledB: EVIDENCE_MISMATCH (length mismatch)");
  } else {
    for (let i = 0; i < evidence.audit.sampledB.length; i += 1) {
      if (rerunAudit.sampledB[i] !== evidence.audit.sampledB[i]) {
        differences.push(`audit.sampledB[${i}]: EVIDENCE_MISMATCH`);
      }
    }
  }
  return {
    valid: differences.length === 0,
    hashMatches,
    comparison,
    differences,
  };
}
