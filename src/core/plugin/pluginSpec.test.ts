import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEAM_IDS,
  TEAM_LIMITS,
  TEAMS_MIN_ABU_VERSION,
  assertMinAbuVersionDeclared,
  checkMinAbuVersion,
  isPackageRelativePath,
  parseLocalizedText,
  parseTeamFile,
  resolveLocalizedText,
  validateMinAbuVersion,
} from '../../../electron/shared/pluginSpec.mjs';
import { PluginManifestError } from '../../../electron/shared/pluginManifestError.mjs';

const ctx = { agentNames: ['sourcer', 'closer'] };

/** The field a failing parse reports, so a rule can be pinned by its path rather than its message. */
function failingField(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginManifestError);
    return (error as PluginManifestError).field;
  }
  throw new Error('expected a PluginManifestError');
}

describe('parseLocalizedText', () => {
  it('accepts a string and a per-locale object', () => {
    expect(parseLocalizedText('招聘', 'f', { required: true })).toBe('招聘');
    expect(parseLocalizedText({ 'zh-CN': '招聘', 'en-US': 'Hiring' }, 'f', { required: true })).toEqual({ 'zh-CN': '招聘', 'en-US': 'Hiring' });
  });

  it('rejects empty strings, unknown locales and empty objects', () => {
    expect(failingField(() => parseLocalizedText('  ', 'f'))).toBe('f');
    expect(failingField(() => parseLocalizedText({ fr: 'x' }, 'f'))).toBe('f.fr');
    expect(failingField(() => parseLocalizedText({}, 'f'))).toBe('f');
    expect(failingField(() => parseLocalizedText(undefined, 'f', { required: true }))).toBe('f');
  });

  it('resolves the requested locale, then zh-CN, then en-US', () => {
    expect(resolveLocalizedText({ 'en-US': 'Hiring' }, 'zh-CN')).toBe('Hiring');
    expect(resolveLocalizedText({ 'zh-CN': '招聘', 'en-US': 'Hiring' }, 'en-US')).toBe('Hiring');
    expect(resolveLocalizedText('plain', 'en-US')).toBe('plain');
    expect(resolveLocalizedText(undefined, 'en-US')).toBe('');
  });
});

