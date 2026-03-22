/**
 * Project Migration Utility
 *
 * Scans existing conversations for common workspacePaths and suggests
 * grouping them into projects. Used for the one-time migration banner
 * when the Projects feature is first introduced.
 */

import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { getBaseName } from '@/utils/pathUtils';

export interface MigrationGroup {
  workspacePath: string;
  folderName: string;
  conversationIds: string[];
}

/**
 * Scan all conversations without a projectId and group them by workspacePath.
 * Returns only groups with 2+ conversations (single conversation is not worth a project).
 */
export function suggestProjectGroupings(): MigrationGroup[] {
  const conversations = useChatStore.getState().conversations;
  const groups = new Map<string, string[]>();

  for (const conv of Object.values(conversations)) {
    if (conv.workspacePath && !conv.projectId && !conv.scheduledTaskId && !conv.triggerId) {
      const path = conv.workspacePath;
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path)!.push(conv.id);
    }
  }

  // Filter: only paths not already bound to a project, with 2+ conversations
  const result: MigrationGroup[] = [];
  for (const [path, ids] of groups) {
    if (ids.length < 2) continue;
    if (useProjectStore.getState().getProjectByWorkspace(path)) continue;
    result.push({
      workspacePath: path,
      folderName: getBaseName(path),
      conversationIds: ids,
    });
  }

  // Sort by conversation count desc
  result.sort((a, b) => b.conversationIds.length - a.conversationIds.length);
  return result;
}

/**
 * Create projects from migration groups and assign conversations.
 */
export function applyMigration(groups: MigrationGroup[]): void {
  const createProject = useProjectStore.getState().createProject;
  const setConversationProject = useChatStore.getState().setConversationProject;

  for (const group of groups) {
    const projectId = createProject({
      name: group.folderName,
      workspacePath: group.workspacePath,
    });

    for (const convId of group.conversationIds) {
      setConversationProject(convId, projectId);
    }
  }
}
