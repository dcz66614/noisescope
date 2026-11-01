# P006 文件格式与复验（T007，项目书 §12）

## 实验文件：`.noisescope.json`

- UTF-8，最大 32 KiB；根对象就是 `ScenarioV1`。
- 拒绝未知 `schemaVersion`、非有限数、错误数组长度及额外字段
  （包括 `valid`/`PASS` 之类自带结论字段）；标题只当纯文本处理，
  原样保存，展示时仍须按纯文本转义，绝不能当 HTML/脚本执行。
- 入口：`src/io/scenario.ts`（校验本体在 `src/domain/validate.ts`，
  不另建第二份校验规则）。

## 证据文件：`.noisescope-evidence.json`

- 最大 8 MiB；唯一 v1 契约见 `src/domain/types.ts` 的 `EvidenceV1`。
- `payloadSha256` = SHA-256(`canonicalJson(payload)` 的 UTF-8 字节)。
  `canonicalJson` 递归按对象键 Unicode 码点序排序，数组顺序保留，
  数值用 `JSON.stringify` 有限数格式，`-0` 规范成 `0`，拒绝
  `undefined`/`NaN`/`Infinity`。它不是 RFC 8785 完整实现，不是数字签名。
- 哈希只覆盖 payload：**哈希一致只说明“结果 payload 哈希一致”，
  不证明整个文件真实**。scenario、audit、meta 另由结构检查、
  随机流审计和完整重算核查；meta 只用于追溯，不参与科学相等判断。
- 科学 payload 不含 `previewB`、全部轨迹事件、事件总数、耗时、
  创建时间；仅 `audit` 保存一个选中轨迹的事件（仅一个审计轨迹）。
- 导入顺序（全部通过前不得提交为当前实验，失败保留当前实验）：
  1. 大小、版本、完整 schema、数组长度、非有限数、counts 行和、
     数值诊断预算。
  2. 核对 `payloadSha256`，并由 counts 重建样本矩（差 ≤ 1e-9）。
  3. `verifyAudit`（`src/verify/replay.ts`）：绑定种子、组别、轨迹号
     及初始化、事件和终止随机流；不调用 SSA 主循环；速率按数学契约
     独立求出。
  4. 用 scenario 通过生产 Worker RUN 重算完整 `RunResult`
     （两组 CME、闭合、全部 M 条 SSA），结果先暂存，不覆盖当前实验。
     T007 单测可直接调用核心生成完整 `RunResult`；T013 再证明正式
     导入确实走生产 Worker，不能以测试替身完成用户流程。
  5. 比较全部科学浮点数组及 times（差 ≤ 1e-9）；`stateCount`、
     `completed`、全部 counts 严格相等；`numerical` 每个诊断独立满足
     预算；`termsUsed` 不作为跨环境相等判据；重算 audit 轨迹观察值
     须与导入 `sampledB` 一致。
- 差异归类：哈希、审计、参考数组、样本计数差异统一
  `EVIDENCE_MISMATCH`，并在 `differences` 中标明字段与类别；
  预算耗尽仍为 `BUDGET_EXCEEDED`，不混作数据篡改；
  取消或超时标“复验未完成”，不显示已验证。
- 诊断预算：`cumulativeTailBound` ≤ 1e-12，`|massDefect|` ≤ 1e-10，
  `minProbability` ≥ −1e-14。
- 入口：`src/io/evidence.ts`（`parseEvidence`、`verifyEvidenceHash`、
  `compareEvidence`、`verifyImportedEvidence`、`serializeEvidence`）。

## 复验的证明边界

独立审计只能证明所记录事件符合本规格和声明的伪随机流，不能证明
该随机流来自真实自然随机源，也不能单凭一条轨迹证明总体分布正确。
完整重算用于可复现性核对，独立解析 oracle 仍是正确性验收的必要环节。

## CSV 与 SVG（§12.3）

- 分布 CSV 固定列：
  `group,time,state_b,cme_probability,ssa_count,sample_count,ssa_probability`，
  行顺序时间升序 → 组别 P、Q → 状态 j 升序；`ssa_count` 为该状态
  SSA 计数，`sample_count` 为该组已完成轨迹数 M（概率分母）。
  数据区不输出任意标题；数值全精度输出。
- 均值表用单独文件、单独列模式
  （`group,time,meanB_cme,varianceB_cme,meanB_ssa,varianceB_ssa`），
  不混入分布表。
- SVG 导出当前分布图和均值图，各自带标题、模型参数、图例、时间
  及“合成模型”说明；不包含远程字体和外链资源。默认文件名只含
  ASCII slug、时间索引和组别，例如 `noisescope-distribution-P-t042.svg`。
  正式 SVG 需图表组件提供完整标签，不能仅导出空壳——本层生成器
  输出的就是带完整标签的成品 SVG。
- 入口：`src/io/csv.ts`、`src/io/svg.ts`。
