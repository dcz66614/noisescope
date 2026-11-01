# P006 ENVIRONMENT_LOCK.md — T001 环境锁定（实测，非历史记录）

- PROJECT_ID: P006，SLUG: noisescope，SPEC_VERSION: 1.0.0
- 锁定时间：2026-10-31（VM 实测）
- 源码根：`04_source/`（任务卡与控制器指派的工作树根；项目书 §15 的
  `04_source/source/` 是“建议布局”，本任务以任务卡为准，验收命令均在
  `04_source/` 内执行。后续任务如需迁移布局，须由控制器另行指派，不得
  在 T001 之后擅自移动源码根。）

## 实测环境

| 项目 | 实测值 |
|---|---|
| OS | Linux htch-runtime 7.0.0-39-generic x86_64 |
| Node | v24.22.1（.nvmrc 锁定 24.22.1） |
| npm | 10.9.4 |
| CPU | 4 核 |
| 内存 | 总 7.7 Gi，探测时可用约 283–597 Mi（紧张；构建时避免并行过载） |
| 磁盘 | /home/hatch 可用 148G |
| Windows | 命令与路径仅审查，Windows 实跑未验证 |

## 锁定依赖（package.json 精确版本 + package-lock.json）

| 依赖 | 锁定版本 | 备注 |
|---|---|---|
| react / react-dom | 19.3.1 / 19.3.1 | 版本一致，19.x 系列最新补丁 |
| typescript | 5.9.3 | 5.9.x 系列最新补丁 |
| vite | 8.3.5 | 8.x 系列最新补丁 |
| vitest | 4.1.12 | 见下方兼容性记录（4.0.0 不可用） |
| @playwright/test | 1.64.1 | 1.x 系列；浏览器见下 |
| tsx | 4.23.15 | 开发依赖，bench 用（bench 脚本本身属后续任务） |
| @types/react / @types/react-dom | 19.3.0 / 19.3.0 | |
| @types/node | 24.19.2 | 供 tsconfig 的 node 类型（smoke 测试用 process.versions） |

构建配置：不使用 @vitejs/plugin-react，改用 Vite 内置 esbuild 的
automatic JSX 转换，避免引入实验性 React 编译器（项目书要求不启用
实验性编译器）。Vitest 4.1 默认用 oxc，不在 vitest.config.ts 里并存
esbuild.jsx（并存会告警且 esbuild 被忽略）。

## 已实现脚本（仅真实可跑的）

- `dev`、`typecheck`、`build`、`test`、`preview`
- 未实现、不占位冒充：`test:core`、`test:e2e`、`bench`、`serve`、
  `release`、`verify:release`。这些脚本指向的文件（scripts/bench.ts、
  scripts/serve.mjs 等、e2e/、tests/core/）在 T001 尚不存在，按任务卡
  “不得用返回 0 的假脚本冒充未来功能”的要求暂不写入 package.json，
  分别由 T008/T013/T015 等拥有任务实现。

## 测试配置固定

- Vitest include 仅 `tests/**/*.test.ts(x)`，exclude e2e/、node_modules/、dist/；
  因此 `npm test` 不收集 Playwright 的 .spec.ts。
- Playwright testDir 为 e2e/，webServer.command 固定为 `npm run preview`
  （测已构建 dist，http://127.0.0.1:4173，strictPort，
  reuseExistingServer=false）。

## 兼容性记录（真实失败，非推测）

1. 一次性安装全部依赖时，npm 10.9.4 的 arborist 在解析对等依赖时报错
   `Cannot read properties of null (reading 'edgesOut')`。分步安装定位到
   Vitest：4.1.x 单独安装时同样报错，4.0.0 可干净安装。
2. 但 Vitest 4.0.0 + Vite 8.3.5 运行时报错
   `Unknown method: getBuiltins. Expected "fetchModule"`（forks 与 threads
   池均失败），测试套件无法收集。
3. 解决：用 `--legacy-peer-deps` 安装 Vitest 4.1.12（仍在 4.x 系列内，
   未换框架），此后 `npm ci` / typecheck / build / vitest 全部干净通过。
   因此锁定 Vitest 4.1.12，并记录：后续复跑若用严格对等依赖安装重建
   lockfile，仍可能复现 arborist 报错，届时应复用本 lockfile 或
   `--legacy-peer-deps`，不得擅自把 Vitest 升到 5.x 或降回 4.0.0。
4. typecheck 初版报错已修复：导入路径去掉 `.tsx` 后缀（TS5097），并
   补装 @types/node（smoke 测试用 process）。
5. T010 补记（R010 接受）：T001 骨架漏了标准 Vite 脚手架文件
   `src/vite-env.d.ts`（仅一行 `/// <reference types="vite/client" />`），
   导致绑定导入 `.module.css` 时 tsc 报 TS2307。这是最小正确修复，
   不改构建配置、不含业务逻辑；文件内 `declare module` 会被当作
   augmentation 而失败、用 ts-ignore 掩盖都更差。T011/T012 的组件
   任务同样依赖它，不必重复定夺。

## 浏览器证据

- T001 验收不含 e2e；为取最小页面截图，另行执行了
  `npx playwright install chromium`，装得 Chrome Headless Shell
  156.0.8078.4（chromium_headless_shell-1248），截图脚本在 /tmp、
  不在源码树内，截图见 `07_evidence/minimal-page.png`，Playwright
  实测 H1 与正文与占位壳一致。
- 本机 /opt/meta-chromium/chrome 是 Hatch 托管浏览器，headless 启动
  被其域策略拒绝（“Hatch WebGL domain policy is required”），未用它
  截图，也未绕过其策略。
- e2e 正式测试仍属后续任务（T013），T001 不声称 e2e 通过。

## 验收结果（T001 范围内）

- `npm ci`：exit 0
- `npm run typecheck`：exit 0
- `npm run build`：exit 0，dist/index.html 0.33 kB，
  dist/assets/index-*.js 219.78 kB（gzip 68.85 kB）
- `npx vitest run tests/smoke.test.ts`：2/2 通过（仅冒烟：占位标题导入
  + Node 24 检查）
- 以上只证明骨架成功，不代表全项目通过；正式功能、SSA、CME、界面
  均未实现，也未测试。

## 施工渠道如实记录（T001）

- 本任务未使用 Antigravity、M365 Copilot 桥、OpenAI、DeepSeek。
- 免费渠道在本子代理 shell 内未调通，故骨架由本子代理直接按任务卡
  编写（任务卡允许的回退），未谎称用了免费模型：
  - WorkBuddy / opencode 中继：VM 直连 100.94.215.83:5390 返回空，
    需经运行时 Tailscale 隧道代理，该代理配置在本 shell 内不可用。
  - dsh-our-free-model：DSH Web 在 127.0.0.1:3080 运行中，但
    /api/our-free-model/summary 无鉴权返回 401；其 token 只在父代理
    的内部脚本里，本子代理不得提取。
  - DSH 本地网关 127.0.0.1:8326 要求 API key，同样不得提取。
  - dsh / opencode CLI 均为交互式 harness，需另行配置 provider，
    不是可直接管道调用的免费模型 CLI。
- 建议控制器后续为施工子代理提供一条无需提取 token 的免费模型调用
  方式（例如已配好 provider 的 opencode run / dsh headless 入口），
  否则后续任务也只能沿用“本代理直写 + 如实说明”的回退。
