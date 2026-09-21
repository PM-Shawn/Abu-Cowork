# Abu 插件与应用 · 开发者规范

> 适用版本：Abu 0.51.0 起。标为「0.50.0」的内容在 0.50.0 就已支持；标为「0.51.0」的内容随应用功能一起提供。
> 相关：[使用指南](User-Guide.zh-CN.md) 的「应用」一节。

## 1. 名词

| 名词 | 含义 |
|---|---|
| 插件 | 一个目录，里面有一份清单，以及技能、专家、专家团、连接器中的一种或几种。用户一次安装，全部生效 |
| 应用 | 清单里带 `app` 字段的插件。安装以后出现在应用切换器里，有自己的首页和导航 |
| 技能 | 一份写给模型的做法说明（`SKILL.md`），可以附带参考资料和脚本 |
| 专家 | 一个有自己提示词和工具范围的角色（`AGENT.md`） |
| 专家团 | 一位队长加几位专家。用户只和队长对话，队长分工、复核、汇报 |
| 连接器 | 一个 MCP server 的声明，让 Abu 能调用外部服务 |
| 市场 | 一个目录，里面有一份 `marketplace.json`，列出若干插件和它们的来源 |

## 2. 包的目录

| 路径 | 是否必须 | 说明 | 最低 Abu 版本 |
|---|---|---|---|
| `.abu-plugin/plugin.json` | 必须 | 清单。找不到时依次尝试 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` | 0.50.0 |
| `skills/<技能目录>/SKILL.md` | 可选 | 技能。文件名也可以是 `skill.md` | 0.50.0 |
| `agents/<专家目录>/AGENT.md` | 可选 | 专家，Abu 自己的形状 | 0.50.0 |
| `agents/<名称>.md` | 可选 | 专家，单文件形状。`agents/` 下其他类型的文件不当作专家 | 0.50.0 |
| `teams/<专家团 id>.json` | 可选 | 专家团 | 0.51.0 |
| `.mcp.json` | 可选 | 连接器声明，自动读取 | 0.50.0 |
| 清单 `mcpServers` 指向的 JSON 文件 | 可选 | 连接器声明 | 0.50.0 |
| `assets/` | 可选 | logo、图标、截图 | 0.50.0（路径由清单字段指定） |
| `commands/`、`hooks/` | — | Abu 不使用。安装确认框会把它们列为「阿布暂不使用」 | 0.50.0 |

包里的符号链接不会被复制，安装确认框会列出被跳过的符号链接。包的根目录本身是符号链接时，安装被拒绝。

## 3. 清单 `plugin.json`

### 3.1 顶层字段

| 字段 | 必填 | 类型 | 说明 | 最低 Abu 版本 |
|---|---|---|---|---|
| `name` | 是 | string | 插件的唯一名称，非空 | 0.50.0 |
| `version` | 否 | string | 语义化版本号，例如 `1.2.0`。每次发布递增，并且和市场条目里的 `version` 保持相同 | 0.50.0 |
| `description` | 否 | string | 一句话说明 | 0.50.0 |
| `author` | 否 | string 或 `{ name, email? }` | 作者 | 0.50.0 |
| `license` | 否 | string | 许可证 | 0.50.0 |
| `keywords` | 否 | string[] | 搜索用的关键词 | 0.50.0 |
| `skills` | 否 | string 或 string[] | 技能目录的相对路径，必须位于包内 | 0.50.0 |
| `mcpServers` | 否 | string 或 object | 字符串：包内一个 JSON 文件的相对路径；对象：直接内联声明。规则见第 7 节 | 0.50.0 |
| `interface` | 否 | object | 展示信息，见 3.2 | 0.50.0 |
| `minAbuVersion` | 使用 `app` 或 `teams/` 时必填 | string | 这个包要求的最低 Abu 版本。低于这个版本的 Abu 不展示这个包；已经安装的显示为不可用并提示升级 | 0.51.0 |
| `app` | 否 | object | 应用配置，见第 8 节 | 0.51.0 |

Abu 不认识的顶层字段会原样保留，不会导致清单被拒绝。

### 3.2 展示信息 `interface`

| 字段 | 类型 | 规则 |
|---|---|---|
| `displayName` | string | 展示名称。应用用它作为切换器里的名称 |
| `shortDescription` | string | 一句话介绍 |
| `longDescription` | string | 详情页的长介绍 |
| `developerName` | string | 开发者名称 |
| `category` | string | 分类 |
| `capabilities` | string[] | 用自然语言写「这个插件会做什么、会读取什么」，显示在安装确认框里 |
| `brandColor` | string | 必须是 `#RRGGBB`，不接受 `#RGB` 简写 |
| `logo`、`logoDark` | string | 包内图片的相对路径，浅色界面和深色界面各一张 |
| `composerIcon` | string | 输入框里的小图标，包内相对路径 |
| `screenshots` | string[] | 每一项必须是 `.png` 文件的路径 |
| `defaultPrompt` | string[] | 最多 3 条，每条不超过 128 个字符 |
| `websiteURL`、`privacyPolicyURL`、`termsOfServiceURL` | string | 官网、隐私政策、使用条款 |

