// Validation for a plugin package's `teams/*.json` files and `minAbuVersion`
// (developer spec §6, §11). Shared by the renderer installer, the Electron
// plugin hosts and `scripts/validate-plugin-market.mjs`, so a package that
// passes the marketplace check is exactly a package that installs.
import semver from 'semver';
import { BUILTIN_AGENT_NAMES } from './pluginAgentFormat.mjs';
import {
    assertUnique,
    fail,
    optionalString,
    parseLocalizedText,
    requireArray,
    requireObject,
    rejectUnknownKeys,
} from './specFields.mjs';

export { isPackageRelativePath, parseLocalizedText, resolveLocalizedText } from './specFields.mjs';

/**
 * The Abu version that introduced `teams/`. A package shipping teams names
 * this version or a later one in `minAbuVersion`: an older Abu does not read
 * `teams/`, so a lower number would send the package to installs that quietly
 * drop its teams.
 */
export const TEAMS_MIN_ABU_VERSION = '0.51.0';
export const BUILTIN_TEAM_ID_PREFIX = 'builtin-team:';
export const BUILTIN_AGENT_ROLE_PREFIX = 'builtin:';
export const PLUGIN_AGENT_ROLE_PREFIX = 'plugin:';

/** Ids of the teams that ship with Abu; `src/core/team/builtinTeams.ts` is pinned to this list by test. */
export const BUILTIN_TEAM_IDS = Object.freeze([
    'builtin-team:software-rd',
    'builtin-team:data-analysis',
    'builtin-team:content-creation',
    'builtin-team:reporting',
    'builtin-team:finance-reconciliation',
    'builtin-team:recruiting',
]);

export const TEAM_LIMITS = Object.freeze({
    leaderNote: 4000,
    expertise: 5,
    samplePrompts: 4,
    membersMin: 2,
    // An emoji or an `icon:<name>/<tint>` preset, the same values a user team's avatar takes.
    avatar: 32,
});

const TEAM_FILE_ID_RE = /^[a-z0-9-]+$/;

/**
 * Is `value` a team id a package may ship (spec §6)? The id becomes a file
 * name under the package's `teams/`, so every surface that turns a recorded id
 * back into a path asks this first.
 */
export function isPluginTeamFileId(value) {
    return typeof value === 'string' && TEAM_FILE_ID_RE.test(value);
}

function localizedList(value, field, max) {
    return requireArray(value, field, { max }).map((entry, index) => parseLocalizedText(entry, `${field}[${index}]`, { required: true }));
}

/** Resolve one expert reference (spec §6) to a role id. */
function resolveExpertReference(value, field, ctx) {
    if (typeof value !== 'string' || value.length === 0) fail('must be an expert name', field, 'type');
    if (value.startsWith(BUILTIN_AGENT_ROLE_PREFIX)) {
        const name = value.slice(BUILTIN_AGENT_ROLE_PREFIX.length);
        if (!BUILTIN_AGENT_NAMES.includes(name)) fail(`built-in expert "${name}" does not exist`, field, 'unknown-reference');
        return value;
    }
    if (!ctx.agentNames.has(value)) fail(`expert "${value}" is not in this package's agents/`, field, 'unknown-reference');
    return `${PLUGIN_AGENT_ROLE_PREFIX}${value}`;
}

/**
 * Validate one `teams/<id>.json` (spec §6). `ctx.agentNames` holds the names
 * of the package's own experts.
 */
export function parseTeamFile(raw, id, ctx) {
    const field = `teams.${id}`;
    if (typeof id !== 'string' || !TEAM_FILE_ID_RE.test(id)) fail(`team id must match ${TEAM_FILE_ID_RE}`, field, 'type');
    const team = requireObject(raw, field);
    rejectUnknownKeys(team, field, ['name', 'leader', 'members', 'leaderNote', 'requirePlanApproval', 'avatar', 'description', 'intro', 'expertise', 'samplePrompts']);
    const agentNames = new Set(ctx?.agentNames ?? []);
    const refCtx = { agentNames };
    const members = requireArray(team.members, `${field}.members`, { min: TEAM_LIMITS.membersMin });
    assertUnique(members, `${field}.members`, 'member');
    const memberRoleIds = members.map((member, index) => resolveExpertReference(member, `${field}.members[${index}]`, refCtx));
    if (team.leader === undefined) fail('is required', `${field}.leader`, 'missing');
    const leaderRoleId = resolveExpertReference(team.leader, `${field}.leader`, refCtx);
    if (!memberRoleIds.includes(leaderRoleId)) fail('leader must also be listed in members', `${field}.leader`, 'unknown-reference');
    if (team.requirePlanApproval !== undefined && typeof team.requirePlanApproval !== 'boolean') fail('must be a boolean', `${field}.requirePlanApproval`, 'type');
    return {
        id,
        name: parseLocalizedText(team.name, `${field}.name`, { required: true }),
        leaderRoleId,
        memberRoleIds,
        leaderNote: optionalString(team.leaderNote, `${field}.leaderNote`, TEAM_LIMITS.leaderNote),
        requirePlanApproval: team.requirePlanApproval === true,
        avatar: optionalString(team.avatar, `${field}.avatar`, TEAM_LIMITS.avatar),
        description: parseLocalizedText(team.description, `${field}.description`, { required: true }),
        intro: parseLocalizedText(team.intro, `${field}.intro`),
        expertise: localizedList(team.expertise, `${field}.expertise`, TEAM_LIMITS.expertise),
        samplePrompts: localizedList(team.samplePrompts, `${field}.samplePrompts`, TEAM_LIMITS.samplePrompts),
    };
}

/** Spec §11: `minAbuVersion`, when present, is a semantic version. */
export function validateMinAbuVersion(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || semver.valid(value) === null) fail('must be a semantic version such as 0.51.0', 'minAbuVersion', 'version');
    return value;
}

/** Throw unless `declared` is `minimum` or newer, judged by release (0.51.0-rc.1 counts as 0.51.0). */
export function assertMinAbuVersionAtLeast(declared, minimum, reason) {
    if (semver.lt(semver.coerce(declared) ?? declared, minimum)) {
        fail(`must be ${minimum} or newer: ${reason} arrived in Abu ${minimum}`, 'minAbuVersion', 'version');
    }
}

/** Spec §11: a package shipping `teams/` declares `minAbuVersion`, `TEAMS_MIN_ABU_VERSION` or newer. */
export function assertMinAbuVersionDeclared(manifest, { hasTeams = false } = {}) {
    if (!hasTeams) return;
    if (manifest.minAbuVersion === undefined) fail('is required when the package ships teams/', 'minAbuVersion', 'missing');
    assertMinAbuVersionAtLeast(validateMinAbuVersion(manifest.minAbuVersion), TEAMS_MIN_ABU_VERSION, 'teams/');
}

/** Does this Abu (`appVersion`) satisfy the package's `minAbuVersion`? */
export function checkMinAbuVersion(manifest, appVersion) {
    const required = validateMinAbuVersion(manifest.minAbuVersion);
    if (required === undefined) return { ok: true };
    if (semver.valid(appVersion) === null) fail(`host version "${appVersion}" is not a semantic version`, 'minAbuVersion', 'version');
    return { ok: semver.gte(appVersion, required), required };
}
