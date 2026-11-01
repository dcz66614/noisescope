# P006 NoiseScope — API 契约（初版，T002）

> 本文件逐字保持项目书 §11、§12 给出的 TypeScript 定义，并补充数组布局、
> 错误码与消息实例。公共字段或类型如需改动，必须走显式契约修订，
> 不得在后续任务中悄悄改变。内部 helper 可私有扩展，不得改变公共字段。

来源：项目书 SPEC 1.0.0 §4、§11、§12；实施计划 P006 T002 节。

## 1 输入与核心结果（§11.1，逐字）

```ts
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
```

## 2 数组布局（补充）

- 状态：统一状态 j 表示 B 的整数数量。线性 A+B=N；二聚 A+2B=N。
- 状态数 S：线性 S=N+1；二聚 S=N/2+1。N 必须是 4 的倍数，4..40。
- pmf / counts：time-major，长度 101×S，索引 = timeIndex × S + j。
- ReferenceGroup 其余数值数组及 numerical：长度均为 101。
- SampleGroup previewB：trajectory-major，长度 min(32, M) × 101。
- times：长度 101，含 0 与 T。
- meanA / varianceA 由同一 PMF 计算或用守恒关系求出；解释面板直接读取
  这些字段，不在组件中重写公式。
- elapsedMs / timings 只是 Worker 内 performance.now 测量，排除消息传输与绘图，
  不进入科学 payload。输入对象不允许被计算过程修改。

## 3 模型与输入范围（§4）

| 参数 | 合法范围 | 默认值 |
| --- | --- | --- |
| model | linear 或 dimer | dimer |
| totalUnits N | 整数 4, 8, 12, …, 40 | 20 |
| forwardRate | linear 0…1；dimer 0…0.05 | dimer 0.02；linear 0.15 |
| reverseRate | 0…1 | dimer 0.2；linear 0.1 |
| horizon T | 有限实数 0.2…20 | 8 |
| observations | 固定 101，含 0 和 T | 101 |
| trajectoriesPerGroup M | 64、128、256、512、1024、2048、4096 | 512 |
| seed | 无符号 32 位整数，含 0 | 20261031 |
| initialPmf | 长度 S，非负，和与 1 的差不超过 1e-12 | 见预置 |

速率约定（§4.2）：

- linear: λj = kf(N−j)，μj = kb·j
- dimer: λj = (kf/2)(N−2j)(N−2j−1)，μj = kb·j
- j=0 时反向率为零，j=jMax 时正向率为零。
- 参数非有限数、非法概率、超范围规模均拒绝，不做悄悄夹取。
- 导入概率和在容差内时保留原值，不自动归一化。
- 自定义两组允许均值不同，此时显示“非同均值实验”，不得继续使用默认教学结论。

## 4 事件记录与终止（§11.2，逐字）

```ts
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
  | { reason: "HORIZON"; time: number; state: number;
      totalRate: number; uWaiting: number; uChoice: number;
      waitingTime: number; candidateTime: number };
export interface AuditTrace {
  group: GroupId;
  trajectoryIndex: number;
  initial: InitialDraw;
  events: ReactionEvent[];
  terminal: TerminalRecord;
  sampledB: number[]; // length 101
}
```

trajectoryIndex 为 0 基整数，0≤index<M；ReactionEvent.index 从 0 连续递增。
HORIZON 的 time 是最后已发生事件时间，不强行改成 T；candidateTime 必须大于 T。
本版只有 ABSORBING 与 HORIZON 两种终止类型。

## 5 纯函数签名（§11.3，逐字）

```ts
export function validateScenario(input: unknown): ScenarioV1;
export function makePreset(id: "variance-split" | "linear-control" |
  "frozen"): ScenarioV1;
export function buildRates(model: ModelSpec): Rates;
export function simulateTrajectory(s: ScenarioV1, group: GroupId,
  trajectoryIndex: number, audit: boolean): {
    sampledB: Uint8Array; eventsExecuted: number; trace?: AuditTrace
  };
export function solveReference(s: ScenarioV1, group: GroupId):
  ReferenceGroup;
export function solveClosure(s: ScenarioV1, group: GroupId):
  Float64Array;
export function computeCdfDistance(counts: ArrayLike<number>,
  probabilities: ArrayLike<number>, sampleCount: number): number;
export function computeComparisonSeries(reference: ReferenceGroup,
  sample: SampleGroup, stateCount: number): {
    meanGap: Float64Array;
    samplingError: Float64Array;
    cdfDistance: Float64Array;
  };
export function verifyAudit(s: ScenarioV1, trace: AuditTrace): {
  valid: boolean; checkedEvents: number; errors: string[]
};
export function serializeScenario(s: ScenarioV1): string;
export function parseScenario(text: string): ScenarioV1;
```

T002 已实现：validateScenario、makePreset、serializeScenario、parseScenario。
其余签名属后续任务（T003–T007），本文件只登记签名，不代表已实现。

## 6 Worker 协议（§11.4，逐字）