### 3.3 示例

官方市场里的 `abu-prd-doctor`（一个清单加一个技能）：

```json
{
  "name": "abu-prd-doctor",
  "version": "1.0.0",
  "description": "给 PRD 做一次结构化体检",
  "author": { "name": "Abu", "email": "hello@abu.example" },
  "license": "MIT",
  "keywords": ["prd", "review", "product"],
  "skills": ["./skills/prd-doctor"],
  "interface": {
    "displayName": "PRD 体检",
    "shortDescription": "三条线快速审 PRD：流程 / 异常 / 文案",
    "developerName": "Abu",
    "category": "productivity",
    "capabilities": ["读取你贴入的 PRD 文本", "产出结构化审查清单"],
    "brandColor": "#C4633A"
  }
}
```

## 4. 技能 `SKILL.md`

文件由 YAML frontmatter 和 Markdown 正文组成。正文是写给模型的做法说明。

| frontmatter 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `name` | 是 | string | 技能名称，同时是它的目录名。必须是一个单独的路径片段：不能含 `/`、`\`、控制字符，不能只由 `.` 组成 |
| `description` | 否 | string | 写清楚用途。模型根据它判断什么时候使用这个技能 |
| `trigger` | 否 | string | 什么情况下应该使用 |
| `do-not-trigger` | 否 | string | 什么情况下不应该使用 |
| `argument-hint` | 否 | string | 用户用 `/技能名` 调用时的参数提示 |
| `user-invocable` | 否 | boolean | 默认 `true`。设为 `false` 时用户不能用 `/` 直接调用 |
| `disable-auto-invoke` | 否 | boolean | 默认 `false`。设为 `true` 时模型不会自己使用它，只能由用户调用 |
| `allowed-tools`、`blocked-tools`、`required-tools` | 否 | string[] 或用空格分隔的字符串 | 这个技能运行期间允许、禁止、必须具备的工具 |
| `model` | 否 | string | 指定模型 |
| `max-turns` | 否 | number | 最大轮数 |
| `context` | 否 | `inline` 或 `fork` | 默认 `inline`：在当前对话里执行。`fork`：在独立的上下文里执行 |
| `agent` | 否 | string | `fork` 时由哪位专家执行 |
| `skills` | 否 | string[] | 预先加载的其他技能 |
| `tags`、`chain` | 否 | string[] | 标签；后续串接的技能 |
| `license`、`compatibility`、`metadata` | 否 | — | Agent Skills 规范的兼容字段 |

正文里可以使用的变量：

| 变量 | 含义 |
|---|---|
| `$ARGUMENTS` | 用户调用时给出的全部参数 |
| `$ARGUMENTS[N]` | 第 N 个参数，从 0 开始 |
| `${ABU_SKILL_DIR}` | 技能目录的绝对路径 |
| `${ABU_SESSION_ID}` | 当前会话的 id |
| `${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}` | 与上面两个等价，兼容 Claude Code 的写法 |

正文没有写 `$ARGUMENTS` 而用户给了参数时，参数会追加在正文末尾。技能目录里的其他文件（参考资料、脚本、模板）不会自动进入提示词，模型在需要时用 `read_skill_file` 读取；`scripts/` 下的文件会连同绝对路径一起列给模型。

## 5. 专家

### 5.1 两种形状

| 形状 | 路径 | 说明 |
|---|---|---|
| 目录 | `agents/<目录>/AGENT.md` | frontmatter 加正文，正文是专家的系统提示词 |
| 单文件 | `agents/<名称>.md` | 同上。没有 frontmatter 时整个文件就是提示词，名称取文件名 |

两种形状在安装时经过同一个转换，结果相同。

### 5.2 frontmatter 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 专家名称。规则与技能名称相同：一个单独的路径片段 |
| `description` | string | 一句话说明这位专家做什么。阿布根据它决定要不要把活派给这位专家 |
| `avatar` | string | 头像 |
| `model` | string | 指定模型 |
| `max-turns` | number | 最大轮数 |
| `tools` | string[] | 允许使用的工具。不写表示沿用运行时默认的工具范围 |
| `disallowed-tools` | string[] | 禁止使用的工具 |
| `skills` | string[] | 预先加载的技能名称 |
| `background` | boolean | 是否在后台运行 |
| `intro` | string | 开场白，用户第一次和这位专家对话时显示 |
| `expertise` | string[] | 擅长领域，用于展示 |
| `sample-prompts` | string[] | 示例提问。点击以后文字填进输入框，不直接发送 |
| `category`、`tags` | string、string[] | 分类与标签 |

`tools`、`disallowed-tools`、`skills`、`tags` 可以写成数组，也可以写成用逗号分隔的字符串。

### 5.3 安装时 Abu 的处理

| 情况 | 处理 |
|---|---|
| frontmatter 里写了 `memory` | 丢弃。包不能替自己的专家申请读取用户的记忆 |
| frontmatter 里写了 `source` | 丢弃。专家的来源由 Abu 按实际安装的插件写入，包不能自己声明来源 |
| 名称和内置专家或者用户已有的专家相同 | 这位专家不安装，安装确认框标注「已存在」。已有的专家不会被覆盖 |
| 名称不是一个安全的路径片段 | 这位专家不安装，标注「名称不安全」 |
| 正文为空 | 这位专家不安装，标注「缺少提示词」 |

内置专家的名称见附录 A。

## 6. 专家团

文件：`teams/<专家团 id>.json`。`id` 只允许小写字母、数字和 `-`。用到 `teams/` 的包必须写 `minAbuVersion`。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `name` | 是 | LocalizedText | 专家团名称 |
| `leader` | 是 | 专家引用 | 队长 |
| `members` | 是 | 专家引用[] | 全部成员，包含队长，至少 2 位 |
| `leaderNote` | 否 | string | 给队长的交代，接到任务时进入队长的提示词。上限 4000 个字符 |
| `requirePlanApproval` | 否 | boolean | 默认 `false`。设为 `true` 时队长分好工以后等用户同意再开工 |
| `avatar` | 否 | string | 一个 emoji，或者 Abu 自带的图标预设 `icon:<图标>/<配色>`（例如 `icon:chart-bar/teal`），与用户自己创建的专家团相同；不超过 32 个字符 |
| `description` | 是 | LocalizedText | 卡片上的一句话介绍 |
| `intro` | 否 | LocalizedText | 开场白 |
| `expertise` | 否 | LocalizedText[] | 擅长领域，最多 5 条 |
| `samplePrompts` | 否 | LocalizedText[] | 示例提问，最多 4 条 |

专家引用的写法：

| 写法 | 含义 |
|---|---|
| `"专家名称"` | 本包 `agents/` 里的专家 |
| `"builtin:专家名称"` | Abu 内置的专家，名称见附录 A |

引用的专家不存在时，清单校验失败。包里的专家团安装以后出现在「专家 → 专家团 → 我的」，卡片标注来源插件；用户不能编辑或删除，卸载插件时一并移除。包里的技能和专家安装以后同样出现在各自页面的「我的」里。

## 7. 连接器

### 7.1 声明位置

三处声明会合并；同一个名称出现两次时校验失败。

| 位置 | 写法 |
|---|---|
| 清单的 `mcpServers` 对象 | 直接内联 |
| 清单的 `mcpServers` 字符串 | 指向包内一个 JSON 文件 |
| 包根目录的 `.mcp.json` | 自动读取 |

JSON 文件的内容可以直接是 server 的映射，也可以包在 `{ "mcpServers": { … } }` 或 `{ "mcp_servers": { … } }` 里。

### 7.2 每个 server 的字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `command` | string | 本地进程的启动命令 |
| `args` | string[] | 启动参数 |
| `env` | object，值为 string | 环境变量 |
| `url` | string | 远程服务地址 |
| `headers` | object，值为 string | 请求头 |
| `transport` | `stdio` 或 `http` | 不写时由 `command` 或 `url` 推断 |

规则：

- server 的名称只允许字母、数字、`_`、`-`，长度 1–128。
- `command` 和 `url` 必须写其中一个，不能两个都写。
- 写了 `url` 就不能写 `args`、`env`；写了 `command` 就不能写 `headers`。
- `name`、`enabled`、`pluginConfiguration` 三个键由 Abu 分配，包里不能写。
- 安装确认框会把每个本地 server 的完整启动命令显示给用户。

### 7.3 需要用户填写的配置

在 `env` 或 `headers` 的值里写 `${config.字段名}`。安装时 Abu 让用户填写这些字段，值保存在系统的密钥存储里，连接时再填入。

```json
{
  "mcpServers": {
    "acme-crm": {
      "url": "https://mcp.acme.example/mcp",
      "headers": { "Authorization": "Bearer ${config.ACME_TOKEN}" }
    }
  }
}
```

| 规则 | 数值 |
|---|---|
| 字段名 | 以字母开头，只含字母、数字、`_`，最长 64 个字符 |
| 出现的位置 | 只能出现在 `env`、`headers` 的值里；出现在 `command`、`url`、`args` 里时校验失败 |
| 字段数量 | 一个插件最多 32 个 |
| 单个值 | 不超过 16KB |
| 全部值合计 | 不超过 64KB |

包里不能写任何真实的 token、密钥或密码。

## 8. 应用配置 `app`

### 8.1 结构

`app` 及其内部对象只接受下面各表列出的字段，多出来的字段会导致校验失败（错误指向那个字段，例如 `app.home.modes.items[0].scenes[0].templetes`）。模式、场景、模板和导航项的 id 只允许字母、数字、`_` 和 `-`，长度不超过 64。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `version` | 是 | `1` | 应用配置的格式版本 |
| `home` | 是 | object | 应用首页，见 8.2 |
| `defaultRun` | 否 | 运行引用 | 用户不点任何场景、直接发送时由谁接活。不写时由阿布带着应用的提示词回答 |
| `promptAppend` | 否 | string | 应用级的提示词，对应用里的每个会话生效。上限 16000 个字符 |
| `nav` | 否 | object | 导航，见 8.4。不写时沿用 Abu 的默认导航 |
| `allowedOrigins` | 有 `url:` 导航项时必填 | string[] | 应用网页允许的来源，见 8.5 |
| `requiredConnectors` | 否 | string[] | 本包 `mcpServers` 里的名称。没有连接时应用首页顶部提示用户去连接 |
| `composer.placeholder` | 否 | LocalizedText | 输入框的占位文字 |

### 8.2 首页 `home`

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `header.title` | 否 | LocalizedText | 首页标题。不写时用 `interface.displayName` |
| `header.slogan` | 否 | LocalizedText | 标题下面的一句标语 |
| `modes.defaultSelected` | 否 | string | 默认选中的模式，必须是某个 `modeId` |
| `modes.items` | 是 | 模式[] | 至少 1 个，建议 2–4 个。只有 1 个时首页不显示模式选择 |

模式：

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `modeId` | 是 | string | 在应用内唯一 |
| `title` | 是 | LocalizedText | 模式名称 |
| `icon` | 否 | string | 包内图片的相对路径 |
| `promptAppend` | 否 | string | 这个模式下每个会话追加的提示词。上限 16000 个字符 |
| `scenes` | 是 | 场景[] | 至少 1 个 |

场景：

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | 是 | string | 在模式内唯一 |
| `title` | 是 | LocalizedText | 场景名称 |
| `icon` | 否 | string | 包内图片的相对路径 |
| `run` | 否 | 运行引用 | 这个场景由谁负责。不写时用 `defaultRun` |
| `promptAppend` | 否 | string | 这个场景追加的提示词。上限 16000 个字符 |
| `placeholder` | 否 | LocalizedText | 选中场景以后输入框的占位文字 |
| `templates` | 是 | 模板[] | 3–6 条 |

模板：

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | 是 | string | 在场景内唯一 |
| `title` | 是 | LocalizedText | 卡片上显示的短标题 |
| `prompt` | 是 | LocalizedText | 点击以后填进输入框的文字。用户可以修改以后再发送 |

### 8.3 运行引用

| 写法 | 含义 |
|---|---|
| `{ "team": "<专家团 id>" }` | 本包 `teams/` 里的专家团 |
| `{ "team": "builtin-team:<id>" }` | Abu 内置的专家团，id 见附录 B |
| `{ "expert": "<专家名称>" }` | 本包的专家 |
| `{ "expert": "builtin:<专家名称>" }` | Abu 内置的专家 |
| `{ "skill": "<技能名称>" }` | 本包的技能 |

引用的对象不存在时校验失败。引用了本包的一位专家、而这位专家因为名称已被占用不会被安装时（第 5.3 节），安装同样被拒绝，错误指向这个引用并说明原因。场景指向专家团时，会话由专家团的队长负责；指向专家时，会话由这位专家负责；指向技能时，会话由阿布负责，并且从第一条消息开始使用这个技能。

### 8.4 导航 `nav`

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `items[].id` | 是 | string | 在导航内唯一 |
| `items[].title` | `url:` 导航项必填 | LocalizedText | 内置入口不写时用 Abu 自己的名称 |
| `items[].icon` | 否 | string | 包内图片的相对路径 |
| `items[].order` | 否 | number | 从小到大排列 |
| `items[].target` | 是 | string | 见下表 |

| `target` | 含义 |
|---|---|
| `builtin:chat` | 新任务。必须出现一次 |
| `builtin:todos`、`builtin:inbox` | 待办、收件箱 |
| `builtin:team` | 专家 |
| `builtin:extensions` | 扩展 |
| `builtin:automation` | 自动化 |
| `url:<网址>` | 应用自己的网页，显示在主区域。只接受 `https://` 和本机预览的 `http://`，来源必须在 `allowedOrigins` 里 |

