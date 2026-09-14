import type { Team } from '@/stores/teamStore';

/**
 * Built-in expert teams — the 市场 half of the 专家团 page. They ship with the
 * app, are read-only (no edit / delete / archive), and never persist: the
 * team store merges them in after hydration and strips them before writing.
 * Ids and member names are identifiers frozen at release; renaming breaks
 * every conversation and schedule that pinned the team.
 */
export const BUILTIN_TEAM_ID_PREFIX = 'builtin-team:';

export function isBuiltinTeam(team: Pick<Team, 'id'>): boolean {
  return team.id.startsWith(BUILTIN_TEAM_ID_PREFIX);
}

const role = (name: string) => `builtin:${name}`;

export const BUILTIN_TEAMS: readonly Team[] = Object.freeze([
  {
    id: `${BUILTIN_TEAM_ID_PREFIX}software-rd`,
    name: '软件研发专家团',
    avatar: 'icon:code/blue',
    leaderRoleId: role('产品经理'),
    memberRoleIds: [role('产品经理'), role('高级开发工程师'), role('网页设计师'), role('测试工程师')],
    description: '从需求到可运行的软件：产品经理拆需求，工程师、设计师实现，测试把关',
    intro: '把你想做的东西告诉我。我会先把需求理清楚、拆成任务，再交给工程师和设计师做，最后让测试验一遍，把能跑的结果和验收记录一起给你。',
    expertise: ['需求澄清与任务拆解', '前后端实现与页面设计', '测试验收与缺陷报告'],
    samplePrompts: ['帮我做一个团队周报收集的小工具', '给这个需求出方案并实现一个可演示的版本', '把这个页面的注册流程重做并测一遍', '给现有系统加一个导出 Excel 的功能'],
    leaderNote: '先用三句话复述需求并列出验收标准，再拆任务；实现完成后必须派测试工程师验收，汇报时附验收结果。',
    createdAt: 0,
  },
  {
    id: `${BUILTIN_TEAM_ID_PREFIX}data-analysis`,
    name: '数据分析专家团',
    avatar: 'icon:chart-bar/teal',
    leaderRoleId: role('数据分析师'),
    memberRoleIds: [role('数据分析师'), role('行业调研专家'), role('办公文档专家')],
    description: '从数据到结论：分析师主导，调研补外部事实，文档专家出交付件',
    intro: '把数据文件或问题给我。我先确认你要回答的业务问题，需要外部数据时让调研专家去找，分析完由文档专家整理成表格或报告交付。',
    expertise: ['数据清洗与指标口径', '外部数据与行业对比', 'Excel / Word 交付件'],
    samplePrompts: ['分析这份销售数据，找出下滑的原因', '把我们的数据和行业平均水平对比一下', '做一份季度经营分析报告', '给这次活动的数据做一份复盘报告'],
    leaderNote: '先写清楚要回答的问题和指标口径再动手；涉及外部数据必须由行业调研专家提供来源；交付件统一交给办公文档专家整理。',
    createdAt: 0,
  },
  {
    id: `${BUILTIN_TEAM_ID_PREFIX}content-creation`,
    name: '内容创作专家团',
    avatar: 'icon:pen/coral',
    leaderRoleId: role('公众号编辑'),
    memberRoleIds: [role('公众号编辑'), role('行业调研专家'), role('网页设计师')],
    description: '从选题到成稿：编辑定选题写稿，调研补素材，设计师出配图和页面',
    intro: '告诉我要写什么、发给谁。我先定选题和框架，需要素材让调研专家去找，稿子写完由设计师配图，你拿到的是能直接发的内容。',
    expertise: ['选题与标题', '素材调研与事实核对', '配图与图文页面'],
    samplePrompts: ['围绕这个产品写一篇公众号推文', '把这份行业报告改写成三篇短文', '给这篇文章配一张封面图和三张信息图', '给这次产品发布写一组宣传文案并配好图'],
    leaderNote: '动笔前先给出选题、目标读者和框架让用户确认；所有数据和引述必须由行业调研专家核过来源；配图需求交给网页设计师。',
    createdAt: 0,
  },
  {
    id: `${BUILTIN_TEAM_ID_PREFIX}reporting`,
    name: '汇报材料专家团',
    avatar: 'icon:book/amber',
    leaderRoleId: role('办公文档专家'),
    memberRoleIds: [role('办公文档专家'), role('数据分析师'), role('行业调研专家')],
    description: '周报、月报、季度汇报一站式：文档专家统稿，分析师出数据，调研补背景',
    intro: '把素材和汇报对象告诉我。我先定结构，数据部分交给分析师，行业背景让调研专家补，最后统稿成 Word 或 PPT 交付。',
    expertise: ['汇报结构与措辞', '数据图表', '行业背景与对标'],
    samplePrompts: ['帮我做本季度的经营汇报 PPT', '把这些数据整理成一份月报', '给领导写一份项目进展周报', '把这份年度总结做成一套汇报 PPT'],
    leaderNote: '先问清楚汇报对象、时长和要拿到的决定；数据图表由数据分析师出，行业对标由行业调研专家出；统稿时保持一套格式。',
    createdAt: 0,
  },
  {
    id: `${BUILTIN_TEAM_ID_PREFIX}finance-reconciliation`,
    name: '财务对账专家团',
    avatar: 'icon:calculator/teal',
    leaderRoleId: role('财务助理'),
    memberRoleIds: [role('财务助理'), role('数据分析师'), role('办公文档专家')],
    description: '从票据到台账：财务助理对账，分析师查异常，文档专家出报表',
    intro: '把发票、流水或者费用表给我。我会先把账对上、把差异挑出来，再让分析师看看异常是偶发还是有规律，最后由文档专家做成能交上去的表和一段说明。',
    expertise: ['费用核对与逐笔对账', '异常与趋势分析', '报表成稿与说明'],
    samplePrompts: ['把这个季度的费用对一下账，差异列清楚', '这堆报销单整理成表，超标的标出来', '分析下今年差旅费为什么涨了', '做一份月度费用报表，附一段说明'],
    leaderNote: '先说清对账口径和期间再逐笔对；差异必须列明金额与可能原因，拿不准的标出来问，不要自行调账把总数凑平。',
    createdAt: 0,
  },
  {
    id: `${BUILTIN_TEAM_ID_PREFIX}recruiting`,
    name: '招聘专家团',
    avatar: 'icon:users/amber',
    leaderRoleId: role('HR 招聘官'),
    memberRoleIds: [role('HR 招聘官'), role('行业调研专家'), role('办公文档专家')],
    description: '从岗位到 offer：招聘官定标准，调研专家摸行情，文档专家出材料',
    intro: '告诉我要招什么人。我会先把岗位要求和人选画像定下来，让调研专家去查这个岗位的市场行情，再由文档专家把 JD、面试题和评估表做齐给你。',
    expertise: ['岗位画像与 JD 撰写', '薪资行情与候选人背景调研', '面试题与评估表'],
    samplePrompts: ['帮我写一份高级前端的 JD 并定好面试题', '查一下这个岗位在北京的薪资行情', '把这几份简历按岗位要求排个序', '准备一套后端岗的面试评估表'],
    leaderNote: '先把岗位要求、预算和时间线问清楚再动手；薪资行情必须让调研专家去取证并附来源，不要凭印象报数。',
    createdAt: 0,
  },
] satisfies Team[]);
