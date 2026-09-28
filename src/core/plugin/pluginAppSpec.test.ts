import { describe, expect, it } from 'vitest';
import {
  APP_LIMITS,
  APP_SUPPORT_MIN_VERSION,
  BUILTIN_TEAM_IDS,
  assertMinAbuVersionDeclared,
  checkMinAbuVersion,
  isAllowedAppPageOrigin,
  isPackageRelativePath,
  parseAppConfig,
  parseLocalizedText,
  parseTeamFile,
  resolveAppPageUrl,
  resolveLocalizedText,
  validateMinAbuVersion,
} from '../../../electron/shared/pluginAppSpec.mjs';
import { PluginManifestError } from '../../../electron/shared/pluginManifestError.mjs';
import { BUILTIN_AGENT_NAMES } from '../../../electron/shared/pluginAgentFormat.mjs';

const ctx = {
  teamIds: ['hiring'],
  agentNames: ['sourcer', 'closer'],
  skillNames: ['jd-writer'],
  mcpServerNames: ['ats'],
};

function templates(count = 3) {
  return Array.from({ length: count }, (_, i) => ({ id: `t${i}`, title: `T${i}`, prompt: `Prompt ${i}` }));
}

function scene(overrides: Record<string, unknown> = {}) {
  return { id: 'write-jd', title: '写 JD', run: { team: 'builtin-team:recruiting' }, templates: templates(), ...overrides };
}

function app(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    home: { modes: { items: [{ modeId: 'prepare', title: '岗位准备', scenes: [scene()] }] } },
    ...overrides,
  };
}

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
    expect(failingField(() => parseTeamFile({ ...team, leaderNote: 'x'.repeat(APP_LIMITS.leaderNote + 1) }, 'hiring', ctx))).toBe('teams.hiring.leaderNote');
    expect(failingField(() => parseTeamFile({ ...team, expertise: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'hiring', ctx))).toBe('teams.hiring.expertise');
    expect(failingField(() => parseTeamFile({ ...team, avatar: 'x'.repeat(APP_LIMITS.teamAvatar + 1) }, 'hiring', ctx))).toBe('teams.hiring.avatar');
    expect(parseTeamFile({ ...team, avatar: 'icon:chart-bar/teal' }, 'hiring', ctx).avatar).toBe('icon:chart-bar/teal');
    expect(failingField(() => parseTeamFile({ ...team, extra: 1 }, 'hiring', ctx))).toBe('teams.hiring.extra');
    expect(failingField(() => parseTeamFile({ ...team, description: undefined }, 'hiring', ctx))).toBe('teams.hiring.description');
  });
});