「项目」、会话列表和账户菜单不属于导航项，在所有应用里保持显示。

### 8.5 应用网页

| 规则 | 说明 |
|---|---|
| 来源 | `allowedOrigins` 的每一项是 `https://主机名[:端口]`；本机预览可以写 `http://127.0.0.1[:端口]` 或 `http://localhost[:端口]`。不接受通配符、路径、查询参数和账号密码 |
| `url:` 导航项 | 网址的来源必须出现在 `allowedOrigins` 里 |
| 跳转 | 网页跳转到 `allowedOrigins` 以外的地址时，Abu 阻止跳转并用系统浏览器打开 |
| 新窗口 | 不允许。链接用系统浏览器打开 |
| 设备权限 | 摄像头、麦克风、定位、通知等请求一律拒绝 |
| 登录状态 | 每个应用单独保存，卸载应用时清除 |
| 和 Abu 的联系 | 没有。网页拿不到用户的身份、会话内容和文件；Abu 也不读取网页的内容 |

应用要在对话里显示自己的界面、并且让界面和对话互相传递数据时，用连接器自带的界面（MCP Apps）。

### 8.6 多语言文字 `LocalizedText`

可以写一个字符串，也可以写 `{ "zh-CN": "…", "en-US": "…" }`。写对象时至少有一种语言；当前界面语言没有对应文字时，先取 `zh-CN`，再取 `en-US`。

