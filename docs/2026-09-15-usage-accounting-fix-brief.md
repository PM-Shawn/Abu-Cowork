# 用量记账修复

代码注释里写的「任务书」指本文件：规则编号 U01–U08、验收编号 V01–V09、「期 N 第 M 步」都在这里定义。

## 要修的问题

用量页的数字长期不增长，日期与用户实际使用的日子对不上，Claude 的缓存两项一直是 0，写入失败时页面上没有任何提示。

## 根因

1. **sidecar 里的记账函数只会抛出错误，调用处把错误吞掉。** 打包 sidecar 时 `usageTracker` 被换成 `sidecar/src/shims/usageTrackerRun.ts`，这个文件直接抛出错误；`src/core/agent/agentLoop.ts` 里唯一的调用处写的是 `import(...).then(...).catch(() => {})`。结果是完全不记。
2. **sidecar 是常态路径。** `src/core/agent/agentLoopRunner.ts` 只有在 sidecar 没有运行时才回到 renderer 内执行主循环，所以第 1 条影响的是绝大多数请求。
3. **日期用 UTC。** 旧的 `usageStatsStore` 与用量页都用 `toISOString().slice(0, 10)` 取日期，东八区凌晨的请求被记到前一天。
4. **Claude 的 `done` 事件整体替换 usage，并且不带缓存字段。** 主循环处理 `usage` 事件时是合并，处理 `done` 事件时是替换；`src/core/llm/claude.ts` 构造 `done` 的 usage 时没有带 `cache_creation_*` 与 `cache_read_*`。即使记账成功，Anthropic 的缓存两项也一直是 0。

第 4 条与第 1 条互相独立，两条都要修。

## 范围

**做**：四条根因的修复；主进程里的一个账本；一个读视图；写入失败可见；抛出错误的 shim 的发版门禁。

**不做**：历史回填、金额与账单对账、旧 `TokenUsage` 协议的统一、清除全部数据的界面、任何 Tauri 一侧的改动、企业服务端的改动。

## 三个设计决策

### 1. 记账放在 provider 边界

采集器放在 `ClaudeAdapter` 与 `OpenAICompatibleAdapter` 两个类的内部。

- 全仓的模型调用最终都经过这两个类（主循环、子代理、上下文压缩、`llmCall`、连接检查、记忆提取、sidecar 的 LLM 宿主），所以每个入口都被覆盖，无须逐个入口接线。
- `SidecarLLMAdapter` 只做转发，自己不记账；记账的是 sidecar 进程里真正发请求的那个 adapter，所以同一次请求只会记一次。
- 尝试的身份在 `fetch` 这一层生成。Anthropic SDK 内部的重试会再经过一次 `fetch`，`openai-compatible` 超出 `max_tokens` 之后的重试是第二次真实发送，两者都各占一条尝试。不改 `maxRetries`、不改请求体、不改重试策略。
- 生图、语音、外部工具自己的模型调用不经过这两个类，不在本次范围内。
- renderer 与 sidecar 运行同一份 adapter 代码，两个进程的语义相同。

`source`、`conversationId`、`skill` 这些 adapter 不知道的字段，放在 `ChatOptions` 的可选项 `accounting` 里，由调用处填写。没有填写时记为 `source: 'other'`、归属为空，记录本身照常保留。

### 2. 一句 SQL 保证幂等

主进程独占一个 `usage.sqlite`（`node:sqlite`，没有新增原生依赖）。一张表，主键是 `attempt_id`，`revision` 单调递增，WAL 模式加 `synchronous=NORMAL`（与主进程里另外两个库一致）。已提交的事务在进程崩溃之后仍然在，只有操作系统崩溃或断电可能丢掉最后几次提交。写入只有一句：

```sql
INSERT INTO usage_attempts VALUES (?, ?, ?)
ON CONFLICT(attempt_id) DO UPDATE SET revision=excluded.revision, snapshot=excluded.snapshot
WHERE excluded.revision > usage_attempts.revision
```

