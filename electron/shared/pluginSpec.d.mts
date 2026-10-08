import type { ParsedPluginTeam } from '../../src/types/app';

export { isPackageRelativePath, parseLocalizedText, resolveLocalizedText } from './specFields.mjs';

export const TEAMS_MIN_ABU_VERSION: string;
export const BUILTIN_TEAM_ID_PREFIX: 'builtin-team:';
export const BUILTIN_AGENT_ROLE_PREFIX: 'builtin:';
export const PLUGIN_AGENT_ROLE_PREFIX: 'plugin:';
export const BUILTIN_TEAM_IDS: readonly string[];
export const TEAM_LIMITS: Readonly<{
  leaderNote: number;
  expertise: number;
  samplePrompts: number;
  membersMin: number;
  avatar: number;
}>;

export function isPluginTeamFileId(value: unknown): value is string;
export function parseTeamFile(raw: unknown, id: string, ctx: { agentNames?: Iterable<string> }): ParsedPluginTeam;
export function validateMinAbuVersion(value: unknown): string | undefined;
export function assertMinAbuVersionAtLeast(declared: string, minimum: string, reason: string): void;
export function assertMinAbuVersionDeclared(manifest: { minAbuVersion?: unknown }, options?: { hasTeams?: boolean }): void;
export function checkMinAbuVersion(manifest: { minAbuVersion?: unknown }, appVersion: string): { ok: boolean; required?: string };
