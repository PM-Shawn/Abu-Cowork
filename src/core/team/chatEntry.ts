import { useTeamStore } from '@/stores/teamStore';

/**
 * Composer entry for teams (in-conversation team, 2026-09-04).
 *
 * The composer normally turns `@<team>` into the team chip, which pins the
 * conversation (`Conversation.teamId`) so the team's leader runs the loop.
 * This helper is the fallback for a mention that reached ChatView as text
 * (sent before the exact-name detection, pasted, typed after attachments):
 * it names the team and returns the message without the mention so the
 * conversation can be pinned and the text sent normally.
 *
 * Matching: the first non-attachment line must start with '@' followed by the
 * longest active-team-name prefix (team names may contain spaces), ended by
 * end-of-line, whitespace or a comma. `@<agent>` is deliberately NOT handled
 * here — mentioning a member keeps inline delegation.
 */
export interface TeamMentionMatch {
  teamId: string;
  teamName: string;
  /** The message with the mention removed (attachment markers kept). */
  rest: string;
}

const ATTACHMENT_MARKER = /^\[Attachment: `[^`]+`\]$/;

export function matchTeamMention(rawText: string): TeamMentionMatch | null {
  const lines = rawText.split('\n');
  // Skip what the composer prepends ahead of the user's text: attachment
  // markers, quoted-reference headers (`[引用 …]`) and blockquote lines.
  const idx = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !ATTACHMENT_MARKER.test(trimmed) && !trimmed.startsWith('[') && !trimmed.startsWith('>');
  });
  if (idx < 0) return null;
  const line = lines[idx].trimStart();
  if (!line.startsWith('@')) return null;
  const candidate = line.slice(1);

  const teams = useTeamStore.getState().teams;
  let best: { id: string; name: string } | null = null;
  for (const team of teams) {
    const after = candidate.slice(team.name.length);
    if (candidate.startsWith(team.name) && (after === '' || /^[\s,，]/.test(after))) {
      if (!best || team.name.length > best.name.length) best = { id: team.id, name: team.name };
    }
  }
  if (!best) return null;

  const remainder = candidate.slice(best.name.length).replace(/^[\s,，]+/, '');
  const restLines = lines.slice();
  restLines[idx] = remainder;
  const rest = restLines.filter((l, i) => i !== idx || l.length > 0).join('\n').trim();
  return { teamId: best.id, teamName: best.name, rest };
}
