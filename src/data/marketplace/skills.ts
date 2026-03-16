import type { MarketplaceItem } from '@/types/marketplace';

/** Skills marketplace templates - aligned with anthropics/skills + Abu built-in */
export const skillTemplates: MarketplaceItem[] = [
  // ============ 文档办公类 ============
  {
    id: 'doc-coauthoring',
    name: 'doc-coauthoring',
    description: '引导用户通过结构化工作流共同撰写文档、提案、技术规格等',
    author: 'Anthropic',
    category: '文档',
    isBuiltin: true,
  },
  {
    id: 'docx',
    name: 'docx',
    description: '创建、读取、编辑 Word 文档（.docx），支持格式化、模板、修订追踪等',
    author: 'Anthropic',
    category: '文档',
    isBuiltin: true,
  },
  {
    id: 'pdf',
    name: 'pdf',
    description: '处理 PDF 文件，包括读取提取、合并拆分、填表、加密、OCR 等',
    author: 'Anthropic',
    category: '文档',
    isBuiltin: true,
  },
  {
    id: 'pptx',
    name: 'pptx',
    description: '创建、读取、编辑演示文稿（.pptx），支持模板、幻灯片布局等',
    author: 'Anthropic',
    category: '文档',
    isBuiltin: true,
  },
  {
    id: 'xlsx',
    name: 'xlsx',
    description: '处理电子表格文件（.xlsx、.csv、.tsv），包括读取、编辑、公式、图表等',
    author: 'Anthropic',
    category: '文档',
    isBuiltin: true,
  },
  {
    id: 'internal-comms',
    name: 'internal-comms',
    description: '撰写内部沟通文档，如状态报告、领导层更新、公司通讯等',
    author: 'Anthropic',
    category: '文档',
    isBuiltin: true,
  },

  // ============ 可视化类 ============
  {
    id: 'html-widget',
    name: 'html-widget',
    description: '在对话中生成可交互的可视化组件 — 图表、动画、小工具、游戏等',
    author: 'Abu',
    category: '可视化',
    isBuiltin: true,
  },

  // ============ 设计创意类 ============
  {
    id: 'algorithmic-art',
    name: 'algorithmic-art',
    description: '使用 p5.js 创建算法艺术，支持种子随机和交互式参数探索',
    author: 'Anthropic',
    category: '设计',
    isBuiltin: true,
  },
  {
    id: 'canvas-design',
    name: 'canvas-design',
    description: '创建精美的视觉艺术作品，输出 .png 和 .pdf 格式',
    author: 'Anthropic',
    category: '设计',
    isBuiltin: true,
  },
  {
    id: 'frontend-design',
    name: 'frontend-design',
    description: '创建高品质、生产级的前端界面，避免泛 AI 风格',
    author: 'Anthropic',
    category: '设计',
    isBuiltin: true,
  },
  {
    id: 'brand-guidelines',
    name: 'brand-guidelines',
    description: '应用 Anthropic 官方品牌色彩和字体到各类设计产出物',
    author: 'Anthropic',
    category: '设计',
    isBuiltin: true,
  },
  {
    id: 'slack-gif-creator',
    name: 'slack-gif-creator',
    description: '创建优化 Slack 使用的动画 GIF',
    author: 'Anthropic',
    category: '设计',
    isBuiltin: true,
  },
  {
    id: 'theme-factory',
    name: 'theme-factory',
    description: '为幻灯片、文档、网页等应用专业主题样式',
    author: 'Anthropic',
    category: '设计',
    isBuiltin: true,
  },

  // ============ 开发工具类 ============
  {
    id: 'claude-api',
    name: 'claude-api',
    description: '使用 Claude API 或 Anthropic SDK 构建应用',
    author: 'Anthropic',
    category: '开发',
    isBuiltin: true,
  },
  {
    id: 'mcp-builder',
    name: 'mcp-builder',
    description: '创建高质量 MCP 服务器，集成外部 API 和服务',
    author: 'Anthropic',
    category: '开发',
    isBuiltin: true,
  },
  {
    id: 'web-artifacts-builder',
    name: 'web-artifacts-builder',
    description: '使用 React、Tailwind CSS、shadcn/ui 构建复杂 Web 组件',
    author: 'Anthropic',
    category: '开发',
    isBuiltin: true,
  },
  {
    id: 'webapp-testing',
    name: 'webapp-testing',
    description: '使用 Playwright 测试 Web 应用，支持截图和日志查看',
    author: 'Anthropic',
    category: '开发',
    isBuiltin: true,
  },
  {
    id: 'skill-creator',
    name: 'skill-creator',
    description: '创建新技能、修改现有技能、运行评估测试',
    author: 'Anthropic',
    category: '开发',
    isBuiltin: true,
  },

  // ============ 系统工具类 ============
  {
    id: 'create-agent',
    name: 'create-agent',
    description: 'AI 引导创建自定义代理',
    author: 'Abu',
    category: '系统',
    isBuiltin: true,
  },
  {
    id: 'schedule',
    name: 'schedule',
    description: '创建和管理定时任务，设置定期自动执行的操作',
    author: 'Abu',
    category: '系统',
    isBuiltin: true,
  },
];
