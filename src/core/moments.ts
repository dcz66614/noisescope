import type { ModelSpec, Rates } from "../domain/types";

export interface DistributionMoments {
  meanB: number;
  varianceB: number;
  meanA: number;
  varianceA: number;
  meanBirthRate: number;
  meanDeathRate: number;
  exactDrift: number;
}

export function computeMoments(
  probability: ArrayLike<number>,
  model: ModelSpec,
  rates: Rates,
): DistributionMoments {
  if (
    probability.length !== rates.birth.length ||
    probability.length !== rates.death.length
  ) {
    throw new RangeError("probability length does not match rates");
  }

  let meanB = 0;
  let secondMomentB = 0;
  let meanBirthRate = 0;
  let meanDeathRate = 0;

  for (let state = 0; state < probability.length; state += 1) {
    const mass = probability[state]!;
    if (!Number.isFinite(mass)) {
      throw new RangeError("probability values must be finite");
    }
    meanB += state * mass;
    secondMomentB += state * state * mass;
    meanBirthRate += rates.birth[state]! * mass;
    meanDeathRate += rates.death[state]! * mass;
  }

  const varianceB = secondMomentB - meanB * meanB;
  const stoichiometry = model.id === "linear" ? 1 : 2;
  const meanA = model.totalUnits - stoichiometry * meanB;
  const varianceA = stoichiometry * stoichiometry * varianceB;

  return {
    meanB,
    varianceB,
    meanA,
    varianceA,
    meanBirthRate,
    meanDeathRate,
    exactDrift: meanBirthRate - meanDeathRate,
  };
}

export function populationMeanAndVariance(
  values: ArrayLike<number>,
): { mean: number; variance: number } {
  if (values.length === 0) {
    return { mean: 0, variance: 0 };
  }

  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!Number.isFinite(value)) {
      throw new RangeError("sample values must be finite");
    }
    sum += value;
    sumSquares += value * value;
  }

  const mean = sum / values.length;
  return {
    mean,
    variance: sumSquares / values.length - mean * mean,
  };
}
