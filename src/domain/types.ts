// P006 NoiseScope — 唯一类型文件（T002 冻结后，后继只能提出契约修订需求，
// 不得擅自修改本文件）
//
// 定义逐字取自项目书 §11、§12（SPEC 1.0.0）。本文件只定义类型，不实现
// SSA、CME、闭合、UI 或任何计算核心。数组布局见 docs/API_CONTRACT.md。

export type ModelId = "linear" | "dimer";
export type GroupId = "P" | "Q";

export interface ModelSpec {
  id: ModelId;
  totalUnits: number;
  forwardRate: number;
  reverseRate: number;
}

export interface ScenarioV1 {
  schemaVersion: 1;
  projectId: "P006";
  title: string; // 1..80 Unicode characters
  model: ModelSpec;
  initial: { P: number[]; Q: number[] };
  horizon: number;
  observations: 101;
  trajectoriesPerGroup: 64 | 128 | 256 | 512 | 1024 | 2048 | 4096;
  seed: number;
  rngVersion: "xorshift32-v1";
}

export interface Rates {
  birth: Float64Array;
  death: Float64Array;
  maxExitRate: number;
}

export interface ProbabilityDiagnostics {
  cumulativeTailBound: number;
  probabilityMass: number;
  massDefect: number;
  minProbability: number;
  termsUsed: number;
}

export interface ReferenceGroup {
  pmf: Float64Array; // time-major: index = timeIndex * stateCount + j
  meanB: Float64Array;
  varianceB: Float64Array;
  meanA: Float64Array;
  varianceA: Float64Array;
  meanBirthRate: Float64Array;
  meanDeathRate: Float64Array;
  exactDrift: Float64Array;
  closureDriftAtExactMean: Float64Array;
  driftCorrection: Float64Array;
  closureMeanB: Float64Array;
  numerical: ProbabilityDiagnostics[]; // length 101
}

export interface SampleGroup {
  counts: Uint32Array; // same time-major indexing as pmf
  completed: number;
  meanB: Float64Array;
  varianceB: Float64Array; // empirical population variance, denominator M
  previewB: Uint8Array; // trajectory-major, min(32,M) * 101
  eventsExecuted: number;
}

export interface RunResult {
  runId: number;
  scenario: ScenarioV1;
  stateCount: number;
  times: Float64Array;
  reference: Record<GroupId, ReferenceGroup>;
  sample: Record<GroupId, SampleGroup>;
  engineVersion: "1.0.0";
  status: "COMPLETE";
  elapsedMs: number; // measured, not a scientific result
  timings: { referenceMs: number; ssaMs: number }; // Worker measurements
}

export interface InitialDraw {
  uInitial: number;
  initialState: number; // B count
  trajectorySeed: number;
}

export interface ReactionEvent {
  index: number;
  timeBefore: number;
  stateBefore: number;
  birth: number;
  death: number;
  totalRate: number;
  uWaiting: number;
  uChoice: number;
  waitingTime: number;
  reaction: "forward" | "reverse";
  timeAfter: number;
  stateAfter: number;
}

export type TerminalRecord =
  | { reason: "ABSORBING"; time: number; state: number }
  | {
      reason: "HORIZON";
      time: number;
      state: number;
      totalRate: number;
      uWaiting: number;
      uChoice: number;
      waitingTime: number;
      candidateTime: number;
    };

export interface AuditTrace {
  group: GroupId;
  trajectoryIndex: number;
  initial: InitialDraw;
  events: ReactionEvent[];
  terminal: TerminalRecord;
  sampledB: number[]; // length 101
}

export type WorkerRequest =
  | { type: "RUN"; runId: number; scenario: ScenarioV1 }
  | {
      type: "REPLAY";
      runId: number;
      scenario: ScenarioV1;
      group: GroupId;
      trajectoryIndex: number;
    };

export type WorkerResponse =
  | {
      type: "PROGRESS";
      runId: number;
      completedP: number;
      completedQ: number;
      targetPerGroup: number;
    }
  | { type: "RESULT"; runId: number; result: RunResult }
  | { type: "TRACE"; runId: number; trace: AuditTrace }
  | { type: "ERROR"; runId: number; code: ErrorCode; message: string };

export type ErrorCode =
  | "INVALID_SCHEMA"
  | "INVALID_MODEL"
  | "INVALID_PMF"
  | "FILE_TOO_LARGE"
  | "VERSION_UNSUPPORTED"
  | "BUDGET_EXCEEDED"
  | "NUMERIC_CONVERGENCE"
  | "EVIDENCE_MISMATCH"
  | "INTERNAL_ERROR";

// §12.2 证据文件契约（实现属 T007，本文件只先行定义，避免后续另建类型文件）
export interface EvidenceReferenceGroup {
  pmf: number[];
  meanB: number[];
  varianceB: number[];
  meanA: number[];
  varianceA: number[];
  meanBirthRate: number[];
  meanDeathRate: number[];
  exactDrift: number[];
  closureDriftAtExactMean: number[];
  driftCorrection: number[];
  closureMeanB: number[];
  numerical: ProbabilityDiagnostics[];
}

export interface EvidenceSampleGroup {
  counts: number[];
  completed: number;
  meanB: number[];
  varianceB: number[];
}

export interface EvidencePayloadV1 {
  stateCount: number;
  times: number[];
  reference: Record<GroupId, EvidenceReferenceGroup>;
  sample: Record<GroupId, EvidenceSampleGroup>;
}

export interface EvidenceMetaV1 {
  createdAt: string; // ISO 8601 UTC
  displayTitle: string;
  userAgent: string;
  platform: string;
  dependencyVersions: Record<string, string>;
  elapsedMs: number;
}

export interface EvidenceV1 {
  schemaVersion: 1;
  engineVersion: "1.0.0";
  scenario: ScenarioV1; // immutable snapshot used for the completed run
  payload: EvidencePayloadV1;
  audit: AuditTrace;
  meta: EvidenceMetaV1;
  payloadSha256: string; // 64 lowercase hexadecimal characters
}

export interface EvidenceComparison {
  matches: boolean;
  referenceMaxAbsError: number;
  sampleCountsMatch: boolean;
  differences: string[]; // field paths and mismatch category
}

export type PresetId = "variance-split" | "linear-control" | "frozen";

/** 状态数 S：线性 N+1，二聚 N/2+1。仅在已验证的 ModelSpec 上调用。 */
export function stateCountForModel(model: ModelSpec): number {
  return model.id === "linear" ? model.totalUnits + 1 : model.totalUnits / 2 + 1;
}
