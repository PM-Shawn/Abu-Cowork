import type { AppConfig, AppLocale, LocalizedText, ParsedPluginTeam } from '../../src/types/app';

export const APP_CONFIG_VERSION: 1;
export const APP_SUPPORT_MIN_VERSION: string;
export const BUILTIN_TEAM_ID_PREFIX: 'builtin-team:';
export const BUILTIN_AGENT_ROLE_PREFIX: 'builtin:';
export const PLUGIN_AGENT_ROLE_PREFIX: 'plugin:';
export const APP_PAGE_TARGET_PREFIX: 'url:';
export const BUILTIN_TEAM_IDS: readonly string[];
export const APP_BUILTIN_NAV_TARGETS: readonly string[];
export const APP_LIMITS: Readonly<{
  promptAppend: number;
  leaderNote: number;
  templatesMin: number;
  templatesMax: number;
  expertise: number;
  samplePrompts: number;
  teamMembersMin: number;
  idLength: number;
  teamAvatar: number;
}>;

/** Names of what the package itself ships, for reference checks. */
export interface AppSpecContext {
  teamIds?: Iterable<string>;
  agentNames?: Iterable<string>;
  skillNames?: Iterable<string>;
  mcpServerNames?: Iterable<string>;
}

export function isPackageRelativePath(value: unknown): value is string;
export function parseLocalizedText(value: unknown, field: string, options: { required: true }): LocalizedText;
export function parseLocalizedText(value: unknown, field: string, options?: { required?: boolean }): LocalizedText | undefined;
export function resolveLocalizedText(text: LocalizedText | undefined, locale: AppLocale): string;
export function isPluginTeamFileId(value: unknown): value is string;
export function parseTeamFile(raw: unknown, id: string, ctx: Pick<AppSpecContext, 'agentNames'>): ParsedPluginTeam;
export function parseAppConfig(raw: unknown, ctx: AppSpecContext): AppConfig;
export function appPageUrl(target: unknown): string | undefined;
export function isAllowedAppPageOrigin(value: unknown): boolean;
export function resolveAppPageUrl(config: AppConfig, navItemId: string): string;
export function validateMinAbuVersion(value: unknown): string | undefined;
export function assertMinAbuVersionDeclared(manifest: { app?: unknown; minAbuVersion?: unknown }, options?: { hasTeams?: boolean }): void;
export function checkMinAbuVersion(manifest: { minAbuVersion?: unknown }, appVersion: string): { ok: boolean; required?: string };
