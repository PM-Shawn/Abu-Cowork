const PRESENT_FILES_EFFECT = 'Abu shows it as a file card under your reply and opens the side preview.';

/**
 * What the agent that answers the user is told about present_files, for a
 * prompt built once the run's tool roster is known and holds the tool (the
 * expert that runs the user turn itself).
 */
export const PRESENT_FILES_RULE =
  `Hand a finished file to the user → call present_files with it near the end of the turn; ${PRESENT_FILES_EFFECT}`;

/**
 * The same rule for a prompt built before the run's tool roster exists (the
 * main system prompt is assembled at run entry): it names the condition, so it
 * holds in runs that do not offer the tool.
 */
export const PRESENT_FILES_RULE_WHEN_OFFERED =
  `Hand a finished file to the user → when the present_files tool is available, call it with the file near the end of the turn; ${PRESENT_FILES_EFFECT}`;
