import type {
  ProviderInstance,
  ActiveModel,
  AuxiliaryServices,
} from '../../../../../src/types/provider';

/**
 * SettingsRepo —— 配置类数据（同步读 + 启动预加载）
 *
 * 理由：agent 主循环大量同步读配置（apiKey/model/temperature），
 * 全改 async 会污染成异步链。采用 init() 一次性装载 + 同步访问。
 */

export interface UserPreferences {
  language: 'zh' | 'en';
  permissionMode: 'strict' | 'normal' | 'bypass';
  enabledMCPServers?: string[];
  autoUpdateCheck?: boolean;
}

export interface SettingsSnapshot {
  providers: ProviderInstance[];
  activeModel: ActiveModel | null;
  auxiliary: AuxiliaryServices;
  preferences: UserPreferences;
}

export interface SettingsRepo {
  init(): Promise<void>;

  getSnapshot(): SettingsSnapshot;
  getProviders(): ProviderInstance[];
  getProvider(id: string): ProviderInstance | undefined;
  getActiveModel(): ActiveModel | null;
  getAuxiliary(): AuxiliaryServices;
  getPreferences(): UserPreferences;

  updateProvider(id: string, patch: Partial<ProviderInstance>): Promise<void>;
  addProvider(p: ProviderInstance): Promise<void>;
  removeProvider(id: string): Promise<void>;
  setActiveModel(am: ActiveModel | null): Promise<void>;
  updateAuxiliary(patch: Partial<AuxiliaryServices>): Promise<void>;
  updatePreferences(patch: Partial<UserPreferences>): Promise<void>;
}
