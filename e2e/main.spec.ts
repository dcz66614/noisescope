// P006 T013 — 端到端集成初版（项目书 §9、实施计划 T013）。
//
// 测已构建的 dist（Playwright webServer = npm run preview，见
// playwright.config.ts）。test:e2e 脚本先 build 再跑测试，保证
// dist 与源码一致。以下断言全部在真实浏览器里跑：运行实验必须
// 走 Worker——App 只通过 workerClient 拿结果，Worker chunk 加载
// 或执行失败时运行永远到不了“已完成”，因此“已完成”本身就是
// Worker 打包、加载、跑通的证明；另加 dist 工件检查佐证 chunk
// 文件确实存在（不是主 bundle 内联）。
import { test, expect, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(HERE, "../../07_evidence");

// T014 演示录屏：文件顶层 test.use（describe 内不允许），
// 因此本文件全部用例都会录像，演示用例的视频事后单独拷到 07_evidence/demo/。
test.use({ video: { mode: "on", size: { width: 1280, height: 720 } } });

async function runDefaultExperiment(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "反应骰 NoiseScope" })).toBeVisible();
  // 生产路径无 mock 完成入口。
  await expect(page.getByRole("button", { name: "开发 mock" })).toHaveCount(0);
  await expect(page.locator("[data-status='READY']")).toBeVisible();
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='RUNNING']")).toBeVisible();
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
    timeout: 180_000,
  });
}

test("worker chunk 已打进 dist 且默认实验在真实浏览器里跑通", async ({
  page,
}) => {
  test.setTimeout(300_000);
  // 工件佐证：dist/assets 里除主 bundle 外还有独立 worker chunk。
  const assetsDir = resolve(HERE, "../dist/assets");
  const assets = readdirSync(assetsDir);
  const workerChunks = assets.filter(
    (name) => name.includes("worker") && name.endsWith(".js"),
  );
  expect(workerChunks.length).toBeGreaterThanOrEqual(1);
  const workerContent = readFileSync(join(assetsDir, workerChunks[0]!), "utf-8");
  expect(workerContent.length).toBeGreaterThan(1000);

  await runDefaultExperiment(page);
  // 同一 runId 下各视图齐全。
  await expect(page.locator("[data-run-id]")).toBeVisible();
  await expect(page.locator("[data-shared-max]")).toBeVisible();
  await expect(
    page.locator("section[aria-label='均值时间线']").getByText("均值时间线"),
  ).toBeVisible();
  await expect(page.getByText("此刻为什么不同")).toBeVisible();
  await expect(page.getByText("采样诊断（CDF）")).toBeVisible();

  // 时间游标移动不触发重跑：状态保持已完成。
  const slider = page.locator("input[aria-label='时间游标']");
  await slider.fill("50");
  await expect(page.getByText("当前观测点：50")).toBeVisible();
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible();

  // 审计重放：Worker REPLAY + 独立复验通过。
  await page.getByRole("button", { name: "重放此轨迹" }).click();
  await expect(
    page.getByRole("heading", { name: "初始化抽样" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/复验通过：已核对 \d+ 个事件/)).toBeVisible({
    timeout: 60_000,
  });

  // 导出：分布 CSV 可下载、表头正确。
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "保存 noisescope-distribution.csv" })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("noisescope-distribution.csv");
  const csvPath = await download.path();
  expect(csvPath).not.toBeNull();
  const csv = readFileSync(csvPath!, "utf-8");
  expect(csv).toContain(
    "group,time,state_b,cme_probability,ssa_count,sample_count,ssa_probability",
  );
  expect(csv.split("\n").length).toBeGreaterThan(100);

  await page.screenshot({
    path: join(EVIDENCE_DIR, "t013-e2e-main.png"),
    fullPage: true,
  });
});

test("线性实验运行到完成", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await page.locator("select[aria-label='网络']").selectOption("linear");
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
    timeout: 180_000,
  });
  await expect(page.locator("[data-shared-max]")).toBeVisible();
});

test("运行中取消后旧结果不被当成新结果", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  // M=4096 的大运行，确保取消时仍在运行中。
  await page.locator("select[aria-label='每组轨迹数 M']").selectOption("4096");
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='RUNNING']")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator("[data-status='CANCELLED']")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("[data-run-id]")).toHaveCount(0);
});

