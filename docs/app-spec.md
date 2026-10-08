# Abu 应用 · 开发者规范

> 适用版本：Abu 0.51.0 起。
> 相关：[插件规范](plugin-spec.md)（技能、专家、专家团、连接器）；[使用指南](User-Guide.zh-CN.md) 的「应用」一节。

## 1. 名词

| 名词 | 含义 |
|---|---|
| 应用 | 为一类工作准备好的阿布：自己的首页、模式、场景、示例问题和导航。用户在应用切换器里切换 |
| 场景 | 首页上的一件事，例如「写一份 JD」。每个场景指定由谁负责，并带 3–6 条示例问题 |
| 负责人 | 场景交给的专家团、专家或技能 |
| 插件 | 技能、专家、专家团、连接器的安装包，规则见[插件规范](plugin-spec.md)。应用可以用到插件带来的东西，用户添加应用时，缺少的插件一起安装 |
| 市场 | 一个目录，里面有一份 `marketplace.json`，列出若干插件和应用 |

应用和插件分开：应用不装技能、专家、专家团和连接器，只引用它们；插件不带首页。

## 2. 应用的目录

| 路径 | 是否必须 | 说明 |
|---|---|---|
| `.abu-app/app.json` | 必须 | 应用文件，见第 3 节 |
| `assets/` | 可选 | logo 和图标，由应用文件里的字段指定路径 |

目录里的符号链接不会被复制。

## 3. 应用文件 `app.json`

应用文件和其中每个对象只接受下面各表列出的字段。多出来的字段会导致校验失败，错误指向那个字段，例如 `home.modes.items[0].scenes[0].templetes`。模式、场景、模板和导航项的 id 只允许字母、数字、`_` 和 `-`，长度不超过 64。

### 3.1 顶层字段

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `name` | 是 | string | 应用的名称：小写字母、数字和 `-`，以字母或数字开头，不超过 64 个字符。和市场条目的 `name` 相同 |
| `version` | 是 | string | 语义化版本号，例如 `1.2.0`。每次发布递增 |
| `minAbuVersion` | 是 | string | 这个应用要求的最低 Abu 版本，`0.51.0` 或更高 |
| `interface` | 是 | object | 展示信息，见 3.2 |
| `plugins` | 否 | string[] | 应用用到的插件名称。运行引用和 `requiredConnectors` 里出现的每个插件都要列在这里 |
| `home` | 是 | object | 首页，见 3.3 |
| `defaultRun` | 否 | 运行引用 | 用户不点任何场景、直接发送时由谁负责。不写时由阿布带着应用的提示词回答 |
| `promptAppend` | 否 | string | 应用级的提示词，对应用里的每个会话生效。上限 16000 个字符 |
| `nav` | 否 | object | 导航，见 3.5。不写时沿用 Abu 的默认导航 |
| `allowedOrigins` | 有 `url:` 导航项时必填 | string[] | 应用网页允许的来源，见 3.6 |
| `requiredConnectors` | 否 | string[] | `<插件名称>/<连接器名称>`，插件必须列在 `plugins` 里。连接器没有连上时，首页顶部提示用户去连接 |
| `composer.placeholder` | 否 | LocalizedText | 输入框的占位文字 |

### 3.2 展示信息 `interface`

| 字段 | 必填 | 类型 | 规则 |
|---|---|---|---|
| `displayName` | 是 | string | 切换器和应用市场里的名称，不超过 64 个字符 |
| `shortDescription` | 是 | string | 一句话介绍，不超过 200 个字符 |
| `longDescription` | 否 | string | 应用市场详情里的介绍，不超过 4000 个字符 |
| `developerName` | 否 | string | 开发者名称，不超过 100 个字符 |
| `category` | 否 | string | 分类，不超过 64 个字符 |
| `brandColor` | 否 | string | 必须是 `#RRGGBB` |
| `logo`、`logoDark` | 否 | string | 应用目录内图片的相对路径，浅色界面和深色界面各一张。在市场里列出的应用必须写 |

### 3.3 首页 `home`

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
| `icon` | 否 | string | 应用目录内图片的相对路径 |
| `promptAppend` | 否 | string | 这个模式下每个会话追加的提示词。上限 16000 个字符 |
| `scenes` | 是 | 场景[] | 至少 1 个 |

场景：

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | 是 | string | 在模式内唯一 |
| `title` | 是 | LocalizedText | 场景名称 |
| `icon` | 否 | string | 应用目录内图片的相对路径 |
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

### 3.4 运行引用

