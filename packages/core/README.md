# @abu/core

> 状态：**脚手架期**（Week 0） · 当前仅接口声明，无运行实现

Abu 共享 Agent 引擎，供 Abu Desktop 和 Prism Web 共用。

## 目录

```
packages/core/src/
  ports/
    adapters/   8 个平台能力接口（Storage/Path/Fetch/Process/Event/Logger/Clock/IPC）
    repos/      6 个业务域仓储接口
    agent.ts    IAgent + SendMessageInput
    stream.ts   StreamEvent 联合类型
    index.ts    聚合导出
```

## 当前状态

- ✅ 接口声明到位（本 PR）
- ⏳ Repo 接口暂时引用 Abu 根仓的 `src/types/*`（相对路径 `../../../../src/types`），**过渡期允许**。后续 Phase 0.2 会把 types 平移到 `packages/core/src/domain/`。
- ⏳ 无实现代码；Abu 现有 `src/core/` 代码不动，不引用本包。
- ⏳ 不纳入根 tsconfig build，避免影响 Abu Desktop 构建。

## 下一步

1. Review 本 PR 的接口定义
2. 挑 `src/core/context/` 做首个依赖注入 POC（独立 PR）
3. 写 In-Memory Mock Adapters 跑 core 单测
