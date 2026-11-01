# 第三方依赖许可证声明

第一方代码（`src/`、`scripts/`、测试、文档、fixtures）采用 MIT，
见 `LICENSE`。本文件只声明第三方依赖，不分发其源码。

## 核对方法与权威来源

- 本文件由发布任务（T015）对照 `package-lock.json` 核对生成。
- `package-lock.json` 是许可证的权威来源：下表只列出
  `package.json` 的直接依赖；传递依赖的完整清单与许可证
  以 lockfile 为准，发布包不随附 `node_modules`。
- 核对时 lockfile 中许可证分布为：MIT 88 个、MPL-2.0 12 个、
  Apache-2.0 6 个、ISC 2 个、BSD-3-Clause 1 个，
  **未发现 GPL 类许可证**。如 lockfile 变更，须重新核对本文件。

## 直接依赖

| 依赖 | 版本（lockfile） | 许可证 | 用途 |
|---|---|---|---|
| react | 19.3.1 | MIT | 界面 |
| react-dom | 19.3.1 | MIT | 界面渲染 |
| @playwright/test | 1.64.1 | Apache-2.0 | 浏览器端到端测试（开发依赖） |
| @types/node | 24.19.2 | MIT | Node 类型（开发依赖） |
| @types/react | 19.3.0 | MIT | React 类型（开发依赖） |
| @types/react-dom | 19.3.0 | MIT | React DOM 类型（开发依赖） |
| tsx | 4.23.15 | MIT | 基准脚本运行（开发依赖） |
| typescript | 5.9.3 | Apache-2.0 | 类型检查与构建（开发依赖） |
| vite | 8.3.5 | MIT | 构建与预览（开发依赖） |
| vitest | 4.1.12 | MIT | 单元测试（开发依赖） |

## 传递依赖中的非 MIT 许可证（摘要）

- Apache-2.0：`@playwright/test`、`detect-libc`、`expect-type`、
  `typescript` 等（以 lockfile 为准）。
- MPL-2.0：`lightningcss` 及其平台包（Vite 的 CSS 处理链）。
- ISC：2 个传递依赖（以 lockfile 为准）。
- BSD-3-Clause：1 个传递依赖（以 lockfile 为准）。

## 明确不包含的内容

- 不复制 GillesPy2 / StochSS 的源码、测试素材或界面。
  二者为 GPL-3.0 参考项目，仅用于研究数学与接口组织；
  若将来引入其代码，必须先做许可证兼容判断和范围修订，
  不能复制后仍宣称全部自有 MIT。
- 不分发完整论文 PDF 或无许可图片；技术参考只保留书目信息
  与链接，见项目书第 18 节。
- 静态发布包（`noisescope-static.zip`）不含 `node_modules`，
  因此运行成品不需要第三方依赖的运行时许可再分发；
  源码包还原时 `npm ci` 会按 lockfile 重新获取上述依赖，
  届时以各依赖自带的许可证文本为准。
