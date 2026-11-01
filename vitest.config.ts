import { defineConfig } from "vitest/config";

export default defineConfig({
  // 不在这里设 esbuild.jsx：Vitest 4.1 默认用 oxc，两者并存会告警且 esbuild 被忽略。
  // 构建侧的 JSX 转换仍由 vite.config.ts 的 esbuild.jsx=automatic 负责。
  test: {
    // 固定：Vitest 仅覆盖 tests/，不收集 e2e/ 的 Playwright .spec.ts。
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    environment: "node",
  },
});
