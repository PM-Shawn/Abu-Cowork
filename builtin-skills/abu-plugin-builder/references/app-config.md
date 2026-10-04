# The `app` field of `.abu-plugin/plugin.json`

A plugin whose manifest carries `app` is an app: after installation it appears in the app switcher, gets its own home page, and every conversation started inside it carries the app's prompt and hands the work to whoever the scene names. A manifest with `app` (or a `teams/` directory) must also declare `minAbuVersion` (semver, the lowest Abu version the package supports). `app` and `teams/` arrived in Abu 0.51.0, so the value is `0.51.0` or newer.

`app` and every object inside it accept only the fields listed here. Any other field fails validation, and the error names the field (for example `app.home.modes.items[0].scenes[0].templetes`). Ids of modes, scenes, templates and navigation items match `^[A-Za-z0-9_-]{1,64}$`.

## Top level

| Field | Required | Type | Meaning |
|---|---|---|---|
| `version` | yes | `1` | Format version of the app configuration |
| `home` | yes | object | The home page, see below |
| `defaultRun` | no | run reference | Who takes the conversation when the user sends without choosing a scene. Absent: Abu answers with the app prompt |
| `promptAppend` | no | string | App-level prompt, applied to every conversation in the app. At most 16000 characters |
| `nav` | no | object | Navigation, see below. Absent: Abu's default navigation |
| `allowedOrigins` | required when a `url:` navigation item exists | string[] | Origins the app's web pages may use, see below |
| `requiredConnectors` | no | string[] | Names from this package's `mcpServers`. While one is not connected, the home page shows a hint |
| `composer.placeholder` | no | LocalizedText | Placeholder of the composer |

## `home`

| Field | Required | Type | Meaning |
|---|---|---|---|
| `header.title` | no | LocalizedText | Home page title. Absent: `interface.displayName` |
| `header.slogan` | no | LocalizedText | One line under the title |
| `modes.defaultSelected` | no | string | Mode selected by default; must be one of the `modeId`s |
| `modes.items` | yes | mode[] | At least 1, ideally 2–4. With a single mode the mode bar is hidden |

Mode:

| Field | Required | Type | Meaning |
|---|---|---|---|
| `modeId` | yes | string | Unique within the app |
| `title` | yes | LocalizedText | Mode name |
| `icon` | no | string | Package-relative image path |
| `promptAppend` | no | string | Prompt appended for every conversation in this mode. At most 16000 characters |
| `scenes` | yes | scene[] | At least 1 |

Scene:

| Field | Required | Type | Meaning |
|---|---|---|---|
| `id` | yes | string | Unique within the mode |
| `title` | yes | LocalizedText | Scene name |
| `icon` | no | string | Package-relative image path |
| `run` | no | run reference | Who handles this scene. Absent: `defaultRun` |
| `promptAppend` | no | string | Prompt appended for this scene. At most 16000 characters |
| `placeholder` | no | LocalizedText | Composer placeholder while the scene is open |
| `templates` | yes | template[] | 3–6 entries |

Template:

| Field | Required | Type | Meaning |
|---|---|---|---|
| `id` | yes | string | Unique within the scene |
| `title` | yes | LocalizedText | Short card title |
| `prompt` | yes | LocalizedText | Text placed in the composer when clicked; the user can edit it before sending |

## Run references

| Form | Meaning |
|---|---|
| `{ "team": "<team id>" }` | A team from this package's `teams/` |
| `{ "team": "builtin-team:<id>" }` | One of Abu's built-in teams, ids in `builtin-catalog.md` |
| `{ "expert": "<expert name>" }` | An expert from this package's `agents/` |
| `{ "expert": "builtin:<expert name>" }` | One of Abu's built-in experts, names in `builtin-catalog.md` |
| `{ "skill": "<skill name>" }` | A skill from this package's `skills/` |

A reference to something that does not exist fails validation. A scene that names a team is led by that team's leader; one that names an expert is handled by that expert; one that names a skill is handled by Abu with the skill active from the first message.

## `nav`

| Field | Required | Type | Meaning |
|---|---|---|---|
| `items[].id` | yes | string | Unique within the navigation |
| `items[].title` | required for `url:` items | LocalizedText | Built-in entries fall back to Abu's own label |
| `items[].icon` | no | string | Package-relative image path |
| `items[].order` | no | number | Ascending |
| `items[].target` | yes | string | See below |

| `target` | Meaning |
|---|---|
| `builtin:chat` | New task. Must appear exactly once |
| `builtin:todos`, `builtin:inbox` | Todos, inbox |
| `builtin:team` | Experts |
| `builtin:extensions` | Extensions |
| `builtin:automation` | Automation |
| `url:<address>` | The app's own web page, shown in the main area. `https://` only, or `http://` for a local preview, and its origin must be listed in `allowedOrigins` |

Projects, the conversation list and the account menu are not navigation items and stay visible in every app.

## App web pages

| Rule | Detail |
|---|---|
| Origins | Each `allowedOrigins` entry is `https://host[:port]`; local previews may use `http://127.0.0.1[:port]` or `http://localhost[:port]`. No wildcards, paths, query strings or credentials |
| `url:` items | The address's origin must be listed in `allowedOrigins` |
| Navigation away | A page leaving `allowedOrigins` is stopped and the address opens in the system browser |
| New windows | Refused; links open in the system browser |
| Device permissions | Camera, microphone, location, notifications and similar requests are refused |
| Login state | Kept per app, cleared when the app is uninstalled |
| Contact with Abu | None. The page gets no user identity, conversation content or files; Abu reads nothing from the page |

## `LocalizedText`

A plain string, or `{ "zh-CN": "…", "en-US": "…" }` with at least one language. When the interface language has no text, `zh-CN` is used, then `en-US`.

## Example: an app on a built-in team

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

## Example: a package team, a skill scene, a connector and a web page

```json
{
  "name": "abu-example-shop-ops",
  "version": "1.0.0",
  "minAbuVersion": "0.51.0",
  "skills": ["./skills/product-listing"],
  "mcpServers": {
    "shop-api": { "url": "https://shop.example.com/mcp", "headers": { "Authorization": "Bearer ${config.SHOP_TOKEN}" } }
  },
  "interface": { "displayName": "店铺运营", "logo": "assets/logo.png", "logoDark": "assets/logo-dark.png" },
  "app": {
    "version": 1,
    "defaultRun": { "team": "store-ops" },
    "requiredConnectors": ["shop-api"],
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
                "run": { "skill": "product-listing" },
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
        { "id": "experts", "target": "builtin:team", "order": 2 },
        { "id": "portal", "title": { "zh-CN": "店铺后台", "en-US": "Shop portal" }, "target": "url:https://example.com/portal", "order": 3 }
      ]
    }
  }
}
```

`store-ops` is `teams/store-ops.json` in the same package (see `teams.md`).

## Images

| Use | Field | Format | Size |
|---|---|---|---|
| App logo | `interface.logo`, `interface.logoDark` | PNG or SVG | 256×256, transparent background, one light and one dark |
| Mode, scene and navigation icons | `icon` | PNG or SVG | 32×32, single-colour line art |
| Team avatar | `avatar` in `teams/*.json` | emoji or `icon:<icon>/<tint>` | — |

Every image lives inside the package and is referenced by a relative path. Do not generate image files unless the user provides them; an app without `interface.logo` shows its name instead.
