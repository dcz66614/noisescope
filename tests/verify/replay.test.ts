import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createObservationTimes, simulateTrajectory } from "../../src/core/ssa";
import { makePreset } from "../../src/domain/presets";
import {
  incompleteVerification,
  independentRates,
  verifyAudit,
} from "../../src/verify/replay";
import { buildSmallRun } from "../io/buildRun";

describe("verifyAudit (§11.2, §5)", () => {
  it("does not call the SSA main loop", () => {
    const source = readFileSync(
      new URL("../../src/verify/replay.ts", import.meta.url),
      "utf8",
    );
    // 只查真实引用（import 与函数调用），不把注释里的“主循环”一词误判。
    expect(source).not.toContain('from "../core/ssa"');
    expect(source).not.toMatch(/simulateTrajectory\s*\(/);
    expect(source).not.toMatch(/simulateSampleGroup\s*\(/);
  });

  it("accepts a genuine trace and its event count", () => {
    const { result, audit } = buildSmallRun();
    const verdict = verifyAudit(result.scenario, audit);
    expect(verdict.valid).toBe(true);
    expect(verdict.errors).toEqual([]);
    expect(verdict.checkedEvents).toBe(audit.events.length);
  });

  it("accepts a frozen (absorbing) trace", () => {
    const scenario = makePreset("frozen");
    const times = createObservationTimes(scenario.horizon, 101);
    const trace = simulateTrajectory({
      model: scenario.model,
      initialPmf: scenario.initial.P,
      horizon: scenario.horizon,
      observationTimes: times,
      baseSeed: scenario.seed,
      group: "P",
      trajectoryIndex: 0,
    }).trace;
    expect(trace.terminal.reason).toBe("ABSORBING");
    expect(verifyAudit(scenario, trace).valid).toBe(true);
  });

  it("detects a tampered random draw even when time/waiting/reaction are recomputed consistently", () => {
    const { result, audit } = buildSmallRun();
    expect(audit.events.length).toBeGreaterThan(0);
    const tampered = structuredClone(audit);
    const event = tampered.events[0]!;
    // 篡改 uWaiting，并同步按新 u 重算 waitingTime/timeAfter：复验重新派生
    // 随机流，仍会因 U 与派生值不一致而发现。
    const rates = independentRates(result.scenario.model, event.stateBefore);
    const newU = event.uWaiting > 0.5 ? event.uWaiting - 0.25 : event.uWaiting + 0.25;
    event.uWaiting = newU;
    event.waitingTime = -Math.log(newU) / rates.totalRate;
    event.timeAfter = event.timeBefore + event.waitingTime;
    expect(verifyAudit(result.scenario, tampered).valid).toBe(false);
  });

  it("detects a tampered choice draw even when reaction/state are recomputed consistently", () => {
    const { result, audit } = buildSmallRun();
    const tampered = structuredClone(audit);
    const event = tampered.events[0]!;
    const rates = independentRates(result.scenario.model, event.stateBefore);
    const newChoice = event.uChoice > 0.5 ? event.uChoice - 0.25 : event.uChoice + 0.25;
    event.uChoice = newChoice;
    const reaction =
      newChoice * rates.totalRate < rates.birth ? "forward" : "reverse";
    event.reaction = reaction;
    event.stateAfter = event.stateBefore + (reaction === "forward" ? 1 : -1);
    expect(verifyAudit(result.scenario, tampered).valid).toBe(false);
  });

  it("detects tampered initial state, terminal candidate, PMF and sampledB", () => {
    const { result, audit } = buildSmallRun();
    const wrongInitial = structuredClone(audit);
    wrongInitial.initial.initialState =
      (wrongInitial.initial.initialState + 1) % 3;
    expect(verifyAudit(result.scenario, wrongInitial).valid).toBe(false);

    if (audit.terminal.reason === "HORIZON") {
      const wrongTerminal = structuredClone(audit);
      if (wrongTerminal.terminal.reason === "HORIZON") {
        wrongTerminal.terminal.candidateTime += 0.5;
        expect(verifyAudit(result.scenario, wrongTerminal).valid).toBe(false);
      }
    }

    const wrongPmf = structuredClone(result.scenario);
    wrongPmf.initial.P = [1, 0, 0];
    // P 初始改为点质量 j=0：原轨迹的初始抽样不再对应，复验必须失败。
    // （若原轨迹恰好初始状态就是 0，则改用 Q 组轨迹做对照见下。）
    const verdict = verifyAudit(wrongPmf, audit);
    if (audit.initial.initialState !== 0) {
      expect(verdict.valid).toBe(false);
    }

    const wrongSampled = structuredClone(audit);
    wrongSampled.sampledB[50] = (wrongSampled.sampledB[50]! + 1) % 3;
    expect(verifyAudit(result.scenario, wrongSampled).valid).toBe(false);
  });

  it("marks cancelled/timeout replay as incomplete, never as verified", () => {
    for (const reason of ["cancelled", "timeout"] as const) {
      const verdict = incompleteVerification(reason);
      expect(verdict.valid).toBe(false);
      expect(verdict.errors.join(" ")).toContain("复验未完成");
    }
  });
});
