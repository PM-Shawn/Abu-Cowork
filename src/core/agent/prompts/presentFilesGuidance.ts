/**
 * What the agent that answers the user is told about present_files. One
 * sentence shared by the main system prompt and the prompt of an expert that
 * runs the user turn itself, so both read the same rule.
 */
export const PRESENT_FILES_RULE =
  'Hand a finished file to the user → call present_files with it near the end of the turn; Abu shows it as a file card under your reply and opens the side preview.';
