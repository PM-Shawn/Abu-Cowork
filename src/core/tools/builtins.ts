// Path safety checks are now handled centrally in registry.ts executeAnyTool
import { toolRegistry } from './registry';

// --- File tools ---
import { readFileTool, writeFileTool, editFileTool, deleteFileTool, listDirectoryTool, searchFilesTool, findFilesTool } from './definitions/fileTools';

// --- Command tools ---
import { runCommandTool } from './definitions/commandTools';

// --- Agent tools ---
// save_skill was deprecated in favor of skill_manage (Module E self-evolution).
// save_agent is kept — no equivalent agent_manage yet.
import { useSkillTool, delegateToAgentTool, readSkillFileTool, saveAgentTool, requestWorkspaceTool } from './definitions/agentTools';
export { clearAllSkillHooks, clearSkillHooksByConversation } from './definitions/agentTools';

// --- Automation tools ---
import { manageScheduledTaskTool, manageTriggerTool, manageFileWatchTool } from './definitions/automationTools';

// --- Media tools ---
import { generateImageTool, processImageTool } from './definitions/mediaTools';

// --- Widget tools (inline visualization) ---
import { showWidgetTool, readMeTool } from './definitions/widgetTools';

// --- Web tools ---
import { webSearchTool, httpFetchTool } from './definitions/webTools';

// --- Memory tools ---
import { reportPlanTool, updateMemoryTool, logTaskCompletionTool } from './definitions/memoryTools';
import { recallTool, readMemoryTool } from './definitions/recallTool';
import { updateSoulTool } from './definitions/updateSoulTool';

// --- System tools ---
import { getSystemInfoTool, clipboardReadTool, clipboardWriteTool, systemNotifyTool, manageMCPServerTool } from './definitions/systemTools';

// --- Skill eval tools ---
import { testSkillTriggerTool, improveSkillDescriptionTool } from './definitions/skillEvalTools';
import { skillViewTool } from './definitions/skillViewTools';
import { skillManageTool } from './definitions/skillManageTool';

// --- Tool discovery ---
import { toolSearchTool } from './definitions/toolSearchTool';

// --- Todo tools ---
import { createTodoTool } from './definitions/todoTools';

// --- Orchestration tools ---
import { runAgentBatchTool } from './definitions/orchestrationTools';

// --- Computer tools ---
import { askUserQuestionTool } from './definitions/askUserQuestionTool';
import { computerTool } from './definitions/computerTools';
export { setComputerUseBatchMode, setSkipAutoScreenshot } from './definitions/computerTools';

export function registerBuiltinTools(): void {
  toolRegistry.register(getSystemInfoTool);
  toolRegistry.register(readFileTool);
  toolRegistry.register(writeFileTool);
  toolRegistry.register(editFileTool);
  toolRegistry.register(deleteFileTool);
  toolRegistry.register(listDirectoryTool);
  toolRegistry.register(runCommandTool);
  toolRegistry.register(searchFilesTool);
  toolRegistry.register(findFilesTool);
  toolRegistry.register(useSkillTool);
  toolRegistry.register(readSkillFileTool);
  toolRegistry.register(reportPlanTool);
  toolRegistry.register(generateImageTool);
  toolRegistry.register(processImageTool);
  toolRegistry.register(showWidgetTool);
  toolRegistry.register(readMeTool);
  toolRegistry.register(httpFetchTool);
  toolRegistry.register(webSearchTool);
  toolRegistry.register(delegateToAgentTool);
  toolRegistry.register(updateMemoryTool);
  toolRegistry.register(updateSoulTool);
  toolRegistry.register(recallTool);
  toolRegistry.register(readMemoryTool);
  toolRegistry.register(manageScheduledTaskTool);
  toolRegistry.register(manageTriggerTool);
  toolRegistry.register(saveAgentTool);
  toolRegistry.register(logTaskCompletionTool);
  toolRegistry.register(manageMCPServerTool);
  toolRegistry.register(manageFileWatchTool);
  toolRegistry.register(clipboardReadTool);
  toolRegistry.register(clipboardWriteTool);
  toolRegistry.register(systemNotifyTool);
  toolRegistry.register(computerTool);
  toolRegistry.register(requestWorkspaceTool);
  toolRegistry.register(askUserQuestionTool);
  toolRegistry.register(testSkillTriggerTool);
  toolRegistry.register(improveSkillDescriptionTool);
  toolRegistry.register(skillViewTool);
  toolRegistry.register(skillManageTool);
  toolRegistry.register(toolSearchTool);
  // create_todo feeds the Inbox. Registered unconditionally; getAllTools()
  // filters it out of the per-request schema when the 'todos-inbox' Labs flag
  // is off, so toggling the flag takes effect without an app restart.
  toolRegistry.register(createTodoTool);
  toolRegistry.register(runAgentBatchTool);
}
