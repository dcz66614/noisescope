// T007 测试辅助：直接调用核心生成完整 RunResult（任务卡明确允许
// T007 单测这样做；T013 再证明正式导入走生产 Worker）。
import type { AuditTrace, RunResult, ScenarioV1 } from "../../src/domain/types";
import { validateScenario } from "../../src/domain/validate";
import { solveReference } from "../../src/core/reference";
import {
  createObservationTimes,
  simulateSampleGroup,
  simulateTrajectory,
} from "../../src/core/ssa";

export function smallScenario(): ScenarioV1 {
  return validateScenario({
    schemaVersion: 1,
    projectId: "P006",
    title: "T007 最小证据",
    model: { id: "dimer", totalUnits: 4, forwardRate: 0.02, reverseRate: 0.2 },
    initial: { P: [0, 1, 0], Q: [0.5, 0, 0.5] },
    horizon: 1,
    observations: 101,
    trajectoriesPerGroup: 64,
    seed: 20261031,
    rngVersion: "xorshift32-v1",
  });
}

export function buildSmallRun(): { result: RunResult; audit: AuditTrace } {
  const scenario = smallScenario();
  const times = createObservationTimes(scenario.horizon, scenario.observations);
  const result: RunResult = {
    runId: 1,
    scenario,
    stateCount: 3,
    times,
    reference: {
      P: solveReference(scenario, "P"),
      Q: solveReference(scenario, "Q"),
    },
    sample: {
      P: simulateSampleGroup({
        model: scenario.model,
        initialPmf: scenario.initial.P,
        horizon: scenario.horizon,
        observationTimes: times,
        trajectories: scenario.trajectoriesPerGroup,
        baseSeed: scenario.seed,
        group: "P",
      }),
      Q: simulateSampleGroup({
        model: scenario.model,
        initialPmf: scenario.initial.Q,
        horizon: scenario.horizon,
        observationTimes: times,
        trajectories: scenario.trajectoriesPerGroup,
        baseSeed: scenario.seed,
        group: "Q",
      }),
    },
    engineVersion: "1.0.0",
    status: "COMPLETE",
    elapsedMs: 0,
    timings: { referenceMs: 0, ssaMs: 0 },
  };
  const audit = simulateTrajectory({
    model: scenario.model,
    initialPmf: scenario.initial.P,
    horizon: scenario.horizon,
    observationTimes: times,
    baseSeed: scenario.seed,
    group: "P",
    trajectoryIndex: 0,
  }).trace;
  return { result, audit };
}

export function testMeta(): {
  createdAt: string;
  displayTitle: string;
  userAgent: string;
  platform: string;
  dependencyVersions: Record<string, string>;
  elapsedMs: number;
} {
  return {
    createdAt: "2026-10-31T00:00:00.000Z",
    displayTitle: "T007 最小证据",
    userAgent: "vitest",
    platform: "node",
    dependencyVersions: { react: "19.3.1", typescript: "5.9.3" },
    elapsedMs: 0,
  };
}
