# New expert teams: `teams/<id>.json`

Write a team into the draft only when no team the user already has, and no built-in team, fits. One JSON file per team under `teams/`; the file name without `.json` is the team id and matches `^[a-z0-9-]+$`. A scene names it as `{ "team": "mine:<id>" }`. When the user confirms the preview, the team is created under Experts → Teams → Mine, and the app points at it.

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
| `"<expert name>"` | A new expert from the draft's `agents/` |
| `"builtin:<expert name>"` | One of Abu's built-in experts, names in `builtin-catalog.md` |

A reference to an expert that does not exist fails validation.

Icon presets: icons `chart-bar`, `code`, `flask`, `pen`, `shield`, `users`, `search`, `database`, `palette`, `compass`, `wrench`, `book`, `megaphone`, `scale`, `sparkles`, `cpu`, `globe`, `camera`, `calculator`, `bot`; tints `blue`, `purple`, `teal`, `coral`, `amber`, `pink`.

## Example

`teams/weekly-review.json`, using one new expert and two built-in experts:

```json
{
  "name": { "zh-CN": "周报复盘小组", "en-US": "Weekly review team" },
  "avatar": "icon:book/teal",
  "leader": "周报整理员",
  "members": ["周报整理员", "builtin:数据分析师", "builtin:办公文档专家"],
  "leaderNote": "先确认这一周的时间范围，再分工；数据结论交给数据分析师核对。",
  "description": { "zh-CN": "把一周的记录整理成周报和复盘", "en-US": "Turns a week of notes into a report and a review" },
  "expertise": [{ "zh-CN": "周报", "en-US": "Weekly reports" }, { "zh-CN": "复盘", "en-US": "Reviews" }]
}
```

`周报整理员` is `agents/周报整理员.md` in the same draft.
