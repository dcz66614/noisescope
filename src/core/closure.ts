import type { GroupId, ModelSpec, ScenarioV1 } from "../domain/types";
import { NumericConvergenceError } from "./uniformization";

const MAX_RK4_STEP = 0.01;
const PHYSICAL_TOLERANCE = 1e-10;

export function closureDrift(model: ModelSpec, meanB: number): number {
  if (!Number.isFinite(meanB)) {
    throw new RangeError("meanB must be finite");
  }

  if (model.id === "linear") {
    return (
      model.forwardRate * model.totalUnits -
      (model.forwardRate + model.reverseRate) * meanB
    );
  }

  const meanA = model.totalUnits - 2 * meanB;
  return (
    0.5 * model.forwardRate * meanA * (meanA - 1) -
    model.reverseRate * meanB
  );
}

function initialMean(initial: ArrayLike<number>): number {
  let mean = 0;
  for (let state = 0; state < initial.length; state += 1) {
    mean += state * initial[state]!;
  }
  return mean;
}

function validateMean(model: ModelSpec, meanB: number): void {
  const upperBound =
    model.id === "linear" ? model.totalUnits : model.totalUnits / 2;
  if (
    !Number.isFinite(meanB) ||
    meanB < -PHYSICAL_TOLERANCE ||
    meanB > upperBound + PHYSICAL_TOLERANCE
  ) {
    throw new NumericConvergenceError(
      "closure mean left the physical interval",
    );
  }
}

function rk4Step(model: ModelSpec, value: number, step: number): number {
  const k1 = closureDrift(model, value);
  const k2 = closureDrift(model, value + 0.5 * step * k1);
  const k3 = closureDrift(model, value + 0.5 * step * k2);
  const k4 = closureDrift(model, value + step * k3);
  return value + (step / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
}

export function solveClosureWithMaxStep(
  scenario: ScenarioV1,
  group: GroupId,
  maxStep: number,
): Float64Array {
  if (!Number.isFinite(maxStep) || maxStep <= 0) {
    throw new RangeError("maxStep must be finite and positive");
  }

  const result = new Float64Array(scenario.observations);
  const initial = scenario.initial[group];
  const initialValue = initialMean(initial);
  result[0] = initialValue;

  if (scenario.model.id === "linear") {
    const totalRate =
      scenario.model.forwardRate + scenario.model.reverseRate;
    if (totalRate === 0) {
      result.fill(initialValue);
      return result;
    }

    const equilibrium =
      (scenario.model.forwardRate * scenario.model.totalUnits) / totalRate;
    for (let index = 1; index < result.length; index += 1) {
      const time =
        (scenario.horizon * index) / (scenario.observations - 1);
      result[index] =
        equilibrium + (initialValue - equilibrium) * Math.exp(-totalRate * time);
      validateMean(scenario.model, result[index]!);
    }
    return result;
  }

  const observationDelta =
    scenario.horizon / (scenario.observations - 1);
  const substeps = Math.max(1, Math.ceil(observationDelta / maxStep));
  const step = observationDelta / substeps;
  let value = initialValue;
  validateMean(scenario.model, value);

  for (let index = 1; index < result.length; index += 1) {
    for (let substep = 0; substep < substeps; substep += 1) {
      value = rk4Step(scenario.model, value, step);
      validateMean(scenario.model, value);
    }
    result[index] = value;
  }

  return result;
}

export function solveClosure(
  scenario: ScenarioV1,
  group: GroupId,
): Float64Array {
  return solveClosureWithMaxStep(scenario, group, MAX_RK4_STEP);
}
