// P006 T008 — 运行客户端（项目书 §11.4、FR09）
//
// 职责：只做 Worker 生命周期与 runId 协议，不维护组件状态，不算公式。
// - 运行时只创建一个有效 Worker：run / replay / cancel 时先 terminate
//   旧实例再创建新实例；同一时刻活着的 Worker 实例数恒为 1（dispose 后为 0）。
// - 取消 = terminate + 新实例，不等待忙碌 Worker 处理取消消息。
// - runId 严格单调增加；任何非当前 runId 的消息一律丢弃，
//   旧 runId 的 RESULT / TRACE / ERROR / PROGRESS 都不能覆盖新运行。
// - 待定 Promise 在被新运行或取消取代时以 Error("cancelled") 拒绝，
//   部分结果绝不标 COMPLETE，也不会被 resolve 出去。
// - PROGRESS 只转发当前 runId 的；completed 超过 target 的进度
//   视为协议违规而丢弃（Worker 本身已保证不超过 M，客户端再守一道）。

import type {
  AuditTrace,
  GroupId,
  RunResult,
  ScenarioV1,
  WorkerRequest,
  WorkerResponse,
} from "../domain/types";

/** 客户端依赖的最小 Worker 接口：与标准 Worker 的子集一致，便于测试注入。 */
export interface WorkerLike {
  postMessage: (message: WorkerRequest) => void;
  terminate: () => void;
  onmessage: ((event: { data: WorkerResponse }) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export interface ProgressState {
  runId: number;
  completedP: number;
  completedQ: number;
  targetPerGroup: number;
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/** 生产工厂：Vite 会把 new URL Worker 入口打包为独立 worker chunk。 */
export function createProductionWorker(): WorkerLike {
  return new Worker(
    new URL("../workers/simulation.worker.ts", import.meta.url),
    { type: "module" },
  ) as unknown as WorkerLike;
}

export function createWorkerClient(
  factory: WorkerFactory = createProductionWorker,
): SimulationWorkerClient {
  return new SimulationWorkerClient(factory);
}

export class SimulationWorkerClient {
  private readonly factory: WorkerFactory;
  private worker: WorkerLike | null = null;
  private nextRunId = 1;
  /** 当前有效 runId；0 表示没有在途运行。 */
  private currentRunId = 0;
  private pending:
    | {
        runId: number;
        resolve: (value: never) => void;
        reject: (error: Error) => void;
        kind: "RUN" | "REPLAY";
      }
    | null = null;
  private progressHandler: ((progress: ProgressState) => void) | null = null;

  constructor(factory: WorkerFactory = createProductionWorker) {
    this.factory = factory;
  }

  get activeRunId(): number {
    return this.currentRunId;
  }

  get isRunning(): boolean {
    return this.currentRunId !== 0;
  }

  /** 是否当前正持有且未 terminate 的 Worker 实例（测试与诊断用）。 */
  get hasWorker(): boolean {
    return this.worker !== null;
  }

  onProgress(handler: (progress: ProgressState) => void): void {
    this.progressHandler = handler;
  }

  /** 终止当前实例并创建新实例；旧 runId 从此无效，待定 Promise 被取消。 */
  private replaceWorker(): WorkerLike {
    if (this.worker !== null) {
      this.worker.onmessage = null;
      this.worker.terminate();
      this.worker = null;
    }
    if (this.pending !== null) {
      const pending = this.pending;
      this.pending = null;
      pending.reject(new CancelledError());
    }
    const created = this.factory();
    created.onmessage = (event) => this.handleMessage(event.data);
    this.worker = created;
    return created;
  }

  private ensureWorker(): WorkerLike {
    if (this.worker === null) {
      const created = this.factory();
      created.onmessage = (event) => this.handleMessage(event.data);
      this.worker = created;
    }
    return this.worker;
  }

  private handleMessage(response: WorkerResponse): void {
    // 旧 runId 无效：不是当前 runId 的任何消息一律丢弃。
    if (response.runId !== this.currentRunId || this.currentRunId === 0) {
      return;
    }
    if (response.type === "PROGRESS") {
      // 协议违规的进度（超 M）丢弃，不转发给 UI。
      if (
        response.completedP > response.targetPerGroup ||
        response.completedQ > response.targetPerGroup ||
        response.completedP < 0 ||
        response.completedQ < 0
      ) {
        return;
      }
      this.progressHandler?.({
        runId: response.runId,
        completedP: response.completedP,
        completedQ: response.completedQ,
        targetPerGroup: response.targetPerGroup,
      });
      return;
    }
    const pending = this.pending;
    if (pending === null || pending.runId !== response.runId) {
      return;
    }
    if (response.type === "RESULT" && pending.kind === "RUN") {
      this.pending = null;
      this.currentRunId = 0;
      (pending.resolve as (value: RunResult) => void)(response.result);
      return;
    }
    if (response.type === "TRACE" && pending.kind === "REPLAY") {
      this.pending = null;
      this.currentRunId = 0;
      (pending.resolve as (value: AuditTrace) => void)(response.trace);
      return;
    }
    if (response.type === "ERROR") {
      this.pending = null;
      this.currentRunId = 0;
      pending.reject(
        new Error(`${response.code}: ${response.message}`),
      );
      return;
    }
    // 类型与等待种类不匹配（如等 RESULT 时收到 TRACE）也丢弃，
    // 不把错误种类的 payload 当成结果。
  }

  /** 开始一次 RUN：取代任何在途运行，旧 runId 立即失效。 */
  run(scenario: ScenarioV1): Promise<RunResult> {
    const worker = this.replaceWorker();
    const runId = this.nextRunId;
    this.nextRunId += 1;
    this.currentRunId = runId;
    const promise = new Promise<RunResult>((resolve, reject) => {
      this.pending = {
        runId,
        resolve: resolve as (value: never) => void,
        reject,
        kind: "RUN",
      };
    });
    worker.postMessage({ type: "RUN", runId, scenario });
    return promise;
  }

  /** 开始一次 REPLAY：同样取代在途运行，返回单条轨迹的 AuditTrace。 */
  replay(
    scenario: ScenarioV1,
    group: GroupId,
    trajectoryIndex: number,
  ): Promise<AuditTrace> {
    const worker = this.replaceWorker();
    const runId = this.nextRunId;
    this.nextRunId += 1;
    this.currentRunId = runId;
    const promise = new Promise<AuditTrace>((resolve, reject) => {
      this.pending = {
        runId,
        resolve: resolve as (value: never) => void,
        reject,
        kind: "REPLAY",
      };
    });
    worker.postMessage({
      type: "REPLAY",
      runId,
      scenario,
      group,
      trajectoryIndex,
    });
    return promise;
  }

  /**
   * 取消：terminate 当前 Worker 并创建新实例，runId 递增后
   * 旧 runId 的任何迟到消息都会被丢弃；待定 Promise 以取消拒绝。
   */
  cancel(): void {
    // 先递增 runId 语义：replaceWorker 会拒绝待定 Promise；
    // 随后创建的新实例只服务之后的新 runId。
    this.currentRunId = 0;
    this.replaceWorker();
  }

  /** 彻底释放：terminate 实例，丢弃在途运行，不再持有 Worker。 */
  dispose(): void {
    if (this.pending !== null) {
      const pending = this.pending;
      this.pending = null;
      pending.reject(new CancelledError());
    }
    if (this.worker !== null) {
      this.worker.onmessage = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.currentRunId = 0;
  }
}
