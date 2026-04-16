import type { Skill, SkillRepo, SkillSource } from '../ports/repos/skill';

interface SkillEntry {
  skill: Skill;
  manifest: string;
  assets: Map<string, Uint8Array>;
}

export class MemorySkillRepo implements SkillRepo {
  private entries = new Map<string, SkillEntry>();

  /** 测试辅助：直接注入一个技能 */
  inject(skill: Skill, manifest = '', assets: Record<string, Uint8Array> = {}): this {
    this.entries.set(skill.id, {
      skill,
      manifest,
      assets: new Map(Object.entries(assets)),
    });
    return this;
  }

  async list() {
    return [...this.entries.values()].map((e) => e.skill);
  }

  async get(id: string) {
    return this.entries.get(id)?.skill ?? null;
  }

  async getByName(name: string) {
    for (const e of this.entries.values()) if (e.skill.name === name) return e.skill;
    return null;
  }

  async install(pkg: string, source: Exclude<SkillSource, 'builtin'>) {
    const id = `skill_${pkg}_${Date.now()}`;
    const skill: Skill = {
      id,
      name: pkg,
      description: `Mock installed skill: ${pkg}`,
      version: '0.0.0',
      source,
      manifestPath: `/mock/skills/${id}/SKILL.md`,
      enabled: true,
      installedAt: Date.now(),
    };
    this.entries.set(id, { skill, manifest: '', assets: new Map() });
    return skill;
  }

  async uninstall(id: string) {
    this.entries.delete(id);
  }

  async setEnabled(id: string, enabled: boolean) {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Skill not found: ${id}`);
    e.skill.enabled = enabled;
  }

  async readManifest(id: string) {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Skill not found: ${id}`);
    return e.manifest;
  }

  async readAsset(id: string, relPath: string) {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Skill not found: ${id}`);
    const asset = e.assets.get(relPath);
    if (!asset) throw new Error(`Asset not found: ${id}/${relPath}`);
    return asset;
  }
}
