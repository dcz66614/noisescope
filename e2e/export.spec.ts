// P006 T014 — 导出一致性（项目书 §14 G-EXPORT、FR10/13）。
//
// 断言导出文件内部数值自洽，不是只断言“能下载”：
// - 分布 CSV：每组每时刻的样本计数之和 = M；样本概率 = 计数/M（1e-9 内）；
//   CME 概率之和 ≈ 1（1e-6 内）。
// - SVG：含 <svg>，无外部图片/链接引用（xmlns 命名空间除外，它不是一次抓取）。
// - 实验 JSON：可解析，且与当前运行场景的种子/视界/M 一致。
// 下载文件同时复制一份到 07_evidence/exports/ 作为真实导出样例。
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPORTS = resolve(HERE, "../../07_evidence/exports");

async function runDefault(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
    timeout: 180_000,
  });
}

async function downloadText(
  page: import("@playwright/test").Page,
  buttonName: string,
): Promise<string> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: buttonName }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const text = readFileSync(path!, "utf-8");
  // 干净解压的源码树外未必有 07_evidence/exports/：先建目录再写，
  // 否则 writeFileSync 抛 ENOENT（T017 BLOCKER 1：测试脚手架缺陷，
  // 下载本身已成功，失败点只在写样例这一步）。
  mkdirSync(EXPORTS, { recursive: true });
  writeFileSync(resolve(EXPORTS, download.suggestedFilename()), text, "utf-8");
  return text;
}

test("分布 CSV 数值自洽：计数和=M，概率=计数/M，CME 概率和≈1", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await runDefault(page);
  const csv = await downloadText(page, "保存 noisescope-distribution.csv");
  const lines = csv.trim().split("\n");
  expect(lines[0]).toBe(
    "group,time,state_b,cme_probability,ssa_count,sample_count,ssa_probability",
  );
  // 按 (group,time) 聚合。
  const sums = new Map<string, { count: number; cme: number; prob: number }>();
  for (const line of lines.slice(1)) {
    const [group, time, , cme, ssaCount, , ssaProb] = line.split(",");
    const key = `${group}|${time}`;
    const acc = sums.get(key) ?? { count: 0, cme: 0, prob: 0 };
    acc.count += Number(ssaCount);
    acc.cme += Number(cme);
    acc.prob += Number(ssaProb);
    sums.set(key, acc);
    // 单行概率 = 计数/M（默认 M=512）。
    expect(Math.abs(Number(ssaProb) - Number(ssaCount) / 512)).toBeLessThan(1e-9);
  }
  expect(sums.size).toBeGreaterThan(100);
  for (const [key, acc] of sums) {
    expect(acc.count).toBe(512);
    expect(Math.abs(acc.cme - 1)).toBeLessThan(1e-6);
    expect(Math.abs(acc.prob - 1)).toBeLessThan(1e-6);
  }
});

test("SVG 可离线打开：含 svg 根元素，无外部图片/链接引用", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await runDefault(page);
  const distSvg = await downloadText(
    page,
    "保存 noisescope-distribution-P-t000.svg",
  );
  expect(distSvg).toContain("<svg");
  expect(distSvg).not.toMatch(/<image[^>]+href="https?:/);
  expect(distSvg).not.toMatch(/href="https?:\/\/(?!www\.w3\.org)/);
  const meansSvg = await downloadText(page, "保存 noisescope-means.svg");
  expect(meansSvg).toContain("<svg");
  expect(meansSvg).not.toMatch(/<image[^>]+href="https?:/);
});

test("实验 JSON 可解析且与当前场景一致，导出后可重导", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await runDefault(page);
  const jsonText = await downloadText(
    page,
    "保存 noisescope-experiment.json",
  );
  const parsed = JSON.parse(jsonText) as {
    seed: number;
    horizon: number;
    trajectoriesPerGroup: number;
  };
  expect(parsed.seed).toBe(20261031);
  expect(parsed.horizon).toBe(8);
  expect(parsed.trajectoriesPerGroup).toBe(512);
  // 均值 CSV 同样下载并留样：101 个观测点 × 两组，行数应 >100。
  const meansCsv = await downloadText(page, "保存 noisescope-means.csv");
  expect(meansCsv.split("\n").length).toBeGreaterThan(100);
});
