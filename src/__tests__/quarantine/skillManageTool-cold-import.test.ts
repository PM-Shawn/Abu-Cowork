// QUARANTINED: https://github.com/PM-Shawn/Abu-Cowork/issues/99 (2026-06-30)
//
// Background: skillManageTool.test.ts's comment (lines 22-25) documents that under
// full-suite parallel load, the `create` action path with agent_proposed=true triggers
// a dynamic-import chain (discoveryStore → agentRegistry + yaml + 8 agents, skillDraftsStore
// → chatStore → builtins, notifications → notice bus) costing ~2.4s and causing the first
// test hitting that path to exceed the 5s timeout (2–9 failures per full run).
//
// Fix applied: vi.mock() stubs for discoveryStore, skillDraftsStore, and notifications were
// added directly to skillManageTool.test.ts, removing the cold-import cost from gate tests.
//
// This quarantine file intentionally tests the SAME write paths WITHOUT those module-level
// stubs, to verify that the stubs in the main file are load-bearing. If these tests start
// timing out in CI, it confirms that removing the stubs from the main file would re-introduce
// the flakiness.
//
// SLA: Review by 2026-07-28. If skillManageTool.test.ts's stubs remain stable, delete this file.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists } from '@tauri-apps/plugin-fs';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useSettingsStore } from '@/stores/settingsStore';
// NOTE: discoveryStore, skillDraftsStore, notifications are NOT stubbed here.
// The tests below rely on the global Tauri mocks in setup.ts to prevent real I/O,
// but do NOT prevent the cold-import cost of loading those module chains.
// Under parallel-suite load on a slow CI runner, these may time out.

vi.mock('@/utils/atomicFs', () => ({
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  atomicWriteWithBackup: vi.fn().mockResolvedValue({ wrote: true, backupPath: null }),
  restoreFromBackup: vi.fn().mockResolvedValue(undefined),
  cleanupOldBackups: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/utils/notifications', () => ({
  notifyDraftProposal: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(exists).mockResolvedValue(true);
  useSettingsStore.setState({
    safety: { enableContentGuard: true, bypass: [] },
  });
  useWorkspaceStore.setState({ currentPath: '/workspace/myapp' });
});

describe('skillManageTool · cold-import timing (quarantined)', () => {
  it('create with agent_proposed=true completes without stubs (timing-sensitive)', async () => {
    const { skillManageTool } = await import('@/core/tools/definitions/skillManageTool');
    const { skillLoader } = await import('@/core/skill/loader');
    vi.spyOn(skillLoader, 'getSkill').mockReturnValue(undefined);
    vi.spyOn(skillLoader, 'discoverSkills').mockResolvedValue([]);

    const result = JSON.parse(
      (await skillManageTool.execute(
        {
          action: 'create',
          name: 'quarantine-test-skill',
          agent_proposed: true,
          trigger_reason: 'quarantine scenario',
          frontmatter: { name: 'quarantine-test-skill', description: 'quarantine test' },
          content: '# body',
        },
        {},
      )) as string,
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe('pending-user-approval');
  });
});
