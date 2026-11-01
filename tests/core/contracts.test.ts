// P006 T002 合同测试（项目书 §4、§11、§12）
// 只测类型、校验、预置与文件格式；不测 SSA、CME、闭合、UI（后续任务）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makePreset } from "../../src/domain/presets";
import {
  parseScenario,
  ScenarioValidationError,
  serializeScenario,
  validateScenario,
} from "../../src/domain/validate";
import type { ScenarioV1 } from "../../src/domain/types";

function meanOf(pmf: number[]): number {
  return pmf.reduce((sum, p, j) => sum + p * j, 0);
}

function baseScenario(): ScenarioV1 {
  return makePreset("variance-split");
}

function withChange(
  mutate: (s: Record<string, unknown>) => void,
): Record<string, unknown> {
  const s = JSON.parse(serializeScenario(baseScenario())) as Record<string, unknown>;
  mutate(s);
  return s;
}

function expectInvalid(
  input: unknown,
  field: string,
  code?: string,
): void {
  let caught: unknown;
  try {
    validateScenario(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ScenarioValidationError);
  const error = caught as ScenarioValidationError;
  expect(error.field).toBe(field);
  expect(error.message.length).toBeGreaterThan(0);
  if (code !== undefined) {
    expect(error.code).toBe(code);
  }
}

describe("P006 T002 presets", () => {
  it("variance-split: dimer length 11, both groups mean 5", () => {
    const s = makePreset("variance-split");
    expect(s.model).toEqual({
      id: "dimer",
      totalUnits: 20,
      forwardRate: 0.02,
      reverseRate: 0.2,
    });
    expect(s.initial.P).toHaveLength(11);
    expect(s.initial.Q).toHaveLength(11);
    expect(meanOf(s.initial.P)).toBeCloseTo(5, 12);
    expect(meanOf(s.initial.Q)).toBeCloseTo(5, 12);
    expect(s.initial.P[5]).toBe(1);
    expect(s.initial.Q[0]).toBe(0.5);
    expect(s.initial.Q[10]).toBe(0.5);
    expect(s.horizon).toBe(8);
    expect(s.observations).toBe(101);
    expect(s.trajectoriesPerGroup).toBe(512);
    expect(s.seed).toBe(20261031);
  });

  it("linear-control: linear length 21, both groups mean 10", () => {
    const s = makePreset("linear-control");
    expect(s.model).toEqual({
      id: "linear",
      totalUnits: 20,
      forwardRate: 0.15,
      reverseRate: 0.1,
    });
    expect(s.initial.P).toHaveLength(21);
    expect(s.initial.Q).toHaveLength(21);
    expect(meanOf(s.initial.P)).toBeCloseTo(10, 12);
    expect(meanOf(s.initial.Q)).toBeCloseTo(10, 12);
    expect(s.initial.P[10]).toBe(1);
    expect(s.initial.Q[0]).toBe(0.5);
    expect(s.initial.Q[20]).toBe(0.5);
  });

  it("frozen: zero rates, same initial distribution as variance-split", () => {
    const s = makePreset("frozen");
    expect(s.model.forwardRate).toBe(0);
    expect(s.model.reverseRate).toBe(0);
    expect(s.model.id).toBe("dimer");
    expect(s.initial.P).toEqual(makePreset("variance-split").initial.P);
    expect(s.initial.Q).toEqual(makePreset("variance-split").initial.Q);
  });

  it("all presets pass validation and round-trip through serialize/parse", () => {
    for (const id of ["variance-split", "linear-control", "frozen"] as const) {
      const s = makePreset(id);
      expect(parseScenario(serializeScenario(s))).toEqual(s);
    }
  });

  it("fixtures on disk parse to the same presets", () => {
    const here = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
    const cases: Array<[string, string]> = [
      ["variance-split.json", "variance-split"],
      ["linear-control.json", "linear-control"],
      ["frozen.json", "frozen"],
    ];
    for (const [file, id] of cases) {
      const text = readFileSync(join(here, "fixtures", file), "utf8");
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(32 * 1024);
      expect(parseScenario(text)).toEqual(makePreset(id as never));
    }
  });
});

describe("P006 T002 validation: acceptance", () => {
  it("does not mutate input and does not share array references", () => {
    const input = JSON.parse(
      serializeScenario(baseScenario()),
    ) as Record<string, unknown>;
    const before = JSON.stringify(input);
    const out = validateScenario(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(out).not.toBe(input);
    const initial = input.initial as { P: number[] };
    const outInitial = out.initial;
    expect(outInitial.P).not.toBe(initial.P);
    outInitial.P[5] = 0;
    expect(initial.P[5]).toBe(1);
  });

  it("preserves a PMF sum inside tolerance without renormalizing", () => {
    const input = withChange((s) => {
      const initial = s.initial as { P: number[]; Q: number[] };
      initial.P[5] = 1 + 5e-13;
    });
    const out = validateScenario(input);
    expect(out.initial.P[5]).toBe(1 + 5e-13);
  });
});

describe("P006 T002 validation: rejections carry code and field", () => {
  it("rejects non-object inputs", () => {
    expectInvalid(null, "");
    expectInvalid([], "");
    expectInvalid("x", "");
  });

  it("rejects wrong schema version and project id", () => {
    expectInvalid(withChange((s) => { s.schemaVersion = 2; }), "schemaVersion", "VERSION_UNSUPPORTED");
    expectInvalid(withChange((s) => { s.schemaVersion = "1"; }), "schemaVersion", "INVALID_SCHEMA");
    expectInvalid(withChange((s) => { s.projectId = "P005"; }), "projectId", "INVALID_SCHEMA");
    expectInvalid(withChange((s) => { s.rngVersion = "xorshift32-v2"; }), "rngVersion", "INVALID_SCHEMA");
  });

  it("rejects bad titles: empty, too long, non-string", () => {
    expectInvalid(withChange((s) => { s.title = ""; }), "title");
    expectInvalid(withChange((s) => { s.title = "a".repeat(81); }), "title");
    expectInvalid(withChange((s) => { s.title = 42; }), "title");
    // 80 个 Unicode 码点（非 UTF-16 单元）应通过：用 80 个 emoji
    const ok = withChange((s) => { s.title = "🧪".repeat(80); });
    expect(validateScenario(ok).title).toBe("🧪".repeat(80));
  });

  it("rejects illegal model: id, N, rates", () => {
    expectInvalid(
      withChange((s) => {
        (s.model as Record<string, unknown>).id = "cubic";
      }),
      "model.id",
      "INVALID_MODEL",
    );
    for (const n of [0, 5, 22, 44, 20.5]) {
      expectInvalid(
        withChange((s) => {
          (s.model as Record<string, unknown>).totalUnits = n;
        }),
        "model.totalUnits",
        "INVALID_MODEL",
      );
    }
    expectInvalid(
      withChange((s) => {
        (s.model as Record<string, unknown>).forwardRate = 0.06;
      }),
      "model.forwardRate",
      "INVALID_MODEL",
    );
    expectInvalid(
      withChange((s) => {
        (s.model as Record<string, unknown>).forwardRate = Number.NaN;
      }),
      "model.forwardRate",
      "INVALID_MODEL",
    );
    expectInvalid(
      withChange((s) => {
        (s.model as Record<string, unknown>).reverseRate = -0.1;
      }),
      "model.reverseRate",
      "INVALID_MODEL",
    );
    expectInvalid(
      withChange((s) => {
        (s.model as Record<string, unknown>).reverseRate = 1.5;
      }),
      "model.reverseRate",
      "INVALID_MODEL",
    );
    // 线性 forwardRate 上限 1：1.5 应拒，1 应过
    const linearOk = withChange((s) => {
      const m = s.model as Record<string, unknown>;
      m.id = "linear";
      m.forwardRate = 1;
      m.reverseRate = 0.1;
    });
    // 线性长度与 PMF 仍为二聚长度，故此处只检查速率本身不单独报错：
    // 把 initial 也换成线性长度后应整体通过
    const linearFull = JSON.parse(serializeScenario(makePreset("linear-control"))) as Record<string, unknown>;
    (linearFull.model as Record<string, unknown>).forwardRate = 1;
    expect(validateScenario(linearFull).model.forwardRate).toBe(1);
    expectInvalid(linearOk, "initial.P", "INVALID_PMF");
  });

  it("rejects bad PMF: negative, length, sum, non-finite", () => {
    expectInvalid(
      withChange((s) => {
        (s.initial as { P: number[] }).P[5] = -0.1;
      }),
      "initial.P[5]",
      "INVALID_PMF",
    );
    expectInvalid(
      withChange((s) => {
        (s.initial as { P: number[] }).P = [1, 0];
      }),
      "initial.P",
      "INVALID_PMF",
    );
    expectInvalid(
      withChange((s) => {
        (s.initial as { Q: number[] }).Q[0] = 0.4;
      }),
      "initial.Q",
      "INVALID_PMF",
    );
    expectInvalid(
      withChange((s) => {
        (s.initial as { P: number[] }).P[5] = Number.POSITIVE_INFINITY;
      }),
      "initial.P[5]",
      "INVALID_PMF",
    );
    expectInvalid(
      withChange((s) => {
        (s.initial as { P: number[] }).P[5] = Number.NaN;
      }),
      "initial.P[5]",
      "INVALID_PMF",
    );
  });

  it("rejects bad scalars: horizon, observations, trajectories, seed", () => {
    expectInvalid(withChange((s) => { s.horizon = 0.1; }), "horizon");
    expectInvalid(withChange((s) => { s.horizon = 21; }), "horizon");
    expectInvalid(withChange((s) => { s.horizon = Number.NaN; }), "horizon");
    expectInvalid(withChange((s) => { s.observations = 100; }), "observations");
    expectInvalid(withChange((s) => { s.trajectoriesPerGroup = 100; }), "trajectoriesPerGroup");
    expectInvalid(withChange((s) => { s.trajectoriesPerGroup = 512.5; }), "trajectoriesPerGroup");
    expectInvalid(withChange((s) => { s.seed = -1; }), "seed");
    expectInvalid(withChange((s) => { s.seed = 4294967296; }), "seed");
    expectInvalid(withChange((s) => { s.seed = 1.5; }), "seed");
    // 边界应通过：seed 0 与 4294967295
    expect(validateScenario(withChange((s) => { s.seed = 0; })).seed).toBe(0);
    expect(validateScenario(withChange((s) => { s.seed = 4294967295; })).seed).toBe(4294967295);
  });

  it("rejects unknown fields", () => {
    expectInvalid(withChange((s) => { s.extra = 1; }), "extra");
    expectInvalid(
      withChange((s) => {
        (s.model as Record<string, unknown>).extra = 1;
      }),
      "model.extra",
      "INVALID_MODEL",
    );
  });

  it("parseScenario rejects invalid JSON and oversized files", () => {
    expect(() => parseScenario("{not json")).toThrow(ScenarioValidationError);
    let oversized = "";
    try {
      parseScenario(serializeScenario(baseScenario()));
      oversized = "x".repeat(40 * 1024);
    } catch {
      oversized = "";
    }
    // 构造一个合法 JSON 但超 32 KiB 的文本：标题内填充（标题本身会先超长，
    // 故用未知字段填充至超大，仍应先报 FILE_TOO_LARGE）
    const big = JSON.stringify({
      ...JSON.parse(serializeScenario(baseScenario())),
      padding: "x".repeat(40 * 1024),
    });
    expect(() => parseScenario(big)).toThrowError(/at most 32768/);
    expect(oversized.length).toBeGreaterThan(0);
  });
});
