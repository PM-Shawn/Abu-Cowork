import { useTeamStore } from '@/stores/teamStore';

/**
 * Would a `save_team` call with this `name` overwrite a team that already
 * exists? Read from the store, never from anything the model asserts — the
 * approval showing this is the one check on the model's claim that the user
 * asked to change that team.
 *
 * Matched the way `save_team` itself resolves the target (trimmed, exact
 * name), so the approval and the write can never talk about different teams.
 * A name the tool would refuse anyway answers false; if the store cannot be
 * read, the answer is true — warning about a replace that does not happen
 * costs a second look, calling a replace "new" costs the user's team.
 */
export function saveTeamWouldReplace(rawName: unknown): boolean {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) return false;
  try {
    return useTeamStore.getState().teams.some((team) => team.name === name);
  } catch {
    return true;
  }
}
