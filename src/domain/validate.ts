// P006 T002 — 场景校验与文件格式（项目书 §4、§11、§12）
//
// 严格验证，不做悄悄夹取、不自动归一化、不修改输入对象。
// 校验失败抛出 ScenarioValidationError，带明确的 code 与 field，
// 调用方（UI / Worker / 导入）可据此显示错误而不损坏现有实验。

import {
  stateCountForModel,
  type ErrorCode,
  type ModelSpec,
  type ScenarioV1,
} from "./types";

export class ScenarioValidationError extends Error {
  readonly code: ErrorCode;
  readonly field: string;

  constructor(code: ErrorCode, field: string, message: string) {
    super(message);
    this.name = "ScenarioValidationError";
    this.code = code;
    this.field = field;
  }
}

const ALLOWED_TRAJECTORIES = [64, 128, 256, 512, 1024, 2048, 4096] as const;
const PMF_SUM_TOLERANCE = 1e-12;
const MAX_SCENARIO_FILE_BYTES = 32 * 1024; // §12.1：.noisescope.json 最大 32 KiB

function fail(code: ErrorCode, field: string, message: string): never {
  throw new ScenarioValidationError(code, field, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function checkFiniteNumber(
  value: unknown,
  code: ErrorCode,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(code, field, `${field} must be a finite number`);
  }
  return normalizeZero(value as number);
}

/**
 * 校验任意未知输入，返回一份全新的 ScenarioV1（数组均为副本）。
 * 输入对象本身不被修改；PMF 在容差内时保留原值，不归一化。
 */
export function validateScenario(input: unknown): ScenarioV1 {
  if (!isRecord(input)) {
    fail("INVALID_SCHEMA", "", "scenario must be an object");
  }

  // 拒绝未知顶层字段：根对象就是 ScenarioV1（§12.1）。
  const allowedTop = new Set([
    "schemaVersion",
    "projectId",
    "title",
    "model",
    "initial",
    "horizon",
    "observations",
    "trajectoriesPerGroup",
    "seed",
    "rngVersion",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedTop.has(key)) {
      fail("INVALID_SCHEMA", key, `unknown field: ${key}`);
    }
  }

  // schemaVersion：缺失/非数字 -> INVALID_SCHEMA；数字但不是 1 -> VERSION_UNSUPPORTED
  if (input.schemaVersion === undefined) {
    fail("INVALID_SCHEMA", "schemaVersion", "schemaVersion is required");
  }
  if (typeof input.schemaVersion !== "number" || !Number.isFinite(input.schemaVersion)) {
    fail("INVALID_SCHEMA", "schemaVersion", "schemaVersion must be a finite number");
  }
  if (input.schemaVersion !== 1) {
    fail(
      "VERSION_UNSUPPORTED",
      "schemaVersion",
      `unsupported schemaVersion: ${input.schemaVersion}`,
    );
  }

  if (input.projectId !== "P006") {
    fail("INVALID_SCHEMA", "projectId", 'projectId must be "P006"');
  }

  if (typeof input.title !== "string") {
    fail("INVALID_SCHEMA", "title", "title must be a string");
  }
  const titleLength = [...input.title].length; // Unicode 码点数，不是 UTF-16 单元数
  if (titleLength < 1 || titleLength > 80) {
    fail(
      "INVALID_SCHEMA",
      "title",
      `title must be 1..80 Unicode characters, got ${titleLength}`,
    );
  }
  const title = input.title;

  // ---- model ----
  if (!isRecord(input.model)) {
    fail("INVALID_MODEL", "model", "model must be an object");
  }
  const modelInput = input.model;
  for (const key of Object.keys(modelInput)) {
    if (!["id", "totalUnits", "forwardRate", "reverseRate"].includes(key)) {
      fail("INVALID_MODEL", `model.${key}`, `unknown model field: ${key}`);
    }
  }
  if (modelInput.id !== "linear" && modelInput.id !== "dimer") {
    fail("INVALID_MODEL", "model.id", 'model.id must be "linear" or "dimer"');
  }
  const modelId = modelInput.id;
  if (
    typeof modelInput.totalUnits !== "number" ||
    !Number.isInteger(modelInput.totalUnits) ||
    modelInput.totalUnits < 4 ||
    modelInput.totalUnits > 40 ||
    modelInput.totalUnits % 4 !== 0
  ) {
    fail(
      "INVALID_MODEL",
      "model.totalUnits",
      "totalUnits must be an integer multiple of 4 between 4 and 40",
    );
  }
  const totalUnits = modelInput.totalUnits;
  const forwardRate = checkFiniteNumber(
    modelInput.forwardRate,
    "INVALID_MODEL",
    "model.forwardRate",
  );
  const forwardMax = modelId === "linear" ? 1 : 0.05;
  if (forwardRate < 0 || forwardRate > forwardMax) {
    fail(
      "INVALID_MODEL",
      "model.forwardRate",
      `forwardRate for ${modelId} must be between 0 and ${forwardMax}`,
    );
  }
  const reverseRate = checkFiniteNumber(
    modelInput.reverseRate,
    "INVALID_MODEL",
    "model.reverseRate",
  );
  if (reverseRate < 0 || reverseRate > 1) {
    fail(
      "INVALID_MODEL",
      "model.reverseRate",
      "reverseRate must be between 0 and 1",
    );
  }
  const model: ModelSpec = {
    id: modelId,
    totalUnits,
    forwardRate,
    reverseRate,
  };
  const stateCount = stateCountForModel(model);

  // ---- initial PMF ----
  if (!isRecord(input.initial)) {
    fail("INVALID_PMF", "initial", "initial must be an object with P and Q");
  }
  const initialInput = input.initial;
  for (const key of Object.keys(initialInput)) {
    if (key !== "P" && key !== "Q") {
      fail("INVALID_PMF", `initial.${key}`, `unknown initial group: ${key}`);
    }
  }
  const initial: { P: number[]; Q: number[] } = { P: [], Q: [] };
  for (const group of ["P", "Q"] as const) {
    const pmf = initialInput[group];
    if (!Array.isArray(pmf)) {
      fail("INVALID_PMF", `initial.${group}`, `initial.${group} must be an array`);
    }
    if (pmf.length !== stateCount) {
      fail(
        "INVALID_PMF",
        `initial.${group}`,
        `initial.${group} length must be ${stateCount}, got ${pmf.length}`,
      );
    }
    const copy: number[] = [];
    let sum = 0;
    for (let j = 0; j < pmf.length; j += 1) {
      const value = pmf[j];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(
          "INVALID_PMF",
          `initial.${group}[${j}]`,
          `initial.${group}[${j}] must be a finite number`,
        );
      }
      if ((value as number) < 0) {
        fail(
          "INVALID_PMF",
          `initial.${group}[${j}]`,
          `initial.${group}[${j}] must not be negative`,
        );
      }
      const v = normalizeZero(value as number);
      copy.push(v);
      sum += v;
    }
    if (Math.abs(sum - 1) > PMF_SUM_TOLERANCE) {
      fail(
        "INVALID_PMF",
        `initial.${group}`,
        `initial.${group} sum must be within ${PMF_SUM_TOLERANCE} of 1, got ${sum}`,
      );
    }
    initial[group] = copy; // 保留原值，不归一化
  }

  // ---- 其余标量 ----
  const horizon = checkFiniteNumber(input.horizon, "INVALID_SCHEMA", "horizon");
  if (horizon < 0.2 || horizon > 20) {
    fail("INVALID_SCHEMA", "horizon", "horizon must be between 0.2 and 20");
  }
  if (input.observations !== 101) {
    fail("INVALID_SCHEMA", "observations", "observations must be exactly 101");
  }
  if (
    typeof input.trajectoriesPerGroup !== "number" ||
    !(ALLOWED_TRAJECTORIES as readonly number[]).includes(
      input.trajectoriesPerGroup,
    )
  ) {
    fail(
      "INVALID_SCHEMA",
      "trajectoriesPerGroup",
      "trajectoriesPerGroup must be one of 64, 128, 256, 512, 1024, 2048, 4096",
    );
  }
  const trajectoriesPerGroup = input.trajectoriesPerGroup as ScenarioV1["trajectoriesPerGroup"];
  if (
    typeof input.seed !== "number" ||
    !Number.isInteger(input.seed) ||
    input.seed < 0 ||
    input.seed > 4294967295
  ) {
    fail(
      "INVALID_SCHEMA",
      "seed",
      "seed must be an unsigned 32-bit integer (0..4294967295)",
    );
  }
  const seed = input.seed;
  if (input.rngVersion !== "xorshift32-v1") {
    fail(
      "INVALID_SCHEMA",
      "rngVersion",
      'rngVersion must be "xorshift32-v1"',
    );
  }

  // 返回全新对象：不持有输入的任何数组引用。
  return {
    schemaVersion: 1,
    projectId: "P006",
    title,
    model,
    initial,
    horizon,
    observations: 101,
    trajectoriesPerGroup,
    seed,
    rngVersion: "xorshift32-v1",
  };
}

/** 序列化场景（§12.1）：根对象就是 ScenarioV1，UTF-8 JSON 文本。 */
export function serializeScenario(scenario: ScenarioV1): string {
  const validated = validateScenario(scenario);
  return JSON.stringify(validated, null, 2);
}

/**
 * 解析场景文本（§12.1 .noisescope.json）：
 * 超过 32 KiB -> FILE_TOO_LARGE；JSON 解析失败 -> INVALID_SCHEMA；
 * 其余按 validateScenario 校验。返回全新对象，不修改任何现有实验。
 */
export function parseScenario(text: string): ScenarioV1 {
  if (typeof text !== "string") {
    fail("INVALID_SCHEMA", "", "scenario text must be a string");
  }
  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > MAX_SCENARIO_FILE_BYTES) {
    fail(
      "FILE_TOO_LARGE",
      "",
      `scenario file must be at most ${MAX_SCENARIO_FILE_BYTES} bytes, got ${byteLength}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("INVALID_SCHEMA", "", "scenario text is not valid JSON");
  }
  return validateScenario(parsed);
}
