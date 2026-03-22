import { useMemo, useCallback, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useI18n } from '@/i18n';
import { Plus, FolderClosed } from 'lucide-react';
import { format } from '@/i18n';
import ProjectItem from './ProjectItem';
import CreateProjectDialog from '@/components/common/CreateProjectDialog';
import ProjectSettingsDialog from '@/components/common/ProjectSettingsDialog';
import { suggestProjectGroupings, applyMigration } from '@/utils/projectMigration';

export default function ProjectsSection() {
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
  const conversations = useChatStore((s) => s.conversations);
  const setViewMode = useSettingsStore((s) => s.setViewMode);

  // Dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const [migrationDismissed, setMigrationDismissed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sectionCollapsed, setSectionCollapsed] = useState(false);

  // Check for migratable conversations
  const migrationGroups = useMemo(() => {
    if (migrationDismissed) return [];
    return suggestProjectGroupings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, migrationDismissed]);

  // Group conversations by projectId
  const projectConversations = useMemo(() => {
    const map: Record<string, typeof conversations[string][]> = {};
    for (const conv of Object.values(conversations)) {
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
  }, [conversations]);

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
        <div className="group/header flex items-center justify-between px-2 py-1.5">
          <button
            onClick={() => setSectionCollapsed(!sectionCollapsed)}
            className="flex items-center gap-1 text-[13px] font-medium text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
          >
            <span>{t.project.sectionTitle}</span>
          </button>
          <button
            onClick={() => setShowCreateDialog(true)}
            className="p-0.5 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors opacity-0 group-hover/header:opacity-100"
            title={t.project.createProject}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Project list */}
        {!sectionCollapsed && projects.length > 0 ? (
          <div className="space-y-0.5">
            {projects.map((project) => (
              <ProjectItem
                key={project.id}
                project={project}
                conversations={projectConversations[project.id] || []}
                expanded={expandedIds.includes(project.id)}
                onNewTask={handleNewTask}
                onOpenSettings={(id) => setSettingsProjectId(id)}
              />
            ))}
          </div>
        ) : !sectionCollapsed ? (
          <button
            onClick={() => setShowCreateDialog(true)}
            className="w-full px-2 py-2 text-[12px] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors text-left"
          >
            + {t.project.emptyState}
          </button>
        ) : null}

        {/* Migration banner */}
        {!sectionCollapsed && migrationGroups.length > 0 && (
          <div className="mx-2 mt-2 px-2.5 py-2 rounded-lg bg-[var(--abu-clay-bg)] text-[12px]">
            <p className="text-[var(--abu-clay)]">
              💡 {format(t.project.migrationBanner, { count: String(migrationGroups.length) })}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <button
                onClick={() => { applyMigration(migrationGroups); setMigrationDismissed(true); }}
                className="text-[var(--abu-clay)] font-medium hover:underline"
              >
                {t.project.migrationAction}
              </button>
              <button
                onClick={() => setMigrationDismissed(true)}
                className="text-[var(--abu-text-muted)] hover:text-[var(--abu-text-tertiary)]"
              >
                {t.project.migrationDismiss}
              </button>
            </div>
          </div>
        )}

        {/* Archived projects */}
        {!sectionCollapsed && archivedProjects.length > 0 && (
          <div className="px-2 mt-1">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="text-[11px] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-tertiary)] transition-colors"
            >
              {format(t.project.archivedCount, { count: String(archivedProjects.length) })}
            </button>
            {showArchived && (
              <div className="mt-1 space-y-0.5">
                {archivedProjects.map((p) => (
                  <div key={p.id} className="flex items-center gap-1.5 px-2 py-1 text-[12px] text-[var(--abu-text-muted)]">
                    <span className="truncate flex-1 flex items-center gap-1.5"><FolderClosed className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />{p.name}</span>
                    <button
                      onClick={() => restoreProject(p.id)}
                      className="shrink-0 text-[var(--abu-clay)] hover:underline"
                    >
                      {t.project.restore}
                    </button>
                    <button
                      onClick={() => {
                        // Unlink conversations then delete
                        const convs = Object.values(conversations).filter(c => c.projectId === p.id);
                        const setProj = useChatStore.getState().setConversationProject;
                        for (const c of convs) setProj(c.id, undefined);
                        deleteProject(p.id);
                      }}
                      className="shrink-0 text-red-400 hover:text-red-500 hover:underline"
                    >
                      {t.project.delete}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Project Dialog */}
      <CreateProjectDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
      />

      {/* Project Settings Dialog */}
      <ProjectSettingsDialog
        open={settingsProjectId !== null}
        onClose={() => setSettingsProjectId(null)}
        projectId={settingsProjectId}
      />
    </>
  );
}