### 8.7 示例

引用内置专家团的「招聘」应用（节选；完整的包在官方市场 `builtin-plugin-market/plugins/abu-app-recruiting/`）：

```json
{
  "name": "abu-app-recruiting",
  "version": "1.0.0",
  "minAbuVersion": "0.51.0",
  "interface": {
    "displayName": "招聘",
    "shortDescription": "从岗位到 offer",
    "logo": "assets/logo.png",
    "logoDark": "assets/logo-dark.png",
    "category": "hr"
  },
  "app": {
    "version": 1,
    "defaultRun": { "team": "builtin-team:recruiting" },
    "home": {
      "header": { "title": "招聘，从岗位到 offer", "slogan": "告诉我要招什么人，或者从下面选一件事开始" },
      "modes": {
        "defaultSelected": "prepare",
        "items": [
          {
            "modeId": "prepare",
            "title": "岗位准备",
            "scenes": [
              {
                "id": "write-jd",
                "title": "写一份 JD",
                "run": { "team": "builtin-team:recruiting" },
                "templates": [
                  { "id": "t1", "title": "高级前端 JD", "prompt": "帮我写一份高级前端工程师的 JD，并定好面试题" },
                  { "id": "t2", "title": "改写 JD", "prompt": "把这份 JD 改得更吸引人，保留必须项" },
                  { "id": "t3", "title": "必须项和加分项", "prompt": "按这个岗位列出必须项和加分项" }
                ]
              }
            ]
          }
        ]
      }
    }
  }
}
```

