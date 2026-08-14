# Computer Use M1 发布准备清单

> 日期：2026-08-14
> 工作树：`codex/computer-use-m1`
> 当前基线：`e408d68b`（正式版本 `0.37.4`）
> 发布顺序：等待 `v0.37.4` 独立完成公开发布与外部验收后，再以其正式发布 SHA 为基线整合并发布 Computer Use 版本。

## 1. 当前结论

- M1 已整合 `v0.37.4` 正式基线，本地候选版本已冻结为 `v0.38.0`；当前候选仍不可直接发布。
- `v0.37.4` 与本版本是两个独立版本，不合并发布、不并行切换更新源。
- 当前只完成本地提交和门禁，不推送、不打 tag、不切换更新源；先完成整合后独立安全复审。
- Computer Use 属于 minor 级能力，版本号冻结为 `0.38.0`。

## 2. 2026-08-14 已完成的本地准备

| 门禁 | 结果 |
|---|---|
| `npm run verify` | 通过：361 个测试文件、4952 个测试；覆盖率 70.45% / 60.32% / 70.33% / 72.13% |
| `npm run build` | 通过 |
| `npm run test:electron:release-stage` | 通过：8/8 |
| `npm run test:electron:release-workflow` | 通过：25/25 |
| `npm run parity:check` | 通过：83 个命令满足、3 个已知后置项 |
| `npm run electron:dev:check` | 通过 |
| `npm run electron:security-test` | 通过：101 passed、1 skipped、0 failed |
| `npm run electron:test` | 通过：迁移、Host UI、安全、命令沙箱、浏览器运行时和 sidecar acceptance 全绿 |
| `npm run test:e2e:electron` | 通过：15/15，含 stop/restart、renderer/sidecar 异常、审批、BrowserView 与能力设置 |
| `npm run build:native-helper` | 通过 |
| `bash scripts/enterprise-leak-guard.sh` | 通过 |
| `git diff --check` | 通过 |
| `npm run pack:electron` | 通过：生成本地未签名 macOS arm64 候选包 |
| `npm run smoke:electron:packaged` | 通过：63 项打包态检查全部为 true |

说明：上述打包态 smoke 使用隔离的本地未签名候选，不能替代最终签名 macOS 身份下的 TCC/Golden Journey，也不能替代 Windows installed 验收。

## 3. `v0.37.4` 外部验收与整合结果

- `v0.37.4` 已独立核对为非 draft、非 prerelease 的正式 GitHub Release；macOS arm64、macOS x64、Windows x64 三个安装资产齐全且下载地址返回 HTTP 200。
- `origin/dev`、`origin/main` 与 `v0.37.4` tag 均指向 `e408d68b04daa33980e23a2320763ae3f179d1d2`；三套 Electron feed 与 `latest-release.json` 均为 `0.37.4`。
- M1 feature commit 为 `fdf9fd0e`，合入正式基线的 merge commit 为 `a5e1e092`，版本准备 commit 为 `ef54ab0e`。
- Git 实际产生的冲突只有两个文件，均按语义合并：
  - `electron/runtimeObservability.cjs`
  - `src/core/agent/agentLoop.ts`
- 合并结果同时保留 `v0.37.4` 的停止/队列生命周期修复与 M1 的 Computer Use 租约、语义循环检测、延迟工具提升和观测字段；针对性回归为 370 个 Vitest 用例与 62 个 Electron node 用例全绿。

## 4. 下一阶段顺序

1. 完成整合后独立安全复审，重点检查 Stop/queue 与 Computer Use task lease、审批失效、renderer reload、helper 代际、观测脱敏及 open-core 边界。
2. 复审无 P0/P1 后推送 feature 分支、创建目标为 `dev` 的 PR，并等待 exact-SHA CI 全绿。
3. 合入 `dev` 后以同一 SHA 创建 `v0.38.0-rc.1`，等待三平台签名、公证、安装 smoke 与 `promotion-ready`。
4. 使用 RC 的最终签名 macOS 应用和 Windows installed 包完成下述真机验收矩阵。
5. 只有 RC 和真机证据全部通过，才将 exact SHA 快进到 `main` 并创建唯一稳定 tag `v0.38.0`。

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
