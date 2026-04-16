export type SkillSource = 'builtin' | 'npm' | 'local';

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  manifestPath: string;
  enabled: boolean;
  installedAt: number;
}

export interface SkillRepo {
  list(): Promise<Skill[]>;
  get(id: string): Promise<Skill | null>;
  getByName(name: string): Promise<Skill | null>;

  install(pkg: string, source: Exclude<SkillSource, 'builtin'>): Promise<Skill>;
  uninstall(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;

  /** 读技能清单文件（SKILL.md） */
  readManifest(id: string): Promise<string>;
  /** 读技能内资产（图标、脚本等） */
  readAsset(id: string, relPath: string): Promise<Uint8Array>;
}
