/**
 * CJK retrieval eval fixture — 20 Chinese memories × 15 Chinese queries.
 *
 * Regression target: the old tokenizer split on whitespace only, so a
 * whitespace-free Chinese query was ONE giant token that substring-matched
 * nothing — Phase 2 recall was effectively dead for Chinese users. The
 * bigram tokenizer must rank the expected memory first for every query
 * below, while the ≥2-bigram threshold + stopword pairs keep noise queries
 * at zero matches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readTextFile, readDir } from '@tauri-apps/plugin-fs';
import { findRelevantMemories } from './relevance';
import { _resetCachedHome } from './paths';
import { _resetScanCache } from './scan';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);

const NOW = 1_750_000_000_000;

const MEMORIES: Array<{ file: string; name: string; description: string }> = [
  { file: 'm01.md', name: '用户偏好-回复风格', description: '用户喜欢简短回复,不要长篇解释' },
  { file: 'm02.md', name: '火山方舟端点', description: '火山方舟三套端点密钥互不通用' },
  { file: 'm03.md', name: '生图错误反馈', description: '生图失败时聊天端点提示改进' },
  { file: 'm04.md', name: '写作目录', description: '用户的文章写作目录与双版本产出偏好' },
  { file: 'm05.md', name: '项目-阿布工作台', description: 'Abu WorkOS 立项与决策记录' },
  { file: 'm06.md', name: '会议纪要模板', description: '周会纪要的固定模板与分发流程' },
  { file: 'm07.md', name: '数据看板链接', description: '业务数据团队常用看板地址' },
  { file: 'm08.md', name: '报销流程', description: '差旅报销的审批链与截止日期' },
  { file: 'm09.md', name: '健身计划', description: '每周三次力量训练安排' },
  { file: 'm10.md', name: '菜谱-红烧肉', description: '家传红烧肉做法要点' },
  { file: 'm11.md', name: '孩子学校', description: '孩子学校的接送时间与老师联系方式' },
  { file: 'm12.md', name: '英语学习', description: '每日背单词计划与复习节奏' },
  { file: 'm13.md', name: '服务器运维', description: '生产服务器的部署与回滚步骤' },
  { file: 'm14.md', name: '数据库备份', description: '每晚自动备份策略与恢复演练' },
  { file: 'm15.md', name: '客户联系人', description: '重点客户的对接人与偏好' },
  { file: 'm16.md', name: '合同审批', description: '合同用印的法务审批流程' },
  { file: 'm17.md', name: '旅行计划-日本', description: '十月日本旅行的行程草案' },
  { file: 'm18.md', name: '摄影参数', description: '常用相机参数与镜头偏好' },
  { file: 'm19.md', name: '周报格式', description: '周报的三段式结构要求' },
  { file: 'm20.md', name: '快捷键设置', description: '常用软件的自定义快捷键' },
];

/** query → the memory name that must rank first */
const EVAL_CASES: Array<{ query: string; expect: string }> = [
  { query: '帮我看看火山方舟的密钥怎么配', expect: '火山方舟端点' },
  { query: '生图又失败了是什么原因', expect: '生图错误反馈' },
  { query: '红烧肉怎么做来着', expect: '菜谱-红烧肉' },
  { query: '周报的格式要求是什么', expect: '周报格式' },
  { query: '差旅报销截止到哪天', expect: '报销流程' },
  { query: '生产服务器怎么回滚', expect: '服务器运维' },
  { query: '数据库备份策略是什么', expect: '数据库备份' },
  { query: '孩子学校几点放学', expect: '孩子学校' },
  { query: '看板地址发我一下', expect: '数据看板链接' },
  { query: '合同盖章走什么流程', expect: '合同审批' },
  { query: '日本行程定了吗', expect: '旅行计划-日本' },
  { query: '英语单词今天背了没', expect: '英语学习' },
  { query: '健身安排是怎样的', expect: '健身计划' },
  { query: '客户那边找谁对接', expect: '客户联系人' },
  { query: '快捷键都设了哪些', expect: '快捷键设置' },
];

function fileContent(m: { name: string; description: string }): string {
  return `---
name: ${m.name}
description: ${m.description}
type: user
source: agent_explicit
created: ${NOW}
updated: ${NOW}
accessCount: 0
private: false
---

${m.name} 的正文内容。`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  _resetCachedHome();
  _resetScanCache();

  mockReadDir.mockResolvedValue(
    MEMORIES.map(m => ({
      name: m.file,
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    })) as Awaited<ReturnType<typeof readDir>>,
  );
  mockReadTextFile.mockImplementation(async path => {
    const hit = MEMORIES.find(m => String(path).endsWith(m.file));
    if (!hit) throw new Error(`unexpected read: ${String(path)}`);
    return fileContent(hit);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CJK retrieval eval (20 memories × 15 queries)', () => {
  for (const c of EVAL_CASES) {
    it(`ranks 「${c.expect}」 first for 「${c.query}」`, async () => {
      const result = await findRelevantMemories(c.query, null);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].name).toBe(c.expect);
    });
  }
});

describe('CJK noise suppression', () => {
  it('returns nothing for chit-chat with no topical overlap', async () => {
    const result = await findRelevantMemories('你好呀今天天气不错', null);
    expect(result).toHaveLength(0);
  });

  it('stopword bigrams alone never match (帮我/这个/东西/一下)', async () => {
    const result = await findRelevantMemories('帮我把这个东西整理一下', null);
    expect(result).toHaveLength(0);
  });

  it('a single shared bigram is below the match threshold', async () => {
    // 数据 appears in two memory names (数据看板链接 / 数据库备份), but one
    // shared pair is noise — neither may match on 数据 alone.
    const result = await findRelevantMemories('数据分析报告写一份', null);
    expect(result).toHaveLength(0);
  });
});

describe('mixed and latin queries (regression)', () => {
  it('matches latin word tokens alongside CJK bigrams', async () => {
    const result = await findRelevantMemories('Abu WorkOS 的立项决策', null);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toBe('项目-阿布工作台');
  });

  it('still returns nothing for unrelated latin queries', async () => {
    const result = await findRelevantMemories('completely unrelated xyzzy query', null);
    expect(result).toHaveLength(0);
  });
});
