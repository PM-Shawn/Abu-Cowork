# Computer Use M1 实施检查点

> 日期：2026-08-12
> 分支：`codex/computer-use-m1`
> 基线：`e0cfa533`
> 状态：M1 开发实现、自动化门禁与独立安全复审已完成；复审发现的关键动作确认绕过、AX 进程错绑和 Windows 并发/重复副作用风险均已修复，最终复审无可复现 P0/P1；最新 packaged smoke 完整通过。仍需在最终签名应用身份下完成 macOS TCC/连续任务/异常矩阵，并补 Windows installed 用户旅程；当前不可发布

## 1. 本阶段目标

M1 聚焦 Computer Use 的可靠执行闭环和宿主安全边界：

1. 将电脑操作统一收敛为 Observe → Act → Verify；
2. 用一次性、短时效 `state_id` 阻断陈旧观察和动作重放；
3. 由 Electron Host Gate 在主进程执行最终校验，而不是信任模型或 renderer；
4. 显式处理屏幕录制、辅助功能权限和 native helper 协议兼容性；
5. 按模型实际声明能力分级，并对未知模型保守处理；
6. 提供不含用户内容的本地运行状态、诊断和关联追踪。

## 2. 已完成能力

### 2.1 Observe → Act → Verify 控制器

- 观察结果生成 30 秒 TTL 的 `state_id`；
- `state_id` 绑定目标应用和目标进程；
- 动作只能消费一次，重放、过期和跨进程复用均拒绝；
- 动作后必须重新观察并给出验证状态；
- 控制器测试覆盖正常路径、过期、重放、目标漂移与验证失败。

### 2.2 Electron Host Gate

- 主进程独立检查当前目标、目标进程、`state_id` 和动作预算；
- 单次门禁仅允许一个写动作，不在 Host 层自动重试；
- renderer 或模型提供的目标信息只作为请求输入，不作为授权事实；
- 门禁测试覆盖伪造状态、陈旧状态、错误进程和重复消费。

### 2.3 权限与 native helper

- 区分屏幕录制与辅助功能权限状态；
- 按本次动作计算所需权限：AX-only 只申请辅助功能，视觉/像素路径才申请屏幕录制；
- 权限向导只展示本任务需要的权限，并在轮询 120 秒后停止等待、提供重试/重启指引；
- 权限需重启时只保存 10 分钟、一次性最小恢复 token（对话 ID、任务摘要 SHA-256、所需权限、时间）；重启后校验仍是同一任务，再重新发起任务和 Host 授权，不复用旧 token / `state_id` / AX session；
- 支持从产品内打开正确的系统设置路径并提示重新启动；
- helper 增加 hello/version/health 协议，版本不兼容时 fail closed；
- helper 进程代际绑定到 `state_id` 和 AX session，崩溃/重启后旧观察立即失效；
- helper 路径与管理器测试通过，Rust helper 可构建。

### 2.4 模型能力分级

- 能力分为 `full`、`structured`、`unsupported`、`unknown`；
- 内置模型按受控目录判定；
- 自定义模型优先读取显式工具能力声明；
- 未声明能力的自定义模型即使名称与已知模型相似，也按 `unknown` 保守阻断；
- DeepSeek 等无视觉模型可以进入结构化工具模式，但不会被描述为具备视觉闭环能力。

### 2.5 产品状态与诊断

- 设置页显示当前模型、能力档位和限制说明；
- 运行状态条显示目标应用、能力模式和 checking/observing/acting/verifying/blocked 阶段；
- 状态条不展示用户输入文本；
- 诊断页复用同一套能力解析器，避免设置页、运行时和诊断结果漂移。

### 2.6 本地关联追踪

- 记录 conversation/loop/computer run/tool call/state 的关联 ID；
- 记录模型档位、目标 bundle/process 和验证状态；
- 字段采用 allowlist；
- 不记录 prompt、截图、AX 标签、用户输入或工具结果正文。
- 补齐 route 类型、每轮 active/deferred 工具数量、Computer Use 是否暴露；
- 补齐 native helper start/ready/crash/restart/timeout 和当前代际快照；
- Host 验证回执记录 attempt 次数、状态变化结论和恢复/停止决策，不记录 AX 原文。

### 2.7 无进展与歧义动作治理

- 连续 3 次无界面变化时只允许一次受控恢复；
- 恢复后再连续 2 次无变化，由宿主控制器停止当前 Computer Use run；
- 高风险/非幂等动作结果不明确时立即锁定 run，禁止自动重试；
- `get_app_state` 与 `activate_app` 只清空旧观察，不会重置停止/恢复预算。
- 同一规则已下沉到 Electron Host 的任务级 attempt ledger：未拿到下一次观察回执前拒绝第二次写动作，renderer 绕过也不能重置预算；
- Host 仅在内存中保留 AX 结构的 SHA-256 指纹来判断是否变化，不持久化标签或输入值。

