import type { AppConfig, AppRunRef, ParsedAppFile } from '../../src/types/app';

export const APP_FILE_PATH: '.abu-app/app.json';
export const APP_CONFIG_VERSION: 1;
export const APPS_MIN_ABU_VERSION: string;
export const APP_PAGE_TARGET_PREFIX: 'url:';
export const APP_BUILTIN_NAV_TARGETS: readonly string[];
export const APP_LIMITS: Readonly<{
  promptAppend: number;
  templatesMin: number;
  templatesMax: number;
  nameLength: number;
}>;

export type AppSource = 'package' | 'created' | 'enterprise';
export type RunTargetKind = 'team' | 'expert' | 'skill';
export type RunTargetOrigin = 'builtin' | 'plugin' | 'mine' | 'enterprise';

export const RUN_REF_PREFIXES: Readonly<{
  team: Readonly<Record<'builtin' | 'plugin' | 'mine' | 'enterprise', string>>;
  expert: Readonly<Record<'builtin' | 'plugin' | 'mine' | 'enterprise', string>>;
  skill: Readonly<Record<'plugin' | 'enterprise', string>>;
}>;

export type RunTarget =
  | { origin: 'builtin'; id: string }
  | { origin: 'plugin'; plugin: string; id: string }
  | { origin: 'mine'; id: string }
  | { origin: 'enterprise'; id: string };

export function splitRunTarget(kind: RunTargetKind, target: string): RunTarget | undefined;
export function isAllowedAppPageOrigin(value: unknown): boolean;
export function appPageUrl(target: unknown): string | undefined;
export function isAppName(value: unknown): value is string;
export function parseAppConfig(raw: Record<string, unknown>, ctx: { source: AppSource; plugins?: Iterable<string>; field?: string }): AppConfig;
export function parseAppFile(raw: unknown, options?: { source?: 'package' | 'created' }): ParsedAppFile;
export function resolveAppPageUrl(config: AppConfig, navItemId: string): string;
export function appRuns(config: AppConfig): Array<{ field: string; run: AppRunRef; modeId?: string; sceneId?: string }>;
