# Computer Use M1 发布准备清单

> 日期：2026-08-14
> 工作树：`codex/computer-use-m1`
> 当前基线：`e0cfa533`（版本 `0.37.0`）
> 发布顺序：等待 `v0.37.4` 独立完成公开发布与外部验收后，再以其正式发布 SHA 为基线整合并发布 Computer Use 版本。

## 1. 当前结论

- M1 功能实现、自动化回归和独立安全复审已完成；当前候选仍不可直接发布。
- `v0.37.4` 与本版本是两个独立版本，不合并发布、不并行切换更新源。
- 当前不提交、不推送、不打 tag；先完成验收准备并保护现有工作树。
- Computer Use 属于 minor 级能力，版本号在完成 `v0.37.4` 基线整合后再冻结，避免提前制造版本冲突。

## 2. 2026-08-14 已完成的本地准备

| 门禁 | 结果 |
|---|---|
| `npm run verify` | 通过：357 个测试文件、4914 个测试；覆盖率 70.28% / 60.18% / 70.10% / 71.98% |
| `npm run build` | 通过 |
| `npm run test:electron:release-stage` | 通过：6/6 |
| `npm run test:electron:release-workflow` | 通过：25/25 |
| `npm run parity:check` | 通过：83 个命令满足、3 个已知后置项 |
| `npm run electron:dev:check` | 通过 |
| `npm run electron:security-test` | 通过：101 passed、1 skipped、0 failed |
| `npm run build:native-helper` | 通过 |
| `bash scripts/enterprise-leak-guard.sh` | 通过 |
| `git diff --check` | 通过 |
| `npm run pack:electron` | 通过：生成本地未签名 macOS arm64 候选包 |

说明：本轮没有启动 packaged smoke。被观察的 `v0.37.4` 任务仍运行自己的 Electron 实例；此时启动第二个候选会污染单实例锁、调试端口和用户数据目录证据。packaged smoke 留到该任务结束且 M1 完成新基线整合后执行。

## 3. 与 `v0.37.4` 的预合并检查

- 远端 `origin/dev` 当前候选为 `e408d68b`，`origin/main` 尚未推进到同一 SHA。
- M1 与 `e0cfa533..e408d68b` 有 22 个同路径改动。
- 不修改工作树的补丁检查显示，以下 11 个文件需要人工语义整合：
  - `electron/nativeHelperManager.cjs`
  - `electron/nativeHelperManager.path.test.cjs`
  - `electron/runtimeObservability.cjs`
  - `src/core/agent/agentLoop.ts`
  - `src/core/agent/agentLoopRunner.test.ts`
  - `src/core/diagnostic/checks/aiServices.ts`
  - `src/core/diagnostic/checks/aiServices.test.ts`
  - `src/i18n/locales/en-US.ts`
  - `src/i18n/locales/zh-CN.ts`
  - `src/i18n/types.ts`
  - `src/types/index.ts`
- 重点不能机械选边：必须同时保留 `v0.37.4` 的停止/队列生命周期修复和 M1 的 Computer Use 租约、Host Gate、helper 代际、诊断字段及产品文案。

## 4. `v0.37.4` 成功后的整合顺序

1. 按发布验收规范独立确认 `v0.37.4`：非 draft Release、三个安装资产、`dev/main/tag` SHA、三套 Electron feed、`latest-release.json` 和安装器 HTTP 可达性。
2. 记录正式发布 SHA，刷新 `origin/dev`、`origin/main` 和 tags；只有三者满足该版本发布策略后才开始 M1 整合。
3. 将 M1 功能保存为可审查的 feature commit，再把正式 `origin/dev` 基线合入 feature 分支；逐个处理上述 11 个语义冲突，不改写 `main`。
4. 重跑全量 `npm run verify`、生产构建、发布事务、parity、open-core 泄露门禁、Electron 安全测试和 native helper 测试。
5. 重建本地候选并执行 packaged smoke；确认没有其他 Abu/Electron 候选占用同一 bundle ID、调试端口或用户数据目录。
6. 对整合后的安全敏感 diff 再做一次独立复审，重点检查 Stop/queue 与 Computer Use task lease、审批失效和 renderer reload 的组合竞态。

## 5. 正式 RC 前真机验收矩阵

### macOS 最终签名身份

- 同一授权启动链下，两个全新对话连续执行 Finder 只读观察，第二次不得出现 `already active`。
- Finder、TextEdit、Calculator 的结构化 Golden Journey 各重复 3 次。
- 覆盖辅助功能/屏幕录制的允许、拒绝、需重启和功能探针失败。
- 覆盖目标切换、helper crash、helper 版本不兼容和升级后首次启动。
- 点击/输入后必须重新观察并得到验证回执；高风险或不明确副作用不得自动重试。

### Windows installed

- dialog focus、前台进程切换和目标 PID 绑定。
- 普通 native 写与审批中的写操作双向互斥。
- Explorer Delete / Shift+Delete 强制归类并确认。
- 不明确副作用锁死当前任务，不能通过新 session 重试。
- 安装、升级、启动、迁移保留和 packaged smoke 全部通过。

## 6. 单独发版门槛

- `v0.37.4` 已完成公开发布和外部验收。
- M1 已整合到该正式基线，11 个语义冲突均有测试与 review 证据。
- macOS 最终签名 TCC/Golden/异常矩阵通过。
- Windows installed 矩阵通过。
- 整合后独立安全复审无 P0/P1。
- 版本号四处一致、双语 changelog 完整，`npm run release:check` 通过。
- exact SHA 的 PR 检查、RC 三平台签名/公证/安装 smoke 和 `promotion-ready` 全绿。
- 稳定版仍按 `dev -> main --ff-only -> 单个正式 tag` 独立发布；发布后再核对 Release、refs、feeds 和安装器。