运行引用指定一位负责人，可以再带一个技能，让会话从第一条消息开始使用这个技能：`{ "team": … }`、`{ "expert": … }`、`{ "team": …, "skill": … }`、`{ "expert": …, "skill": … }`，或者只写 `{ "skill": … }`。

| 写法 | 含义 |
|---|---|
| `"team": "builtin-team:<id>"` | Abu 内置的专家团，id 见[插件规范附录 B](plugin-spec.md#附录-b--内置专家团的-id) |
| `"expert": "builtin:<专家名称>"` | Abu 内置的专家，名称见[插件规范附录 A](plugin-spec.md#附录-a--内置专家的名称) |
| `"team": "plugin:<插件名称>/<专家团 id>"` | 插件带来的专家团 |
| `"expert": "plugin:<插件名称>/<专家名称>"` | 插件带来的专家 |
| `"skill": "plugin:<插件名称>/<技能名称>"` | 插件带来的技能 |

内置专家团或内置专家不存在、`plugin:` 的插件没有列在 `plugins` 里时，校验失败。插件带来的东西在用户添加应用时检查：插件没有安装时一起安装；已经安装的版本没有带来引用的东西时一起更新。

场景指向专家团时，会话由专家团的队长负责；指向专家时，会话由这位专家负责；只指向技能时，会话由阿布负责，并且从第一条消息开始使用这个技能。

### 3.5 导航 `nav`

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `items[].id` | 是 | string | 在导航内唯一 |
| `items[].title` | `url:` 导航项必填 | LocalizedText | 内置入口不写时用 Abu 自己的名称 |
| `items[].icon` | 否 | string | 应用目录内图片的相对路径 |
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

### 3.6 应用网页

| 规则 | 说明 |
|---|---|
| 来源 | `allowedOrigins` 的每一项是 `https://主机名[:端口]`；本机预览可以写 `http://127.0.0.1[:端口]` 或 `http://localhost[:端口]`。不接受通配符、路径、查询参数和账号密码 |
| `url:` 导航项 | 网址的来源必须出现在 `allowedOrigins` 里 |
| 登录跳转 | 网页打开时会跳转到别的网址（例如公司的登录页）的，把那个网址的来源也写进 `allowedOrigins` |
| 跳转 | 网页跳转到 `allowedOrigins` 以外的地址时，Abu 阻止跳转并用系统浏览器打开 |
| 新窗口 | 不允许。链接用系统浏览器打开 |
| 设备权限 | 摄像头、麦克风、定位、通知等请求一律拒绝 |
| 登录状态 | 每个应用单独保存，移除应用时清除 |
| 和 Abu 的联系 | 没有。网页拿不到用户的身份、会话内容和文件；Abu 也不读取网页的内容 |

添加带网页入口的应用前，用户会看到「这个应用会在阿布里打开这些网站」和网站列表。应用要在对话里显示自己的界面、并且让界面和对话互相传递数据时，用连接器自带的界面（MCP Apps）。

### 3.7 多语言文字 `LocalizedText`

可以写一个字符串，也可以写 `{ "zh-CN": "…", "en-US": "…" }`。写对象时至少有一种语言；当前界面语言没有对应文字时，先取 `zh-CN`，再取 `en-US`。

### 3.8 示例

用到插件「店铺助手」的「店铺运营」应用（节选；完整的市场在仓库的 `examples/plugin-market/`）：

```json
{
  "name": "shop-ops",
  "version": "1.0.0",
  "minAbuVersion": "0.51.0",
  "interface": {
    "displayName": "店铺运营",
    "shortDescription": "选品、详情页、评价回复，一个首页全做完",
    "logo": "assets/logo.png",
    "logoDark": "assets/logo-dark.png"
  },
  "plugins": ["shop-assistant"],
  "defaultRun": { "team": "plugin:shop-assistant/store-ops" },
  "requiredConnectors": ["shop-assistant/shop-api"],
  "allowedOrigins": ["https://example.com"],
  "home": {
    "modes": {
      "items": [
        {
          "modeId": "listing",
          "title": { "zh-CN": "详情页", "en-US": "Listings" },
          "scenes": [
            {
              "id": "write-listing",
              "title": { "zh-CN": "写详情页", "en-US": "Write a listing" },
              "run": { "skill": "plugin:shop-assistant/product-listing" },
              "templates": [
                { "id": "full", "title": "从参数写整页", "prompt": "根据这些商品参数写一整页详情页文案" },
                { "id": "rewrite", "title": "改写标题", "prompt": "把这个商品标题改成三个更吸引点击的版本" },
                { "id": "faq", "title": "补一组 FAQ", "prompt": "给这个商品补一组买家最常问的问题和回答" }
              ]
            }
          ]
        }
      ]
    }
  },
  "nav": {
    "items": [
      { "id": "chat", "target": "builtin:chat", "order": 1 },
      { "id": "portal", "title": { "zh-CN": "店铺后台", "en-US": "Shop portal" }, "target": "url:https://example.com/portal", "order": 2 }
    ]
  }
}
```

只用内置专家团的应用见官方市场的 `builtin-plugin-market/apps/recruiting/`。

## 4. 图片

| 用途 | 字段 | 格式 | 建议尺寸 |
|---|---|---|---|
| 应用的 logo | `interface.logo`、`interface.logoDark` | PNG 或 SVG | 256×256，透明背景，浅色和深色各一张 |
| 模式、场景、导航项的图标 | `icon` | PNG 或 SVG | 32×32，单色线条 |

所有图片必须位于应用目录内，用相对路径引用。没有 logo 的应用显示名称的第一个字。

## 5. 市场里的应用

### 5.1 `marketplace.json` 的 `apps`

应用和插件列在同一份 `marketplace.json` 里：插件在 `plugins`，应用在 `apps`。文件位置和其他顶层字段见[插件规范第 12 节](plugin-spec.md#12-市场-marketplacejson)。

| 条目字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 与应用文件的 `name` 相同 |
| `source` | 是 | 应用从哪里取，写法与插件条目相同：市场目录内的相对路径、`url`、`git-subdir` |
| `version` | 远程来源必填 | 与应用文件的 `version` 相同 |
| `description` | 远程来源必填 | 应用市场卡片上的一句话介绍 |
| `minAbuVersion` | 远程来源必填 | 与应用文件的 `minAbuVersion` 相同 |

相对路径的应用，应用市场直接读应用文件里的名称、介绍、logo 和负责人；远程来源的应用，应用市场显示条目里写的内容，用户点「使用」时再取回整个应用。

```json
{
  "name": "acme-apps",
  "owner": { "name": "Acme" },
  "plugins": [
    { "name": "shop-assistant", "version": "1.0.0", "minAbuVersion": "0.51.0", "source": "./plugins/shop-assistant" }
  ],
  "apps": [
    { "name": "shop-ops", "source": "./apps/shop-ops" }
  ]
}
```

### 5.2 应用用到的插件从哪里装

用户添加应用时，`plugins` 里没有安装的插件按下面的顺序查找，找到第一个就用它：

1. 应用所在的市场；
2. Abu 官方市场；
3. 用户添加过的其他市场。

所以应用用到的插件，最好和应用放在同一个市场里。

### 5.3 市场地址

用户在应用市场或插件市场点「添加市场」，可以填一个地址，也可以选一个文件夹。地址必须以 `https://` 开头：

| 地址 | Abu 怎样取回 |
|---|---|
| `https://github.com/<所有者>/<仓库>` | 下载仓库默认分支的压缩包 |
| 以 `.zip` 结尾的网址 | 下载压缩包。压缩包里所有内容放在同一个顶层文件夹里 |
| 其他网址 | 当作 git 仓库克隆 |

取回的市场根目录要有 `marketplace.json`。Abu 在用户打开应用市场时检查取回时间，超过一小时就重新取回；取回失败时继续使用上一次的内容。添加失败时用户看到的原因：

| 原因 | 用户看到 |
|---|---|
| 地址需要登录才能访问 | 这个地址需要登录才能访问 |
| 地址里没有 `marketplace.json`，或者内容不合规 | 这个地址里没有市场 |
| 用户已经有一个同名的市场 | 已经有一个同名的市场，请联系提供地址的人 |

市场的 `name` 带上开发者自己的名称（例如 `acme-apps`），避免客户同时添加两个开发者的市场时重名。

### 5.4 更新

用户已经添加的应用，市场里这个应用的 `version` 和已添加的不同时，应用市场里显示「更新」。更新前同样检查用到的插件，缺少的一起安装，版本不够的一起更新。已有的会话继续按创建时的配置运行，新会话使用新配置。

`minAbuVersion` 高于用户的 Abu 时，应用市场里显示「需要先升级阿布」，不能使用。

## 6. 从文件夹添加

在应用市场点「从文件夹添加」，选择一个应用目录（里面有 `.abu-app/app.json`）。Abu 复制这个目录，校验以后显示和市场里相同的确认页。从文件夹添加的应用没有自己所在的市场，用到的插件从 5.2 的第 2、3 步查找。再次从文件夹添加同一个 `name` 的应用，会替换原来的那一个。开发时用它预览自己的应用。

## 7. 在对话里创建应用

用户点切换器的「创建应用」，在对话里说明要做哪类工作，由阿布写出应用。这样做出来的应用只存在于这位用户的电脑上，运行引用还可以写：

| 写法 | 含义 |
|---|---|
| `"team": "mine:<专家团 id>"` | 用户自己创建的专家团 |
| `"expert": "mine:<专家名称>"` | 用户自己创建的专家 |

需要新专家、新专家团时，阿布把它们写在草稿里，用户确认预览以后作为用户自己的专家、专家团创建。`mine:` 只能出现在这种应用里；放进市场的应用不能使用。

## 8. 本地预览与校验

1. 在应用目录写好 `.abu-app/app.json`。
2. 在 Abu 的应用市场点「从文件夹添加」，选择应用目录。确认页里能看到首页、每个场景的负责人、需要一起安装的插件和网页来源。
3. 添加以后应用出现在切换器里，进入就能看到首页、导航和网页。
4. 修改以后提高 `version`，再从文件夹添加一次。

校验失败时，错误信息给出不合格字段的完整路径。常见原因：

| 错误指向 | 常见原因 |
|---|---|
| `name` | 用了大写字母、空格或中文 |
| `minAbuVersion` | 没有写；写的不是语义化版本号；低于 `0.51.0` |
| `…run.team`、`…run.expert`、`…run.skill` | 写法不在 3.4 的表里；内置专家团或内置专家不存在；`plugin:` 的插件没有列在 `plugins` 里 |
| `…templates` | 少于 3 条或者多于 6 条 |
| `allowedOrigins` | 来源写了路径、通配符或者不是 HTTPS |
| `nav.items[n].target` | `url:` 写的不是 `https://` 或本机预览的 `http://`；来源不在 `allowedOrigins` 里；没有写 `title` |
| `requiredConnectors[n]` | 不是 `<插件名称>/<连接器名称>`；插件没有列在 `plugins` 里 |
| 任意路径 | 写了表里没有的字段（多数是拼写错误） |

在 Abu 的仓库里可以校验整个市场，规则和官方市场收录时相同：

```bash
npm run market:check -- --dir <市场目录>
```

它还会核对：条目的 `name`、`version`、`minAbuVersion` 与应用文件一致；应用写了 `logo` 和 `logoDark`；引用的图片都在应用目录里；`plugin:` 引用的专家团、专家、技能和 `requiredConnectors` 的连接器确实由那个插件带来。应用用到的插件先在被校验的市场里找，再到官方市场找。

## 9. 交付给客户

1. 把市场目录放进一个 git 仓库，或者打成一个 zip 放在可下载的地址上。
2. 交付前，在一个干净的阿布里用「添加市场」填这个地址，按客户的步骤点一次「使用」：确认页的内容和预期一致；需要一起安装的插件装上了；每个场景都能开始。
3. 把地址交给客户。客户在应用市场点「添加市场」，填入地址，找到应用点「使用」。
4. 发布新版本时提高应用和插件的 `version`，更新仓库或压缩包。客户打开应用市场时，距离上一次取回超过一小时就会重新取回，应用上显示「更新」。

需要登录才能访问的地址，客户的阿布无法取回。

## 10. 提交到官方应用市场

向 Abu 仓库的 `builtin-plugin-market/` 提交应用条目：来源写成 `git-subdir` 或 `url`，并固定 `sha`；写全 `version`、`description`、`minAbuVersion`。应用用到的插件要在官方市场里。Abu 官方按第 3.6 节的网页规则、插件规范第 10 节的安全规则和本规范第 11 节的检查清单人工审核，`npm run market:check` 通过以后随下一个 Abu 版本进入官方市场。更新时提交新的 `sha`，再次审核。

## 11. 提交前检查

- [ ] 应用文件有 `name`、`version`、`minAbuVersion`、`interface.displayName`、`interface.shortDescription`、`interface.logo`、`interface.logoDark`。
- [ ] 每个场景有 3–6 条模板，模板的 `prompt` 用户点了就能直接发送。
- [ ] 每个 `run` 指向的负责人存在；用到的插件都列在 `plugins` 里，并且在同一个市场或官方市场里。
- [ ] 有 `url:` 导航项时 `allowedOrigins` 已经列全，包括网页打开时会跳转到的登录页。
- [ ] 图片都在应用目录内，logo 有浅色和深色两张。
- [ ] `npm run market:check -- --dir <市场目录>` 通过。
- [ ] 在干净的阿布里按第 9 节第 2 步走过一次。