## 3. 已通过验证

| 验证项 | 结果 |
|---|---|
| `npm run verify` | 通过：357 个测试文件、4914 个测试；覆盖率 70.28% / 60.18% / 70.10% / 71.98% |
| `npm run electron:dev:check` | 通过 |
| `npm run electron:security-test` | 通过：101 passed、1 skipped、0 failed |
| native helper path tests | 通过：8/8 |
| `npm run build:native-helper` | 通过 |
| `npm run build:electron:renderer` | 通过 |
| `npm run electron:boot-verify` | 通过 |
| `npm run pack:electron` | 通过：生成本地未签名候选包 |
| `npm run smoke:electron:packaged` | 通过：退出占用同一 bundle ID 单实例锁的旧 `/Applications/Abu.app` 后，完整 packaged smoke（含 BrowserView 可见合成、native helper、sidecar、沙箱、浏览器与进程树清理）全部通过 |
| M1 聚合回归（WP0/Golden manifest/控制器/恢复/模型/Trace/工具/状态条） | 通过：8 个测试文件、112 个测试 |
| `git diff --check` | 通过 |

## 4. 尚未满足的发布条件

1. **真实 Electron Computer Use 旅程待复验**：2026-08-13 已确认 DeepSeek `deepseek-v4-flash` 正确进入 `structured` 模式并暴露 Computer Use。首轮 Finder 观察发现的 `get_active_window → osascript → System Events → -1743` 阻断已改为 native helper 的 `NSWorkspace.frontmostApplication()`；AX 快照已限定到 focused/main window，真实 Finder 观察从 500 个截断节点降至 27 个有效节点并成功返回窗口标题和前三项。随后发现任务终态租约未释放，已补 sidecar allowlist 与 renderer 进程边界幂等兜底；仍需从已授权 Terminal 启动后验证连续两次任务均成功，再完成 Finder/TextEdit/Calculator 真机矩阵。
2. **packaged macOS Computer Use 旅程待验证**：候选包完整 smoke 已通过。此前 `windowComposite=null` 来自旧 `/Applications/Abu.app` 占用同一 bundle ID 的单实例锁；退出旧实例后同一候选重跑通过，未通过削弱断言掩盖问题。仍需对最终签名应用身份分别验证屏幕录制与辅助功能权限，并跑通观察、点击/输入、再观察验证。
3. **异常旅程待验证**：至少覆盖权限拒绝、目标切换、helper 崩溃/版本不兼容和升级后首次启动。
4. **Windows installed 用户旅程待验证**：代码级回归已确认 Windows 保持原视觉控制路径、使用原有前台进程探针，不调用 macOS-only AX/identity API；仍需在 Windows Electron 安装包中验证 dialog focus、前台进程切换、普通动作互斥和歧义副作用停止。
5. **独立安全复审已完成**：独立会话经过五轮复现—修复—复审，最终未发现可复现 P0/P1。该签字不替代 macOS 签名/TCC 和 Windows installed 真机门禁。
6. **尚未提交、推送或发布**：当前只是开发 worktree 中的候选实现。

## 5. 对照初步方案的剩余开发清单

| 工作项 | 当前判断 | 下一步 |
|---|---|---|
| M0 Deferred Tool Search / recovery allowlist / 通用 loop guard | 已开发 | 进入诊断回放验收 |
| M1 Observe–Act–Verify / Host Gate / `state_id` | 已开发并通过独立安全复审 | 进入双平台真机矩阵 |
| 按任务权限、权限枚举、120 秒等待边界 | 已开发 | 验证 6 种权限组合 |
| 权限流程重启后恢复原任务 | 已开发 | 真机验证重启回到原对话、任务重新发起且 Host 再次授权 |
| CU 无进展一次恢复、歧义副作用停止 | **已开发（renderer + Host 双层）** | 真机注入无变化与不明确动作，核对回执和停止体验 |
| Helper hello/health/版本兼容与崩溃代际失效 | 已开发 | 真机注入 crash 并验证自动恢复只读观察 |
| 路由选择、工具 exposure、Helper 生命周期 Trace | **已开发** | 用诊断包回放核对跨进程事件链 |
| WP0 版本化回放 manifest（确定性用例不少于 20） | **已开发：25 条、6 个域** | 后续现场问题继续追加，保持确定性门禁 |
| 5 条 Golden Journey manifest 与重复运行记录 | **候选 manifest 已开发；真机记录未完成** | 与产品冻结 Finder/TextEdit/Calculator 候选范围后，每条重复运行 3 次 |
| 首次授权、升级、Helper crash、目标切换 packaged 矩阵 | 尚未验证 | 候选包阶段和用户一起测试 |
| Allowed Apps 持久授权、截图/AX 反馈选择器 | 首期明确后置 | 不阻塞 M1 |
| 独立签名 Helper App / 独立更新 | M3 后置 | M1 指标稳定后单独立项 |

