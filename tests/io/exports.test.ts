import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_CSV_HEADER,
  exportDistributionCsv,
  exportMeansCsv,
  MEANS_CSV_HEADER,
} from "../../src/io/csv";
import {
  exportDistributionSvg,
  exportMeansSvg,
  svgFileName,
} from "../../src/io/svg";
import { buildSmallRun } from "./buildRun";

describe("CSV export (§12.3)", () => {
  it("uses fixed columns and time/group/state ordering", () => {
    const { result } = buildSmallRun();
    const lines = exportDistributionCsv(result).trim().split("\n");
    expect(lines[0]).toBe(DISTRIBUTION_CSV_HEADER);
    // 101 时刻 × 2 组 × 3 状态 + 表头。
    expect(lines.length).toBe(1 + 101 * 2 * 3);
    const first = lines[1]!.split(",");
    expect(first[0]).toBe("P");
    expect(first[1]).toBe("0");
    expect(first[2]).toBe("0");
    // t=0 P 组：PMF 在 j=1 处为 1，样本计数也在 j=1 处等于 M。
    const t0P = lines.slice(1, 4).map((l) => l.split(","));
    expect(t0P[1]![3]).toBe("1");
    expect(t0P[1]![4]).toBe("64");
    expect(t0P[1]![5]).toBe("64");
    expect(t0P[1]![6]).toBe("1");
    // 每行 ssa_probability = ssa_count / sample_count。
    for (const line of lines.slice(1)) {
      const parts = line.split(",");
      expect(Number(parts[6])).toBeCloseTo(
        Number(parts[4]) / Number(parts[5]),
        12,
      );
    }
  });

  it("keeps the means table in a separate file with its own columns", () => {
    const { result } = buildSmallRun();
    const lines = exportMeansCsv(result).trim().split("\n");
    expect(lines[0]).toBe(MEANS_CSV_HEADER);
    expect(lines.length).toBe(1 + 101 * 2);
    expect(lines[1]!.split(",")).toHaveLength(6);
  });
});

describe("SVG export (§12.3)", () => {
  it("distribution SVG carries title, params, legend, time and synthetic note, no external resources", () => {
    const { result } = buildSmallRun();
    const svg = exportDistributionSvg(result, "P", 0);
    expect(svg).toContain("分布图");
    expect(svg).toContain("dimer");
    expect(svg).toContain("CME 概率");
    expect(svg).toContain("SSA 样本概率");
    expect(svg).toContain("合成模型");
    // xmlns 命名空间 URI 不是外链资源：先去掉它再查，剩下的 http(s) 链接才算外链。
    const withoutXmlns = svg.replace(
      'xmlns="http://www.w3.org/2000/svg"',
      "",
    );
    expect(withoutXmlns).not.toMatch(/http:\/\//);
    expect(withoutXmlns).not.toMatch(/https:\/\//);
    expect(svg).not.toContain("<link");
    expect(svg).not.toContain("url(");
    expect(svg).not.toContain("@import");
    expect(svgFileName("distribution", "P", 42)).toBe(
      "noisescope-distribution-P-t042.svg",
    );
  });

  it("means SVG carries all three series in its legend", () => {
    const { result } = buildSmallRun();
    const svg = exportMeansSvg(result);
    expect(svg).toContain("参考均值");
    expect(svg).toContain("闭合均值");
    expect(svg).toContain("SSA 样本均值");
    expect(svg).toContain("合成模型");
    expect(svg).toContain("<polyline");
  });
});
