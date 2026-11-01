import type { ProbabilityDiagnostics, Rates } from "../domain/types";

export const UNIFORMIZATION_RATE_LIMIT = 40;
export const UNIFORMIZATION_Z_LIMIT = 8;
export const STEP_TAIL_TOLERANCE = 1e-14;
export const CUMULATIVE_TAIL_TOLERANCE = 1e-12;
export const MAX_UNIFORMIZATION_TERMS = 256;

export class NumericConvergenceError extends Error {
  readonly code = "NUMERIC_CONVERGENCE" as const;

  constructor(message: string) {
    super(message);
    this.name = "NumericConvergenceError";
  }
}

export interface UniformizationStep {
  probability: Float64Array;
  diagnostics: ProbabilityDiagnostics;
}

function validateProbability(
  probability: ArrayLike<number>,
  stateCount: number,
): void {
  if (probability.length !== stateCount) {
    throw new RangeError("probability length does not match rates");
  }

  for (let state = 0; state < probability.length; state += 1) {
    if (!Number.isFinite(probability[state]!)) {
      throw new RangeError("probability values must be finite");
    }
  }
}

function diagnostics(
  probability: Float64Array,
  cumulativeTailBound: number,
  termsUsed: number,
): ProbabilityDiagnostics {
  let probabilityMass = 0;
  let minProbability = Number.POSITIVE_INFINITY;

  for (const value of probability) {
    probabilityMass += value;
    minProbability = Math.min(minProbability, value);
  }

  return {
    cumulativeTailBound,
    probabilityMass,
    massDefect: 1 - probabilityMass,
    minProbability,
    termsUsed,
  };
}

export function multiplyByUniformizedTransition(
  vector: ArrayLike<number>,
  rates: Rates,
): Float64Array {
  const stateCount = rates.birth.length;
  validateProbability(vector, stateCount);

  if (rates.death.length !== stateCount) {
    throw new RangeError("birth and death arrays must have equal lengths");
  }

  const nu = rates.maxExitRate;
  if (nu === 0) {
    return Float64Array.from(vector);
  }
  if (!Number.isFinite(nu) || nu < 0 || nu > UNIFORMIZATION_RATE_LIMIT) {
    throw new RangeError(
      `uniformization rate must be within [0, ${UNIFORMIZATION_RATE_LIMIT}]`,
    );
  }

  const result = new Float64Array(stateCount);

  for (let state = 0; state < stateCount; state += 1) {
    const birth = rates.birth[state]!;
    const death = rates.death[state]!;
    let value = vector[state]! * (1 - (birth + death) / nu);

    if (state > 0) {
      value += vector[state - 1]! * rates.birth[state - 1]! / nu;
    }
    if (state + 1 < stateCount) {
      value += vector[state + 1]! * rates.death[state + 1]! / nu;
    }

    result[state] = value;
  }

  return result;
}

export function poissonTailBound(
  weightNPlusOne: number,
  z: number,
  n: number,
): number {
  if (n + 2 <= z) {
    return Number.POSITIVE_INFINITY;
  }

  return weightNPlusOne / (1 - z / (n + 2));
}

export function uniformizationStep(
  initial: ArrayLike<number>,
  rates: Rates,
  delta: number,
  priorCumulativeTailBound = 0,
): UniformizationStep {
  if (!Number.isFinite(delta) || delta < 0) {
    throw new RangeError("delta must be finite and non-negative");
  }

  const stateCount = rates.birth.length;
  validateProbability(initial, stateCount);

  if (rates.death.length !== stateCount) {
    throw new RangeError("birth and death arrays must have equal lengths");
  }

  const nu = rates.maxExitRate;
  if (!Number.isFinite(nu) || nu < 0 || nu > UNIFORMIZATION_RATE_LIMIT) {
    throw new RangeError(
      `uniformization rate must be within [0, ${UNIFORMIZATION_RATE_LIMIT}]`,
    );
  }

  if (nu === 0 || delta === 0) {
    const probability = Float64Array.from(initial);
    return {
      probability,
      diagnostics: diagnostics(
        probability,
        priorCumulativeTailBound,
        1,
      ),
    };
  }

  const z = nu * delta;
  if (z > UNIFORMIZATION_Z_LIMIT) {
    throw new RangeError(
      `uniformization interval requires nu * delta <= ${UNIFORMIZATION_Z_LIMIT}`,
    );
  }

  let vector: Float64Array<ArrayBufferLike> = Float64Array.from(initial);
  let weight = Math.exp(-z);
  const probability = new Float64Array(stateCount);

  for (let state = 0; state < stateCount; state += 1) {
    probability[state] = weight * vector[state]!;
  }

  for (let n = 0; n < MAX_UNIFORMIZATION_TERMS; n += 1) {
    const nextWeight = weight * z / (n + 1);
    const tailBound = poissonTailBound(nextWeight, z, n);

    if (tailBound <= STEP_TAIL_TOLERANCE) {
      const cumulativeTailBound = priorCumulativeTailBound + tailBound;
      if (cumulativeTailBound > CUMULATIVE_TAIL_TOLERANCE) {
        throw new NumericConvergenceError(
          "cumulative Poisson tail bound exceeds budget",
        );
      }

      return {
        probability,
        diagnostics: diagnostics(
          probability,
          cumulativeTailBound,
          n + 1,
        ),
      };
    }

    vector = multiplyByUniformizedTransition(vector, rates);
    weight = nextWeight;

    for (let state = 0; state < stateCount; state += 1) {
      probability[state] =
        probability[state]! + weight * vector[state]!;
    }
  }

  throw new NumericConvergenceError(
    `Poisson series did not converge within ${MAX_UNIFORMIZATION_TERMS} terms`,
  );
}

export function solveAtTime(
  initial: ArrayLike<number>,
  rates: Rates,
  time: number,
): UniformizationStep {
  if (!Number.isFinite(time) || time < 0) {
    throw new RangeError("time must be finite and non-negative");
  }

  if (time === 0 || rates.maxExitRate === 0) {
    return uniformizationStep(initial, rates, time);
  }

  const intervalCount = Math.max(
    1,
    Math.ceil((rates.maxExitRate * time) / UNIFORMIZATION_Z_LIMIT),
  );
  const delta = time / intervalCount;
  let probability: Float64Array<ArrayBufferLike> =
    Float64Array.from(initial);
  let cumulativeTailBound = 0;
  let termsUsed = 0;

  for (let interval = 0; interval < intervalCount; interval += 1) {
    const step = uniformizationStep(
      probability,
      rates,
      delta,
      cumulativeTailBound,
    );
    probability = step.probability;
    cumulativeTailBound = step.diagnostics.cumulativeTailBound;
    termsUsed += step.diagnostics.termsUsed;
  }

  return {
    probability,
    diagnostics: diagnostics(
      probability,
      cumulativeTailBound,
      termsUsed,
    ),
  };
}
