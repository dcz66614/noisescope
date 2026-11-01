// P006 T014 — 离线运行（项目书 §14 G-OFFLINE、FR11）。
//
// “只允许本地请求”用路由拦截实现：除 127.0.0.1/localhost 外的
// 任何请求一律 abort 并记录；若页面真向外网发请求，测试会看到
// 记录并失败。注意不用 context.setOffline(true)，那会连本地
// preview 服务器也拦住，测的就不是“本地可运行”而是“全断网”。
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../07_evidence/screenshots");

test("只允许本地请求的浏览器仍能完成实验和导出", async ({ page }) => {
  test.setTimeout(300_000);
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
      await route.continue();
    } else {
      blocked.push(url);
      await route.abort();
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
    timeout: 180_000,
  });
  // 导出同样只走本地 Blob 下载，不应触发外网请求。
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "保存 noisescope-distribution.csv" })
    .click();
  const download = await downloadPromise;
  const csvPath = await download.path();
  expect(csvPath).not.toBeNull();
  const csv = readFileSync(csvPath!, "utf-8");
  expect(csv).toContain("group,time,state_b");
  expect(blocked).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/offline.png`, fullPage: true });
});

test("离线环境下线性实验与审计重放仍可用", async ({ page }) => {
  test.setTimeout(300_000);
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
      await route.continue();
    } else {
      await route.abort();
    }
  });
  await page.goto("/");
  await page.locator("select[aria-label='网络']").selectOption("linear");
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
    timeout: 180_000,
  });
  await page.getByRole("button", { name: "重放此轨迹" }).click();
  await expect(
    page.getByRole("heading", { name: "初始化抽样" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/复验通过：已核对 \d+ 个事件/)).toBeVisible({
    timeout: 60_000,
  });
});
