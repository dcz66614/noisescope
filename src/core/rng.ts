export interface RandomSource {
  nextUint32(): number;
  nextOpen01(): number;
}

const UINT32_RANGE = 0x1_0000_0000;
const NONZERO_FALLBACK = 0x6d2b79f5;

export class XorShift32 implements RandomSource {
  private state: number;

  constructor(seed: number) {
    const normalized = seed >>> 0;
    this.state = normalized === 0 ? NONZERO_FALLBACK : normalized;
  }

  nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  nextOpen01(): number {
    return (this.nextUint32() + 0.5) / UINT32_RANGE;
  }
}

function mixUint32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x85ebca6b);
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, 0xc2b2ae35);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

export function deriveTrajectorySeed(
  baseSeed: number,
  group: "P" | "Q",
  trajectoryIndex: number,
): number {
  if (!Number.isSafeInteger(trajectoryIndex) || trajectoryIndex < 0) {
    throw new RangeError("trajectoryIndex must be a non-negative safe integer");
  }

  const groupSalt = group === "P" ? 0xa341316c : 0xc8013ea4;
  const state = mixUint32(
    (baseSeed >>> 0) ^
      groupSalt ^
      Math.imul(trajectoryIndex + 1, 0x9e3779b9),
  );
  return state === 0 ? NONZERO_FALLBACK : state;
}

export function createTrajectoryRng(
  baseSeed: number,
  group: "P" | "Q",
  trajectoryIndex: number,
): XorShift32 {
  return new XorShift32(deriveTrajectorySeed(baseSeed, group, trajectoryIndex));
}
