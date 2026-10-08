# The app file: `.abu-app/app.json`

An app gives the user a home page for one line of work: modes, scenes in each mode, and example prompts in each scene. Every conversation started inside the app carries the app's prompt and hands the work to whoever the scene names.

The file and every object inside it accept only the fields listed here. Any other field fails validation, and the error names the field (for example `home.modes.items[0].scenes[0].templetes`). Ids of modes, scenes, templates and navigation items match `^[A-Za-z0-9_-]{1,64}$`.

## Top level

| Field | Required | Type | Meaning |
|---|---|---|---|
| `name` | yes | string | Lowercase letters, digits and dashes, starting with a letter or digit, at most 64 characters. Unique among the user's apps |
| `version` | yes | string | Semantic version, for example `1.0.0` |
| `minAbuVersion` | yes | string | `0.51.0` or newer |
| `interface` | yes | object | How the app is shown, see below |
| `plugins` | no | string[] | Names of installed plugins whose experts, teams, skills or connectors the app uses |
| `home` | yes | object | The home page, see below |
| `defaultRun` | no | run reference | Who takes the conversation when the user sends without choosing a scene. Absent: Abu answers with the app prompt |
| `promptAppend` | no | string | App-level prompt, applied to every conversation in the app. At most 16000 characters |
| `nav` | no | object | Navigation, see below. Absent: Abu's default navigation |
| `allowedOrigins` | required when a `url:` navigation item exists | string[] | Origins the app's web pages may use, see below |
| `requiredConnectors` | no | string[] | `<plugin>/<connector>` of a plugin listed in `plugins`. While one is not connected, the home page shows a hint |
| `composer.placeholder` | no | LocalizedText | Placeholder of the composer |

## `interface`

| Field | Required | Type | Meaning |
|---|---|---|---|
| `displayName` | yes | string | App name in the switcher, at most 64 characters |
| `shortDescription` | yes | string | One line under the name, at most 200 characters |
| `longDescription` | no | string | At most 4000 characters |
| `developerName` | no | string | At most 100 characters |
| `category` | no | string | At most 64 characters |
| `brandColor` | no | string | `#RRGGBB` |
| `logo`, `logoDark` | no | string | Image path inside the draft folder, see Images |

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
| `icon` | no | string | Image path inside the draft folder |
| `promptAppend` | no | string | Prompt appended for every conversation in this mode. At most 16000 characters |
| `scenes` | yes | scene[] | At least 1 |

Scene:

| Field | Required | Type | Meaning |
|---|---|---|---|
| `id` | yes | string | Unique within the mode |
| `title` | yes | LocalizedText | Scene name |
| `icon` | no | string | Image path inside the draft folder |
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

A run names a team or an expert, optionally with a skill the conversation starts with, or only a skill: `{ "team": … }`, `{ "expert": … }`, `{ "team": …, "skill": … }`, `{ "expert": …, "skill": … }`, `{ "skill": … }`.

| Form | Meaning |
|---|---|
| `"team": "mine:<team id>"` | A team the user already has (`yours.teams` from `app_prepare`), or a new team `teams/<id>.json` in the draft |
| `"expert": "mine:<expert name>"` | An expert the user already has (`yours.experts`), or a new expert `agents/<name>.md` in the draft |
| `"team": "builtin-team:<id>"` | One of Abu's built-in teams, ids in `builtin-catalog.md` |
| `"expert": "builtin:<expert name>"` | One of Abu's built-in experts, names in `builtin-catalog.md` |
| `"team"`, `"expert"` or `"skill": "plugin:<plugin>/<id>"` | A team, expert or skill of an installed plugin listed in `plugins` |

A reference to something that does not exist on this computer fails validation. A scene that names a team is led by that team's leader; one that names an expert is handled by that expert; one that names only a skill is handled by Abu with the skill active from the first message.

## `nav`

| Field | Required | Type | Meaning |
|---|---|---|---|
| `items[].id` | yes | string | Unique within the navigation |
| `items[].title` | required for `url:` items | LocalizedText | Built-in entries fall back to Abu's own label |
| `items[].icon` | no | string | Image path inside the draft folder |
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
| Login state | Kept per app, cleared when the app is removed |
| Contact with Abu | None. The page gets no user identity, conversation content or files; Abu reads nothing from the page |

## `LocalizedText`

A plain string, or `{ "zh-CN": "…", "en-US": "…" }` with at least one language. When the interface language has no text, `zh-CN` is used, then `en-US`.

## Example

A weekly report app: one scene on the user's own team, one on a new expert, one on a built-in expert.

```json
{
  "name": "weekly-report",
  "version": "1.0.0",
  "minAbuVersion": "0.51.0",
  "interface": { "displayName": "周报", "shortDescription": "每周五把一周的工作整理成周报" },
  "defaultRun": { "expert": "mine:周报整理员" },
  "promptAppend": "用户在写周报。先问清这一周的时间范围，再动手。",
  "home": {
    "header": { "title": "这周做了什么？", "slogan": "贴上记录或者说几句，我来整理" },
    "modes": {
      "items": [
        {
          "modeId": "write",
          "title": "写周报",
          "scenes": [
            {
              "id": "draft",
              "title": "整理成周报",
              "run": { "expert": "mine:周报整理员" },
              "templates": [
                { "id": "from-notes", "title": "从记录整理", "prompt": "把下面这些记录整理成本周周报：" },
                { "id": "from-todos", "title": "从待办整理", "prompt": "根据我这周完成的待办写一份周报" },
                { "id": "shorter", "title": "压缩成三句话", "prompt": "把这份周报压缩成三句话，给老板看" }
              ]
            },
            {
              "id": "data",
              "title": "补上数据",
              "run": { "expert": "builtin:数据分析师" },
              "templates": [
                { "id": "chart", "title": "做一张趋势图", "prompt": "用这份表格做一张本周数据的趋势图" },
                { "id": "compare", "title": "和上周对比", "prompt": "把本周和上周的数据对比，列出变化最大的三项" },
                { "id": "explain", "title": "解释波动", "prompt": "解释一下这组数据这周为什么波动" }
              ]
            }
          ]
        },
        {
          "modeId": "review",
          "title": "复盘",
          "scenes": [
            {
              "id": "retro",
              "title": "项目复盘",
              "run": { "team": "mine:1f3a9c" },
              "templates": [
                { "id": "what-went-well", "title": "做得好的", "prompt": "帮我复盘这周项目里做得好的地方" },
                { "id": "risks", "title": "风险", "prompt": "列出下周项目的主要风险和应对" },
                { "id": "next", "title": "下周计划", "prompt": "根据这周的进展排一份下周计划" }
              ]
            }
          ]
        }
      ]
    }
  }
}
```

`周报整理员` is `agents/周报整理员.md` in the draft; `1f3a9c` is a team id from `yours.teams`.

## Images

| Use | Field | Format | Size |
|---|---|---|---|
| App logo | `interface.logo`, `interface.logoDark` | PNG or SVG | 256×256, transparent background, one light and one dark |
| Mode, scene and navigation icons | `icon` | PNG or SVG | 32×32, single-colour line art |

Every image lives inside the draft folder and is referenced by a relative path. Do not generate image files unless the user provides them; an app without `interface.logo` shows its name instead.
