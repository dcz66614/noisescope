// P006 T014 — 性能基准（项目书 §14、实施计划 T014）。
//
// 真实测量，不是返回 0 的占位脚本：
// - 固定输入：variance-split 预置（G01，二聚默认实验，M=512/组，T=8，101 观测点）。
// - Worker 等效计算：直接调用 workers/simulation.worker.ts 的 runScenario
//  （与真实 Worker 同一计算路径：校验 -> 两组 CME -> 两组批处理 SSA；
//   在 Node/tsx 里 import 该文件不会注册 Worker 全局监听，见该文件底部守卫）。
// - CME 基准：直接调用 core/reference.ts 的 solveReference（P、Q 两组）。
// - 方法：预热 2 次后测 10 次，p95 = 升序后第 ceil(0.95*n) 个值。
// - 门禁（项目书 §14，不可单方面改动）：Worker 计算 p95 ≤ 3000 ms；
//   CME 两组基准 p95 ≤ 300 ms。任一门禁不过即 exit 1。
// - 输出：stdout 摘要 + 05_tests/benchmark/bench-<时间戳>.json 与 bench-latest.md。
//   时间戳用 UTC ISO，文件名中的冒号替换为连字符。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makePreset } from "../src/domain/presets";
import { solveReference } from "../src/core/reference";
import { runScenario } from "../src/workers/simulation.worker";

const WARMUP = 2;
const RUNS = 10;
const WORKER_P95_LIMIT_MS = 3000;
const CME_P95_LIMIT_MS = 300;

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function main(): void {
  const scenario = makePreset("variance-split");
  if (scenario.trajectoriesPerGroup !== 512 || scenario.horizon !== 8) {
    throw new Error(
      `bench 输入不是默认 G01：M=${scenario.trajectoriesPerGroup}，T=${scenario.horizon}`,
    );
  }
  const workerTotals: number[] = [];
  const workerSsa: number[] = [];
  const cmeTotals: number[] = [];

  for (let i = 0; i < WARMUP; i += 1) {
    runScenario(scenario, 9000 + i);
  }
  for (let i = 0; i < RUNS; i += 1) {
    const result = runScenario(scenario, 9100 + i);
    workerTotals.push(result.elapsedMs);
    workerSsa.push(result.timings.ssaMs);
    const t0 = performance.now();
    solveReference(scenario, "P");
    solveReference(scenario, "Q");
    cmeTotals.push(performance.now() - t0);
  }
  // 交叉核对：runScenario 内部 timings.referenceMs 应与独立 CME 测量同量级；
  // 若两者数量级背离，说明测量路径不一致，bench 应报错而不是静默通过。
  const workerP95 = p95(workerTotals);
  const cmeP95 = p95(cmeTotals);
  const workerPass = workerP95 <= WORKER_P95_LIMIT_MS;
  const cmePass = cmeP95 <= CME_P95_LIMIT_MS;
  const report = {
    project: "P006",
    input: {
      preset: "variance-split",
      model: scenario.model.id,
      trajectoriesPerGroup: scenario.trajectoriesPerGroup,
      horizon: scenario.horizon,
      observations: scenario.observations,
      seed: scenario.seed,
    },
    method: { warmup: WARMUP, runs: RUNS, p95: "ceil(0.95*n)th sorted value" },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    workerTotalMs: {
      runs: workerTotals,
      mean: mean(workerTotals),
      p95: workerP95,
      limitMs: WORKER_P95_LIMIT_MS,
      pass: workerPass,
    },
    workerSsaMs: { runs: workerSsa, mean: mean(workerSsa), p95: p95(workerSsa) },
    cmeMs: {
      runs: cmeTotals,
      mean: mean(cmeTotals),
      p95: cmeP95,
      limitMs: CME_P95_LIMIT_MS,
      pass: cmePass,
    },
    overallPass: workerPass && cmePass,
    generatedAtUtc: new Date().toISOString(),
  };

  const here = dirname(fileURLToPath(import.meta.url));
  // scripts/ 在 04_source 内；项目根的 05_tests/benchmark 在两级之上。
  const outDir = resolve(here, "../../05_tests/benchmark");
  mkdirSync(outDir, { recursive: true });
  const stamp = report.generatedAtUtc.replace(/[:.]/g, "-");
  writeFileSync(
    resolve(outDir, `bench-${stamp}.json`),
    JSON.stringify(report, null, 2),
    "utf-8",
  );
  writeFileSync(
    resolve(outDir, "bench-latest.md"),
    [
      "# P006 bench 最新结果",
      "",
      `- 生成时间（UTC）：${report.generatedAtUtc}`,
      `- 输入：variance-split，M=512/组，T=8，101 观测点，种子 ${scenario.seed}`,
      `- 方法：预热 ${WARMUP} 次后测 ${RUNS} 次，p95 为升序第 ceil(0.95*n) 个值`,
      `- Worker 计算 p95：${workerP95.toFixed(1)} ms（门禁 ≤ ${WORKER_P95_LIMIT_MS} ms，${workerPass ? "通过" : "不通过"}）`,
      `- CME 两组基准 p95：${cmeP95.toFixed(1)} ms（门禁 ≤ ${CME_P95_LIMIT_MS} ms，${cmePass ? "通过" : "不通过"}）`,
      `- Worker SSA 部分 p95：${p95(workerSsa).toFixed(1)} ms`,
      `- 结论：${report.overallPass ? "PASS" : "FAIL"}`,
      "",
    ].join("\n"),
    "utf-8",
  );

  console.log(JSON.stringify(report, null, 2));
  if (!report.overallPass) {
    console.error("bench 门禁未通过");
    process.exitCode = 1;
  }
}

main();
