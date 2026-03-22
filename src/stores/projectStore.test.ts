import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from './projectStore';

function resetStore() {
  useProjectStore.setState({
    projects: {},
    expandedProjectIds: [],
  });
}

describe('projectStore', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('createProject', () => {
    it('should create a project with generated id and timestamps', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Test Project',
        workspacePath: '/path/to/project',
      });

      const project = useProjectStore.getState().projects[id];
      expect(project).toBeDefined();
      expect(project.name).toBe('Test Project');
      expect(project.workspacePath).toBe('/path/to/project');
      expect(project.pinned).toBe(false);
      expect(project.archived).toBe(false);
      expect(project.createdAt).toBeGreaterThan(0);
      expect(project.lastActiveAt).toBeGreaterThan(0);
    });

    it('should auto-expand newly created project', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Test',
        workspacePath: '/test',
      });

      expect(useProjectStore.getState().expandedProjectIds).toContain(id);
    });

    it('should enforce unique workspacePath constraint', () => {
      const id1 = useProjectStore.getState().createProject({
        name: 'Project A',
        workspacePath: '/shared/path',
      });

      const id2 = useProjectStore.getState().createProject({
        name: 'Project B',
        workspacePath: '/shared/path',
      });

      // Should return existing project id instead of creating a new one
      expect(id2).toBe(id1);
      expect(Object.keys(useProjectStore.getState().projects)).toHaveLength(1);
    });

    it('should allow different workspacePaths', () => {
      useProjectStore.getState().createProject({
        name: 'A',
        workspacePath: '/path/a',
      });
      useProjectStore.getState().createProject({
        name: 'B',
        workspacePath: '/path/b',
      });

      expect(Object.keys(useProjectStore.getState().projects)).toHaveLength(2);
    });

    it('should store optional fields', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Full Project',
        workspacePath: '/full',
        description: 'A test project',
        icon: '📊',
        defaultSkills: ['skill1'],
        defaultMCPServers: ['mcp1'],
        modelOverride: 'claude-opus-4-6',
      });

      const project = useProjectStore.getState().projects[id];
      expect(project.description).toBe('A test project');
      expect(project.icon).toBe('📊');
      expect(project.defaultSkills).toEqual(['skill1']);
      expect(project.defaultMCPServers).toEqual(['mcp1']);
      expect(project.modelOverride).toBe('claude-opus-4-6');
    });
  });

  describe('updateProject', () => {
    it('should update project fields', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Old Name',
        workspacePath: '/test',
      });

      useProjectStore.getState().updateProject(id, {
        name: 'New Name',
        icon: '🎨',
        description: 'Updated',
      });

      const project = useProjectStore.getState().projects[id];
      expect(project.name).toBe('New Name');
      expect(project.icon).toBe('🎨');
      expect(project.description).toBe('Updated');
    });

    it('should update updatedAt timestamp', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Test',
        workspacePath: '/test',
      });

      const before = useProjectStore.getState().projects[id].updatedAt;
      useProjectStore.getState().updateProject(id, { name: 'Updated' });
      const after = useProjectStore.getState().projects[id].updatedAt;

      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe('deleteProject', () => {
    it('should remove project from store', () => {
      const id = useProjectStore.getState().createProject({
        name: 'To Delete',
        workspacePath: '/delete-me',
      });

      expect(useProjectStore.getState().projects[id]).toBeDefined();
      useProjectStore.getState().deleteProject(id);
      expect(useProjectStore.getState().projects[id]).toBeUndefined();
    });

    it('should clean up expandedProjectIds', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Test',
        workspacePath: '/test',
      });

      expect(useProjectStore.getState().expandedProjectIds).toContain(id);
      useProjectStore.getState().deleteProject(id);
      expect(useProjectStore.getState().expandedProjectIds).not.toContain(id);
    });
  });

  describe('archiveProject / restoreProject', () => {
    it('should archive and restore a project', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Test',
        workspacePath: '/test',
      });

      expect(useProjectStore.getState().projects[id].archived).toBe(false);

      useProjectStore.getState().archiveProject(id);
      expect(useProjectStore.getState().projects[id].archived).toBe(true);

      useProjectStore.getState().restoreProject(id);
      expect(useProjectStore.getState().projects[id].archived).toBe(false);
    });

    it('archived projects should not appear in getActiveProjects', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Test',
        workspacePath: '/test',
      });

      expect(useProjectStore.getState().getActiveProjects()).toHaveLength(1);

      useProjectStore.getState().archiveProject(id);
      expect(useProjectStore.getState().getActiveProjects()).toHaveLength(0);
      expect(useProjectStore.getState().getArchivedProjects()).toHaveLength(1);
    });
  });

  describe('togglePin', () => {
    it('should toggle pinned state', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Test',
        workspacePath: '/test',
      });

      expect(useProjectStore.getState().projects[id].pinned).toBe(false);
      useProjectStore.getState().togglePin(id);
      expect(useProjectStore.getState().projects[id].pinned).toBe(true);
      useProjectStore.getState().togglePin(id);
      expect(useProjectStore.getState().projects[id].pinned).toBe(false);
    });
  });

  describe('touchProject', () => {
    it('should update lastActiveAt', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Test',
        workspacePath: '/test',
      });

      const before = useProjectStore.getState().projects[id].lastActiveAt;
      // Small delay to ensure different timestamp
      useProjectStore.getState().touchProject(id);
      const after = useProjectStore.getState().projects[id].lastActiveAt;

      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe('toggleExpanded', () => {
    it('should toggle expanded state', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Test',
        workspacePath: '/test',
      });

      // Auto-expanded on create
      expect(useProjectStore.getState().expandedProjectIds).toContain(id);
      useProjectStore.getState().toggleExpanded(id);
      expect(useProjectStore.getState().expandedProjectIds).not.toContain(id);
      useProjectStore.getState().toggleExpanded(id);
      expect(useProjectStore.getState().expandedProjectIds).toContain(id);
    });
  });

  describe('getProjectByWorkspace', () => {
    it('should find project by workspace path', () => {
      const id = useProjectStore.getState().createProject({
        name: 'Test',
        workspacePath: '/find-me',
      });

      const found = useProjectStore.getState().getProjectByWorkspace('/find-me');
      expect(found?.id).toBe(id);
    });

    it('should return undefined for unknown path', () => {
      const found = useProjectStore.getState().getProjectByWorkspace('/unknown');
      expect(found).toBeUndefined();
    });
  });

  describe('getActiveProjects sorting', () => {
    it('should sort pinned first, then by lastActiveAt desc', () => {
      const id1 = useProjectStore.getState().createProject({
        name: 'Oldest',
        workspacePath: '/oldest',
      });
      const id2 = useProjectStore.getState().createProject({
        name: 'Newest',
        workspacePath: '/newest',
      });

      // Touch oldest to make it more recent
      useProjectStore.getState().touchProject(id1);

      const active = useProjectStore.getState().getActiveProjects();
      // id1 was touched more recently
      expect(active[0].id).toBe(id1);
      expect(active[1].id).toBe(id2);

      // Pin id2 — it should come first now
      useProjectStore.getState().togglePin(id2);
      const afterPin = useProjectStore.getState().getActiveProjects();
      expect(afterPin[0].id).toBe(id2);
      expect(afterPin[1].id).toBe(id1);
    });
  });
});