带包内专家团、技能场景、连接器和网页入口的完整示例在仓库的 `examples/plugin-market/plugins/abu-example-shop-ops/`。

## 9. 图片

| 用途 | 字段 | 格式 | 建议尺寸 |
|---|---|---|---|
| 插件和应用的 logo | `interface.logo`、`interface.logoDark` | PNG 或 SVG | 256×256，透明背景，浅色和深色各一张 |
| 输入框里的小图标 | `interface.composerIcon` | PNG 或 SVG | 32×32 |
| 截图 | `interface.screenshots` | 只接受 PNG | 1280×800，最多 3 张 |
| 模式、场景、导航项的图标 | `icon` | PNG 或 SVG | 32×32，单色线条 |
| 专家团头像 | `teams/*.json` 的 `avatar` | emoji 或图标预设 | — |

所有图片必须位于包内，用相对路径引用。

## 10. 安全规则

- 包里不能写真实的凭据。需要用户提供的值用 `${config.字段名}` 声明（第 7.3 节）。
- 专家能用哪些工具，由 Abu 的运行时默认范围和专家自己的 `tools`、`disallowed-tools` 共同决定；包不能给专家增加 Abu 没有的工具。
- 专家的 `memory` 和 `source` 由 Abu 决定（第 5.3 节）。
- 包不能覆盖用户已有的专家和内置专家。
- `commands/`、`hooks/` 目录和符号链接不会被使用。
- 应用网页的限制见第 8.5 节。
- 用户安装前看到的确认框会完整列出：来源与版本、技能、连接器及启动命令、需要填写的配置、专家、专家团、应用的导航入口和网页来源、`interface.capabilities` 的说明。确认框显示的内容和实际安装的内容来自同一份不可变的快照。