这一句同时保证：同一条重复写入只留一条；`revision` 只增不减；旧的快照不会覆盖新的；乱序到达也安全。因此生产者无须知道写入是否成功，重发没有害处，也就不需要确认回执。

没有待发队列，也没有内存里的补存队列。写入失败时主进程累加计数，记下首次与末次失败的时间和稳定的错误码，随查询结果返回，页面显示一行提示。

账本是独立的权威数据。遇到版本号比当前程序认识的更高、或者数据库损坏时，停止写入并提示，不删除重建。

### 3. 发送请求之前不等待任何存储

顺序固定为：分配 `attemptId` → 发起请求 → 写第一版快照（不等待结果）→ 每次出现新的 usage 写下一个 `revision` → 结束时写终态。

记账失败因此不会阻塞聊天，这一点无须额外的超时或降级逻辑。

### 传输通道：sidecar 直接到主进程

`electron/mcpBridge.cjs` 在主进程里逐行解析 sidecar 的 stdout，用量帧在这里被拦下并写进账本。这条通道不经过 renderer：renderer 刷新、卡住或者没有订阅时，用量照常记录。renderer 自己发起的模型请求经 preload 的 IPC 写入账本。

## 产品规则

- **U01 单视图。** 页面显示统计起点和一行「更早的记录不完整，未并入」。旧 store 的数据保留在本地，不回填、不相加、不再读取。
- **U02 请求尝试。** 计数的标签是「请求尝试」：客户端确实交给传输层的一次模型请求。SDK 内部重试与超出限额后的重试各算一次，没有发出去的参数校验失败不算。一条用户消息可能触发多次。每条尝试带有来源 `source`，供诊断使用。不得称为账单请求数。
- **U03 用量口径。** 输入总量 = 非缓存输入 + 缓存读 + 缓存写；输出包含推理，推理是输出的子项，不重复相加。`null` 表示未知，`0` 只表示已知为零。非法值、非有限值、负数、互相矛盾的字段不进入可信合计，计入不完整的次数。汇总里含有未知值时，页面顶部一行写出受影响的尝试数。缓存命中率只在缓存读与输入总量都已知的尝试上计算，没有可比数据时显示「—」。金额与账单对账不在范围内。
- **U04 日期。** 日期按请求开始时的本地日历归属。保存本地日期、UTC 起止时间、IANA 时区、offset。跨午夜的请求归属开始那一天；更改时区不改写旧记录；重试是新的尝试，使用它自己的开始日期。页面长时间开着跨过午夜时要刷新。
- **U05 写入失败。** 请求的结果（成功、失败、取消、中断）与用量是否完整互相独立。写入失败不得阻塞聊天，不得打断进行中的回答，不得额外触发任何模型重试；失败只累加健康计数，页面显示「有 N 次请求未能记录，统计可能不完整」。不承诺补存，不承诺重启后找回。查询失败时保留上一次的快照并标注「暂未更新」，不清成 0。同一条尝试重复写入不重复计数。
- **U06 保存期与隐私。** 新账本不做按天数的静默裁剪。只保存请求身份、路由与模型、时间、用量、结果和必要的关联；不保存提示词、回答、图片、密钥、完整请求头。删除会话不冲减全局用量。诊断包只输出范围汇总、覆盖、失败计数与稳定的错误码。提供显式的 purge API 并测试（覆盖数据库文件与 `-wal`、`-shm`），不接入任何用户流程，升级、故障恢复、删除会话都不得调用它。
- **U07 企业部署的两份用量。** 企业部署另有一份由服务端统计的用量，带金额，按服务端的日期边界分桶。客户端页面按本地日历、计请求尝试、没有金额，两边不能逐笔对账。企业模式下客户端页面必须标注：「客户端记录的聊天模型请求尝试，非计费口径；账单见控制台」。
- **U08 消息气泡只显示输出。** 消息气泡原先显示旧口径的输入与输出，会和新账本对同一轮对话给出不同的数字。改为只显示输出一项。

