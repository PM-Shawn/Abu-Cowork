# Release Notes Convention

Abu 的 release notes 写作规范。配合 `CLAUDE.md` 的 Release Process 一节使用。

> **核心原则**：跟 commit message 一样双语，但**中文为主，英文点睛**，不要每行翻译。Patch 走极简、Minor+ 走完整，永远写"为什么"和具体数字。

---

## 三档模板

### Patch (vX.Y.Z++) — 单点修复 / 小优化

**判定**：1-2 个 commit，单一主题，无新功能或破坏性变更。

```markdown
## vX.Y.Z — 一句话主题

**根因**：[一句话讲清楚 bug 的本质 / 优化的动机]

**修复**：
- [用户能看到的影响 1]
- [用户能看到的影响 2]
- [必要时给出关键技术细节，例如"9 处 spawn 加 CREATE_NO_WINDOW"]

Full Changelog: https://github.com/PM-Shawn/Abu-Cowork/compare/vX.Y.Z-1...vX.Y.Z
```

**参考范例**：[v0.13.6](https://github.com/PM-Shawn/Abu-Cowork/releases/tag/v0.13.6)（Windows PowerShell 弹窗修复）。

**反例**：v0.13.5 仅 "See the assets below" — 用户不知道这版改了什么，不要再这样写。

---

### Minor (vX.Y.0) — 新功能 / 多个 fix 合集

**判定**：包含至少一个新功能，或聚合了 ≥3 个有用户感知的 fix。

```markdown
## ✨ Features / 新功能

- **feat(模块)**: 中文一句话描述 — Why it matters
  - 子点：具体行为 / 用户场景
  - 子点：必要时给出关键数字

## 🐛 Fixes / 修复

- **fix(模块)**: 中文描述（带必要的根因或场景）
- **fix(模块)**: 中文描述

## 🪟 Platform-Specific (可选，仅当存在 Windows / macOS 专属变更时)

- **Windows**: ...
- **macOS**: ...

## English Summary

- 3-5 行英文，给海外用户和 AI crawler 看
- 重点功能 + 重点 fix，不需要逐条翻译
- 末尾可附 migration / breaking 提示

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/vX.Y-1.0...vX.Y.0
```

**参考范例**：[v0.13.9](https://github.com/PM-Shawn/Abu-Cowork/releases/tag/v0.13.9)（PPTX 预览 + 官网刷新）、[v0.13.12](https://github.com/PM-Shawn/Abu-Cowork/releases/tag/v0.13.12)（诊断面板 + confirm-dialog 修复）。

**English Summary 何时加**：会发到公众号 / 官网下载页 / 海外渠道时加；纯内部修复不加。

---

### Major (vX.0.0) — 架构变更 / 破坏性更新

**判定**：包含 breaking changes、数据迁移、依赖升级（用户需要主动操作）。

在 Minor 模板基础上加：

```markdown
## ⚠️ Breaking Changes / 破坏性变更

- [变更点]：[影响范围] → [用户需要做什么]

## 🔄 Migration Notes / 迁移说明

1. [步骤 1]
2. [步骤 2]
3. **回滚方案**：[万一升级出问题怎么退回去]

## 数据迁移 (如适用)

- 旧版本数据自动迁移：是 / 否
- 受影响的 store：abu-chat (vN→vN+1) 等
- 迁移失败时的兜底行为
```

---

## 写作规范

### 1. Title 格式

| 档位 | 格式 | 例 |
|---|---|---|
| Patch (单一主题) | `vX.Y.Z — 一句话主题` | `v0.13.6 — 修复 Windows PowerShell 弹窗` |
| Patch (杂项) | `vX.Y.Z` | `v0.13.10` |
| Minor | `vX.Y.0 — 主题` 或 `vX.Y.0` | `v0.13.9 — 预览体验优化 + 官网刷新` |
| Major | `vX.0.0 — 主题` | `v1.0.0 — 公开版本` |

副标题让 release 列表能扫读，**强烈推荐 patch 也带**（除非是纯 chore/CI 修复）。

### 2. 双语策略

- **中文为主**：用户群以中文为主，标题、bullet 主体都用中文。
- **英文点睛**：bullet 开头用 conventional commit prefix（`feat(xxx):` / `fix(xxx):`），末尾可缀英文短语强化（"— Why it matters"）。
- **不要每行翻译**：浪费字数，看着像机翻。
- **English Summary**：仅在 minor+ 且确认有海外受众时加，3-5 行总览，不逐条对应。

### 3. 写"为什么"，不只是"什么"

每个 bullet 至少有一项是真实价值，不要堆砌实现细节：

✅ `MCP 状态修复：MCP 服务报错 / 连接测试结束后状态不再残留` — 用户场景明确
❌ `重构 mcpStore` — 用户不关心
❌ `优化性能` — 没说优化了什么

### 4. 数字即证据

跟公众号 voice 一致，能给数字给数字：

✅ "TTL 从 5s 延长至 30s，减少 PowerShell 调用频率"
✅ "9 处子进程 spawn 统一加 `CREATE_NO_WINDOW`"
✅ "技能数量从 25+ 更新到 28 个"

❌ "大幅优化性能"
❌ "显著提升体验"

### 5. Emoji 使用

- **Patch 标题**：不加 emoji（看着像营销号）。
- **Minor+ 分区**：可以加 ✨ / 🐛 / 🪟 / 🍎 / ⚠️ / 🔄 等，让分区一眼可识别。
- **Bullet 内**：尽量不加。

### 6. 链接和 Changelog

- 末尾必加 `Full Changelog: ...compare/...` 链接（gh release 自动生成可保留）。
- 涉及具体 commit 可挂 commit 短 SHA，但不要堆 PR 编号清单。

---

## 常见反模式

1. **空 release**："See the assets below" / "Bug fixes and improvements" — 等于没写，用户没法判断要不要升。
2. **机翻全文**：每行中英对照，看着臃肿，且英文质量通常不如简洁的 English Summary。
3. **commit log 堆叠**：直接把 `git log --oneline` 贴上来 — 没有筛选和组织，用户看不懂。
4. **过度技术细节**：用户看不懂 "重构 chatStore.normalizer 为 nullable schema"，要写 "解决多模型切换时偶发的消息丢失"。
5. **隐藏破坏性变更**：major 不写 Migration Notes 等于埋雷。

---

## Checklist (创建 release 前过一遍)

- [ ] Title 是否带主题副标题？
- [ ] 是否每个 bullet 都说清了用户感知？
- [ ] 是否给了至少一个具体数字？
- [ ] Patch：是否在 200 字以内？Minor+：是否分了区？
- [ ] 是否有 Full Changelog 链接？
- [ ] Major：是否有 Breaking Changes 和 Migration Notes？
- [ ] 是否避免了"大幅优化 / 显著提升"等空话？

---

## gh CLI 速查

### 推荐流程（避免双 release）

⚠️ **本仓库 CI 在 tag push 后会自动建一个 release**（默认标题 `Abu vX.Y.Z`，body 是占位符 "See the assets below…"，正好是本文档的反例），并把构建产物作为 asset 上传。所以**不要用 `gh release create`**——会建出第二份，原有的自动 release 仍在，标题/body 没人改。

正确顺序：

```bash
# 1. 把 release notes 写到文件（避免 shell 转义）
vim /tmp/release-notes.md

# 2. push tag（触发 CI 自动建空 release + 跑构建）
git push origin main --tags

# 3. 等 CI 把 release 建出来（看到 release list 里有这一行即可，不必等 asset 跑完）
gh release list --limit 3

# 4. 覆盖自动 release 的标题和 body（按 tag 精准命中那一份）
gh release edit v0.23.1 --title "v0.23.1 — 主题" -F /tmp/release-notes.md

# 5. （可选）等 asset 上传完，对外宣传
```

### 其它常用

```bash
# 看上一版怎么写的（拷模板）
gh release view v0.23.0 --json body -q .body

# 列出 release 的所有 asset
gh release view v0.23.1 --json assets -q '.assets[].name'

# 真的需要从零创建（无 CI 自动建 release 的场景）才用 create
gh release create vX.Y.Z --title "..." -F /tmp/notes.md
```

### 已知坑

- `gh release create --draft` + `gh release edit --draft=false`：草稿是 untagged 状态，publish 时会**新建**一个 release 占用 tag，而 CI 那份还在。表现为同一 tag 出现两份 release。如要走 draft 流程，必须先用 API 删 CI 自动建的那份（`gh api -X DELETE /repos/PM-Shawn/Abu-Cowork/releases/<id>`），再 publish 你的草稿。一般情况下没必要走 draft——直接 edit 自动 release 更快。
