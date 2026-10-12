# Abu 插件 · 开发者规范

> 适用版本：Abu 0.51.0 起。标为「0.50.0」的内容在 0.50.0 就已支持；标为「0.51.0」的内容从 0.51.0 开始支持。
> 相关：[应用规范](app-spec.md)；[使用指南](User-Guide.zh-CN.md)。

## 1. 名词

| 名词 | 含义 |
|---|---|
| 插件 | 一个目录，里面有一份清单，以及技能、专家、专家团、连接器中的一种或几种。用户一次安装，全部生效 |
| 技能 | 一份写给模型的做法说明（`SKILL.md`），可以附带参考资料和脚本 |
| 专家 | 一个有自己提示词和工具范围的角色（`AGENT.md`） |
| 专家团 | 一位队长加几位专家。用户只和队长对话，队长分工、复核、汇报 |
| 连接器 | 一个 MCP server 的声明，让 Abu 能调用外部服务 |
| 市场 | 一个目录，里面有一份 `marketplace.json`，列出若干插件、应用和它们的来源 |
| 应用 | 为一类工作准备好的阿布，有自己的首页和场景，规则见[应用规范](app-spec.md)。应用可以用到插件带来的技能、专家、专家团和连接器 |

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
| `minAbuVersion` | 使用 `teams/` 时必填 | string | 这个包要求的最低 Abu 版本。低于这个版本的 Abu 不展示这个包；已经安装的显示为不可用并提示升级 | 0.51.0 |

Abu 不认识的顶层字段会原样保留，不会导致清单被拒绝。

### 3.2 展示信息 `interface`

| 字段 | 类型 | 规则 |
|---|---|---|
| `displayName` | string | 展示名称 |
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

`LocalizedText` 可以写一个字符串，也可以写 `{ "zh-CN": "…", "en-US": "…" }`。写对象时至少有一种语言；当前界面语言没有对应文字时，先取 `zh-CN`，再取 `en-US`。

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

## 8. 应用怎样用到插件

应用的格式、市场里的应用条目、交付和发布见[应用规范](app-spec.md)。应用用下面的写法引用插件带来的东西，插件要列在应用文件的 `plugins` 里：

| 写法 | 含义 |
|---|---|
| `"team": "plugin:<插件名称>/<专家团 id>"` | 插件 `teams/` 里的专家团 |
| `"expert": "plugin:<插件名称>/<专家名称>"` | 插件的专家 |
| `"skill": "plugin:<插件名称>/<技能名称>"` | 插件的技能 |
| `requiredConnectors` 里的 `<插件名称>/<连接器名称>` | 插件声明的连接器 |

用户添加应用时，没有安装的插件一起安装；已经安装的版本没有带来引用的东西时一起更新。所以插件发布新版本时，已经被应用引用的专家、专家团、技能和连接器不要改名或删除。

带专家团、专家、技能和连接器的插件，以及用到它们的应用，完整示例在仓库的 `examples/plugin-market/`。

## 9. 图片

| 用途 | 字段 | 格式 | 建议尺寸 |
|---|---|---|---|
| 插件的 logo | `interface.logo`、`interface.logoDark` | PNG 或 SVG | 256×256，透明背景，浅色和深色各一张 |
| 输入框里的小图标 | `interface.composerIcon` | PNG 或 SVG | 32×32 |
| 截图 | `interface.screenshots` | 只接受 PNG | 1280×800，最多 3 张 |
| 专家团头像 | `teams/*.json` 的 `avatar` | emoji 或图标预设 | — |

所有图片必须位于包内，用相对路径引用。

## 10. 安全规则

- 包里不能写真实的凭据。需要用户提供的值用 `${config.字段名}` 声明（第 7.3 节）。
- 专家能用哪些工具，由 Abu 的运行时默认范围和专家自己的 `tools`、`disallowed-tools` 共同决定；包不能给专家增加 Abu 没有的工具。
- 专家的 `memory` 和 `source` 由 Abu 决定（第 5.3 节）。
- 包不能覆盖用户已有的专家和内置专家。
- `commands/`、`hooks/` 目录和符号链接不会被使用。
- 用户安装前看到的确认框会完整列出：来源与版本、技能、连接器及启动命令、需要填写的配置、专家、专家团、`interface.capabilities` 的说明。确认框显示的内容和实际安装的内容来自同一份不可变的快照。

## 11. 版本与兼容

- `version` 用语义化版本号，每次发布递增。
- Abu 怎样判断「有更新」，取决于市场条目的来源写法：相对路径的来源，比较市场条目的 `version` 和用户已安装的版本，两者不同就提示更新；`url` 和 `git-subdir` 的来源，比较条目里固定的 `sha` 和安装时记下的 `sha`。条目没有写 `version`（相对路径）或 `sha`（远程来源）时，Abu 不提示更新。
- 用到 `teams/` 的包必须写 `minAbuVersion`，最低是 `0.51.0`（`teams/` 从这个版本开始支持）。写得比 `0.51.0` 低会被拒绝，错误指向 `minAbuVersion`——更低的 Abu 读不到 `teams/`，包会装成一个没有专家团的插件。
- 字段与版本的对照：

| 字段或能力 | 最低 Abu 版本 |
|---|---|
| 第 3–5、7 节标为 0.50.0 的全部内容 | 0.50.0 |
| `minAbuVersion` | 0.51.0 |
| `teams/` | 0.51.0 |
| 市场条目的 `displayName`、`minAbuVersion` | 0.51.0 |
| 市场的 `apps`（见[应用规范](app-spec.md)） | 0.51.0 |

