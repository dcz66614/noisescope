import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  compareEvidence,
  EvidenceError,
  parseEvidence,
  recomputeSampleMoments,
  serializeEvidence,
  verifyEvidenceHash,
  verifyImportedEvidence,
} from "../../src/io/evidence";
import { buildSmallRun, testMeta } from "./buildRun";

describe("canonicalJson (§12.2)", () => {
  it("sorts keys, normalizes -0, and rejects non-finite/undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson([1, -0, 2])).toBe("[1,0,2]");
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
  });
});

describe("evidence round-trip, hash and full rerun (§12.2)", () => {
  it("serializes, parses, verifies the hash, and matches an identical rerun", async () => {
    const { result, audit } = buildSmallRun();
    const text = await serializeEvidence(result, audit, testMeta());
    const parsed = parseEvidence(text);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.engineVersion).toBe("1.0.0");
    expect(await verifyEvidenceHash(parsed)).toBe(true);
    const rerun = buildSmallRun();
    const comparison = compareEvidence(parsed, rerun.result);
    expect(comparison.matches).toBe(true);
    expect(comparison.sampleCountsMatch).toBe(true);
    expect(comparison.differences).toEqual([]);
    const full = await verifyImportedEvidence(
      parsed,
      rerun.result,
      rerun.audit,
    );
    expect(full.valid).toBe(true);
    expect(full.hashMatches).toBe(true);
  });

  it("detects a tampered reference PMF via hash and rerun comparison", async () => {
    const { result, audit } = buildSmallRun();
    const parsed = parseEvidence(
      await serializeEvidence(result, audit, testMeta()),
    );
    parsed.payload.reference.P.pmf[0]! += 0.01;
    expect(await verifyEvidenceHash(parsed)).toBe(false);
    const rerun = buildSmallRun();
    const comparison = compareEvidence(parsed, rerun.result);
    expect(comparison.matches).toBe(false);
    expect(
      comparison.differences.some((d) =>
        d.startsWith("payload.reference.P.pmf"),
      ),
    ).toBe(true);
  });

  it("rejects a counts row whose sum no longer equals completed", async () => {
    const { result, audit } = buildSmallRun();
    const parsed = parseEvidence(
      await serializeEvidence(result, audit, testMeta()),
    );
    parsed.payload.sample.P.counts[0]! += 1;
    expect(() => parseEvidence(JSON.stringify(parsed))).toThrowError(
      EvidenceError,
    );
  });

  it("rejects sample moments that no longer match counts recomputation", async () => {
    const { result, audit } = buildSmallRun();
    const parsed = parseEvidence(
      await serializeEvidence(result, audit, testMeta()),
    );
    parsed.payload.sample.Q.meanB[10]! += 0.5;
    expect(() => parseEvidence(JSON.stringify(parsed))).toThrow();
  });

  it("detects a swapped counts pair in a non-audit group via full rerun comparison", async () => {
    // 行和不变（交换同一时刻两状态的计数），解析能通过，完整重算必须发现。
    const { result, audit } = buildSmallRun();
    const parsed = parseEvidence(
      await serializeEvidence(result, audit, testMeta()),
    );
    const row = parsed.payload.sample.Q.counts;
    const tmp = row[0]!;
    row[0] = row[1]!;
    row[1] = tmp;
    // 交换后矩也随之重算，否则解析就会先拒绝；这里模拟“同步改矩”的篡改者。
    const recomputed = recomputeSampleMoments(row, 3, 64);
    parsed.payload.sample.Q.meanB = recomputed.meanB;
    parsed.payload.sample.Q.varianceB = recomputed.varianceB;
    expect(parseEvidence(JSON.stringify(parsed))).toBeTruthy();
    const rerun = buildSmallRun();
    const comparison = compareEvidence(parsed, rerun.result);
    expect(comparison.matches).toBe(false);
    expect(comparison.sampleCountsMatch).toBe(false);
  });

  it("rejects imported valid/PASS fields and oversize files", async () => {
    const { result, audit } = buildSmallRun();
    const text = await serializeEvidence(result, audit, testMeta());
    const withValid = JSON.parse(text) as Record<string, unknown>;
    withValid.valid = true;
    expect(() => parseEvidence(JSON.stringify(withValid))).toThrow();
    const withPass = JSON.parse(text) as Record<string, unknown>;
    withPass.PASS = true;
    expect(() => parseEvidence(JSON.stringify(withPass))).toThrow();
    expect(() => parseEvidence(" ".repeat(8 * 1024 * 1024 + 1))).toThrow(
      /at most/,
    );
  });

  it("rejects a numerical diagnostic over budget as BUDGET_EXCEEDED, not mismatch", async () => {
    const { result, audit } = buildSmallRun();
    const parsed = parseEvidence(
      await serializeEvidence(result, audit, testMeta()),
    );
    parsed.payload.reference.P.numerical[0]!.cumulativeTailBound = 1e-6;
    expect(() => parseEvidence(JSON.stringify(parsed))).toThrowError(
      /BUDGET_EXCEEDED|cumulative tail/,
    );
  });

  it("does not mutate inputs during comparison", async () => {
    const { result, audit } = buildSmallRun();
    const parsed = parseEvidence(
      await serializeEvidence(result, audit, testMeta()),
    );
    const before = JSON.stringify(parsed);
    const rerun = buildSmallRun();
    const rerunBefore = JSON.stringify(rerun.result, (key, value) =>
      typeof value === "object" && value !== null && "buffer" in (value as object)
        ? Array.from(value as ArrayLike<number>)
        : value,
    );
    compareEvidence(parsed, rerun.result);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(
      JSON.stringify(rerun.result, (key, value) =>
        typeof value === "object" && value !== null && "buffer" in (value as object)
          ? Array.from(value as ArrayLike<number>)
          : value,
      ),
    ).toBe(rerunBefore);
  });
});
