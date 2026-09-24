import type { ConversationAppBinding } from '@/types/app';

/**
 * The prompt section a conversation started inside an app carries. The app's
 * own instructions (app, mode and scene `promptAppend`, already joined by
 * `buildAppBinding`) sit inside a delimiter so the model reads them as the
 * package author's guidance, never as Abu's own rules; the total is capped
 * the way plugin skills are, so a package cannot push the rest of the prompt
 * out of the window.
 */
export const APP_PROMPT_APPEND_MAX_CHARS = 48000;

export function buildAppContextSection(binding: ConversationAppBinding): string {
  const lines = [
    '## App Context',
    `You are working inside the app "${binding.appName}". This is the workspace the user selected for this conversation. When this app's experts, skills and connectors can complete the task, use them first.`,
  ];
  const instructions = binding.promptAppend?.trim();
  if (instructions) {
    const bounded = instructions.length > APP_PROMPT_APPEND_MAX_CHARS
      ? `${instructions.slice(0, APP_PROMPT_APPEND_MAX_CHARS)}\n[app instructions truncated at ${APP_PROMPT_APPEND_MAX_CHARS} characters]`
      : instructions;
    lines.push('', '<app-instructions>', bounded, '</app-instructions>');
  }
  return `\n${lines.join('\n')}`;
}
