import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useTeamStore } from '@/stores/teamStore';
import { saveTeamWouldReplace } from './teamLookup';

const team = (name: string) => ({ id: `id-${name}`, name, leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 });

describe('saveTeamWouldReplace', () => {
  beforeEach(() => { useTeamStore.setState({ teams: [team('数据小队')] }); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('is true for a name a team already carries, trimmed like save_team trims it', () => {
    expect(saveTeamWouldReplace('数据小队')).toBe(true);
    expect(saveTeamWouldReplace('  数据小队  ')).toBe(true);
  });

  it('is false for a name no team carries', () => {
    expect(saveTeamWouldReplace('写作小队')).toBe(false);
  });

  it.each([['', 'empty'], ['   ', 'blank'], [undefined, 'missing'], [42, 'non-string']] as const)(
    'is false for a %s name — save_team refuses those before writing anything',
    (raw) => {
      expect(saveTeamWouldReplace(raw)).toBe(false);
    },
  );

  // Calling a replace "new" costs the user their team, so an unreadable store
  // answers "replace" and the confirmation warns rather than reassures.
  it('is true when the store cannot be read', () => {
    vi.spyOn(useTeamStore, 'getState').mockImplementation(() => { throw new Error('store unavailable'); });
    expect(saveTeamWouldReplace('写作小队')).toBe(true);
  });
});