describe('parseTeamFile', () => {
  const team = { name: '招聘小组', description: '从岗位到 offer', leader: 'sourcer', members: ['sourcer', 'builtin:HR 招聘官'] };

  it('resolves package experts to plugin: ids and built-ins to builtin: ids', () => {
    const parsed = parseTeamFile(team, 'hiring', ctx);
    expect(parsed).toMatchObject({
      id: 'hiring',
      leaderRoleId: 'plugin:sourcer',
      memberRoleIds: ['plugin:sourcer', 'builtin:HR 招聘官'],
      requirePlanApproval: false,
      expertise: [],
      samplePrompts: [],
    });
  });

  it('reports the exact field for every rule', () => {
    expect(failingField(() => parseTeamFile(team, 'Hiring', ctx))).toBe('teams.Hiring');
    expect(failingField(() => parseTeamFile({ ...team, members: ['sourcer'] }, 'hiring', ctx))).toBe('teams.hiring.members');
    expect(failingField(() => parseTeamFile({ ...team, members: ['sourcer', 'sourcer'] }, 'hiring', ctx))).toBe('teams.hiring.members[1]');
    expect(failingField(() => parseTeamFile({ ...team, members: ['sourcer', 'ghost'] }, 'hiring', ctx))).toBe('teams.hiring.members[1]');
    expect(failingField(() => parseTeamFile({ ...team, members: ['sourcer', 'builtin:不存在'] }, 'hiring', ctx))).toBe('teams.hiring.members[1]');
    expect(failingField(() => parseTeamFile({ ...team, leader: 'closer' }, 'hiring', ctx))).toBe('teams.hiring.leader');
    expect(failingField(() => parseTeamFile({ ...team, leaderNote: 'x'.repeat(TEAM_LIMITS.leaderNote + 1) }, 'hiring', ctx))).toBe('teams.hiring.leaderNote');
    expect(failingField(() => parseTeamFile({ ...team, expertise: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'hiring', ctx))).toBe('teams.hiring.expertise');
    expect(failingField(() => parseTeamFile({ ...team, avatar: 'x'.repeat(TEAM_LIMITS.avatar + 1) }, 'hiring', ctx))).toBe('teams.hiring.avatar');
    expect(parseTeamFile({ ...team, avatar: 'icon:chart-bar/teal' }, 'hiring', ctx).avatar).toBe('icon:chart-bar/teal');
    expect(failingField(() => parseTeamFile({ ...team, extra: 1 }, 'hiring', ctx))).toBe('teams.hiring.extra');
    expect(failingField(() => parseTeamFile({ ...team, description: undefined }, 'hiring', ctx))).toBe('teams.hiring.description');
  });
});

describe('isPackageRelativePath', () => {
  it('keeps asset paths inside the package', () => {
    expect(isPackageRelativePath('assets/logo.png')).toBe(true);
    expect(isPackageRelativePath('./assets\\logo.png')).toBe(true);
    expect(isPackageRelativePath('/etc/passwd')).toBe(false);
    expect(isPackageRelativePath('assets/../../x')).toBe(false);
    expect(isPackageRelativePath('C:/x.png')).toBe(false);
    expect(isPackageRelativePath('')).toBe(false);
    // A control character truncates the path at the OS boundary and hides the
    // rest of it from whoever reads the install screen.
    expect(isPackageRelativePath(`assets/${String.fromCharCode(0)}logo.png`)).toBe(false);
    expect(isPackageRelativePath(`assets/${String.fromCharCode(127)}logo.png`)).toBe(false);
    expect(isPackageRelativePath(' assets/logo.png')).toBe(false);
  });
});

describe('minAbuVersion', () => {
  it('must be a semantic version when present', () => {
    expect(validateMinAbuVersion(undefined)).toBeUndefined();
    expect(validateMinAbuVersion('0.51.0')).toBe('0.51.0');
    expect(failingField(() => validateMinAbuVersion('0.51'))).toBe('minAbuVersion');
    expect(failingField(() => validateMinAbuVersion(51))).toBe('minAbuVersion');
  });

  it('is required once the package ships teams/', () => {
    expect(() => assertMinAbuVersionDeclared({})).not.toThrow();
    expect(failingField(() => assertMinAbuVersionDeclared({}, { hasTeams: true }))).toBe('minAbuVersion');
    expect(() => assertMinAbuVersionDeclared({ minAbuVersion: '0.51.0' }, { hasTeams: true })).not.toThrow();
  });

  it('refuses a package that claims an Abu older than teams/', () => {
    // An Abu below TEAMS_MIN_ABU_VERSION does not read teams/, so the package
    // would install with its teams silently gone.
    expect(TEAMS_MIN_ABU_VERSION).toBe('0.51.0');
    expect(failingField(() => assertMinAbuVersionDeclared({ minAbuVersion: '0.4.0' }, { hasTeams: true }))).toBe('minAbuVersion');
    // A package written against a pre-release of that version targets a build
    // that already reads teams/.
    expect(() => assertMinAbuVersionDeclared({ minAbuVersion: '0.51.0-rc.1' }, { hasTeams: true })).not.toThrow();
  });

  it('compares against the host version', () => {
    expect(checkMinAbuVersion({}, '0.50.0')).toEqual({ ok: true });
    expect(checkMinAbuVersion({ minAbuVersion: '0.51.0' }, '0.50.0')).toEqual({ ok: false, required: '0.51.0' });
    expect(checkMinAbuVersion({ minAbuVersion: '0.51.0' }, '0.51.0')).toEqual({ ok: true, required: '0.51.0' });
    expect(checkMinAbuVersion({ minAbuVersion: '0.51.0' }, '1.0.0-beta.1')).toEqual({ ok: true, required: '0.51.0' });
    expect(failingField(() => checkMinAbuVersion({ minAbuVersion: '0.51.0' }, 'dev'))).toBe('minAbuVersion');
  });
});

describe('BUILTIN_TEAM_IDS', () => {
  it('lists six prefixed, unique ids', () => {
    expect(BUILTIN_TEAM_IDS).toHaveLength(6);
    expect(new Set(BUILTIN_TEAM_IDS).size).toBe(6);
    for (const id of BUILTIN_TEAM_IDS) expect(id.startsWith('builtin-team:')).toBe(true);
  });
});
