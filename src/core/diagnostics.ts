import type { ReferenceGroup, SampleGroup } from "../domain/types";

export function computeCdfDistance(
  counts: ArrayLike<number>,
  probabilities: ArrayLike<number>,
  sampleCount: number,
): number {
  if (counts.length !== probabilities.length) {
    throw new RangeError("counts and probabilities must have equal lengths");
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new RangeError("sampleCount must be a non-negative integer");
  }
  if (sampleCount === 0) {
    return 0;
  }

  let empiricalCdf = 0;
  let referenceCdf = 0;
  let distance = 0;

  for (let state = 0; state < counts.length; state += 1) {
    const count = counts[state]!;
    const probability = probabilities[state]!;
    if (
      !Number.isFinite(count) ||
      count < 0 ||
      !Number.isFinite(probability)
    ) {
      throw new RangeError("counts and probabilities must be finite");
    }
    empiricalCdf += count / sampleCount;
    referenceCdf += probability;
    distance = Math.max(distance, Math.abs(empiricalCdf - referenceCdf));
  }

  return distance;
}

export function computeComparisonSeries(
  reference: ReferenceGroup,
  sample: SampleGroup,
  stateCount: number,
): {
  meanGap: Float64Array;
  samplingError: Float64Array;
  cdfDistance: Float64Array;
  driftCorrection: Float64Array;
} {
  if (!Number.isInteger(stateCount) || stateCount <= 0) {
    throw new RangeError("stateCount must be a positive integer");
  }

  const observationCount = reference.meanB.length;
  if (
    reference.closureMeanB.length !== observationCount ||
    reference.driftCorrection.length !== observationCount ||
    sample.meanB.length !== observationCount ||
    reference.pmf.length !== observationCount * stateCount ||
    sample.counts.length !== observationCount * stateCount
  ) {
    throw new RangeError("comparison series dimensions do not match");
  }

  const meanGap = new Float64Array(observationCount);
  const samplingError = new Float64Array(observationCount);
  const cdfDistance = new Float64Array(observationCount);

  for (let timeIndex = 0; timeIndex < observationCount; timeIndex += 1) {
    meanGap[timeIndex] =
      reference.meanB[timeIndex]! - reference.closureMeanB[timeIndex]!;
    samplingError[timeIndex] =
      sample.meanB[timeIndex]! - reference.meanB[timeIndex]!;

    const offset = timeIndex * stateCount;
    cdfDistance[timeIndex] = computeCdfDistance(
      sample.counts.subarray(offset, offset + stateCount),
      reference.pmf.subarray(offset, offset + stateCount),
      sample.completed,
    );
  }

  return {
    meanGap,
    samplingError,
    cdfDistance,
    driftCorrection: reference.driftCorrection,
  };
}
