export interface Project {
  id: string;
  name: string;
  workspacePath: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRules {
  projectId: string;
  content: string;
  updatedAt: number;
}

export interface ProjectRepo {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(p: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Promise<Project>;
  update(id: string, patch: Partial<Project>): Promise<void>;
  delete(id: string): Promise<void>;

  getRules(projectId: string): Promise<ProjectRules | null>;
  saveRules(projectId: string, content: string): Promise<void>;
}
