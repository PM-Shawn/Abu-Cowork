import { describe, it, expect, vi, beforeEach } from 'vitest';
import { skillLoader } from '../../skill/loader';
import { skillViewTool } from './skillViewTools';
import type { Skill } from '../../../types';

const makeSkill = (name: string, extras: Partial<Skill> = {}): Skill => ({
  name,
  description: `Test skill ${name}`,
  content: `# ${name}\n\nBody content here.`,
  filePath: `/some/path/${name}/SKILL.md`,
  skillDir: `/some/path/${name}`,
  source: 'user',
  ...extras,
});

beforeEach(() => {
  // Reset any spies attached by earlier tests
  vi.restoreAllMocks();
});

describe('skillViewTool', () => {
  it('returns full skill JSON when file_path is not provided', async () => {
    const skill = makeSkill('my-skill', {
      trigger: 'user asks X',
      source: 'workspace-auto',
    });
    vi.spyOn(skillLoader, 'getSkill').mockReturnValue(skill);
    vi.spyOn(skillLoader, 'listSupportingFiles').mockResolvedValue([
      'references/api.md',
      'templates/body.txt',
    ]);

    const result = await skillViewTool.execute({ name: 'my-skill' }, {});
    const parsed = JSON.parse(result as string);

    expect(parsed).toMatchObject({
      name: 'my-skill',
      description: 'Test skill my-skill',
      source: 'workspace-auto',
      trigger: 'user asks X',
      content: expect.stringContaining('Body content'),
      supporting_files: ['references/api.md', 'templates/body.txt'],
    });
  });

  it('returns error string with sample of available skills when not found', async () => {
    vi.spyOn(skillLoader, 'getSkill').mockReturnValue(null as unknown as Skill);
    vi.spyOn(skillLoader, 'getAvailableSkills').mockReturnValue([
      { name: 'weekly-report', description: 'x' },
      { name: 'hive-query-orders', description: 'y' },
    ]);

    const result = await skillViewTool.execute({ name: 'nonexistent' }, {});
    expect(result).toContain('not found');
    expect(result).toContain('weekly-report');
  });

  it('returns supporting file content when file_path provided', async () => {
    const skill = makeSkill('docs-skill');
    vi.spyOn(skillLoader, 'getSkill').mockReturnValue(skill);
    vi.spyOn(skillLoader, 'loadSupportingFile').mockResolvedValue(
      '# API Guide\n\nCall `/v1/orders`.',
    );

    const result = await skillViewTool.execute(
      { name: 'docs-skill', file_path: 'references/api.md' },
      {},
    );
    expect(result).toContain('API Guide');
    expect(result).toContain('/v1/orders');
  });

  it('rejects path traversal attempts', async () => {
    const skill = makeSkill('safe-skill');
    vi.spyOn(skillLoader, 'getSkill').mockReturnValue(skill);

    const result = await skillViewTool.execute(
      { name: 'safe-skill', file_path: '../../etc/passwd' },
      {},
    );
    expect(result).toContain('Error');
    expect(result).toContain('..');
  });

  it('lists available files when requested file is missing', async () => {
    const skill = makeSkill('missing-file-skill');
    vi.spyOn(skillLoader, 'getSkill').mockReturnValue(skill);
    vi.spyOn(skillLoader, 'loadSupportingFile').mockResolvedValue(null);
    vi.spyOn(skillLoader, 'listSupportingFiles').mockResolvedValue([
      'references/exists.md',
    ]);

    const result = await skillViewTool.execute(
      { name: 'missing-file-skill', file_path: 'references/nope.md' },
      {},
    );
    expect(result).toContain('not found');
    expect(result).toContain('references/exists.md');
  });

  it('reports "no supporting files" when skill directory has none', async () => {
    const skill = makeSkill('lean-skill');
    vi.spyOn(skillLoader, 'getSkill').mockReturnValue(skill);
    vi.spyOn(skillLoader, 'loadSupportingFile').mockResolvedValue(null);
    vi.spyOn(skillLoader, 'listSupportingFiles').mockResolvedValue([]);

    const result = await skillViewTool.execute(
      { name: 'lean-skill', file_path: 'references/anything.md' },
      {},
    );
    expect(result).toContain('no supporting files');
  });

  it('is marked as concurrency-safe (read-only)', () => {
    expect(skillViewTool.isConcurrencySafe).toBe(true);
  });
});
