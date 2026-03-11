---
name: init
description: 初始化工作区规则文件 (.abu/ABU.md)，分析项目结构生成项目规则模板
user-invocable: true
context: inline
allowed-tools:
  - read_file
  - write_file
  - list_directory
  - run_command
  - find_files
tags:
  - init
  - 初始化
  - rules
  - 规则
---

你现在帮用户初始化项目规则文件（`.abu/ABU.md`）。

## 前置检查

1. **检查工作区**：确认当前已设置工作区路径。如果没有，提示用户先设置工作区。
2. **检查已有规则**：检查 `.abu/ABU.md` 是否已存在。
   - 如果已存在，读取内容并建议改进，而不是覆盖。
   - 如果不存在，继续下面的初始化流程。

## 初始化流程

### 第一步：分析项目结构

扫描以下关键文件（按存在情况读取）：
- `package.json` — Node.js 项目配置
- `README.md` — 项目说明
- `tsconfig.json` — TypeScript 配置
- `pyproject.toml` / `setup.py` / `requirements.txt` — Python 项目
- `Cargo.toml` — Rust 项目
- `go.mod` — Go 项目
- `pom.xml` / `build.gradle` — Java 项目
- `.eslintrc*` / `.prettierrc*` — 代码风格配置
- `Makefile` / `Dockerfile` / `docker-compose.yml` — 构建部署
- `.gitignore` — 版本控制配置

同时用 `list_directory` 查看项目顶层目录结构。

### 第二步：生成 ABU.md

根据分析结果，生成 `.abu/ABU.md` 文件，内容包括：

```markdown
# 项目规则

## 项目概述
<!-- 基于 README 和 package.json 等提取 -->

## 技术栈
<!-- 基于配置文件分析 -->

## 编码规范
<!-- 基于 eslint/prettier 等配置提取，或给出合理默认值 -->

## 构建与运行
<!-- 基于 package.json scripts 或 Makefile 等提取 -->

## 项目结构
<!-- 基于目录结构概述 -->

## 其他约定
<!-- 根据项目特点补充 -->
```

### 第三步：创建 rules 目录

创建 `.abu/rules/` 目录（如果不存在）。

### 第四步：提示用户

完成后告知用户：
1. 已创建 `.abu/ABU.md`，可以手动编辑补充
2. 可在 `.abu/rules/` 下创建模块化规则文件（如 `coding-style.md`、`api-conventions.md`）
3. 建议将 `.abu/ABU.md` 和 `.abu/rules/` 提交到 git
4. 建议将 `.abu/MEMORY.md` 加入 `.gitignore`（AI 记忆不应入库）
5. Abu 会在每次对话中自动加载这些规则

## 注意事项
- 生成的内容应基于实际项目分析，不要臆造不存在的信息
- 规则要简洁实用，避免空洞的模板内容
- 如果项目有特殊约定（如 monorepo、特殊部署流程），应体现在规则中
