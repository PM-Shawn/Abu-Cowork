import type { MarketplaceItem } from '@/types/marketplace';

/** English overrides for expert display fields (name/description/tags/expertise/samplePrompts) */
export const expertsEnUS: Record<string, Partial<MarketplaceItem>> = {
  'sr-engineer': {
    name: 'Senior Engineer',
    description: '10+ years full-stack experience, expert in architecture, performance & code review',
    intro: "I'm a full-stack engineer with 10 years across architecture, performance and large-scale code review. Drop your code or problem — I'll give precise diff-level suggestions, no hedging.",
    tags: ['Full-Stack', 'Architecture', 'Code Review'],
    expertise: [
      'Code reading & precise diff-level improvement suggestions',
      'Architecture design, tech selection & performance bottleneck analysis',
      'Code review: hidden risks, edge cases, security issues',
      'Translating vague requirements into actionable technical plans',
    ],
    samplePrompts: [
      'Review this code and tell me what\'s wrong',
      'Zustand vs Redux for React state management — which and why',
      'How do I optimize the performance of this API',
    ],
  },
  'product-manager': {
    name: 'Product Manager',
    description: '8 years B2B/B2C product experience, expert in requirements analysis & product strategy',
    intro: "I've done 8 years of B2B/B2C product work — PRDs, user research, competitive analysis, roadmaps. When we discuss requirements I'll first nail down who the user is, what hurts and how we'll measure success.",
    tags: ['Requirements', 'PRD Writing', 'User Research'],
    expertise: [
      'Product docs: PRD, BRD, requirement review materials',
      'User story decomposition & prioritization (RICE/ICE/MoSCoW)',
      'Competitive analysis & market positioning',
      'Product roadmap planning',
    ],
    samplePrompts: [
      'Write a PRD for a user registration feature',
      'How do I break this requirement into user stories',
      'Help me build a competitive analysis framework',
    ],
  },
  'data-analyst': {
    name: 'Data Analyst',
    description: '7 years data analysis experience, expert in SQL, Python & statistical modeling',
    intro: "7 years in data analysis — SQL, Python, A/B testing, segmentation. Analysis must serve business decisions: I'll walk through the approach, give the code, then tell you what to do when you see this result.",
    tags: ['SQL', 'Python', 'A/B Testing'],
    expertise: [
      'Metric system design & dashboard building',
      'SQL queries & optimization (funnel/retention/cohort)',
      'A/B test design, significance testing & result interpretation',
      'User behavior analysis, RFM model & segmentation',
    ],
    samplePrompts: [
      'Write a SQL query for 7-day retention rate',
      'How do I design an A/B test for this feature',
      'Analyze this dataset and identify anomalies',
    ],
  },
  'wechat-editor': {
    name: 'WeChat Editor',
    description: '6 years content operations in tech/business, expert in topic planning & viral articles',
    intro: "6 years editing WeChat content in tech/business — topics, structure, headlines, polish. Writing always starts with 'why would the reader finish this?' Drafts come with hooks, share-worthy lines and zero filler.",
    tags: ['Topic Planning', 'Headline Writing', 'Content Ops'],
    expertise: [
      'Topic planning: find angles from trends, assess viral potential',
      'Article structure: hook → core content → call to action',
      'Headline creation: 5-10 candidates with open-rate rationale',
      'Article polish: improve flow, cut filler, strengthen rhythm',
    ],
    samplePrompts: [
      'Write a WeChat article about AI productivity tools',
      'Generate 5 headline candidates for this article',
      'Why is this article underperforming — help me diagnose',
    ],
  },
  'hr-recruiter': {
    name: 'HR Recruiter',
    description: '8 years internet industry recruiting, expert in JD writing, interview design & offer negotiation',
    intro: "8 years recruiting in tech — JDs, screening, structured interviews, offer negotiation. Before writing a JD I'll ask why this role exists and what success looks like in a year, then put it on paper.",
    tags: ['JD Writing', 'Interview Design', 'Offer Negotiation'],
    expertise: [
      'JD writing: precise job responsibilities & requirements',
      'Resume screening: spotting potential vs. red flags',
      'Interview question design: behavioral (STAR), situational',
      'Offer negotiation tactics & scripts',
    ],
    samplePrompts: [
      'Write a JD for a Data Analyst role',
      'Design 5 interview questions for this position',
      'Candidate\'s salary expectation is over budget — how do I negotiate',
    ],
  },
};
