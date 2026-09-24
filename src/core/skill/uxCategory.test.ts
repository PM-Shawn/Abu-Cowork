import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sourceToUXCategory } from './uxCategory';

describe('sourceToUXCategory', () => {
  it('groups user / standard / project / project-standard into "mine"', () => {
    expect(sourceToUXCategory('user')).toBe('mine');
    expect(sourceToUXCategory('standard')).toBe('mine');
    expect(sourceToUXCategory('project')).toBe('mine');
    expect(sourceToUXCategory('project-standard')).toBe('mine');
  });

  it('puts workspace-auto into "mine" (per-row badge shows origin)', () => {
    // workspace-auto skills land in "我的" with a "自进化" badge via
    // sourceBadge(). Keeping them in a separate category was confusing
    // when the user explicitly asked Abu to create the skill.
    expect(sourceToUXCategory('workspace-auto')).toBe('mine');
  });

  it('keeps draft in "agent-evolved" (pending review, not yet accepted)', () => {
    // Drafts are agent-proposed skills awaiting user accept/reject.
    // They're managed by SkillDraftsPanel, not the regular skill list.
    expect(sourceToUXCategory('draft')).toBe('agent-evolved');
  });

  it('maps builtin separately from mine', () => {
    expect(sourceToUXCategory('builtin')).toBe('builtin');
  });

  it('files plugin-contributed and organization-pushed skills under 我的 — the user has them', () => {
    // 我的 is what the user owns, 市场 what they can still get. A skill an
    // installed plugin brought in is theirs (badged, read-only, gone with the
    // plugin); one the organization pushed likewise.
    expect(sourceToUXCategory('plugin')).toBe('mine');
    expect(sourceToUXCategory('enterprise')).toBe('mine');
  });

  it('treats undefined source as legacy "mine" (no source field yet)', () => {
    // Some older persisted skills may predate the source field.
    expect(sourceToUXCategory(undefined)).toBe('mine');
  });

  describe('unknown source (runtime safety)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('returns null and warns — unknown skills are hidden, not misfiled', () => {
      // Cast forces the runtime-only branch (TS would reject this).
      const result = sourceToUXCategory('some-future-value' as never);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknown skill source'),
      );
    });
  });
});
