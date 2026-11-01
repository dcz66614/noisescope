import type {
  GroupId,
  ReferenceGroup,
  ScenarioV1,
} from "../domain/types";
import { buildRates } from "./generator";
import { closureDrift, solveClosure } from "./closure";
import { computeMoments } from "./moments";
import { solveAtTime } from "./uniformization";

export function solveReference(
  scenario: ScenarioV1,
  group: GroupId,
): ReferenceGroup {
  const rates = buildRates(scenario.model);
  const stateCount = rates.birth.length;
  const observationCount = scenario.observations;
  const pmf = new Float64Array(observationCount * stateCount);
  const meanB = new Float64Array(observationCount);
  const varianceB = new Float64Array(observationCount);
  const meanA = new Float64Array(observationCount);
  const varianceA = new Float64Array(observationCount);
  const meanBirthRate = new Float64Array(observationCount);
  const meanDeathRate = new Float64Array(observationCount);
  const exactDrift = new Float64Array(observationCount);
  const closureDriftAtExactMean = new Float64Array(observationCount);
  const driftCorrection = new Float64Array(observationCount);
  const closureMeanB = solveClosure(scenario, group);
  const numerical = [];
  const initial = scenario.initial[group];

  for (let timeIndex = 0; timeIndex < observationCount; timeIndex += 1) {
    const time =
      (scenario.horizon * timeIndex) / (observationCount - 1);
    const solved = solveAtTime(initial, rates, time);
    const offset = timeIndex * stateCount;
    pmf.set(solved.probability, offset);
    numerical.push(solved.diagnostics);

    const moments = computeMoments(
      solved.probability,
      scenario.model,
      rates,
    );
    meanB[timeIndex] = moments.meanB;
    varianceB[timeIndex] = moments.varianceB;
    meanA[timeIndex] = moments.meanA;
    varianceA[timeIndex] = moments.varianceA;
    meanBirthRate[timeIndex] = moments.meanBirthRate;
    meanDeathRate[timeIndex] = moments.meanDeathRate;
    exactDrift[timeIndex] = moments.exactDrift;
    closureDriftAtExactMean[timeIndex] = closureDrift(
      scenario.model,
      moments.meanB,
    );
    driftCorrection[timeIndex] =
      exactDrift[timeIndex]! - closureDriftAtExactMean[timeIndex]!;
  }

  return {
    pmf,
    meanB,
    varianceB,
    meanA,
    varianceA,
    meanBirthRate,
    meanDeathRate,
    exactDrift,
    closureDriftAtExactMean,
    driftCorrection,
    closureMeanB,
    numerical,
  };
}