## 11. 版本与兼容

- `version` 用语义化版本号，每次发布递增。
- Abu 怎样判断「有更新」，取决于市场条目的来源写法：相对路径的来源，比较市场条目的 `version` 和用户已安装的版本，两者不同就提示更新；`url` 和 `git-subdir` 的来源，比较条目里固定的 `sha` 和安装时记下的 `sha`。条目没有写 `version`（相对路径）或 `sha`（远程来源）时，Abu 不提示更新。
- 用到 `app` 或 `teams/` 的包必须写 `minAbuVersion`，取所用字段里要求最高的那个版本，最低是 `0.51.0`（`app` 和 `teams/` 从这个版本开始支持）。写得比 `0.51.0` 低会被拒绝，错误指向 `minAbuVersion`——更低的 Abu 读不到这两处，包会装成一个没有应用也没有专家团的普通插件。
- `app.version` 是应用配置的格式版本，目前只有 `1`。以后格式有不兼容的变化时才会增加。
- 会话创建时会记下应用当时的配置。应用更新以后，已有的会话继续按创建时的配置运行，新会话使用新配置。
- 字段与版本的对照：

| 字段或能力 | 最低 Abu 版本 |
|---|---|
| 第 3–5、7 节标为 0.50.0 的全部内容 | 0.50.0 |
| `minAbuVersion` | 0.51.0 |
| `teams/` | 0.51.0 |
| `app` | 0.51.0 |
| 市场条目的 `providesApp`、`displayName` | 0.51.0 |

## 12. 市场 `marketplace.json`

文件位置：市场目录下的 `.abu-plugin/marketplace.json`；也能读 `.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json`。

