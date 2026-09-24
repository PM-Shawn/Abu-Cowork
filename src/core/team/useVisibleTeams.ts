import { useMemo } from 'react';
import { selectVisibleTeams, useTeamStore, type Team } from '@/stores/teamStore';

export function useVisibleTeams(): Team[] {
  const teams = useTeamStore((state) => state.teams);
  const managedTeamSources = useTeamStore((state) => state.managedTeamSources);
  return useMemo(
    () => selectVisibleTeams({ teams, managedTeamSources }),
    [teams, managedTeamSources],
  );
}
