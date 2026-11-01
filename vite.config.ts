import { defineConfig } from "vite";

// T001: 不使用 @vitejs/plugin-react，避免引入实验性 React 编译器。
// 仅用 Vite 内置 esbuild 做 automatic JSX 转换；骨架不需要 Fast Refresh。
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