## 6. 下一检查点

在最终签名且已授权的 macOS 应用身份下，先从两个全新对话连续执行 Finder 只读观察，确认第一任务终态释放租约、第二任务不再报 `already active`，并核对 `renderer.computer_use_task_cleanup` trace；随后重跑 Finder/TextEdit/Calculator 结构化 Golden Journey（每条 3 次）及权限/Helper 异常矩阵。Windows 侧用 installed 候选验证前台进程绑定、审批期间正反向并发写阻断和歧义副作用停止。双平台通过后才进入提交与发版决策。

## 7. 2026-08-13 首轮真机验收记录

### 7.1 环境有效性

- Electron PID `88359`、sidecar PID `88385`，均为本次重启后的新进程；
- `sidecar/index.mjs` 已在启动前重新构建，包含 `agent_route_selected` 与 `agent_tool_exposure` 新事件；
- 运行时事件确认 `modelId=deepseek-v4-flash`、`modelTier=structured`、`computerUseExposed=true`；
- 产品设置页显示 Computer Use Ready，屏幕读取和界面控制均为 Allowed。

### 7.2 有效通过项

1. DeepSeek 无多模态时被正确识别为 `structured`，没有发送截图或图片输入；
2. 请求正确路由到 Computer Use，不再误走文件系统 `List`；
3. 运行状态条正确展示 `Finder · Structured mode · Checking readiness`；
4. Trace 未记录 prompt、AX 标签或截图正文。

### 7.3 P0 阻断

- 用例：`gj-finder-structured-observe`；
- 期望：只通过 AX 读取 Finder 当前窗口标题和可见前三项；
- 结果：失败，系统返回“未获得授权将 Apple 事件发送给 System Events（-1743）”；
- 根因：`computerTools.ts` 在 `get_app_state` 前执行敏感应用检查时调用旧的 `get_active_window`，macOS 实现仍使用 `osascript/System Events`。真正的原生 `activate_app` 与 `ax_snapshot` 尚未执行；
- 影响：Finder、TextEdit、Calculator 等所有结构化 Computer Use 路径均会在同一前置检查处失败。当前 Golden Journey 重复运行应暂停，避免把共因失败错误归因给模型；
- 修复方向：前台应用身份检查改为 native helper 的 `NSWorkspace.frontmostApplication()`，并保留 Host Gate 的 bundle/process 绑定与动作前最终校验，不新增 Apple Events 权限依赖。

### 7.4 开发流程阻断

- `preelectron:dev` 当前只执行 Electron preflight 与 renderer build，不构建 sidecar；
- 首次验收因此实际运行了“新 renderer + 旧 sidecar”，旧结果已作废；
- 修复方向：开发启动自动构建 sidecar，或在 preflight 中以源码/产物时间戳和必需事件标识 fail closed。

### 7.5 P0 修复结果

- Computer Use 的前台应用安全检查已切换为 native helper `frontmost_app_identity`，macOS 使用 `NSWorkspace.frontmostApplication()` 返回 bundle ID 与 PID；
- renderer 的 Electron 路径不再调用 `get_active_window`，Tauri 兼容路径保持不变；
- Host Gate 的目标分类、bundle/process 绑定和动作前最终校验保持不变，没有降低安全标准；
- `preelectron:dev` 与 `preelectron:dev:enterprise` 现在都会在启动前构建 sidecar 和 native helper，避免新 renderer 配旧运行时；
- `npm run verify` 通过：357 个测试文件、4913 个测试；Electron 安全测试 90 通过、1 跳过；
- native helper 源码与候选包内二进制均实测支持 `frontmost_app_identity`，返回前台应用 bundle ID/PID，不触发 Apple Events；
- 候选包构建成功，helper 握手与 ping smoke 通过。整体 packaged smoke 连续两次被既有内置浏览器窗口合成截图检查阻断（`windowComposite=null`），与 Computer Use/helper 检查无关，作为独立发布阻断保留。

### 7.6 AX 窗口范围与任务租约 P0