## 两条固定口径

1. **`offsetMinutes = -new Date().getTimezoneOffset()`，UTC+8 记为 +480。** 写进注释与测试。符号与 IANA 的读法一致。
2. **`openai-compatible` 协议承载 Claude 时的缓存口径。** 企业网关一律经过 OpenAI 适配器，其上的 Claude 模型也是如此。规则：`inputTotal = prompt_tokens`；响应带 `cache_creation_input_tokens` 时取为 `cacheWrite`，并把 `inputTotal` 是否包含它记为未知；响应带 `prompt_cache_miss_tokens`（DeepSeek）时直接作为 `uncachedInput`。

## 协议：能算出来的不保存

每条尝试的快照保存：`attemptId`、`logicalCallId`、`providerInstanceId`、`protocol`、`requestedModel`、`servedModel`、`source`、`conversationId`、`skill`、`startedAtUtc`、`localDate`、`tzId`、`offsetMinutes`、`endedAtUtc`、`outcome`、`revision`，六个 token 字段（`inputTotal`、`uncachedInput`、`cacheRead`、`cacheWrite`、`outputTotal`、`reasoningOutput`，类型都是 `number | null`），以及一个 `evidence: 'final' | 'partial' | 'none'`。

完整性在查询时由 `null` 与 `evidence` 计算，不保存。不保存 provider 报告的总数，不为每个字段单独保存 `validationState` 这类校验状态。

累计快照的语义：provider 在流里给出的用量是累计值，同一条尝试后来的字段是修订，不相加；缺少的字段不覆盖已知的字段。只收到开始事件就中断的尝试，即使输入输出都有值，也只能标为已知部分。成功、失败、取消本身都不能证明用量完整。

`reasoningOutput` 是新增的采集项：旧的 `TokenUsage` 没有推理字段。

## 实施分期

### 期 1「用量数字对了」

1. **口径冻结**：`AccountingUsage` 与身份字段；`offsetMinutes` 的符号断言；六组固定样例（Anthropic 的 `start+delta`、只有 `start` 之后中断、OpenAI 的尾部 usage、企业网关上的 Claude、缺字段、矛盾字段），逐字段写明期望值。
2. **账本与两条通道**：主进程的 `usage.sqlite`、单句幂等写入、健康计数；版本检查；sidecar stdout 帧的拦截；renderer 经 preload 写入。故障注入：只读的库、损坏的库、写到一半进程被终止、同一条重放 100 次。
3. **采集与语义修复**：采集器进入两个 adapter，尝试计数在 `fetch` 层；删除 `usageTrackerRun.ts` 和旧的 `usageTracker` 写入路径，sidecar 一侧的发送在 `src/core/llm/usageSink.ts` 与 `sidecar/src/shims/usageSinkRun.ts`；三处语义修复（主循环 `done` 分支改为合并、`claude.ts` 的 `done` usage 带上缓存字段、子代理循环去掉 `outputTokens` 的二次累加）；各调用处填写 `source`。
4. **读视图**：用量页改读新账本，日期按本地日历，单视图加统计起点一行，写入失败一行提示，会话上的用量标记改读新数据，消息气泡只显示输出。
5. **门禁与真机**：`npm run verify` 退出码 0 且覆盖率不降，`npm run electron:dev:check`，在真实 Electron 里走完受影响的路径。

对外声明修复之前，需要在 Windows 上验收：文件系统与磁盘刷新的行为在两个平台上不同，macOS 上通过不能代替 Windows。

### 期 2「用量看得懂」

1. 完整性的表达：未知用量的受影响尝试数、查询失败时保留旧快照并标注「暂未更新」、缓存命中率只按可比的尝试计算（U03）。
2. 企业部署的两份用量标注一行（U07）。
3. 诊断包的用量汇总段：范围汇总、按来源的汇总、覆盖、失败计数、稳定的错误码。

### 期 3「防复发」