| 顶层字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 市场名称 |
| `owner` | 否 | `{ name?, email? }` |
| `description` | 否 | 市场介绍 |
| `renames` | 否 | 旧插件名称到新名称的映射。用旧名称安装的插件，会按这张表对应到改名以后的条目 |
| `plugins` | 是 | 插件条目的数组 |

| 条目字段 | 必填 | 说明 | 最低 Abu 版本 |
|---|---|---|---|
| `name` | 是 | 插件名称，与清单的 `name` 相同 | 0.50.0 |
| `displayName` | 应用条目必填 | 市场卡片上显示的名称，与清单的 `interface.displayName` 相同。不写时卡片显示 `name` | 0.51.0 |
| `description`、`version`、`author`、`category`、`homepage`、`keywords`、`tags` | 否 | 市场列表里显示的信息 | 0.50.0 |
| `source` | 是 | 插件从哪里取，见下表 | 0.50.0 |
| `providesApp` | 否 | 这个插件是不是应用。设为 `true` 时出现在「发现应用」里；清单里没有 `app` 字段时安装失败 | 0.51.0 |
| `minAbuVersion` | 应用条目必填 | 与清单里的 `minAbuVersion` 相同。Abu 用它在市场列表里隐藏自己用不了的包；官方市场收录时核对它和清单一致 | 0.51.0 |

| `source` 的写法 | 含义 |
|---|---|
| `"./plugins/my-plugin"` | 市场目录内的相对路径 |
| `{ "source": "local", "path": "…" }` | 同上 |
| `{ "source": "url", "url": "…", "sha": "…" }` | 一个下载地址，`sha` 可选 |
| `{ "source": "git-subdir", "url": "…", "path": "…", "ref": "…", "sha": "…" }` | 一个 git 仓库里的子目录，`ref`、`sha` 可选 |

## 13. 本地预览与校验

1. 把插件目录放进一个市场目录，写好 `marketplace.json`。
2. 在 Abu 里打开「扩展 → 插件 → 市场」，点「添加插件市场」，选择这个市场目录。
3. 在市场里找到自己的插件，点「使用」或「安装」。确认框里能看到 Abu 从包里读到的全部内容。
4. 应用安装以后出现在切换器里，进入就能看到首页、导航和网页。
5. 修改包以后，同时提高清单和市场条目里的 `version`。Abu 发现市场条目的 `version` 和已安装的版本不同，就会在这个插件上显示「更新」；更新前同样出现确认框。

也可以在 Abu 里点切换器的「创建应用」，或者「扩展 → 插件 → 添加 → 创建插件」，在对话里描述要解决的工作，由阿布按本规范写出包；阿布写完会自己调用校验工具，按报错的字段修正到通过。草稿出现在「扩展 → 插件 → 我的」，点「校验并预览」检查以后再安装；带应用配置的草稿安装以后直接进入应用。阿布写包时读取的写法说明（内置技能 `abu-plugin-builder` 的 `references/`）和本规范第 6 节、第 8 节、附录 A、附录 B 的内容一致。

校验失败时，错误信息会给出不合格字段的完整路径，例如 `interface.brandColor`、`mcpServers.acme-crm.transport`、`app.home.modes.items[1].scenes[0].run`。常见原因：

