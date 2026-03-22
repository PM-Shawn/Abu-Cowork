// Path safety checks are now handled centrally in registry.ts executeAnyTool
import { toolRegistry } from './registry';

// --- File tools ---
import { readFileTool, writeFileTool, editFileTool, listDirectoryTool, searchFilesTool, findFilesTool } from './definitions/fileTools';

// --- Command tools ---
import { runCommandTool } from './definitions/commandTools';

// --- Agent tools ---
import { useSkillTool, delegateToAgentTool, readSkillFileTool, saveSkillTool, saveAgentTool, requestWorkspaceTool } from './definitions/agentTools';
export { clearAllSkillHooks } from './definitions/agentTools';

// --- Automation tools ---
import { manageScheduledTaskTool, manageTriggerTool, manageFileWatchTool } from './definitions/automationTools';

// --- Media tools ---
import { generateImageTool, processImageTool } from './definitions/mediaTools';

// --- Web tools ---
import { webSearchTool, httpFetchTool } from './definitions/webTools';

// --- Memory tools ---
import { reportPlanTool, updateMemoryTool, todoWriteTool, logTaskCompletionTool } from './definitions/memoryTools';
import { recallTool } from './definitions/recallTool';

// --- System tools ---
import { getSystemInfoTool, clipboardReadTool, clipboardWriteTool, systemNotifyTool, manageMCPServerTool } from './definitions/systemTools';

// --- Skill eval tools ---
import { testSkillTriggerTool, improveSkillDescriptionTool } from './definitions/skillEvalTools';

// --- Computer tools ---
import { computerTool } from './definitions/computerTools';
export { setComputerUseBatchMode, setSkipAutoScreenshot } from './definitions/computerTools';

export function registerBuiltinTools(): void {
  toolRegistry.register(getSystemInfoTool);
  toolRegistry.register(readFileTool);
  toolRegistry.register(writeFileTool);
  toolRegistry.register(editFileTool);
  toolRegistry.register(listDirectoryTool);
  toolRegistry.register(runCommandTool);
  toolRegistry.register(searchFilesTool);
  toolRegistry.register(findFilesTool);
  toolRegistry.register(useSkillTool);
  toolRegistry.register(readSkillFileTool);
  toolRegistry.register(reportPlanTool);
  toolRegistry.register(generateImageTool);
  toolRegistry.register(processImageTool);
  toolRegistry.register(httpFetchTool);
  toolRegistry.register(webSearchTool);
  toolRegistry.register(delegateToAgentTool);
  toolRegistry.register(updateMemoryTool);
  toolRegistry.register(recallTool);
  toolRegistry.register(todoWriteTool);
  toolRegistry.register(manageScheduledTaskTool);
  toolRegistry.register(manageTriggerTool);
  toolRegistry.register(saveSkillTool);
  toolRegistry.register(saveAgentTool);
  toolRegistry.register(logTaskCompletionTool);
  toolRegistry.register(manageMCPServerTool);
  toolRegistry.register(manageFileWatchTool);
  toolRegistry.register(clipboardReadTool);
  toolRegistry.register(clipboardWriteTool);
  toolRegistry.register(systemNotifyTool);
  toolRegistry.register(computerTool);
  toolRegistry.register(requestWorkspaceTool);
  toolRegistry.register(testSkillTriggerTool);
  toolRegistry.register(improveSkillDescriptionTool);
}