```ts
export type WorkerRequest =
  | { type: "RUN"; runId: number; scenario: ScenarioV1 }
  | { type: "REPLAY"; runId: number; scenario: ScenarioV1;
      group: GroupId; trajectoryIndex: number };

export type WorkerResponse =
  | { type: "PROGRESS"; runId: number;
      completedP: number; completedQ: number; targetPerGroup: number }
  | { type: "RESULT"; runId: number; result: RunResult }
  | { type: "TRACE"; runId: number; trace: AuditTrace }
  | { type: "ERROR"; runId: number; code: ErrorCode; message: string };

export type ErrorCode =
  | "INVALID_SCHEMA" | "INVALID_MODEL" | "INVALID_PMF"
  | "FILE_TOO_LARGE" | "VERSION_UNSUPPORTED"
  | "BUDGET_EXCEEDED" | "NUMERIC_CONVERGENCE"
  | "EVIDENCE_MISMATCH" | "INTERNAL_ERROR";
```

取消由主线程 terminate 当前 Worker 并创建新实例实现；runId 严格单调递增，
主线程丢弃非当前 runId 的任何消息。每完成最多 64 条轨迹至少发送一次进度；
取消后的部分结果不可标 COMPLETE。

## 7 T002 校验实现细则与错误码、消息实例

校验失败抛出 `ScenarioValidationError`，含 `code`、`field`、`message` 三个字段，
调用方据此显示错误，不修改现有实验。示例：

- `{"code":"INVALID_PMF","field":"initial.P[5]","message":"initial.P[5] must not be negative"}`
- `{"code":"INVALID_MODEL","field":"model.totalUnits","message":"totalUnits must be an integer multiple of 4 between 4 and 40"}`
- `{"code":"INVALID_MODEL","field":"model.forwardRate","message":"forwardRate for dimer must be between 0 and 0.05"}`
- `{"code":"VERSION_UNSUPPORTED","field":"schemaVersion","message":"unsupported schemaVersion: 2"}`
- `{"code":"FILE_TOO_LARGE","field":"","message":"scenario file must be at most 32768 bytes, got 41012"}`

细则：

- schemaVersion 缺失/非有限数 → INVALID_SCHEMA；数字但不是 1 → VERSION_UNSUPPORTED。
- projectId 不是 "P006"、observations 不是 101、trajectoriesPerGroup 不在
  [64, 128, 256, 512, 1024, 2048, 4096]、seed 不是 0..4294967295 的整数、
  rngVersion 不是 "xorshift32-v1" → INVALID_SCHEMA。
- title 按 Unicode 码点数计 1..80，非字符串、空、超长 → INVALID_SCHEMA。
- model.id 不是 linear/dimer、totalUnits 非法、forwardRate/reverseRate
  非有限或超范围、未知 model 字段 → INVALID_MODEL。
- initial 不是对象、组缺失、长度不是 S、元素非有限或为负、和与 1 的差
  超过 1e-12、未知组 → INVALID_PMF。
- 未知顶层字段 → INVALID_SCHEMA（根对象就是 ScenarioV1）。
- 校验返回全新对象（数组均为副本），不修改输入；PMF 在容差内保留原值，
  不归一化；-0 规范为 0。
- parseScenario：文本字节数超过 32768 → FILE_TOO_LARGE；JSON 解析失败 →
  INVALID_SCHEMA；其余按 validateScenario。
- serializeScenario：先校验再序列化，输出为带 2 空格缩进的 JSON。

## 8 预置（§4.1、§9、§12.1）

| 预置 id | 模型 / N / 速率 | 初始 PMF | 标题 |
| --- | --- | --- | --- |
| variance-split | dimer / 20 / kf 0.02, kb 0.2 | P: j=5 取 1；Q: j=0 与 j=10 各 0.5 | 同均值不同走势 |
| linear-control | linear / 20 / kf 0.15, kb 0.1 | P: j=10 取 1；Q: j=0 与 j=20 各 0.5 | 线性对照 |
| frozen | dimer / 20 / kf 0, kb 0 | 与 variance-split 相同 | 零速率冻结 |

三者共用：horizon 8，observations 101，trajectoriesPerGroup 512，
seed 20261031，rngVersion "xorshift32-v1"，schemaVersion 1，projectId "P006"。
fixtures/ 下的三个 JSON 即 serializeScenario(makePreset(id)) 的输出，
默认二聚示例与 §12.1 完全一致。

## 9 文件格式（§12，摘要）

- 实验文件：扩展名 .noisescope.json，UTF-8，最大 32 KiB，根对象就是
  ScenarioV1；拒绝未知 schemaVersion、非有限数、错误数组长度及额外可执行字段。
  标题只当纯文本处理。
- 证据文件：扩展名 .noisescope-evidence.json，最大 8 MiB，类型见
  src/domain/types.ts 中 EvidenceV1 一节（实现属 T007）。
- CSV 固定列：group,time,state_b,cme_probability,ssa_count,sample_count,
  ssa_probability，逐时间、组别、j 升序。
- SVG 导出当前分布图和均值图，各自带标题、模型参数、图例、时间及
  “合成模型”说明；不包含远程字体和外链资源。
