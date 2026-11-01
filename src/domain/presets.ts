// P006 T002 — 三个预置（项目书 §4.1、§9、§12.1、§13）
//
// 预置名称即 UI 预置选择中的三项：同均值不同走势、线性对照、零速率冻结。
// 标题只是展示文本，不是计算参数（§12.2）；计算字段（模型、速率、
// 初始 PMF、T、M、seed）全部取自规格，不由施工者自创。
// 所有预置共用：horizon 8，observations 101，trajectoriesPerGroup 512，
// seed 20261031，rngVersion "xorshift32-v1"。

import { stateCountForModel, type PresetId, type ScenarioV1 } from "./types";
import { validateScenario } from "./validate";

function pmfWith(
  stateCount: number,
  entries: ReadonlyArray<readonly [index: number, probability: number]>,
): number[] {
  const pmf = new Array<number>(stateCount).fill(0);
  for (const [index, probability] of entries) {
    if (index < 0 || index >= stateCount) {
      throw new Error(`preset PMF index out of range: ${index}`);
    }
    pmf[index] = probability;
  }
  return pmf;
}

function buildPreset(scenario: ScenarioV1): ScenarioV1 {
  // 预置本身也要过同一校验，确保 fixtures 与 makePreset 永远合法。
  return validateScenario(scenario);
}

/**
 * variance-split（默认二聚，同均值不同走势）：
 * dimer N=20，kf=0.02，kb=0.2；S=11；P 在 j=5 取概率 1；
 * Q 在 j=0 与 j=10 各取 0.5；两组初始均值均为 5。
 */
function varianceSplit(): ScenarioV1 {
  const model = { id: "dimer" as const, totalUnits: 20, forwardRate: 0.02, reverseRate: 0.2 };
  const s = stateCountForModel(model); // 11
  return buildPreset({
    schemaVersion: 1,
    projectId: "P006",
    title: "同均值不同走势",
    model,
    initial: {
      P: pmfWith(s, [[5, 1]]),
      Q: pmfWith(s, [
        [0, 0.5],
        [10, 0.5],
      ]),
    },
    horizon: 8,
    observations: 101,
    trajectoriesPerGroup: 512,
    seed: 20261031,
    rngVersion: "xorshift32-v1",
  });
}

/**
 * linear-control（线性对照）：
 * linear N=20，kf=0.15，kb=0.1；S=21；P 在 j=10 取概率 1；
 * Q 在 j=0 与 j=20 各取 0.5；两组初始均值均为 10。
 */
function linearControl(): ScenarioV1 {
  const model = { id: "linear" as const, totalUnits: 20, forwardRate: 0.15, reverseRate: 0.1 };
  const s = stateCountForModel(model); // 21
  return buildPreset({
    schemaVersion: 1,
    projectId: "P006",
    title: "线性对照",
    model,
    initial: {
      P: pmfWith(s, [[10, 1]]),
      Q: pmfWith(s, [
        [0, 0.5],
        [20, 0.5],
      ]),
    },
    horizon: 8,
    observations: 101,
    trajectoriesPerGroup: 512,
    seed: 20261031,
    rngVersion: "xorshift32-v1",
  });
}

/**
 * frozen（零速率冻结，G06）：
 * 与 variance-split 相同的初始分布与规模，但 kf=kb=0，
 * 故全部分布、轨迹、均值应保持初始状态。
 */
function frozen(): ScenarioV1 {
  const model = { id: "dimer" as const, totalUnits: 20, forwardRate: 0, reverseRate: 0 };
  const s = stateCountForModel(model); // 11
  return buildPreset({
    schemaVersion: 1,
    projectId: "P006",
    title: "零速率冻结",
    model,
    initial: {
      P: pmfWith(s, [[5, 1]]),
      Q: pmfWith(s, [
        [0, 0.5],
        [10, 0.5],
      ]),
    },
    horizon: 8,
    observations: 101,
    trajectoriesPerGroup: 512,
    seed: 20261031,
    rngVersion: "xorshift32-v1",
  });
}

export function makePreset(id: PresetId): ScenarioV1 {
  switch (id) {
    case "variance-split":
      return varianceSplit();
    case "linear-control":
      return linearControl();
    case "frozen":
      return frozen();
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown preset id: ${String(exhaustive)}`);
    }
  }
}
