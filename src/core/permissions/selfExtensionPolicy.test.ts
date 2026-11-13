import { describe, expect, it } from 'vitest';
import { classifySelfExtension } from './selfExtensionPolicy';
import { format, getI18n } from '@/i18n';

const t = () => getI18n().commandConfirm;
const schedule = () => getI18n().schedule;

/** `what` + the name, the way the dialog words a named thing. */
const named = (what: string, name: string) => format(t().selfExtensionNamed, { what, name });
const withDetail = (summary: string, detail: string) => format(t().selfExtensionDetail, { summary, detail });
const action = (verb: string, thing: string) => format(t().selfExtensionAction, { verb, thing });

describe('classifySelfExtension', () => {
  describe('automation managers', () => {
    const KINDS = [
      ['manage_scheduled_task', () => t().selfExtensionNounTask, () => t().selfExtensionReasonTask],
      ['manage_trigger', () => t().selfExtensionNounTrigger, () => t().selfExtensionReasonTrigger],
      ['manage_file_watch', () => t().selfExtensionNounFileWatch, () => t().selfExtensionReasonFileWatch],
    ] as const;

    it.each([
      ['manage_trigger', 'create', () => t().selfExtensionVerbCreate],
      ['manage_trigger', 'update', () => t().selfExtensionVerbUpdate],
      ['manage_trigger', 'delete', () => t().selfExtensionVerbDelete],
      ['manage_trigger', 'pause', () => t().selfExtensionVerbPause],
      ['manage_trigger', 'resume', () => t().selfExtensionVerbResume],
      ['manage_scheduled_task', 'create', () => t().selfExtensionVerbCreate],
      ['manage_scheduled_task', 'update', () => t().selfExtensionVerbUpdate],
      ['manage_scheduled_task', 'delete', () => t().selfExtensionVerbDelete],
      ['manage_scheduled_task', 'pause', () => t().selfExtensionVerbPause],
      ['manage_scheduled_task', 'resume', () => t().selfExtensionVerbResume],
      ['manage_file_watch', 'add', () => t().selfExtensionVerbCreate],
      ['manage_file_watch', 'remove', () => t().selfExtensionVerbDelete],
      ['manage_file_watch', 'toggle', () => t().selfExtensionVerbToggle],
    ] as const)('classifies %s(%s) as a durable self-extension, in plain words', (name, act, verb) => {
      const [, noun, reason] = KINDS.find(([tool]) => tool === name)!;
      expect(classifySelfExtension(name, { action: act })).toEqual({
        summary: action(verb(), noun()),
        reason: reason(),
      });
    });

    it.each(KINDS)('leaves the read-only %s(list) action outside the self-extension gate', (name) => {
      expect(classifySelfExtension(name, { action: 'list' })).toBeNull();
    });

    it.each(KINDS)('fails closed for an unknown %s action, and says which action it was', (name, noun, reason) => {
      expect(classifySelfExtension(name, { action: 'future_mutation' })).toEqual({
        summary: withDetail(action(t().selfExtensionVerbOther, noun()), 'future_mutation'),
        reason: reason(),
      });
    });

    it.each(KINDS)('fails closed when %s omits its action', (name, noun, reason) => {
      expect(classifySelfExtension(name, {})).toEqual({
        summary: action(t().selfExtensionVerbOther, noun()),
        reason: reason(),
      });
    });

    it.each(KINDS)('does not mistake an inherited property for a known %s action', (name, noun) => {
      const result = classifySelfExtension(name, { action: 'constructor' });
      expect(result?.summary).toBe(withDetail(action(t().selfExtensionVerbOther, noun()), 'constructor'));
    });

    it('keeps the three kinds apart, in the summary and in the reason', () => {
      const [task, trigger, watch] = KINDS.map(([name]) => classifySelfExtension(name, { action: 'future_mutation' })!);
      expect(new Set([task.summary, trigger.summary, watch.summary]).size).toBe(3);
      expect(new Set([task.reason, trigger.reason, watch.reason]).size).toBe(3);
    });

    describe('scheduled tasks', () => {
      const create = (extra: Record<string, unknown>) =>
        classifySelfExtension('manage_scheduled_task', { action: 'create', name: '每周一检查库存', ...extra });
      const label = () => named(action(t().selfExtensionVerbCreate, t().selfExtensionNounTask), '每周一检查库存');

      it('names a new task and says when it runs', () => {
        const s = schedule();
        expect(create({ frequency: 'weekly', day_of_week: 1, time_hour: 9, time_minute: 0 })?.summary)
          .toBe(withDetail(label(), `${s.frequencyWeekly} ${s.monday} 09:00`));
      });

      it('words a weekly task the way the tool defaults it: Monday at 9:00', () => {
        const s = schedule();
        expect(create({ frequency: 'weekly' })?.summary).toBe(withDetail(label(), `${s.frequencyWeekly} ${s.monday} 09:00`));
      });

      it.each([
        ['daily', { time_hour: 7, time_minute: 5 }, () => `${schedule().frequencyDaily} 07:05`],
        ['weekdays', { time_hour: 18 }, () => `${schedule().frequencyWeekdays} 18:00`],
        ['hourly', { time_minute: 30 }, () => schedule().frequencyHourly],
        ['manual', {}, () => schedule().frequencyManual],
      ] as const)('says when a %s task runs', (frequency, extra, detail) => {
        expect(create({ frequency, ...extra })?.summary).toBe(withDetail(label(), detail()));
      });

      it('shows no schedule it cannot read, and still names the task', () => {
        expect(create({})?.summary).toBe(label());
        expect(create({ frequency: 'sometimes' })?.summary).toBe(label());
      });

      it('falls back to the tool default for an unusable time instead of showing it', () => {
        const s = schedule();
        expect(create({ frequency: 'daily', time_hour: 99, time_minute: 'noon' })?.summary)
          .toBe(withDetail(label(), `${s.frequencyDaily} 09:00`));
      });

      it('still classifies a create that names nothing', () => {
        expect(classifySelfExtension('manage_scheduled_task', { action: 'create', frequency: 'daily' })?.summary)
          .toBe(withDetail(action(t().selfExtensionVerbCreate, t().selfExtensionNounTask), `${schedule().frequencyDaily} 09:00`));
      });
    });

    describe('naming a task or trigger the call only knows by id', () => {
      it.each([
        ['manage_scheduled_task', () => t().selfExtensionNounTask],
        ['manage_trigger', () => t().selfExtensionNounTrigger],
      ] as const)('names the stored %s that update / delete / pause / resume point at', (name, noun) => {
        for (const [act, verb] of [
          ['update', t().selfExtensionVerbUpdate],
          ['delete', t().selfExtensionVerbDelete],
          ['pause', t().selfExtensionVerbPause],
          ['resume', t().selfExtensionVerbResume],
        ] as const) {
          expect(classifySelfExtension(name, { action: act, task_id: 'x', trigger_id: 'x' }, { automationTargetName: '库存日报' })?.summary)
            .toBe(named(action(verb, noun()), '库存日报'));
        }
      });

      it('names nothing it was not told, rather than guess from the id', () => {
        expect(classifySelfExtension('manage_scheduled_task', { action: 'delete', task_id: 'k3j2h1' })?.summary)
          .toBe(action(t().selfExtensionVerbDelete, t().selfExtensionNounTask));
      });

      it('prefers the stored name over the one in the call when updating', () => {
        expect(classifySelfExtension('manage_trigger', { action: 'update', trigger_id: 'x', name: '别的名字' }, { automationTargetName: '原来的名字' })?.summary)
          .toBe(named(action(t().selfExtensionVerbUpdate, t().selfExtensionNounTrigger), '原来的名字'));
      });

      it('falls back to the name in the call when an update matches no stored one', () => {
        expect(classifySelfExtension('manage_trigger', { action: 'update', trigger_id: 'x', name: '新名字' })?.summary)
          .toBe(named(action(t().selfExtensionVerbUpdate, t().selfExtensionNounTrigger), '新名字'));
      });

      it('does not let the call name what it deletes', () => {
        expect(classifySelfExtension('manage_scheduled_task', { action: 'delete', task_id: 'x', name: '无关紧要' })?.summary)
          .toBe(action(t().selfExtensionVerbDelete, t().selfExtensionNounTask));
      });
    });

    describe('triggers', () => {
      const label = () => named(action(t().selfExtensionVerbCreate, t().selfExtensionNounTrigger), '收到发票');

      it('names a new trigger', () => {
        expect(classifySelfExtension('manage_trigger', { action: 'create', name: '收到发票', source_type: 'http' })?.summary).toBe(label());
      });

      it('says which path a file trigger listens to', () => {
        expect(classifySelfExtension('manage_trigger', { action: 'create', name: '收到发票', source_type: 'file', source_path: '/Users/me/发票' })?.summary)
          .toBe(withDetail(label(), format(t().selfExtensionWatching, { path: '/Users/me/发票' })));
      });
    });

    describe('file watches', () => {
      it('names the folder a new rule watches, and the filter', () => {
        const base = named(action(t().selfExtensionVerbCreate, t().selfExtensionNounFileWatch), '/Users/me/Downloads');
        expect(classifySelfExtension('manage_file_watch', { action: 'add', path: '/Users/me/Downloads' })?.summary).toBe(base);
        expect(classifySelfExtension('manage_file_watch', { action: 'add', path: '/Users/me/Downloads', pattern: '*.pdf' })?.summary)
          .toBe(withDetail(base, '*.pdf'));
      });

      it('names no target when removing or toggling a rule: its id says nothing a person can read', () => {
        expect(classifySelfExtension('manage_file_watch', { action: 'remove', rule_id: 'ab12' }, { automationTargetName: 'ignored' })?.summary)
          .toBe(action(t().selfExtensionVerbDelete, t().selfExtensionNounFileWatch));
        expect(classifySelfExtension('manage_file_watch', { action: 'toggle', rule_id: 'ab12' })?.summary)
          .toBe(action(t().selfExtensionVerbToggle, t().selfExtensionNounFileWatch));
      });
    });
  });

  describe('manage_mcp_server', () => {
    const install = () => t().selfExtensionMcpInstall;

    it('asks before adding a server, and says what it adds', () => {
      expect(classifySelfExtension('manage_mcp_server', { action: 'install', name: 'github' }))
        .toEqual({ summary: named(install(), 'github'), reason: t().selfExtensionReasonMcp });
      expect(classifySelfExtension('manage_mcp_server', { action: 'ensure', name: 'github' }, { mcpServerConfigured: false }))
        .toEqual({ summary: named(install(), 'github'), reason: t().selfExtensionReasonMcp });
    });

    it('does not ask to reconnect a server the user already set up', () => {
      expect(classifySelfExtension('manage_mcp_server', { action: 'ensure', name: 'abu-browser-bridge' }, { mcpServerConfigured: true }))
        .toBeNull();
    });

    it('treats ensure as an install when the caller could not tell', () => {
      expect(classifySelfExtension('manage_mcp_server', { action: 'ensure', name: 'abu-browser-bridge' }))
        .toEqual({ summary: named(install(), 'abu-browser-bridge'), reason: t().selfExtensionReasonMcp });
    });

    it('never lets the configured fact excuse an install or a custom server', () => {
      expect(classifySelfExtension('manage_mcp_server', { action: 'install', name: 'github' }, { mcpServerConfigured: true }))
        .not.toBeNull();
      expect(classifySelfExtension('manage_mcp_server', { action: 'add_custom', name: 'x', url: 'http://10.0.0.1/mcp' }, { mcpServerConfigured: true }))
        .not.toBeNull();
    });

    it('leaves the read-only actions alone', () => {
      expect(classifySelfExtension('manage_mcp_server', { action: 'search', query: 'github' })).toBeNull();
      expect(classifySelfExtension('manage_mcp_server', { action: 'open_setup', name: 'abu-browser-bridge' })).toBeNull();
    });

    it('still classifies an install that names nothing', () => {
      expect(classifySelfExtension('manage_mcp_server', { action: 'install' })).toEqual({
        summary: install(),
        reason: t().selfExtensionReasonMcp,
      });
    });

    it('says where a custom service lives', () => {
      expect(classifySelfExtension('manage_mcp_server', { action: 'add_custom', name: '内部数据库', url: 'http://10.0.0.1:8080/mcp' })?.summary)
        .toBe(withDetail(named(t().selfExtensionMcpAddCustom, '内部数据库'), 'http://10.0.0.1:8080/mcp'));
    });

    it('shows the real host, and leaves credentials and query tokens out of the dialog', () => {
      const summary = classifySelfExtension('manage_mcp_server', {
        action: 'add_custom', name: 'x', url: 'https://trusted.example@evil.example/mcp?token=s3cret#frag',
      })?.summary;
      expect(summary).toBe(withDetail(named(t().selfExtensionMcpAddCustom, 'x'), 'https://evil.example/mcp'));
      expect(summary).not.toContain('s3cret');
      expect(summary).not.toContain('trusted.example');
    });

    it('shows an address it cannot parse as given', () => {
      expect(classifySelfExtension('manage_mcp_server', { action: 'add_custom', name: 'x', url: 'not a url' })?.summary)
        .toBe(withDetail(named(t().selfExtensionMcpAddCustom, 'x'), 'not a url'));
    });

    it('still classifies a custom service with no address', () => {
      expect(classifySelfExtension('manage_mcp_server', { action: 'add_custom', name: 'x' })?.summary)
        .toBe(named(t().selfExtensionMcpAddCustom, 'x'));
    });
  });

  describe('update_soul', () => {
    it('says the persona is rewritten', () => {
      expect(classifySelfExtension('update_soul', { content: 'new persona' })).toEqual({
        summary: t().selfExtensionUpdateSoul,
        reason: t().selfExtensionReasonSoul,
      });
    });
  });

  // The approval is the one check on "the user asked to change that expert":
  // it must say whether this save creates an expert or replaces one, decided
  // from disk by the caller — never from the model's own `overwrite` flag.
  describe('save_agent says whether it creates or replaces', () => {
    it('says "new" when no AGENT.md is there, whatever the model claims', () => {
      expect(classifySelfExtension('save_agent', { name: 'reviewer', overwrite: true }, { saveAgentReplaces: false }))
        .toEqual({ summary: named(t().selfExtensionSaveAgentNew, 'reviewer'), reason: t().selfExtensionReasonAgent });
    });

    it('says "replaces" when an AGENT.md is there, even without overwrite', () => {
      expect(classifySelfExtension('save_agent', { name: 'reviewer' }, { saveAgentReplaces: true }))
        .toEqual({ summary: named(t().selfExtensionSaveAgentReplace, 'reviewer'), reason: t().selfExtensionReasonAgent });
    });

    it('says "replaces" when the caller could not tell', () => {
      expect(classifySelfExtension('save_agent', { name: 'reviewer' }))
        .toEqual({ summary: named(t().selfExtensionSaveAgentReplace, 'reviewer'), reason: t().selfExtensionReasonAgent });
    });

    it('still classifies a call with no usable name, so it cannot slip the gate', () => {
      expect(classifySelfExtension('save_agent', {}, { saveAgentReplaces: false }))
        .toEqual({ summary: t().selfExtensionSaveAgentNew, reason: t().selfExtensionReasonAgent });
      expect(classifySelfExtension('save_agent', { name: 42 })?.summary).toBe(t().selfExtensionSaveAgentReplace);
    });

    it('keeps the two labels distinct', () => {
      expect(t().selfExtensionSaveAgentNew).not.toBe(t().selfExtensionSaveAgentReplace);
    });
  });

  // `save_team` overwrites by name and writes `leaderNote` — free text that is
  // injected into this team's instructions on every later run. Same durable
  // foothold as a subagent, so the same gate and the same create/replace split.
  describe('save_team says whether it creates or replaces', () => {
    it('says "new" when no team carries that name', () => {
      expect(classifySelfExtension('save_team', { name: '数据小队', leader: 'a', members: [] }, { saveTeamReplaces: false }))
        .toEqual({ summary: named(t().selfExtensionSaveTeamNew, '数据小队'), reason: t().selfExtensionReasonTeam });
    });

    it('says "replaces" when a team of that name already exists', () => {
      expect(classifySelfExtension('save_team', { name: '数据小队', leader: 'a', members: [] }, { saveTeamReplaces: true }))
        .toEqual({ summary: named(t().selfExtensionSaveTeamReplace, '数据小队'), reason: t().selfExtensionReasonTeam });
    });

    it('says "replaces" when the caller could not tell', () => {
      expect(classifySelfExtension('save_team', { name: '数据小队' }))
        .toEqual({ summary: named(t().selfExtensionSaveTeamReplace, '数据小队'), reason: t().selfExtensionReasonTeam });
    });

    it('still classifies a call with no usable name, so it cannot slip the gate', () => {
      expect(classifySelfExtension('save_team', {}, { saveTeamReplaces: false }))
        .toEqual({ summary: t().selfExtensionSaveTeamNew, reason: t().selfExtensionReasonTeam });
    });

    it('keeps the two labels distinct, and apart from the expert ones', () => {
      expect(t().selfExtensionSaveTeamNew).not.toBe(t().selfExtensionSaveTeamReplace);
      expect(t().selfExtensionSaveTeamNew).not.toBe(t().selfExtensionSaveAgentNew);
    });
  });

  describe('reasons', () => {
    it('gives each kind its own plain sentence', () => {
      const reasons = [
        classifySelfExtension('save_agent', { name: 'a' })!,
        classifySelfExtension('save_team', { name: 'a' })!,
        classifySelfExtension('update_soul', {})!,
        classifySelfExtension('manage_mcp_server', { action: 'install', name: 'a' })!,
        classifySelfExtension('manage_scheduled_task', { action: 'create' })!,
        classifySelfExtension('manage_trigger', { action: 'create' })!,
        classifySelfExtension('manage_file_watch', { action: 'add' })!,
      ].map((result) => result.reason);
      expect(reasons.every((reason) => reason.length > 0)).toBe(true);
      expect(new Set(reasons).size).toBe(reasons.length);
    });

    it('does not talk about internal tool names', () => {
      const i18n = t();
      for (const text of [
        i18n.selfExtensionReasonAgent, i18n.selfExtensionReasonTeam, i18n.selfExtensionReasonSoul, i18n.selfExtensionReasonMcp,
        i18n.selfExtensionReasonTask, i18n.selfExtensionReasonTrigger, i18n.selfExtensionReasonFileWatch,
      ]) {
        expect(text).not.toMatch(/manage_|save_|update_soul|MCP/);
      }
    });
  });

  describe('names chosen by the model', () => {
    it('shows a long name on one line, clipped', () => {
      const summary = classifySelfExtension('save_agent', { name: `第一行\n\n第二行 ${'长'.repeat(200)}` })!.summary;
      expect(summary).not.toMatch(/\n/);
      expect(summary).toContain('第一行 第二行');
      expect(summary).toContain('…');
      expect(summary.length).toBeLessThan(100);
    });

    it('does not expand placeholders written into a name', () => {
      const summary = classifySelfExtension('save_agent', { name: '{what}{name}$&' }, { saveAgentReplaces: false })?.summary;
      expect(summary).toContain('{what}{name}$&');
      expect(summary).toBe(named(t().selfExtensionSaveAgentNew, '{what}{name}$&'));
    });
  });
});

