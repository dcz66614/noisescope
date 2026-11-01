import type { ModelSpec, Rates } from "../domain/types";

export function stateCount(model: ModelSpec): number {
  return model.id === "linear"
    ? model.totalUnits + 1
    : Math.floor(model.totalUnits / 2) + 1;
}

export function buildRates(model: ModelSpec): Rates {
  const count = stateCount(model);
  const birth = new Float64Array(count);
  const death = new Float64Array(count);
  let maxExitRate = 0;

  for (let state = 0; state < count; state += 1) {
    if (model.id === "linear") {
      birth[state] = model.forwardRate * (model.totalUnits - state);
    } else {
      const countA = model.totalUnits - 2 * state;
      birth[state] =
        model.forwardRate * countA * Math.max(0, countA - 1) * 0.5;
    }

    death[state] = model.reverseRate * state;

    if (state === count - 1) {
      birth[state] = 0;
    }
    if (state === 0) {
      death[state] = 0;
    }

    maxExitRate = Math.max(maxExitRate, birth[state]! + death[state]!);
  }

  return { birth, death, maxExitRate };
}

export function generatorRows(rates: Rates): Float64Array[] {
  const count = rates.birth.length;
  const rows = Array.from(
    { length: count },
    () => new Float64Array(count),
  );

  for (let state = 0; state < count; state += 1) {
    const birth = rates.birth[state]!;
    const death = rates.death[state]!;

    rows[state]![state] = -(birth + death);
    if (state + 1 < count) {
      rows[state]![state + 1] = birth;
    }
    if (state > 0) {
      rows[state]![state - 1] = death;
    }
  }

  return rows;
}