describe('parseAppConfig', () => {
  it('returns a normalized config for a minimal app', () => {
    const parsed = parseAppConfig(app(), ctx);
    expect(parsed.version).toBe(1);
    expect(parsed.home.modes.items[0].scenes[0].run).toEqual({ team: 'builtin-team:recruiting' });
    expect(parsed.nav).toBeUndefined();
    expect(parsed.allowedOrigins).toBeUndefined();
  });

  it('checks version, modes, scenes and template counts', () => {
    expect(failingField(() => parseAppConfig(app({ version: 2 }), ctx))).toBe('app.version');
    expect(failingField(() => parseAppConfig(app({ home: { modes: { items: [] } } }), ctx))).toBe('app.home.modes.items');
    expect(failingField(() => parseAppConfig(app({ home: { modes: { items: [{ modeId: 'a', title: 'A', scenes: [] }] } } }), ctx))).toBe('app.home.modes.items[0].scenes');
    expect(failingField(() => parseAppConfig(app({ home: { modes: { items: [{ modeId: 'a', title: 'A', scenes: [scene({ templates: templates(2) })] }] } } }), ctx))).toBe('app.home.modes.items[0].scenes[0].templates');
    expect(failingField(() => parseAppConfig(app({ home: { modes: { items: [{ modeId: 'a', title: 'A', scenes: [scene({ templates: templates(7) })] }] } } }), ctx))).toBe('app.home.modes.items[0].scenes[0].templates');
    expect(failingField(() => parseAppConfig(app({ home: { modes: { defaultSelected: 'nope', items: [{ modeId: 'a', title: 'A', scenes: [scene()] }] } } }), ctx))).toBe('app.home.modes.defaultSelected');
  });

  it('rejects duplicate ids at every level', () => {
    const mode = { modeId: 'a', title: 'A', scenes: [scene()] };
    expect(failingField(() => parseAppConfig(app({ home: { modes: { items: [mode, mode] } } }), ctx))).toBe('app.home.modes.items[1]');
    expect(failingField(() => parseAppConfig(app({ home: { modes: { items: [{ ...mode, scenes: [scene(), scene()] }] } } }), ctx))).toBe('app.home.modes.items[0].scenes[1]');
    const dupTemplates = [...templates(2), { id: 't0', title: 'dup', prompt: 'dup' }];
    expect(failingField(() => parseAppConfig(app({ home: { modes: { items: [{ ...mode, scenes: [scene({ templates: dupTemplates })] }] } } }), ctx))).toBe('app.home.modes.items[0].scenes[0].templates[2]');
  });

  it('resolves run references against the package and the built-in catalog', () => {
    const withRun = (run: unknown) => app({ home: { modes: { items: [{ modeId: 'a', title: 'A', scenes: [scene({ run })] }] } } });
    const field = 'app.home.modes.items[0].scenes[0].run';
    expect(parseAppConfig(withRun({ team: 'hiring' }), ctx).home.modes.items[0].scenes[0].run).toEqual({ team: 'hiring' });
    expect(parseAppConfig(withRun({ expert: 'closer' }), ctx).home.modes.items[0].scenes[0].run).toEqual({ expert: 'closer' });
    expect(parseAppConfig(withRun({ expert: `builtin:${BUILTIN_AGENT_NAMES[1]}` }), ctx).home.modes.items[0].scenes[0].run).toEqual({ expert: `builtin:${BUILTIN_AGENT_NAMES[1]}` });
    expect(parseAppConfig(withRun({ skill: 'jd-writer' }), ctx).home.modes.items[0].scenes[0].run).toEqual({ skill: 'jd-writer' });
    expect(failingField(() => parseAppConfig(withRun({ team: 'ghost' }), ctx))).toBe(`${field}.team`);
    expect(failingField(() => parseAppConfig(withRun({ team: 'builtin-team:ghost' }), ctx))).toBe(`${field}.team`);
    expect(failingField(() => parseAppConfig(withRun({ expert: 'ghost' }), ctx))).toBe(`${field}.expert`);
    expect(failingField(() => parseAppConfig(withRun({ expert: 'builtin:ghost' }), ctx))).toBe(`${field}.expert`);
    expect(failingField(() => parseAppConfig(withRun({ skill: 'ghost' }), ctx))).toBe(`${field}.skill`);
    expect(failingField(() => parseAppConfig(withRun({ team: 'hiring', skill: 'jd-writer' }), ctx))).toBe(field);
    expect(failingField(() => parseAppConfig(app({ defaultRun: { team: 'ghost' } }), ctx))).toBe('app.defaultRun.team');
  });

  it('checks requiredConnectors, promptAppend length and unknown fields', () => {
    expect(failingField(() => parseAppConfig(app({ requiredConnectors: ['crm'] }), ctx))).toBe('app.requiredConnectors[0]');
    expect(parseAppConfig(app({ requiredConnectors: ['ats'] }), ctx).requiredConnectors).toEqual(['ats']);
    expect(failingField(() => parseAppConfig(app({ promptAppend: 'x'.repeat(APP_LIMITS.promptAppend + 1) }), ctx))).toBe('app.promptAppend');
    expect(failingField(() => parseAppConfig(app({ theme: 'dark' }), ctx))).toBe('app.theme');
    expect(failingField(() => parseAppConfig(app({ composer: { placeholder: '' } }), ctx))).toBe('app.composer.placeholder');
  });

  describe('nav', () => {
    const nav = (items: unknown[]) => ({ items });
    const chat = { id: 'chat', target: 'builtin:chat' };

    it('requires builtin:chat exactly once and unique ids', () => {
      expect(failingField(() => parseAppConfig(app({ nav: nav([{ id: 'team', target: 'builtin:team' }]) }), ctx))).toBe('app.nav.items');
      expect(failingField(() => parseAppConfig(app({ nav: nav([chat, { id: 'chat2', target: 'builtin:chat' }]) }), ctx))).toBe('app.nav.items');
      expect(failingField(() => parseAppConfig(app({ nav: nav([chat, { id: 'chat', target: 'builtin:team' }]) }), ctx))).toBe('app.nav.items[1]');
      expect(failingField(() => parseAppConfig(app({ nav: nav([chat, { id: 'x', target: 'builtin:settings' }]) }), ctx))).toBe('app.nav.items[1].target');
    });

    it('binds url: targets to allowedOrigins and requires a title', () => {
      const page = { id: 'portal', title: '门户', target: 'url:https://portal.example.com/home?x=1' };
      expect(failingField(() => parseAppConfig(app({ nav: nav([chat, page]) }), ctx))).toBe('app.nav.items[1].target');
      expect(failingField(() => parseAppConfig(app({ nav: nav([chat, page]), allowedOrigins: ['https://other.example.com'] }), ctx))).toBe('app.nav.items[1].target');
      expect(failingField(() => parseAppConfig(app({ nav: nav([chat, { ...page, title: undefined }]), allowedOrigins: ['https://portal.example.com'] }), ctx))).toBe('app.nav.items[1].title');
      expect(failingField(() => parseAppConfig(app({ nav: nav([chat, { ...page, target: 'url:not a url' }]), allowedOrigins: ['https://portal.example.com'] }), ctx))).toBe('app.nav.items[1].target');
      // `blob:` and `filesystem:` take their origin from the address inside
      // them, so an origin comparison alone would let one through while the
      // page it names is something else entirely.
      for (const scheme of ['blob:https://portal.example.com/x', 'filesystem:https://portal.example.com/temporary/x']) {
        expect(failingField(() => parseAppConfig(app({ nav: nav([chat, { ...page, target: `url:${scheme}` }]), allowedOrigins: ['https://portal.example.com'] }), ctx))).toBe('app.nav.items[1].target');
      }
      const parsed = parseAppConfig(app({ nav: nav([chat, page]), allowedOrigins: ['https://portal.example.com'] }), ctx);
      expect(resolveAppPageUrl(parsed, 'portal')).toBe('https://portal.example.com/home?x=1');
      // The host loads whatever `resolveAppPageUrl` returns, so it settles the
      // scheme itself rather than trusting the config it was handed.
      const forged = { ...parsed, nav: { items: [{ id: 'portal', target: 'url:blob:https://portal.example.com/x' }] } };
      expect(failingField(() => resolveAppPageUrl(forged, 'portal'))).toBe('app.nav.items');
      expect(failingField(() => resolveAppPageUrl(parsed, 'chat'))).toBe('app.nav.items');
      expect(failingField(() => resolveAppPageUrl(parsed, 'missing'))).toBe('app.nav.items');
    });

    it('validates allowedOrigins entries', () => {
      for (const bad of ['https://a.example.com/', 'https://a.example.com/path', 'http://a.example.com', 'https://*.example.com', 'https://u:p@a.example.com', 'a.example.com']) {
        expect(failingField(() => parseAppConfig(app({ allowedOrigins: [bad] }), ctx))).toBe('app.allowedOrigins[0]');
      }
      expect(parseAppConfig(app({ allowedOrigins: ['https://a.example.com:8443', 'http://127.0.0.1:5173', 'http://localhost'] }), ctx).allowedOrigins).toHaveLength(3);
      expect(failingField(() => parseAppConfig(app({ allowedOrigins: ['https://a.example.com', 'https://a.example.com'] }), ctx))).toBe('app.allowedOrigins[1]');
    });
  });
});