`sidecar/src/shims/` 下会抛出错误的文件（含 `throw` 语句、含 `Promise.reject(...)` 调用，或者转出了这样的本地模块）必须导出分类常量 `SHIM_THROW_KIND`，取值为 `wiring-guard`、`shell-side`、`input-check`、`feature-gap` 之一，含义见 `sidecar/src/shims/shimThrowKind.ts`。`shimSurfaceCoverage.test.ts` 断言每个这样的文件都有分类；`scripts/release-preflight.mjs` 遇到 `feature-gap` 就让发版失败。

根因第 1 条就是这类缺口：一个 shim 用抛出错误顶替了功能，没有任何机制阻止它随版本发出去。

### 期 4「补齐」

1. 显式的 purge API 与测试（覆盖数据库文件与 `-wal`、`-shm`），不接入任何用户流程。
2. 推理 token 的采集（`completion_tokens_details.reasoning_tokens`）。
3. 性能基准：十万行的日期范围查询、并发五十个请求、异常计数的大输入。运行一次并记录数据，不作为门禁。
4. 评估「后续事项」里的两项。

## 验收

| 编号 | 规则 | 必需的验证 |
|---|---|---|
| V01 | U01 | 带旧数据升级：新视图的起点正确，旧 key 的字节不变，没有相加；会话上的用量标记读新数据，没有新记录时不显示旧值 |
| V02 | U02 | 主代理、并发的子代理、压缩、记忆提取、技能辅助、连接检查都带有 `source`；`SidecarLLMAdapter` 转发不重复计数；SDK 内部重试与超出限额后的重试各成一条尝试 |
| V03 | U03 与两条固定口径 | Anthropic 的 `start+delta` 与只有 `start` 之后中断或取消（累计值不得当作最终值）；OpenAI 的尾部 usage；企业网关上 Claude 的 `cacheWrite`；推理子项；全部未知、仅缓存未知、非法字段、溢出，逐字段写明期望值 |
| V04 | U04 | UTC+8 的午夜、负的 offset、夏令时、更改时区、跨午夜的重试、系统时钟回拨、页面长时间开着跨日后的刷新；`offsetMinutes` 的符号断言 |
| V05 | U05 | 重放 100 次后请求数仍为 1；乱序的 `revision` 不回退；提交之后进程被终止再重启，记录仍在；只读的库与损坏的库之下仍能正常聊天并得到回答，不触发任何模型重试，健康计数可见；查询失败时保留旧快照 |
| V06 | U06 | 账本与诊断包里没有敏感内容；删除会话不减少全局用量；不同数据身份之间不混账；purge 之后三个文件都没有残留 |
| V07 | U07 与 U08 | 企业环境下客户端页面的标注存在；同一轮对话不出现两个互相矛盾的数字 |
| V08 | 期 3 | 人为把一个 shim 标成 `feature-gap` 时，发版检查必须失败 |
| V09 | 性能 | 十万行的日期范围查询、并发五十个请求、异常计数的大输入；界面响应不受影响。超出预算时先解释再评审，不调低阈值 |

测试按层命名（`*.test.ts`、`*.integration.test.ts`、`*.contract.test.ts`、`e2e/*.spec.ts`），固定时间、随机数与网络。

## 后续事项

- **旧 `TokenUsage` 协议的 `inputTokens` 在不同 provider 之间含义不同**：Anthropic 不含缓存，OpenAI 的 `prompt_tokens` 含缓存。旧视图的缓存合计因此对 OpenAI 路径重复计入缓存。本次没有改动它，以免连带改变计价与上下文预算。
- **token 估算器的校准**：主循环用 `calibrateFromUsage` 校准估算器，它的输入受根因第 4 条影响。修复之后校准的输入会变化，需要观察上下文预算有没有漂移。
- **旧 store 的 `conversationTotals` 从不裁剪**，是 localStorage 里原有的增长项，本次不处理。
- **生图的用量**：`src/core/tools/definitions/mediaTools.ts` 直接向 `/images/generations` 发请求，不经过两个 adapter，本次的记账覆盖不到它。
