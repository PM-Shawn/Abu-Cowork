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
    samplePrompts: ['帮我做一个团队周报收集的小工具', '给这个需求出方案并实现一个可演示的版本', '把这个页面的注册流程重做并测一遍'],
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
    samplePrompts: ['分析这份销售数据，找出下滑的原因', '把我们的数据和行业平均水平对比一下', '做一份季度经营分析报告'],
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
    samplePrompts: ['围绕这个产品写一篇公众号推文', '把这份行业报告改写成三篇短文', '给这篇文章配一张封面图和三张信息图'],
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
    samplePrompts: ['帮我做本季度的经营汇报 PPT', '把这些数据整理成一份月报', '给领导写一份项目进展周报'],
    leaderNote: '先问清楚汇报对象、时长和要拿到的决定；数据图表由数据分析师出，行业对标由行业调研专家出；统稿时保持一套格式。',
    createdAt: 0,
  },
] satisfies Team[]);