| 错误指向 | 常见原因 |
|---|---|
| `name` | 清单缺少 `name` |
| `interface.screenshots` | 截图不是 `.png` |
| `interface.defaultPrompt` | 超过 3 条，或者单条超过 128 个字符 |
| `mcpServers.<名称>.transport` | `command` 和 `url` 都写了，或者都没写 |
| `mcpServers.<名称>.transportFields` | `url` 和 `args` / `env` 同时出现，或者 `command` 和 `headers` 同时出现 |
| `mcpServers.<名称>.configurationLocation` | `${config.…}` 写在了 `command`、`url` 或 `args` 里 |
| `mcpServers.configuration` | 配置字段超过 32 个 |
| `skills`、`mcpServers`（路径） | 路径指向包外，或者文件不存在 |
| `app.…run` | 引用的专家团、专家或技能不存在 |
| `app.allowedOrigins` | 来源写了路径、通配符或者不是 HTTPS |
| `app.nav.items[n].target` | `url:` 写的不是 `https://` 或本机预览的 `http://`；来源不在 `allowedOrigins` 里；没有写 `title` |
| `skills/<目录>` | `SKILL.md` 的 `name` 缺失，或者不能作为一个目录名（含有 `/`、`\`、控制字符，或者首尾有空白） |
| `mcpServers` | 写成了数组；同一个名称在清单和 `.mcp.json` 里各出现一次 |
| `app.…` 任意路径 | 写了表里没有的字段（多数是拼写错误） |
| `teams.<id>.members[n]`、`teams.<id>.leader` | 引用的专家不存在；队长不在成员里；成员少于 2 位 |
| `minAbuVersion` | 用了 `app` 或 `teams/` 却没有写；写的不是语义化版本号；当前 Abu 低于要求 |

官方市场收录时（`npm run market:check`）还会核对：条目的 `name`、`version`、`minAbuVersion` 与清单一致；`providesApp` 与清单里有没有 `app` 一致；应用写了 `interface.displayName`、`shortDescription`、`logo`、`logoDark`，并且条目的 `displayName` 与 `interface.displayName` 一字不差（市场卡片读条目，应用内部读清单）；清单和应用配置里引用的图片文件都在包里。

## 14. 提交前检查

- [ ] 清单有 `name`、`version`、`interface.displayName`、`interface.shortDescription`、`interface.logo`。
- [ ] 用到 `app` 或 `teams/` 的包写了 `minAbuVersion`。
- [ ] 每个技能的 `description` 写清了用途和使用时机。
- [ ] 每位专家的正文不为空，名称没有和内置专家重名。
- [ ] 连接器没有写任何真实的凭据；需要用户填写的值全部用 `${config.字段名}` 声明。
- [ ] `interface.capabilities` 用用户看得懂的话写清了插件会做什么、会读取什么。
- [ ] 应用：每个场景有 3–6 条模板；每个 `run` 指向的对象存在；有 `url:` 导航项时 `allowedOrigins` 已经列全。
- [ ] 图片都在包内，logo 有浅色和深色两张。
- [ ] 在干净的 Abu 里从市场完整安装过一次，确认框里的内容和预期一致；卸载以后没有残留。
- [ ] 包里没有符号链接。

## 15. 发布

两条渠道：

| 渠道 | 做法 |
|---|---|
| 自己的市场 | 把市场目录放在一个 git 仓库或者一个可下载的地址上，用户通过「添加插件市场」接入 |
| Abu 官方市场 | 向官方市场的仓库提交一条市场条目：来源写成 `git-subdir` 或 `url`，并固定 `sha`；应用条目加 `providesApp: true`。Abu 官方按第 10 节的安全规则和第 14 节的检查清单人工审核，通过以后随下一个 Abu 版本进入官方市场。更新时提交新的 `sha`，再次审核 |

官方市场收录时运行的校验，和 Abu 安装时、「校验并预览」时运行的是同一套。

## 附录 A · 内置专家的名称

`高级开发工程师`、`产品经理`、`数据分析师`、`公众号编辑`、`HR 招聘官`、`办公文档专家`、`行业调研专家`、`网页设计师`、`测试工程师`、`行政助理`、`财务助理`、`合同审阅专家`。

这些名称发布以后不会改变。引用时写 `builtin:<名称>`。

## 附录 B · 内置专家团的 id

| id | 名称 | 队长 | 成员 |
|---|---|---|---|
| `builtin-team:software-rd` | 软件研发专家团 | 产品经理 | 高级开发工程师、网页设计师、测试工程师 |
| `builtin-team:data-analysis` | 数据分析专家团 | 数据分析师 | 行业调研专家、办公文档专家 |
| `builtin-team:content-creation` | 内容创作专家团 | 公众号编辑 | 行业调研专家、网页设计师 |
| `builtin-team:reporting` | 汇报材料专家团 | 办公文档专家 | 数据分析师、行业调研专家 |
| `builtin-team:finance-reconciliation` | 财务对账专家团 | 财务助理 | 数据分析师、办公文档专家 |
| `builtin-team:recruiting` | 招聘专家团 | HR 招聘官 | 行业调研专家、办公文档专家 |

这些 id 发布以后不会改变。
