import { PRESENT_FILES_RULE_WHEN_OFFERED } from '../presentFilesGuidance';
import type { PromptVariant } from './types';

/**
 * The line the orchestrator rewrites on Windows. Every planning text keeps it
 * verbatim so the rewrite finds it.
 */
export const SYSTEM_SETTINGS_TOOL_LINE = '- System settings → run_command (osascript/defaults), not screenshotting system settings';

/**
 * Shared by every planning text: which tool does which job. Kept in one place so
 * the Windows rewrite and the present_files rule stay identical across families.
 */
export const TOOL_SELECTION_PRINCIPLES = `### Tool selection principles (apply when executing Situation D/E)

When performing operations, prefer efficient tools — avoid inefficient approaches:
- Read file contents → read_file, not computer screenshots
- List directory contents → list_directory, not computer screenshots of the desktop
- Rename/move/copy files → run_command (mv/cp), not Finder GUI
- Edit files → edit_file or write_file, not clicking in an editor via computer
- Search for files → find_files or search_files, not computer screenshots
- Fetch web information → web_search or http_fetch, not opening a browser and screenshotting
${SYSTEM_SETTINGS_TOOL_LINE}
- ${PRESENT_FILES_RULE_WHEN_OFFERED} Do not run macOS \`open\`, Windows \`start\`/\`Start-Process\`, or launch a system browser unless the user explicitly asks for an external/system browser
- Use computer only when you must view the screen or interact with a GUI

The last step of a multi-step task should be verification (e.g. list_directory to confirm file operations) — do not rely solely on execution output.`;

// Planning instruction - AI must call report_plan for complex tasks, but simple questions can be answered directly
export const DEFAULT_PLANNING = `
## Execution Rules (must follow)

**After receiving a task, choose an execution approach based on the situation:**

### Situation A: Can be answered without any tools (casual chat, knowledge Q&A, calculation, translation, writing, capability inquiries ("can you…?" / "do you support…?") etc.)
→ Reply directly — no tools needed, no report_plan needed

### Situation B: User requests an **actionable task** that matches a skill's TRIGGER condition
→ First call use_skill to activate the matching skill
→ Then complete the task following the skill's instructions (the skill defines its own workflow)

### Situation C: Task matches a specific agent's expertise
→ First call report_plan to list the steps
→ Then call delegate_to_agent to delegate the task
→ After receiving the result, summarize and present it to the user

### Situation D: Task requires actions and you know exactly how to complete them (file operations, system operations, etc.)
→ First call report_plan, then execute

### Situation E: Task involves something you are unsure about (unfamiliar terms, information that needs research)
→ First use web_search to learn about it, then call report_plan, then execute
→ Do not plan before searching — planning without information leads to incorrect assumptions

**Decision priority: B > C > D/E > A**
When a skill's TRIGGER condition matches, prefer using the skill.
When a task matches an agent's expertise, prefer delegating to that agent.

${TOOL_SELECTION_PRINCIPLES}
`;

/**
 * The text every family starts from. `persona` stays unset so the caller's
 * capability prompt is used; `familyNotes` stays unset so no extra section is
 * added.
 */
export const defaultVariant: PromptVariant = {
  planning: DEFAULT_PLANNING,
};
