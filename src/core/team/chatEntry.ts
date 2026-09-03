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
export function tryHandleTeamMention(rawText: string, options?: { hasImages?: boolean }):
  | { handled: true; teamName: string; taskId: string; goal: string }
  | { handled: false; reason?: 'empty_goal' | 'unsupported_context'; teamName?: string } {
  // Composer file attachments travel as `[Attachment: `path`]` lines, and they
  // are prepended AHEAD of the user's text whenever the mention was typed
  // inline instead of picked from the popup. Strip them first — matching on the
  // raw text would silently disable the whole team route as soon as a file is
  // attached, even though attachments are exactly what a team task wants
  // (PRD §4.3: 附件=任务附件).
  const attachments: string[] = [];
  const text = rawText.replace(/\[Attachment: `([^`]+)`\]\n?/g, (_m, path: string) => {
    attachments.push(path);
    return '';
  }).trim();
  const teams = useTeamStore.getState().teams.filter((t) => !t.archivedAt);
  /** Longest active-team-name prefix of `candidate` (the text after an '@'). */
  const matchTeam = (candidate: string): { id: string; name: string } | null => {
    let best: { id: string; name: string } | null = null;
    for (const team of teams) {
      if (candidate === team.name || candidate.startsWith(team.name + ' ') || candidate.startsWith(team.name + '\n') || candidate.startsWith(team.name + '，') || candidate.startsWith(team.name + ',')) {
        if (!best || team.name.length > best.name.length) best = { id: team.id, name: team.name };
      }
    }
    return best;
  };

  const match = text.startsWith('@') ? matchTeam(text.slice(1)) : null;
  if (!match) {
    // The composer also prepends quoted references ahead of the user's text,
    // and those carry blockquotes/fences we cannot safely split back out. A
    // mention buried behind one is still clearly a hand-off, so refuse it out
    // loud rather than letting it degrade into an ordinary chat turn (the
    // silent-fallthrough bug this replaced).
    const buried = text.split('\n').map((line) => (line.startsWith('@') ? matchTeam(line.slice(1)) : null)).find(Boolean);
    if (buried) return { handled: false, reason: 'unsupported_context', teamName: buried.name };
    return { handled: false };
  }
  // Images never enter the text at all — they travel as a separate argument,
  // so a team task would drop them silently.
  if (options?.hasImages) return { handled: false, reason: 'unsupported_context', teamName: match.name };
  const rest = text.slice(1);

  const goal = rest.slice(match.name.length).replace(/^[\s,，]+/, '').trim();
  if (!goal) return { handled: false, reason: 'empty_goal', teamName: match.name };

  const task = useTeamStore.getState().createTask({ teamId: match.id, goal, attachments });
  kickoffTask(task.id);
  return { handled: true, teamName: match.name, taskId: task.id, goal };
}
