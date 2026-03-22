import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { Project } from '../types/project';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// --- Store types ---

interface ProjectState {
  projects: Record<string, Project>;
  /** Sidebar expanded state (ephemeral, not persisted) */
  expandedProjectIds: string[];
}

interface ProjectActions {
  // CRUD
  createProject: (data: Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'lastActiveAt' | 'pinned' | 'archived'>) => string;
  updateProject: (id: string, data: Partial<Pick<Project, 'name' | 'description' | 'icon' | 'defaultSkills' | 'defaultSkillArgs' | 'defaultMCPServers' | 'modelOverride'>>) => void;
  deleteProject: (id: string) => void;
  archiveProject: (id: string) => void;
  restoreProject: (id: string) => void;

  // Organization
  togglePin: (id: string) => void;
  /** Update lastActiveAt (call when a conversation in this project is active) */
  touchProject: (id: string) => void;
  toggleExpanded: (id: string) => void;

  // Queries
  getProjectByWorkspace: (workspacePath: string) => Project | undefined;
  /** Active (non-archived) projects sorted by pinned → lastActiveAt desc */
  getActiveProjects: () => Project[];
  getArchivedProjects: () => Project[];
}

export type ProjectStore = ProjectState & ProjectActions;

export const useProjectStore = create<ProjectStore>()(
  persist(
    immer((set, get) => ({
      projects: {},
      expandedProjectIds: [],

      // --- CRUD ---

      createProject: (data) => {
        // Enforce unique workspacePath
        const existing = get().getProjectByWorkspace(data.workspacePath);
        if (existing) {
          return existing.id;
        }

        const id = generateId();
        const now = Date.now();
        set((state) => {
          state.projects[id] = {
            ...data,
            id,
            pinned: false,
            archived: false,
            createdAt: now,
            updatedAt: now,
            lastActiveAt: now,
          };
          // Auto-expand newly created project
          if (!state.expandedProjectIds.includes(id)) {
            state.expandedProjectIds.push(id);
          }
        });
        return id;
      },

      updateProject: (id, data) => {
        set((state) => {
          const project = state.projects[id];
          if (project) {
            Object.assign(project, data, { updatedAt: Date.now() });
          }
        });
      },

      deleteProject: (id) => {
        set((state) => {
          delete state.projects[id];
          state.expandedProjectIds = state.expandedProjectIds.filter(eid => eid !== id);
        });
      },

      archiveProject: (id) => {
        set((state) => {
          const project = state.projects[id];
          if (project) {
            project.archived = true;
            project.updatedAt = Date.now();
          }
        });
      },

      restoreProject: (id) => {
        set((state) => {
          const project = state.projects[id];
          if (project) {
            project.archived = false;
            project.updatedAt = Date.now();
          }
        });
      },

      // --- Organization ---

      togglePin: (id) => {
        set((state) => {
          const project = state.projects[id];
          if (project) {
            project.pinned = !project.pinned;
            project.updatedAt = Date.now();
          }
        });
      },

      touchProject: (id) => {
        set((state) => {
          const project = state.projects[id];
          if (project) {
            project.lastActiveAt = Date.now();
          }
        });
      },

      toggleExpanded: (id) => {
        set((state) => {
          const idx = state.expandedProjectIds.indexOf(id);
          if (idx >= 0) {
            state.expandedProjectIds.splice(idx, 1);
          } else {
            state.expandedProjectIds.push(id);
          }
        });
      },

      // --- Queries ---

      getProjectByWorkspace: (workspacePath) => {
        const projects = get().projects;
        return Object.values(projects).find(p => p.workspacePath === workspacePath);
      },

      getActiveProjects: () => {
        const projects = Object.values(get().projects).filter(p => !p.archived);
        // Sort: pinned first, then by lastActiveAt descending
        return projects.sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.lastActiveAt - a.lastActiveAt;
        });
      },

      getArchivedProjects: () => {
        return Object.values(get().projects)
          .filter(p => p.archived)
          .sort((a, b) => b.updatedAt - a.updatedAt);
      },
    })),
    {
      name: 'abu-projects',
      version: 1,
      partialize: (state) => ({
        projects: state.projects,
        // expandedProjectIds is ephemeral — not persisted
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Reset ephemeral fields
          state.expandedProjectIds = [];
        }
      },
    },
  ),
);
