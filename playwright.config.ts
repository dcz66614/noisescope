import { defineConfig } from "@playwright/test";

// 固定（实施计划 §10.2）：T001—T014 的 webServer 一律用 npm run preview，
// 测已构建的 dist，端口 4173、strictPort、reuseExistingServer=false。
// T001 不安装 Chromium、不跑 e2e；浏览器安装与 e2e 由后续任务（T013）负责。
export default defineConfig({
  testDir: "e2e",
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 120000,
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
});
