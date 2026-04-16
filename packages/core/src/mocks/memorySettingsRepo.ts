import type {
  SettingsRepo,
  SettingsSnapshot,
  UserPreferences,
} from '../ports/repos/settings';
import type {
  ProviderInstance,
  ActiveModel,
  AuxiliaryServices,
} from '../../../../src/types/provider';

const defaultPreferences: UserPreferences = {
  language: 'zh',
  permissionMode: 'normal',
  enabledMCPServers: [],
  autoUpdateCheck: true,
};

const defaultAuxiliary: AuxiliaryServices = {};

export class MemorySettingsRepo implements SettingsRepo {
  private snapshot: SettingsSnapshot;
  private initialized = false;

  constructor(initial?: Partial<SettingsSnapshot>) {
    this.snapshot = {
      providers: initial?.providers ?? [],
      activeModel: initial?.activeModel ?? null,
      auxiliary: initial?.auxiliary ?? defaultAuxiliary,
      preferences: { ...defaultPreferences, ...(initial?.preferences ?? {}) },
    };
  }

  async init(): Promise<void> {
    this.initialized = true;
  }

  private assertInit() {
    if (!this.initialized) {
      throw new Error('SettingsRepo.init() must be called before sync reads');
    }
  }

  getSnapshot() {
    this.assertInit();
    return this.snapshot;
  }
  getProviders() {
    this.assertInit();
    return this.snapshot.providers;
  }
  getProvider(id: string) {
    this.assertInit();
    return this.snapshot.providers.find((p) => p.id === id);
  }
  getActiveModel() {
    this.assertInit();
    return this.snapshot.activeModel;
  }
  getAuxiliary() {
    this.assertInit();
    return this.snapshot.auxiliary;
  }
  getPreferences() {
    this.assertInit();
    return this.snapshot.preferences;
  }

  async updateProvider(id: string, patch: Partial<ProviderInstance>) {
    const idx = this.snapshot.providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`Provider not found: ${id}`);
    this.snapshot.providers[idx] = { ...this.snapshot.providers[idx], ...patch };
  }
  async addProvider(p: ProviderInstance) {
    this.snapshot.providers.push(p);
  }
  async removeProvider(id: string) {
    this.snapshot.providers = this.snapshot.providers.filter((p) => p.id !== id);
  }
  async setActiveModel(am: ActiveModel | null) {
    this.snapshot.activeModel = am;
  }
  async updateAuxiliary(patch: Partial<AuxiliaryServices>) {
    this.snapshot.auxiliary = { ...this.snapshot.auxiliary, ...patch };
  }
  async updatePreferences(patch: Partial<UserPreferences>) {
    this.snapshot.preferences = { ...this.snapshot.preferences, ...patch };
  }
}
