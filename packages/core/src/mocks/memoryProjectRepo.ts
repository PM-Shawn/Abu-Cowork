import type {
  Project,
  ProjectRepo,
  ProjectRules,
} from '../ports/repos/project';

function genId(): string {
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class MemoryProjectRepo implements ProjectRepo {
  private projects = new Map<string, Project>();
  private rules = new Map<string, ProjectRules>();

  async list() {
    return [...this.projects.values()];
  }
  async get(id: string) {
    return this.projects.get(id) ?? null;
  }
  async create(p: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>) {
    const now = Date.now();
    const full: Project = { ...p, id: genId(), createdAt: now, updatedAt: now };
    this.projects.set(full.id, full);
    return full;
  }
  async update(id: string, patch: Partial<Project>) {
    const cur = this.projects.get(id);
    if (!cur) throw new Error(`Project not found: ${id}`);
    this.projects.set(id, { ...cur, ...patch, id, updatedAt: Date.now() });
  }
  async delete(id: string) {
    this.projects.delete(id);
    this.rules.delete(id);
  }

  async getRules(projectId: string) {
    return this.rules.get(projectId) ?? null;
  }
  async saveRules(projectId: string, content: string) {
    this.rules.set(projectId, { projectId, content, updatedAt: Date.now() });
  }
}
