// P006 T014 — 取消与过期结果（项目书 §14：取消 ≤250ms；FR09）。
//
// 取消延迟用页内 MutationObserver 计时：点击前在页内安装观察者，
// 记录 data-status 变为 CANCELLED 时的 performance.now()，与点击前
// 同一时钟的 performance.now() 相减。这样测的是 UI 更新延迟，
// 不含 Playwright 定位轮询的开销；若用 expect 轮询计时会把测试
// 框架开销算进门禁，造成假失败。
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../07_evidence/screenshots");

async function runDefault(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
    timeout: 180_000,
  });
}

test("取消延迟 ≤250ms，且取消后无 runId、无部分结果", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await page.locator("select[aria-label='每组轨迹数 M']").selectOption("4096");
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='RUNNING']")).toBeVisible();
  // 页内观察者：只记录第一次变为 CANCELLED 的时刻。
  await page.evaluate(() => {
    const w = window as unknown as {
      __cancelObserved: number | null;
    };
    w.__cancelObserved = null;
    const obs = new MutationObserver(() => {
      const s = document
        .querySelector("[data-status]")
        ?.getAttribute("data-status");
      if (s === "CANCELLED" && w.__cancelObserved === null) {
        w.__cancelObserved = performance.now();
      }
    });
    const el = document.querySelector("[data-status]");
    if (el) obs.observe(el, { attributes: true, attributeFilter: ["data-status"] });
  });
  const tClick = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator("[data-status='CANCELLED']")).toBeVisible({
    timeout: 60_000,
  });
  const tObserved = await page.evaluate(
    () =>
      (window as unknown as { __cancelObserved: number | null })
        .__cancelObserved,
  );
  expect(tObserved).not.toBeNull();
  const latencyMs = tObserved! - tClick;
  console.log(`T014 cancel latency: ${latencyMs.toFixed(1)} ms (gate <= 250 ms)`);
  expect(latencyMs).toBeLessThanOrEqual(250);
  await expect(page.locator("[data-run-id]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/cancelled.png`, fullPage: true });
});

test("参数变更使旧结果过期为 STALE，导出禁用", async ({ page }) => {
  test.setTimeout(300_000);
  await runDefault(page);
  await expect(page.locator("[data-run-id]")).toBeVisible();
  // 改种子属于计算参数变更，必须使 COMPLETE -> STALE。
  await page.locator("input[aria-label='种子']").fill("42");
  await expect(page.locator("[data-status='STALE']")).toBeVisible();
  await expect(page.getByText(/旧结果已灰化/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存 noisescope-experiment.json" }),
  ).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/stale.png`, fullPage: true });
});

test("非法导入保留当前实验", async ({ page }) => {
  test.setTimeout(300_000);
  await runDefault(page);
  const runIdText = await page.locator("[data-run-id]").innerText();
  // 证据区也有一个 textarea（同在“文件交互”外区内），故定位必须
  // 收紧到“导入实验”区，否则严格模式命中 2 个元素（GPT 终审 Round 1 修复）。
  await page
    .locator("section[aria-label='导入实验'] textarea")
    .fill('{"schemaVersion": 99, "projectId": "P006"}');
  await page
    .getByRole("button", { name: "导入粘贴的实验文本" })
    .click();
  // 非法导入只显示错误，不替换当前实验：状态仍 COMPLETE，runId 不变。
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible();
  await expect(page.locator("[data-run-id]")).toHaveText(runIdText);
  await page.screenshot({ path: `${SHOTS}/invalid-import.png`, fullPage: true });
});
