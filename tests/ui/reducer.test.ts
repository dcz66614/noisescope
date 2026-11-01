// P006 T009 — 界面状态机测试（项目书 §9、实施计划 T009）。
// 只测 reducer（纯函数），不测 React 渲染、不测 Worker、不测 mock 截图。
import { describe, expect, it } from "vitest";
import {
  canonicalInitial,
  initialState,
  pmfMean,
  pmfVariance,
  reducer,
  type AppState,
} from "../../src/app/reducer";

function completedState(): AppState {
  // 冻结前修复：MOCK_COMPLETE 已删除，完成改走真实 RUN_COMPLETE（无 result 时
  // 仅置状态并以当前场景作快照，足够覆盖过期/非计算参数的语义）。
  const ready = initialState("variance-split");
  const running = reducer(ready, { type: "RUN_REQUESTED" });
  return reducer(running, { type: "RUN_COMPLETE" });
}

describe("initial state", () => {
  it("starts READY with the variance-split preset", () => {
    const state = initialState("variance-split");
    expect(state.status).toBe("READY");
    expect(state.scenario.model.id).toBe("dimer");
    expect(state.scenario.model.totalUnits).toBe(20);
    expect(state.scenario.initial.P).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
    expect(state.timeIndex).toBe(0);
    expect(state.error).toBeNull();
  });

  it("reports PMF mean and variance for the preset groups", () => {
    const state = initialState("variance-split");
    expect(pmfMean(state.scenario.initial.P)).toBe(5);
    expect(pmfVariance(state.scenario.initial.P)).toBe(0);
    expect(pmfMean(state.scenario.initial.Q)).toBe(5);
    expect(pmfVariance(state.scenario.initial.Q)).toBe(25);
  });
});

describe("run status transitions", () => {
  it("observes READY -> RUNNING -> COMPLETE -> STALE -> RUNNING -> CANCELLED", () => {
    let state = initialState();
    expect(state.status).toBe("READY");
    state = reducer(state, { type: "RUN_REQUESTED" });
    expect(state.status).toBe("RUNNING");
    state = reducer(state, { type: "RUN_COMPLETE" });
    expect(state.status).toBe("COMPLETE");
    expect(state.isMockResult).toBe(false);
    expect(state.lastRunScenario).not.toBeNull();
    // 计算参数变更使旧结果过期。
    state = reducer(state, { type: "UPDATE_SEED", seed: 123 });
    expect(state.status).toBe("STALE");
    state = reducer(state, { type: "RUN_REQUESTED" });
    expect(state.status).toBe("RUNNING");
    state = reducer(state, { type: "CANCEL" });
    expect(state.status).toBe("CANCELLED");
  });

  it("does not complete unless running, and does not cancel unless running", () => {
    const ready = initialState();
    expect(reducer(ready, { type: "RUN_COMPLETE" }).status).toBe("READY");
    expect(reducer(ready, { type: "CANCEL" }).status).toBe("READY");
  });

  it("reports ERROR and preserves the scenario on failure", () => {
    const running = reducer(initialState(), { type: "RUN_REQUESTED" });
    const failed = reducer(running, {
      type: "RUN_FAILED",
      message: "worker crashed",
    });
    expect(failed.status).toBe("ERROR");
    expect(failed.error).toBe("worker crashed");
    expect(failed.scenario).toEqual(initialState().scenario);
    const cleared = reducer(failed, { type: "CLEAR_ERROR" });
    expect(cleared.error).toBeNull();
    expect(cleared.scenario).toEqual(initialState().scenario);
  });
});

describe("non-compute parameters never expire a result", () => {
  it("title change keeps COMPLETE and does not clear the run snapshot", () => {
    const completed = completedState();
    const renamed = reducer(completed, {
      type: "UPDATE_TITLE",
      title: "改名而已",
    });
    expect(renamed.status).toBe("COMPLETE");
    expect(renamed.scenario.title).toBe("改名而已");
    expect(renamed.lastRunScenario).toEqual(completed.lastRunScenario);
  });

  it("time cursor change keeps COMPLETE, clamps, and never re-runs", () => {
    const completed = completedState();
    const moved = reducer(completed, { type: "SET_TIME_INDEX", timeIndex: 42 });
    expect(moved.status).toBe("COMPLETE");
    expect(moved.timeIndex).toBe(42);
    expect(reducer(moved, { type: "SET_TIME_INDEX", timeIndex: 999 }).timeIndex).toBe(100);
    expect(reducer(moved, { type: "SET_TIME_INDEX", timeIndex: -3 }).timeIndex).toBe(0);
  });
});