describe('isAllowedAppPageOrigin / isPackageRelativePath', () => {
  it('accepts exact https origins and loopback http only', () => {
    expect(isAllowedAppPageOrigin('https://gu.qq.com')).toBe(true);
    expect(isAllowedAppPageOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedAppPageOrigin('http://192.168.1.2')).toBe(false);
    expect(isAllowedAppPageOrigin('https://gu.qq.com?x')).toBe(false);
    expect(isAllowedAppPageOrigin(42)).toBe(false);
  });

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

  it('is required once the package uses app or teams/', () => {
    expect(() => assertMinAbuVersionDeclared({})).not.toThrow();
    expect(() => assertMinAbuVersionDeclared({ app: {}, minAbuVersion: '0.51.0' })).not.toThrow();
    expect(failingField(() => assertMinAbuVersionDeclared({ app: {} }))).toBe('minAbuVersion');
    expect(failingField(() => assertMinAbuVersionDeclared({}, { hasTeams: true }))).toBe('minAbuVersion');
  });

  it('refuses a package that claims an Abu older than app and teams/', () => {
    // An Abu below APP_SUPPORT_MIN_VERSION reads neither field, so the package
    // would install as a plain plugin — the app and the teams silently gone.
    expect(APP_SUPPORT_MIN_VERSION).toBe('0.51.0');
    expect(failingField(() => assertMinAbuVersionDeclared({ app: {}, minAbuVersion: '0.50.0' }))).toBe('minAbuVersion');
    expect(failingField(() => assertMinAbuVersionDeclared({ minAbuVersion: '0.4.0' }, { hasTeams: true }))).toBe('minAbuVersion');
    expect(() => assertMinAbuVersionDeclared({ app: {}, minAbuVersion: '1.2.0' })).not.toThrow();
    // A package written against a pre-release of that version targets a build
    // that already reads both fields.
    expect(() => assertMinAbuVersionDeclared({ app: {}, minAbuVersion: '0.51.0-rc.1' })).not.toThrow();
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
