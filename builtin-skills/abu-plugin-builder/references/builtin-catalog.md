# Abu's built-in experts and teams

Reference these from `teams/*.json` (`builtin:<name>`) and from `app` run references (`{ "expert": "builtin:<name>" }`, `{ "team": "builtin-team:<id>" }`). Write the names exactly as listed; they do not change between releases.

## Built-in experts

`高级开发工程师`、`产品经理`、`数据分析师`、`公众号编辑`、`HR 招聘官`、`办公文档专家`、`行业调研专家`、`网页设计师`、`测试工程师`、`行政助理`、`财务助理`、`合同审阅专家`

## Built-in teams

| id | Name | Leader | Members |
|---|---|---|---|
| `builtin-team:software-rd` | 软件研发专家团 | 产品经理 | 高级开发工程师、网页设计师、测试工程师 |
| `builtin-team:data-analysis` | 数据分析专家团 | 数据分析师 | 行业调研专家、办公文档专家 |
| `builtin-team:content-creation` | 内容创作专家团 | 公众号编辑 | 行业调研专家、网页设计师 |
| `builtin-team:reporting` | 汇报材料专家团 | 办公文档专家 | 数据分析师、行业调研专家 |
| `builtin-team:finance-reconciliation` | 财务对账专家团 | 财务助理 | 数据分析师、办公文档专家 |
| `builtin-team:recruiting` | 招聘专家团 | HR 招聘官 | 行业调研专家、办公文档专家 |

Pick a built-in team when its roster already fits the scene; ship a package team only when the app needs its own experts or a different roster.
