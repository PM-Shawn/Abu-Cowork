# Teams shipped by a package: `teams/<id>.json`

A package can ship expert teams the same way it ships experts and skills. One JSON file per team under `teams/`; the file name without `.json` is the team id and matches `^[a-z0-9-]+$`. A package with a `teams/` directory must declare `minAbuVersion` in its manifest, `0.51.0` or newer — the version `teams/` arrived in.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `name` | yes | LocalizedText | Team name |
| `leader` | yes | expert reference | The leader |
| `members` | yes | expert reference[] | Every member including the leader, at least 2 |
| `leaderNote` | no | string | Standing instructions for the leader, placed in the leader's prompt when a task arrives. At most 4000 characters |
| `requirePlanApproval` | no | boolean | Default `false`. `true` makes the leader wait for the user's approval after splitting the work |
| `avatar` | no | string | One emoji, or one of Abu's icon presets `icon:<icon>/<tint>` (for example `icon:chart-bar/teal`), at most 32 characters |
| `description` | yes | LocalizedText | One line shown on the card |
| `intro` | no | LocalizedText | Opening line |
| `expertise` | no | LocalizedText[] | Areas of expertise, at most 5 |
| `samplePrompts` | no | LocalizedText[] | Sample prompts, at most 4 |

Expert references:

| Form | Meaning |
|---|---|
| `"<expert name>"` | An expert from this package's `agents/` |
| `"builtin:<expert name>"` | One of Abu's built-in experts, names in `builtin-catalog.md` |

A reference to an expert that does not exist fails validation. A package expert whose name is already taken by an existing expert is skipped at installation, and a team that references it is refused with an error naming the reference.

Installed package teams appear under Experts → Teams → Mine with the plugin named on the card. The user cannot edit or delete them; uninstalling the plugin removes them.

Icon presets: icons `chart-bar`, `code`, `flask`, `pen`, `shield`, `users`, `search`, `database`, `palette`, `compass`, `wrench`, `book`, `megaphone`, `scale`, `sparkles`, `cpu`, `globe`, `camera`, `calculator`, `bot`; tints `blue`, `purple`, `teal`, `coral`, `amber`, `pink`.

## Example

`teams/store-ops.json`, using one package expert and two built-in experts:

```json
{
  "name": { "zh-CN": "店铺运营小组", "en-US": "Store operations team" },
  "avatar": "icon:compass/coral",
  "leader": "店铺运营顾问",
  "members": ["店铺运营顾问", "builtin:数据分析师", "builtin:办公文档专家"],
  "leaderNote": "先确认店铺类目和目标，再分工；数据结论交给数据分析师核对。",
  "requirePlanApproval": false,
  "description": { "zh-CN": "选品、详情页和评价回复一起做", "en-US": "Sourcing, listings and review replies together" },
  "intro": { "zh-CN": "说说你的店铺和想做的事，我来安排。", "en-US": "Tell me about your shop and what you need; I will organise it." },
  "expertise": [{ "zh-CN": "选品分析", "en-US": "Sourcing" }, { "zh-CN": "详情页文案", "en-US": "Listing copy" }],
  "samplePrompts": [{ "zh-CN": "对比这三款候选商品", "en-US": "Compare these three candidates" }]
}
```

`店铺运营顾问` is `agents/店铺运营顾问.md` in the same package.