- 原生 AX 快照优先从 `AXFocusedWindow` 开始，失败时回退 `AXMainWindow`，最后才回退应用根节点；避免 Finder 菜单栏和侧边栏先耗尽 500 节点预算，同时减少向模型暴露无关界面结构；
- 真实 DeepSeek/Finder 只读任务成功：只调用一次 `computer.get_app_state`，返回 27 个窗口内节点、窗口标题“桌面”和可见前三项；未调用 `run_command`、AppleScript 或截图，也未再出现 `-1743`；
- 紧接着的新任务暴露第二个 P0：sidecar 结束时 `ax_close_session` / `computer_use_end_task` 被 reverse RPC allowlist 拒绝，而清理异常被吞掉，导致主进程持续持有全局前台任务租约；
- 修复为两层幂等清理：sidecar 仅开放可信生命周期代码所需的两个 cleanup command；renderer 在 sidecar run 的 `finally` 中等待 task lease 释放后才允许下一任务返回，同时记录成功/失败 trace。模型无法直接调用 `native.invoke`，权限面未扩大；
- 定向回归通过：`agentLoopRunner` + `computerTools` 共 178 个测试；完整 `npm run verify` 通过 4913 个测试；Electron 安全测试 90 通过、1 个环境性跳过；
- 自动化重启由 Codex 进程启动时，macOS TCC 将其识别为未授权来源，产品正确显示 `Control interface · Setup required`。为避免绕过系统授权，连续任务真机复验暂停，必须由用户在已授权 Terminal 中启动同一 worktree 后继续。

### 7.7 自主重启与 packaged smoke 复验

- 用户明确授权自主重启后，从 worktree 执行 `npm run electron:dev`：sidecar、native helper 与 renderer 均在启动前重建，但 macOS 仍按启动责任链把该实例识别为未授权来源，产品正确 fail closed 到 `Control interface · Setup required`；未修改或绕过系统隐私权限；
- 系统中同时存在凌晨启动的 `/Applications/Abu.app`，它占用了 `com.abu.app` 单实例锁。先正常退出旧安装版，再启动 worktree 的 ad-hoc packaged 候选；候选路径不同且无正式 Team ID，不能继承旧安装版的 TCC 授权，因此不将其作为 Computer Use 真机通过证据；
- 退出旧安装版后，`npm run smoke:electron:packaged` 完整通过。BrowserView `windowComposite=null` 未再复现，确认此前结果是同 bundle ID 旧实例干扰，而非需要削弱 smoke 断言或修改产品合成逻辑；
- M1 聚合回归再次通过 8 个测试文件、111 个测试；完整 `npm run verify` 再次通过 357 个测试文件、4913 个测试，覆盖率保持 70.25% / 60.11% / 70.08% / 71.94%。

### 7.8 独立安全复审与跨平台收口

- 独立复审首先复现关键操作确认绕过：renderer 声明 `category=none` 时，Return、无语义像素点击等动作可绕过二次确认。Host 现按“原生语义识别 → 已声明关键类型 → 无语义保守确认”裁决，且所有应用都适用；确认框保留 send/delete/purchase 等精确类型与详情；
- AX 快照原先在 Host 校验 bundle/PID 后，由 helper 再按应用名解析，存在同名或进程重启后的错绑窗口。现在 Host 将期望 bundle/PID 写入 helper 请求，helper 单次解析后核对身份并直接对该 PID 创建 AX element；
- Windows 保持原有视觉控制能力，不强行依赖 macOS AX `state_id`；前台身份继续使用 Windows `get_active_window`，native input 前仍复核进程名/PID。所有 Windows control command 共享 task-level mutex，覆盖“审批先开始”和“普通 native 写先开始”两个并发时序；关键动作 native 结果不明确时锁死整个任务，禁止新 session 重试；Explorer Delete/Shift+Delete 由 Host 强制识别为删除动作；
- 独立会话共进行五轮针对性复现，最终结论为无当前可复现 P0/P1；`npm run electron:security-test` 通过 101 项、1 项环境性跳过，Rust helper 测试 3/3，企业代码泄露门禁与 `git diff --check` 均通过；
- 最终 `npm run verify` 退出码为 0：357 个测试文件、4914 个测试；覆盖率 70.28% / 60.18% / 70.10% / 71.98%。M1 聚合回归为 8 个测试文件、112 个测试；
- 重新执行 `npm run electron:dev:check`、release helper 构建、`npm run pack:electron` 和 `npm run smoke:electron:packaged`，最新候选完整通过，包含 helper handshake/ping、sandbox、sidecar、浏览器、MCP、Office、停止/崩溃进程树清理；
- 复审签字和 ad-hoc packaged smoke 只关闭代码级与打包结构风险，不构成最终签名应用 TCC 证据，也不替代 Windows installed 真机验收。
