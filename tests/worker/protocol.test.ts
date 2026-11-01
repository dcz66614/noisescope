// P006 T008 — Worker 协议测试（项目书 §11.4、FR09）
//
// 不依赖真实浏览器 Worker：协议层用 handleRequest 直接测；
// 客户端生命周期用 FakeWorker 注入测（terminate / 新实例 / 旧 runId）。
// 真实 Worker 打包由 `npm run build` 验证（Vite 会打包 worker 入口）。

import { describe, expect, it } from "vitest";
import { simulateTrajectory, createObservationTimes } from "../../src/core/ssa";
import type {
  WorkerRequest,
  WorkerResponse,
} from "../../src/domain/types";
import { handleRequest } from "../../src/workers/simulation.worker";
import {
  SimulationWorkerClient,
  type WorkerLike,
} from "../../src/app/workerClient";
import { validateScenario } from "../../src/domain/validate";
import type { ScenarioV1 } from "../../src/domain/types";

/** 最小场景（与 batching.test.ts 内联定义相同，避免跨测试文件 import 导致重复注册）。 */
export function smallScenario(): ScenarioV1 {
  return validateScenario({
    schemaVersion: 1,
    projectId: "P006",
    title: "T008 最小场景",
    model: { id: "dimer", totalUnits: 4, forwardRate: 0.02, reverseRate: 0.2 },
    initial: { P: [0, 1, 0], Q: [0.5, 0, 0.5] },
    horizon: 1,
    observations: 101,
    trajectoriesPerGroup: 64,
    seed: 20261031,
    rngVersion: "xorshift32-v1",
  });
}

/** 注入式假 Worker：记录创建 / terminate / 发出的消息，可手动投递响应。 */
class FakeWorker implements WorkerLike {
  static created = 0;
  static terminated = 0;
  posted: WorkerRequest[] = [];
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  alive = true;

  constructor() {
    FakeWorker.created += 1;
  }

  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    if (this.alive) {
      this.alive = false;
      FakeWorker.terminated += 1;
    }
  }

  emit(response: WorkerResponse): void {
    this.onmessage?.({ data: response });
  }

  get liveCount(): number {
    return FakeWorker.created - FakeWorker.terminated;
  }
}

describe("worker protocol (handleRequest)", () => {
  it("RUN: PROGRESS 不超 M，且 RESULT 只在 P、Q 都完成 M 条后出现", () => {
    const responses = handleRequest({
      type: "RUN",
      runId: 1,
      scenario: smallScenario(),
    });
    const resultMsg = responses.find((r) => r.type === "RESULT");
    expect(resultMsg).toBeDefined();
    expect(responses[responses.length - 1]?.type).toBe("RESULT");
    if (resultMsg?.type !== "RESULT") throw new Error("no RESULT");
    expect(resultMsg.result.status).toBe("COMPLETE");
    expect(resultMsg.result.sample.P.completed).toBe(64);
    expect(resultMsg.result.sample.Q.completed).toBe(64);
    // RESULT 之前的所有 PROGRESS 都不超 M，且最后一次进度已是 (64,64)。
    const progresses = responses.filter((r) => r.type === "PROGRESS");
    expect(progresses.length).toBeGreaterThan(0);
    for (const p of progresses) {
      if (p.type !== "PROGRESS") continue;
      expect(p.completedP).toBeLessThanOrEqual(64);
      expect(p.completedQ).toBeLessThanOrEqual(64);
      expect(p.targetPerGroup).toBe(64);
    }
    const last = progresses[progresses.length - 1];
    if (last?.type === "PROGRESS") {
      expect(last.completedP).toBe(64);
      expect(last.completedQ).toBe(64);
    }
    // RESULT 之前不出现第二个 RESULT，且无 ERROR。
    expect(responses.filter((r) => r.type === "RESULT")).toHaveLength(1);
    expect(responses.filter((r) => r.type === "ERROR")).toHaveLength(0);
  });

  it("REPLAY: TRACE 的 101 个 sampledB 与原轨迹逐值一致", () => {
    const scenario = smallScenario();
    const times = createObservationTimes(scenario.horizon, scenario.observations);
    const original = simulateTrajectory({
      model: scenario.model,
      initialPmf: scenario.initial.Q,
      horizon: scenario.horizon,
      observationTimes: times,
      baseSeed: scenario.seed,
      group: "Q",
      trajectoryIndex: 5,
    });
    const responses = handleRequest({
      type: "REPLAY",
      runId: 2,
      scenario,
      group: "Q",
      trajectoryIndex: 5,
    });
    expect(responses).toHaveLength(1);
    const traceMsg = responses[0];
    expect(traceMsg?.type).toBe("TRACE");
    if (traceMsg?.type !== "TRACE") throw new Error("no TRACE");
    expect(traceMsg.trace.sampledB).toHaveLength(101);
    expect(traceMsg.trace.sampledB).toEqual(Array.from(original.sampledB));
    expect(traceMsg.trace.group).toBe("Q");
    expect(traceMsg.trace.trajectoryIndex).toBe(5);
  });

  it("REPLAY: 越界轨迹号只发 ERROR，不发 TRACE", () => {
    const responses = handleRequest({
      type: "REPLAY",
      runId: 3,
      scenario: smallScenario(),
      group: "P",
      trajectoryIndex: 64,
    });
    expect(responses).toHaveLength(1);
    expect(responses[0]?.type).toBe("ERROR");
  });

  it("RUN: 非法场景只发 ERROR，不发部分 RESULT", () => {
    const bad = {
      ...(smallScenario() as unknown as Record<string, unknown>),
      initial: { P: [0.5, 0.5, 0.5], Q: [0.5, 0, 0.5] },
    };
    const responses = handleRequest({ type: "RUN", runId: 4, scenario: bad as never });
    expect(responses).toHaveLength(1);
    expect(responses[0]?.type).toBe("ERROR");
    expect(responses.filter((r) => r.type === "RESULT")).toHaveLength(0);
  });

  it("RUN: 事件预算超限转为 BUDGET_EXCEEDED，不标 COMPLETE", () => {
    const responses = handleRequest(
      { type: "RUN", runId: 5, scenario: smallScenario() },
      { maxEvents: 0 },
    );
    expect(responses).toHaveLength(1);
    const error = responses[0];
    expect(error?.type).toBe("ERROR");
    if (error?.type === "ERROR") {
      expect(error.code).toBe("BUDGET_EXCEEDED");
    }
  });

  it("未知请求类型转为 INTERNAL_ERROR", () => {
    const responses = handleRequest({
      type: "BOGUS",
      runId: 6,
    } as unknown as WorkerRequest);
    expect(responses[0]?.type).toBe("ERROR");
  });
});