test("导出实验 JSON 后可重导入", async ({ page }) => {
  test.setTimeout(300_000);
  await runDefaultExperiment(page);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "保存 noisescope-experiment.json" })
    .click();
  const download = await downloadPromise;
  const jsonPath = await download.path();
  expect(jsonPath).not.toBeNull();
  const jsonText = readFileSync(jsonPath!, "utf-8");
  // 实验 JSON 的根对象就是 ScenarioV1（§12.1），不含 UI 预置 id；
  // 断言它确实是默认实验：种子 20261031、视界 8、每组 512 条。
  const parsed = JSON.parse(jsonText) as {
    seed: number;
    horizon: number;
    trajectoriesPerGroup: number;
    title: string;
  };
  expect(parsed.seed).toBe(20261031);
  expect(parsed.horizon).toBe(8);
  expect(parsed.trajectoriesPerGroup).toBe(512);
  expect(parsed.title.length).toBeGreaterThan(0);

  // 证据区也有一个 textarea（同在“文件交互”外区内），故定位必须
  // 收紧到“导入实验”区，否则严格模式命中 2 个元素（GPT 终审 Round 1 修复）。
  await page
    .locator("section[aria-label='导入实验'] textarea")
    .fill(jsonText);
  await page
    .getByRole("button", { name: "导入粘贴的实验文本" })
    .click();
  await expect(page.getByText(/已导入实验/)).toBeVisible();
  await expect(page.locator("[data-status='READY']")).toBeVisible();
  // 导入后旧结果失效，不再展示旧 runId。
  await expect(page.locator("[data-run-id]")).toHaveCount(0);
});

// P006 T014 — M 512→1024 前缀不变（项目书 §13 G07、R013 建议补的 US04 用例）。
//
// 浏览器层面验证：M 从 512 增到 1024 后，前 512 条轨迹不变。
// 直接断言分布计数会错（计数随 M 变），正确做法是重放同一条轨迹：
// P 组 0 号轨迹在两次运行中的审计文本（uInitial 全精度、轨迹种子、
// 初始状态、事件表）必须逐字相同，因为 per-trajectory 种子只依赖
// (seed, group, trajectoryIndex)，不依赖 M。
test("M 512→1024 后同一轨迹重放逐字相同（前缀不变）", async ({ page }) => {
  test.setTimeout(300_000);
  async function replayP0Text(): Promise<string> {
    await page.getByRole("button", { name: "重放此轨迹" }).click();
    await expect(
      page.getByRole("heading", { name: "初始化抽样" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/复验通过：已核对 \d+ 个事件/)).toBeVisible({
      timeout: 60_000,
    });
    // 只比轨迹本身（初始化抽样 + 事件表 + 终止说明），不比审计区
    // 的控件文案：控件里的“合法范围：0 到 M-1”随 M 变化，那是 UI
    // 文案不是轨迹内容；上一版测试误把整区文本逐字比对，导致
    // M=1024 时因范围文案不同而假失败，生产轨迹本身并未变。
    // （T014 测试错误修复，生产代码未动。）
    const initial = await page
      .locator("section[aria-label='初始化抽样']")
      .innerText();
    const table = await page
      .locator("section[aria-label='事件审计'] table")
      .innerText();
    const terminal = await page
      .locator("section[aria-label='终止说明']")
      .innerText();
    return `${initial}\n${table}\n${terminal}`;
  }
  await runDefaultExperiment(page);
  const text512 = await replayP0Text();
  await page.locator("select[aria-label='每组轨迹数 M']").selectOption("1024");
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
    timeout: 180_000,
  });
  const text1024 = await replayP0Text();
  expect(text1024).toBe(text512);
});

