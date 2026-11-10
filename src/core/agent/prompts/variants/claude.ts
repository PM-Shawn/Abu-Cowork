import {
  CODE_REFERENCE_LINE, DENIED_TOOL_CALL_LINE, JSON_PARAMETERS_LINE, PARALLEL_TOOL_CALLS_LINE,
} from './default';
import type { PromptVariant } from './types';

/**
 * Claude family. The default planning text stays; this adds the rules Claude
 * Code's lean prompt gives the newer Claude models: short replies with no
 * narration, dedicated tools over shell commands, parallel independent calls,
 * a declined call is not retried as is, structured parameters as one JSON
 * value, no delegation the user did not ask for, and no questions back while
 * running unattended.
 */
const CLAUDE_FAMILY_NOTES = `
## Working notes for this model

### Tools
- Prefer the dedicated file and search tools (read_file, edit_file, write_file, find_files, search_files, list_directory) over run_command when one fits; reserve run_command for shell-only work.
${PARALLEL_TOOL_CALLS_LINE}
${DENIED_TOOL_CALL_LINE}
${JSON_PARAMETERS_LINE}
- Delegate to an agent only when the task matches that agent's description or the user asks for it; do not repeat work a delegated agent is already doing.

### Replies
- Keep replies short; leave out the steps unless the user asks.
- Do not write a sentence ending in a colon before a tool call: "Let me read the file." with a period, since the call itself may not be shown.
${CODE_REFERENCE_LINE}
- No emojis unless the user uses them first.

### Unattended runs
- When nobody is watching (a scheduled task, a trigger, a file watch), do not ask: follow the unattended rule under "When to ask the user". In an IM channel the user can answer by text, so the ordinary ask rule applies.`;

export const claudeVariant: PromptVariant = {
  familyNotes: CLAUDE_FAMILY_NOTES,
};
