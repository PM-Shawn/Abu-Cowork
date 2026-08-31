import { useTeamStore } from '@/stores/teamStore';
import { kickoffTask } from './orchestrator';

/**
 * Chat-composer entry for team tasks (user decision 2026-08-31: the composer
 * is the primary way to hand work over; the 任务 tab is the kanban).
 *
 * `@<team name> <goal>` in the composer becomes a team task — intercepted
 * locally like `/compact`, before any LLM run. `@<agent>` is deliberately NOT
 * handled here: mentioning a member keeps today's inline-delegation behavior
 * (you stay and watch); handing off to an individual goes through the task
 * creation dialog instead.
 *
 * Matching: longest active-team-name prefix after '@' (team names may contain
 * spaces), then the rest of the message is the goal — stored verbatim.
 */
export function tryHandleTeamMention(rawText: string):
  | { handled: true; teamName: string; taskId: string; goal: string }
  | { handled: false; reason?: 'empty_goal'; teamName?: string } {
  const text = rawText.trim();
  if (!text.startsWith('@')) return { handled: false };
  const rest = text.slice(1);

  const teams = useTeamStore.getState().teams.filter((t) => !t.archivedAt);
  let match: { id: string; name: string } | null = null;
  for (const team of teams) {
    if (rest === team.name || rest.startsWith(team.name + ' ') || rest.startsWith(team.name + '\n') || rest.startsWith(team.name + '，') || rest.startsWith(team.name + ',')) {
      if (!match || team.name.length > match.name.length) match = { id: team.id, name: team.name };
    }
  }
  if (!match) return { handled: false };

  const goal = rest.slice(match.name.length).replace(/^[\s,，]+/, '');
  if (!goal) return { handled: false, reason: 'empty_goal', teamName: match.name };

  const task = useTeamStore.getState().createTask({ teamId: match.id, goal });
  kickoffTask(task.id);
  return { handled: true, teamName: match.name, taskId: task.id, goal };
}
