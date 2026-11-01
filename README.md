# P006 反应骰 NoiseScope

同均值异分布的随机反应实验室：两个初始均值相同、分布不同的组，
在非线性反应下均值会向相反方向走；在线性反应下均值重合。
本程序用 SSA 随机模拟、有限状态 CME 概率基准和均值闭合诊断，
把“方差修正”这件事算清楚、画清楚、审计清楚。

默认实验（`variance-split`，二聚 `2A ⇌ B`，`A + 2B = 20`，
`kf = 0.02`，`kb = 0.2`）：P 组恒为 `B = 5`，Q 组一半 `B = 0`、
一半 `B = 10`。两组初始 `E[B] = 5`、`E[A] = 10`，
初始 `dE[B]/dt` 为 P 组 −0.1、Q 组 +0.9，差值 +1.0 正是方差修正。
详见 `docs/MODEL_ASSUMPTIONS.md` 与 `HOW_TO_REPRODUCE.md`。

## 快速开始

要求：Node 24（见 `.nvmrc`，24.22.1）、npm。
首次运行需要联网安装依赖与浏览器（Playwright Chromium）；之后
运行成品不需要联网，全部计算在本地浏览器 Worker 内完成。

Linux（bash，源码根）：

```bash
node --version
npm --version
npm ci
npm run typecheck
npm run test:core
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run bench
npm run serve
```

Windows（PowerShell，源码根，命令与上面一一对应）：

```powershell
node --version
npm --version
npm ci
npm run typecheck
npm run test:core
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run bench
npm run serve
```

然后用浏览器打开 <http://127.0.0.1:4173/>。
`npm run serve` 只用 Node 内建模块，绑定 127.0.0.1，
提供 `dist/` 内的文件；按 Ctrl+C 停止。

> Windows 命令已列出，但**未在本 Linux VM 上实跑**，如在 Windows
> 上遇到路径或端口问题，请以实际报错为准，不要把 Linux 的实测
> 结果当作 Windows 的实测结果。

## 只运行成品（不需要源码与 npm 依赖）

```bash
npm run build
npm run release
npm run verify:release
```

产物在 `release/`：`noisescope-static.zip` 与 `source-release.zip`，
另有 `SOURCE_MANIFEST.csv`、`SHA256SUMS.txt`、`release-manifest.json`。
解压静态包后：

```bash
node serve.mjs dist 4173
```

再打开 <http://127.0.0.1:4173/>。静态包内只有 `dist/`、
`serve.mjs` 与运行说明，没有 `node_modules`，不需要 `npm ci`。

## 文档

- `USER_GUIDE.md` — 界面、预置、运行、审计、导出、离线与故障处理。
- `HOW_TO_REPRODUCE.md` — 不依赖聊天记录复现黄金样例与统计门禁。
- `docs/MODEL_ASSUMPTIONS.md` — 模型假设、公式边界与不声称事项。
- `docs/API_CONTRACT.md` — 输入、校验与文件格式契约。
- `docs/FILE_FORMAT.md` — 实验文件、证据文件、CSV/SVG 格式。
- `docs/ENVIRONMENT_LOCK.md` — 本机实测环境与锁定版本。
- `THIRD_PARTY_NOTICES.md` — 第三方依赖许可证（以 `package-lock.json` 为准）。
- `LICENSE` — 第一方代码 MIT 许可证。

## 重要边界

- 本程序是合成模型演示，不读取麦克风、摄像头或传感器，
  不上传文件，全部输入是合成参数或本地 JSON。
- “开发 mock”只在开发阶段存在，生产路径没有 mock 完成入口；
  mock 结果不可导出为成功实验（冻结前另有修复卡删除死代码分支，
  见任务记录，T015 不改生产源码）。
- 论文 PDF 不作为产品资源分发，仅保留书目信息与链接；
  不复制第三方 GPL 源码（GillesPy2 / StochSS 仅为数学与接口参考）。