describe("compute parameter changes expire a result", () => {
  it.each([
    ["seed", { type: "UPDATE_SEED", seed: 7 } as const],
    ["horizon", { type: "UPDATE_HORIZON", horizon: 4 } as const],
    ["trajectories", { type: "UPDATE_TRAJECTORIES", trajectoriesPerGroup: 64 } as const],
    ["rates", { type: "UPDATE_RATES", reverseRate: 0.3 } as const],
  ])("%s change expires COMPLETE to STALE", (_label, action) => {
    const completed = completedState();
    const next = reducer(completed, action);
    expect(next.status).toBe("STALE");
    expect(next.lastRunScenario).toEqual(completed.lastRunScenario);
  });

  it("preset change expires COMPLETE to STALE and swaps the scenario", () => {
    const completed = completedState();
    const next = reducer(completed, {
      type: "SELECT_PRESET",
      presetId: "linear-control",
    });
    expect(next.status).toBe("STALE");
    expect(next.scenario.model.id).toBe("linear");
    expect(next.presetId).toBe("linear-control");
  });
});

describe("model and PMF editing", () => {
  it("model/N change rebuilds a legal equal-mean PMF and reports the reset", () => {
    const state = reducer(initialState("linear-control"), {
      type: "UPDATE_MODEL",
      modelId: "dimer",
      totalUnits: 20,
    });
    // 线性 kf 0.15 超出二聚上限 0.05，应被钳制并说明。
    expect(state.scenario.model.forwardRate).toBe(0.05);
    expect(state.scenario.initial).toEqual(
      canonicalInitial({ id: "dimer", totalUnits: 20 }),
    );
    expect(state.notice).toContain("已重置初始分布");
    expect(state.notice).toContain("钳制");
  });

  it("point and two-point PMF edits keep equal means when chosen so", () => {
    let state = initialState("variance-split");
    state = reducer(state, {
      type: "UPDATE_PMF",
      group: "P",
      mode: "two-point",
      lowIndex: 0,
      highIndex: 10,
      lowWeight: 0.5,
    });
    expect(state.error).toBeNull();
    expect(state.scenario.initial.P[0]).toBe(0.5);
    expect(state.scenario.initial.P[10]).toBe(0.5);
    expect(pmfMean(state.scenario.initial.P)).toBe(5);
    state = reducer(state, {
      type: "UPDATE_PMF",
      group: "Q",
      mode: "point",
      pointIndex: 5,
    });
    expect(state.scenario.initial.Q[5]).toBe(1);
  });

  it("restore preset PMF resets to the canonical equal-mean distribution", () => {
    let state = initialState("variance-split");
    state = reducer(state, {
      type: "UPDATE_PMF",
      group: "P",
      mode: "point",
      pointIndex: 0,
    });
    expect(state.scenario.initial.P[0]).toBe(1);
    state = reducer(state, { type: "RESTORE_PRESET_PMF" });
    expect(state.scenario.initial.P).toEqual(
      canonicalInitial(state.scenario.model).P,
    );
    expect(state.notice).toContain("已恢复同均值预置");
  });
});

describe("input errors preserve the original configuration", () => {
  it("invalid rate, horizon, seed, N and PMF keep the original scenario", () => {
    const original = initialState("variance-split");
    const cases = [
      reducer(original, { type: "UPDATE_RATES", forwardRate: 99 }),
      reducer(original, { type: "UPDATE_HORIZON", horizon: 100 }),
      reducer(original, { type: "UPDATE_SEED", seed: -1 }),
      reducer(original, {
        type: "UPDATE_MODEL",
        modelId: "dimer",
        totalUnits: 22,
      }),
      reducer(original, {
        type: "UPDATE_PMF",
        group: "P",
        mode: "two-point",
        lowIndex: 3,
        highIndex: 3,
        lowWeight: 0.5,
      }),
      reducer(original, {
        type: "UPDATE_PMF",
        group: "P",
        mode: "point",
        pointIndex: 99,
      }),
      reducer(original, { type: "UPDATE_TITLE", title: "" }),
    ];
    for (const next of cases) {
      expect(next.error).not.toBeNull();
      expect(next.scenario).toEqual(original.scenario);
    }
  });
});