## 12. 市场 `marketplace.json`

文件位置：市场目录下的 `.abu-plugin/marketplace.json`；也能读 `.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json`。

| 顶层字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 市场名称 |
| `owner` | 否 | `{ name?, email? }` |
| `description` | 否 | 市场介绍 |
| `renames` | 否 | 旧插件名称到新名称的映射。用旧名称安装的插件，会按这张表对应到改名以后的条目 |
| `plugins` | 是 | 插件条目的数组 |
| `apps` | 否 | 应用条目的数组，见[应用规范第 5 节](app-spec.md#5-市场里的应用) |

| 条目字段 | 必填 | 说明 | 最低 Abu 版本 |
|---|---|---|---|
| `name` | 是 | 插件名称，与清单的 `name` 相同 | 0.50.0 |
| `displayName` | 否 | 市场卡片上显示的名称，与清单的 `interface.displayName` 相同。不写时卡片显示 `name` | 0.51.0 |
| `description`、`version`、`author`、`category`、`homepage`、`keywords`、`tags` | 否 | 市场列表里显示的信息 | 0.50.0 |
| `source` | 是 | 插件从哪里取，见下表 | 0.50.0 |
| `minAbuVersion` | 否 | 与清单里的 `minAbuVersion` 相同。Abu 用它在市场列表里隐藏自己用不了的包；官方市场收录时核对它和清单一致 | 0.51.0 |

| `source` 的写法 | 含义 |
|---|---|
| `"./plugins/my-plugin"` | 市场目录内的相对路径 |
| `{ "source": "local", "path": "…" }` | 同上 |
| `{ "source": "url", "url": "…", "sha": "…" }` | 一个下载地址，`sha` 可选 |
| `{ "source": "git-subdir", "url": "…", "path": "…", "ref": "…", "sha": "…" }` | 一个 git 仓库里的子目录，`ref`、`sha` 可选 |

## 13. 本地预览与校验

1. 把插件目录放进一个市场目录，写好 `marketplace.json`。
2. 在 Abu 里打开「扩展 → 插件 → 市场」，点「添加市场」，选择这个市场目录。
3. 在市场里找到自己的插件，点「安装」。确认框里能看到 Abu 从包里读到的全部内容。
4. 修改包以后，同时提高清单和市场条目里的 `version`。Abu 发现市场条目的 `version` 和已安装的版本不同，就会在这个插件上显示「更新」；更新前同样出现确认框。

也可以在 Abu 里点「扩展 → 插件 → 添加 → 创建插件」，在对话里描述要解决的工作，由阿布按本规范写出包；阿布写完会自己调用校验工具，按报错的字段修正到通过。草稿出现在「扩展 → 插件 → 我的」，点「校验并预览」检查以后再安装。阿布写包时读取的写法说明（内置技能 `abu-plugin-builder` 的 `references/`）和本规范第 6 节、附录 A、附录 B 的内容一致。

校验失败时，错误信息会给出不合格字段的完整路径，例如 `interface.brandColor`、`mcpServers.acme-crm.transport`、`teams.store-ops.leader`。常见原因：

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
| `skills/<目录>` | `SKILL.md` 的 `name` 缺失，或者不能作为一个目录名（含有 `/`、`\`、控制字符，或者首尾有空白） |
| `mcpServers` | 写成了数组；同一个名称在清单和 `.mcp.json` 里各出现一次 |
| `teams.<id>.members[n]`、`teams.<id>.leader` | 引用的专家不存在；队长不在成员里；成员少于 2 位 |
| `minAbuVersion` | 用了 `teams/` 却没有写；写的不是语义化版本号；当前 Abu 低于要求 |

官方市场收录时（`npm run market:check`）还会核对：条目的 `name`、`version`、`minAbuVersion` 与清单一致；清单里引用的图片文件都在包里。

## 14. 提交前检查

- [ ] 清单有 `name`、`version`、`interface.displayName`、`interface.shortDescription`、`interface.logo`。
- [ ] 用到 `teams/` 的包写了 `minAbuVersion`。
- [ ] 每个技能的 `description` 写清了用途和使用时机。
- [ ] 每位专家的正文不为空，名称没有和内置专家重名。
- [ ] 连接器没有写任何真实的凭据；需要用户填写的值全部用 `${config.字段名}` 声明。
- [ ] `interface.capabilities` 用用户看得懂的话写清了插件会做什么、会读取什么。
- [ ] 被应用引用的专家、专家团、技能和连接器在新版本里没有改名或删除。
- [ ] 图片都在包内，logo 有浅色和深色两张。
- [ ] 在干净的 Abu 里从市场完整安装过一次，确认框里的内容和预期一致；卸载以后没有残留。
- [ ] 包里没有符号链接。

## 15. 发布

两条渠道：

| 渠道 | 做法 |
|---|---|
| 自己的市场 | 把市场目录放在一个 git 仓库或者一个可下载的地址上，用户通过「添加市场」接入，地址的写法见[应用规范 5.3](app-spec.md#53-市场地址) |
| Abu 官方市场 | 向官方市场的仓库提交一条市场条目：来源写成 `git-subdir` 或 `url`，并固定 `sha`。Abu 官方按第 10 节的安全规则和第 14 节的检查清单人工审核，通过以后随下一个 Abu 版本进入官方市场。更新时提交新的 `sha`，再次审核 |

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
