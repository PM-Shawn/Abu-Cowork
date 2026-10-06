import { useMemo, useCallback, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import ProjectItem from './ProjectItem';
import { projectCreateProps, useProjectRowFocus } from './projectRowFocus';
import ProjectSettingsDialog from '@/components/common/ProjectSettingsDialog';

// The create project window belongs to the sidebar: a created project turns the sidebar to
// the file tree, which takes this section off the page.
export default function ProjectsSection({ onCreateProject }: { onCreateProject: () => void }) {
  const { t } = useI18n();
  const projectsMap = useProjectStore((s) => s.projects);
  const restoreProject = useProjectStore((s) => s.restoreProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const expandedIds = useProjectStore((s) => s.expandedProjectIds);
  const touchProject = useProjectStore((s) => s.touchProject);

  // Derive active/archived from raw map to avoid selector returning new array each time
  const projects = useMemo(() =>
    Object.values(projectsMap)
      .filter((p) => !p.archived)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.lastActiveAt - a.lastActiveAt;
      }),
    [projectsMap]
  );
  const archivedProjects = useMemo(() =>
    Object.values(projectsMap)
      .filter((p) => p.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [projectsMap]
  );
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const setViewMode = useSettingsStore((s) => s.setViewMode);

  // Dialog state
  // A row whose project is archived or deleted from its own menu hands the focus to a neighbour.
  const noteRowLeaving = useProjectRowFocus();
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sectionCollapsed, setSectionCollapsed] = useState(false);

  // Group conversations by projectId using lightweight index
  const projectConversations = useMemo(() => {
    const map: Record<string, typeof conversationIndex[string][]> = {};
    for (const conv of Object.values(conversationIndex)) {
      if (conv.projectId) {
        if (!map[conv.projectId]) map[conv.projectId] = [];
        map[conv.projectId].push(conv);
      }
    }
    // Sort each group by createdAt desc
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => b.createdAt - a.createdAt);
    }
    return map;
  }, [conversationIndex]);

  // Create new task within a project
  const handleNewTask = useCallback((projectId: string) => {
    const project = useProjectStore.getState().projects[projectId];
    if (!project) return;

    // Create conversation with inherited config
    const convId = useChatStore.getState().createConversation(project.workspacePath, { projectId });

    // Apply default skills/MCP if configured
    if (project.defaultSkills?.length || project.defaultMCPServers?.length) {
      useChatStore.setState((state) => {
        const conv = state.conversations[convId];
        if (conv) {
          if (project.defaultSkills?.length) conv.activeSkills = [...project.defaultSkills];
          if (project.defaultSkillArgs) conv.activeSkillArgs = { ...project.defaultSkillArgs };
          if (project.defaultMCPServers?.length) conv.enabledMCPServers = [...project.defaultMCPServers];
        }
      });
    }

    useWorkspaceStore.getState().setWorkspace(project.workspacePath);

    // Auto-expand project
    const { expandedProjectIds, toggleExpanded } = useProjectStore.getState();
    if (!expandedProjectIds.includes(projectId)) {
      toggleExpanded(projectId);
    }

    touchProject(projectId);
    setViewMode('chat');
  }, [touchProject, setViewMode]);

  return (
    <>
      <div className="px-4 pb-1">
        {/* Section header */}
        <div className="group/header flex h-7 items-center justify-between pr-2">
          <Button
            variant="plain"
            size="sm"
            onClick={() => setSectionCollapsed(!sectionCollapsed)}
            className="text-label-tertiary hover:text-label"
          >
            {t.project.sectionTitle}
          </Button>
          <IconButton
            icon={AppIcons.add}
            label={t.project.createProject}
            size="sm"
            onClick={onCreateProject}
            className="opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
            {...projectCreateProps}
          />
        </div>

        {/* Project list */}
        {!sectionCollapsed && projects.length > 0 ? (
          <div className="space-y-1">
            {projects.map((project) => (
              <ProjectItem
                key={project.id}
                project={project}
                conversations={projectConversations[project.id] || []}
                expanded={expandedIds.includes(project.id)}
                onNewTask={handleNewTask}
                onOpenSettings={(id) => setSettingsProjectId(id)}
                onLeaving={noteRowLeaving}
              />
            ))}
          </div>
        ) : !sectionCollapsed ? (
          <Button
            variant="plain"
            size="sm"
            onClick={onCreateProject}
            className="w-full justify-start font-normal text-label-tertiary hover:text-label"
          >
            + {t.project.emptyState}
          </Button>
        ) : null}

        {/* Archived projects */}
        {!sectionCollapsed && archivedProjects.length > 0 && (
          <div className="mt-1">
            <Button
              variant="plain"
              size="sm"
              onClick={() => setShowArchived(!showArchived)}
              className="font-normal text-label-tertiary hover:text-label-secondary"
            >
              {format(t.project.archivedCount, { count: String(archivedProjects.length) })}
            </Button>
            {showArchived && (
              <div className="mt-1 space-y-1">
                {archivedProjects.map((p) => (
                  <div key={p.id} className="flex h-6 items-center gap-2 px-2 text-ui-sm text-label-tertiary">
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <Icon icon={AppIcons.folder} size="sm" />
                      <span className="truncate">{p.name}</span>
                    </span>
                    <Button variant="plain" size="sm" onClick={() => restoreProject(p.id)} className="text-link">
                      {t.project.restore}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        // Unlink conversations then delete
                        const convs = Object.values(conversationIndex).filter(c => c.projectId === p.id);
                        const setProj = useChatStore.getState().setConversationProject;
                        for (const c of convs) setProj(c.id, undefined);
                        deleteProject(p.id);
                      }}
                    >
                      {t.project.delete}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Project Settings Dialog */}
      <ProjectSettingsDialog
        open={settingsProjectId !== null}
        onClose={() => setSettingsProjectId(null)}
        projectId={settingsProjectId}
      />
    </>
  );
}
