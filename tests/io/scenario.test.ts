import { describe, expect, it } from "vitest";
import {
  parseExperimentFile,
  serializeExperimentFile,
} from "../../src/io/scenario";
import { makePreset } from "../../src/domain/presets";

describe("experiment file format (§12.1)", () => {
  it("round-trips the default and linear presets", () => {
    for (const id of ["variance-split", "linear-control", "frozen"] as const) {
      const scenario = makePreset(id);
      const parsed = parseExperimentFile(serializeExperimentFile(scenario));
      expect(parsed).toEqual(scenario);
      // 序列化不持有原对象数组引用：改解析结果不影响原预置。
      parsed.initial.P[0] = 999;
      expect(scenario.initial.P[0]).not.toBe(999);
    }
  });

  it("rejects unknown and executable-semantics fields", () => {
    const scenario = makePreset("variance-split");
    const withUnknown = { ...scenario, exec: "rm -rf /" };
    expect(() => parseExperimentFile(JSON.stringify(withUnknown))).toThrow();
    const withValid = { ...scenario, valid: true };
    expect(() => parseExperimentFile(JSON.stringify(withValid))).toThrow();
  });

  it("rejects files over 32 KiB", () => {
    const scenario = makePreset("variance-split");
    const padded = `${serializeExperimentFile(scenario)}${" ".repeat(40 * 1024)}`;
    // 尾部空白仍是合法 JSON，但字节超限必须拒绝。
    expect(() => parseExperimentFile(padded)).toThrow(/at most/);
  });

  it("treats the title as plain text, verbatim", () => {
    const scenario = makePreset("variance-split");
    const titled = { ...scenario, title: "<script>alert(1)</script>" };
    const parsed = parseExperimentFile(JSON.stringify(titled));
    expect(parsed.title).toBe("<script>alert(1)</script>");
  });

  it("rejects a wrong schemaVersion and non-finite numbers", () => {
    const scenario = makePreset("variance-split");
    expect(() =>
      parseExperimentFile(
        JSON.stringify({ ...scenario, schemaVersion: 2 }),
      ),
    ).toThrow();
    const bad = serializeExperimentFile(scenario).replace(
      '"horizon": 8',
      '"horizon": null',
    );
    expect(() => parseExperimentFile(bad)).toThrow();
  });
});