describe("worker client (runId / cancel / single worker)", () => {
  it("runId 严格单调，旧 run 的迟到 RESULT 被丢弃", async () => {
    FakeWorker.created = 0;
    FakeWorker.terminated = 0;
    let factoryWorker: FakeWorker | null = null;
    const client = new SimulationWorkerClient(() => {
      factoryWorker = new FakeWorker();
      return factoryWorker;
    });
    const scenario = smallScenario();
    const first = client.run(scenario);
    const firstOutcome = first.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    const firstRunId = factoryWorker!.posted[0]!.runId;
    // 第二次 run 取代第一次：旧 runId 立即失效。
    const second = client.run(scenario);
    const secondRunId = factoryWorker!.posted[0]!.runId;
    expect(secondRunId).toBeGreaterThan(firstRunId);
    expect(await firstOutcome).toBe("cancelled");
    // 旧 runId 的迟到 RESULT 不能 resolve 第二次运行。
    let secondResolved = false;
    const secondOutcome = second.then(() => {
      secondResolved = true;
    });
    factoryWorker!.emit({
      type: "RESULT",
      runId: firstRunId,
      result: undefined as never,
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    // 当前 runId 的 RESULT 才能 resolve。
    const responses = handleRequest({
      type: "RUN",
      runId: secondRunId,
      scenario,
    });
    const resultMsg = responses.find((r) => r.type === "RESULT");
    if (resultMsg?.type === "RESULT") {
      factoryWorker!.emit(resultMsg);
    }
    await secondOutcome;
    expect(secondResolved).toBe(true);
    client.dispose();
  });

  it("取消 = terminate + 新实例，旧 runId 迟到消息无效，同一时刻只活一个 Worker", () => {
    FakeWorker.created = 0;
    FakeWorker.terminated = 0;
    let current: FakeWorker | null = null;
    const client = new SimulationWorkerClient(() => {
      current = new FakeWorker();
      return current;
    });
    const scenario = smallScenario();
    const pending = client.run(scenario);
    const outcome = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    const runId = current!.posted[0]!.runId;
    expect(current!.liveCount).toBe(1);
    client.cancel();
    expect(FakeWorker.terminated).toBe(1);
    expect(current!.liveCount).toBe(1); // 新实例已创建，旧实例已 terminate
    expect(current!.alive).toBe(true);
    // 取消后旧 runId 的 RESULT 被丢弃（不会抛、不会 resolve 任何东西）。
    current!.emit({
      type: "RESULT",
      runId,
      result: undefined as never,
    });
    return expect(outcome).resolves.toBe("cancelled").then(() => {
      client.dispose();
      expect(current!.liveCount).toBe(0);
    });
  });

  it("超 M 的进度被丢弃，ERROR 使 run 拒绝且不带结果", async () => {
    let current: FakeWorker | null = null;
    const client = new SimulationWorkerClient(() => {
      current = new FakeWorker();
      return current;
    });
    const seen: number[] = [];
    client.onProgress((p) => seen.push(p.completedP));
    const scenario = smallScenario();
    const pending = client.run(scenario);
    const outcome = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    const runId = current!.posted[0]!.runId;
    current!.emit({
      type: "PROGRESS",
      runId,
      completedP: 65,
      completedQ: 0,
      targetPerGroup: 64,
    });
    expect(seen).toEqual([]);
    current!.emit({
      type: "PROGRESS",
      runId,
      completedP: 32,
      completedQ: 0,
      targetPerGroup: 64,
    });
    expect(seen).toEqual([32]);
    current!.emit({
      type: "ERROR",
      runId,
      code: "INVALID_PMF",
      message: "bad pmf",
    });
    expect(await outcome).toContain("INVALID_PMF");
    client.dispose();
  });

  it("replay 走同一 runId 协议：当前 runId 的 TRACE 才 resolve", async () => {
    let current: FakeWorker | null = null;
    const client = new SimulationWorkerClient(() => {
      current = new FakeWorker();
      return current;
    });
    const scenario = smallScenario();
    const pending = client.replay(scenario, "P", 0);
    const runId = current!.posted[0]!.runId;
    expect(current!.posted[0]).toMatchObject({
      type: "REPLAY",
      group: "P",
      trajectoryIndex: 0,
    });
    const responses = handleRequest({
      type: "REPLAY",
      runId,
      scenario,
      group: "P",
      trajectoryIndex: 0,
    });
    const traceMsg = responses[0];
    if (traceMsg?.type === "TRACE") {
      current!.emit(traceMsg);
    }
    const trace = await pending;
    expect(trace.sampledB).toHaveLength(101);
    expect(trace.group).toBe("P");
    client.dispose();
  });
});
