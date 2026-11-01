// P006 GPT 终审 Round 1 修复 — 证据导出与复验（项目书 §12.2）。
//
// 真实浏览器用例，不是只补单元测试：
// - 正常往返：运行 → 导出证据 JSON → 选文件复验 → 通过，且原 runId 不变。
// - 篡改 payload（参考均值）：复验失败，原实验保留（runId 不变）。
// - 篡改审计（sampledB）：复验失败，原实验保留。
// - 篡改审计事件（Round 2 B1 回归：events[0].uWaiting，sampledB 与
//   payload 哈希都不动）：复验失败，原实验保留。
// - 取消复验：M=4096 证据的完整重算窗口内点取消 → 已取消，原实验保留。
// - 小文本粘贴：非法证据文本走粘贴路径 → 解析失败，原实验保留。
// 复验是只读的：通过与否一律不替换当前实验（见 FileActions 注释）。
//
// 注意：证据文件约 236 KB，Playwright fill() 往受控 textarea 塞
// 大文本会超时（实测 30 s 超时，产品粘贴本身无此问题）；故大文本
// 用例一律走“选择证据文件”路径（真实用户流程：下载后选文件复验），
// 粘贴路径只用小文本覆盖。
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

async function runExperiment(
  page: import("@playwright/test").Page,
  m?: string,
) {
  await page.goto("/");
  if (m !== undefined) {
    await page.locator("select[aria-label='每组轨迹数 M']").selectOption(m);
  }
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
    timeout: 180_000,
  });
}

async function downloadEvidence(
  page: import("@playwright/test").Page,
): Promise<string> {
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByRole("button", { name: "保存 noisescope-evidence.json" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFileSync(path!, "utf-8");
}

/** 把证据文本写临时文件，用证据区的“选择证据文件”提交复验。 */
async function verifyEvidenceFile(
  page: import("@playwright/test").Page,
  text: string,
  name: string,
) {
  const file = resolve(tmpdir(), `p006-evidence-${name}.json`);
  writeFileSync(file, text, "utf-8");
  await page
    .locator('section[aria-label="证据复验"] input[type="file"]')
    .setInputFiles(file);
}

test("证据正常往返：导出 → 复验通过，原 runId 不变", async ({ page }) => {
  test.setTimeout(300_000);
  await runExperiment(page);
  const evidenceText = await downloadEvidence(page);
  const parsed = JSON.parse(evidenceText) as { payloadSha256: string };
  expect(parsed.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
  await verifyEvidenceFile(page, evidenceText, "roundtrip");
  await expect(page.getByText(/证据复验通过/)).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator("[data-run-id]")).toHaveCount(1);
});

test("篡改 payload 参考均值：复验失败，原实验保留", async ({ page }) => {
  test.setTimeout(300_000);
  await runExperiment(page);
  const evidenceText = await downloadEvidence(page);
  const parsed = JSON.parse(evidenceText) as {
    payload: { reference: { P: { meanB: number[] } } };
  };
  parsed.payload.reference.P.meanB[0] =
    parsed.payload.reference.P.meanB[0]! + 0.1;
  await verifyEvidenceFile(page, JSON.stringify(parsed), "tamper-payload");
  await expect(page.getByText(/证据复验失败，当前实验已保留/)).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator("[data-run-id]")).toHaveCount(1);
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible();
});

test("篡改审计 sampledB：复验失败，原实验保留", async ({ page }) => {
  test.setTimeout(300_000);
  await runExperiment(page);
  const evidenceText = await downloadEvidence(page);
  const parsed = JSON.parse(evidenceText) as {
    audit: { sampledB: number[] };
  };
  parsed.audit.sampledB[10] = parsed.audit.sampledB[10] === 0 ? 1 : 0;
  await verifyEvidenceFile(page, JSON.stringify(parsed), "tamper-audit");
  await expect(page.getByText(/证据复验失败，当前实验已保留/)).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator("[data-run-id]")).toHaveCount(1);
});

test("篡改审计事件 uWaiting（Round 2 B1 回归）：复验失败，原实验保留", async ({ page }) => {
  test.setTimeout(300_000);
  await runExperiment(page);
  const evidenceText = await downloadEvidence(page);
  const parsed = JSON.parse(evidenceText) as {
    audit: { events: { uWaiting: number }[] };
  };
  expect(parsed.audit.events.length).toBeGreaterThan(0);
  // 只改事件随机数，sampledB 与 payload 哈希都不动：旧复验会误判通过。
  parsed.audit.events[0]!.uWaiting += 0.1;
  await verifyEvidenceFile(page, JSON.stringify(parsed), "tamper-event");
  await expect(page.getByText(/证据复验失败，当前实验已保留/)).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator("[data-run-id]")).toHaveCount(1);
});

test("取消复验：M=4096 重算窗口内取消，已取消且原实验保留", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await runExperiment(page, "4096");
  const evidenceText = await downloadEvidence(page);
  const file = resolve(tmpdir(), "p006-evidence-cancel.json");
  writeFileSync(file, evidenceText, "utf-8");
  await page
    .locator('section[aria-label="证据复验"] input[type="file"]')
    .setInputFiles(file);
  // 注意：禁用按钮文案也是“正在复验…”，故必须用状态段落的完整
  // 文本定位，否则 getByText(/正在复验/) 会命中 2 个元素而严格模式报错。
  await expect(
    page.getByText("正在复验：完整重算进行中，当前实验不受影响。"),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "取消复验" }).click();
  await expect(page.getByText(/复验已取消，当前实验已保留/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("[data-run-id]")).toHaveCount(1);
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible();
});

test("小文本粘贴非法证据：解析失败，原实验保留", async ({ page }) => {
  test.setTimeout(300_000);
  await runExperiment(page);
  await page.getByPlaceholder("粘贴 noisescope-evidence.json 文本").fill("不是 JSON");
  await page.getByRole("button", { name: "导入并复验证据" }).click();
  await expect(page.getByText(/证据解析失败，当前实验已保留/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-run-id]")).toHaveCount(1);
});