// P006 T014 — 六类真实截图（项目书 §17 最低 UI 证据，缺失的两类在此补齐；
// 取消后状态与非法导入见 cancel.spec.ts）。
test("六类截图：默认分布与初始漂移、线性均值重合、事件详情、采样诊断", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await runDefaultExperiment(page);
  await page.screenshot({
    path: join(EVIDENCE_DIR, "screenshots/default-distribution.png"),
    fullPage: true,
  });
  // 采样诊断在解释栏内单独截取。
  await page
    .locator("section[aria-label='解释栏']")
    .screenshot({ path: join(EVIDENCE_DIR, "screenshots/sampling-diagnosis.png") });
  // 事件详情：重放后截取审计区。
  await page.getByRole("button", { name: "重放此轨迹" }).click();
  await expect(
    page.getByRole("heading", { name: "初始化抽样" }),
  ).toBeVisible({ timeout: 60_000 });
  await page
    .locator("section[aria-label='事件审计']")
    .screenshot({ path: join(EVIDENCE_DIR, "screenshots/event-detail.png") });
  // 线性：均值重合而分布不同。
  await page.locator("select[aria-label='网络']").selectOption("linear");
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
    timeout: 180_000,
  });
  await page.screenshot({
    path: join(EVIDENCE_DIR, "screenshots/linear.png"),
    fullPage: true,
  });
});

// P006 T014 — 90—150 秒核心演示（真实操作，非预录动画）。
// 流程：默认实验 -> 游标 -> 线性实验 -> 审计重放 -> 导出 -> 冻结预置。
// 停顿是给观看者留的真实停留时间，不是空转：每步都有可见状态变化。
test("90—150 秒真实主流程演示", async ({ page }) => {
    test.setTimeout(300_000);
    const started = Date.now();
    await page.goto("/");
    await page.waitForTimeout(8000);
    await page.getByRole("button", { name: "运行实验", exact: true }).click();
    await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
      timeout: 180_000,
    });
    await page.waitForTimeout(15000);
    const slider = page.locator("input[aria-label='时间游标']");
    for (const v of ["25", "50", "75"]) {
      await slider.fill(v);
      await page.waitForTimeout(8000);
    }
    await page.locator("select[aria-label='网络']").selectOption("linear");
    await page.getByRole("button", { name: "运行实验", exact: true }).click();
    await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
      timeout: 180_000,
    });
    await page.waitForTimeout(12000);
    await page.getByRole("button", { name: "重放此轨迹" }).click();
    await expect(
      page.getByRole("heading", { name: "初始化抽样" }),
    ).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(10000);
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "保存 noisescope-distribution.csv" })
      .click();
    await downloadPromise;
    await page.waitForTimeout(8000);
    await page.locator("select[aria-label='预置选择']").selectOption("frozen");
    await page.getByRole("button", { name: "运行实验", exact: true }).click();
    await expect(page.locator("[data-status='COMPLETE']")).toBeVisible({
      timeout: 180_000,
    });
    await page.waitForTimeout(12000);
    const seconds = (Date.now() - started) / 1000;
    console.log(`T014 demo duration: ${seconds.toFixed(1)} s (gate 90-150 s)`);
    expect(seconds).toBeGreaterThanOrEqual(90);
    expect(seconds).toBeLessThanOrEqual(150);
  });

// P006 T017 修复 — 项目书 §4：自定义两组初始均值不同时显示
// “非同均值实验”，不得继续使用默认教学结论。
// 默认预置两组均值均为 5：先断言无横幅，再把 P 组点位置从 5 改
// 为 0（P 均值变 0，Q 均值仍 5），断言横幅与弱化后的页眉出现；
// 点“恢复同均值预置”后横幅消失。不跑 Worker，纯 UI 断言。
test("均值不同时显示非同均值实验横幅，恢复预置后消失", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "反应骰 NoiseScope" }),
  ).toBeVisible();
  // 注：横幅用文本定位，不用 getByRole("alert", { name })——alert
  // 角色的可访问名不从内容计算，name 匹配会恒失败，文本本身在场。
  await expect(
    page.getByText(/非同均值实验：P 组初始均值/),
  ).toHaveCount(0);
  await expect(
    page.locator("header").getByText(/非同均值实验/),
  ).toHaveCount(0);
  await page.locator("input[aria-label='P 组点位置']").fill("0");
  await expect(
    page.getByText(/非同均值实验：P 组初始均值/),
  ).toBeVisible();
  await expect(
    page.locator("header").getByText(/非同均值实验/),
  ).toBeVisible();
  await expect(page.getByText(/当前预置：.*非同均值实验/)).toBeVisible();
  await page.getByRole("button", { name: "恢复同均值预置" }).click();
  await expect(
    page.getByText(/非同均值实验：P 组初始均值/),
  ).toHaveCount(0);
  await expect(
    page.locator("header").getByText(/非同均值实验/),
  ).toHaveCount(0);
});