describe('installing a skill', () => {
  const rules = () => getI18n().permission.rules;
  const named = (what: string, name: string) => format(getI18n().commandConfirm.selfExtensionNamed, { what, name });
  const withDetail = (summary: string, detail: string) => format(getI18n().commandConfirm.selfExtensionDetail, { summary, detail });

  it('asks for an install from a web address, naming the host and path but not the query', () => {
    expect(classifySelfExtension('skill_manage', {
      action: 'install', name: '周报', source: 'https://example.com/skills/weekly.zip?token=secret',
    })).toEqual({
      summary: withDetail(named(rules().skillInstall, '周报'), 'https://example.com/skills/weekly.zip'),
      reason: rules().skillInstallReason,
    });
  });

  it('asks for an install from a package name or a folder too', () => {
    expect(classifySelfExtension('skill_manage', { action: 'install', source: 'cooper' })).toEqual({
      summary: withDetail(rules().skillInstall, 'cooper'),
      reason: rules().skillInstallReason,
    });
    expect(classifySelfExtension('skill_manage', { action: 'install', source: '/Users/me/skills/x' })?.reason)
      .toBe(rules().skillInstallReason);
  });

  it('asks even when the call names no source (the tool refuses it later)', () => {
    expect(classifySelfExtension('skill_manage', { action: 'install' })).toEqual({
      summary: rules().skillInstall,
      reason: rules().skillInstallReason,
    });
  });

  it('leaves the other skill actions to the draft queue and the content guard', () => {
    for (const action of ['create', 'patch', 'edit', 'delete', 'list', undefined]) {
      expect(classifySelfExtension('skill_manage', { action })).toBeNull();
    }
  });
});
