import { describe, it, expect } from 'vitest';
import { commandScope, fileScope, teamTaskRuleCategory, type TeamTaskRuleSubject } from './teamApprovalScope';

const identity = (scope: string | null) => ({ scope });

describe('commandScope', () => {
  it('keys a plain command on its first two words', () => {
    expect(commandScope('npm run build')).toBe('prefix:npm run');
    expect(commandScope('npm run test -- --watch')).toBe('prefix:npm run');
    expect(commandScope('  git   commit -m "x" ')).toBe('prefix:git commit');
    expect(commandScope('ls')).toBe('prefix:ls');
  });

  it('keys a chained, piped or redirected command on its exact text', () => {
    for (const text of ['npm run build && rm -rf ~', 'a || b', 'a; b', 'a & b', 'a | b', 'a > f', 'a < f', 'echo `id`', 'echo $(id)', 'a\nb']) {
      expect(commandScope(text)).toBe(`exact:${text.trim()}`);
    }
  });

  it('keys a command that starts with an environment assignment on its exact text', () => {
    expect(commandScope('FOO=1 npm run build')).toBe('exact:FOO=1 npm run build');
  });
});

describe('fileScope', () => {
  it('keys a file on its folder and the sorted capabilities', () => {
    expect(fileScope('/w/out/report.md', ['write', 'read'])).toBe('read+write:/w/out');
    expect(fileScope('C:\\w\\out\\a.txt', ['read'])).toBe('read:C:/w/out');
  });
});

describe('teamTaskRuleCategory', () => {
  const command = (level: TeamTaskRuleSubject['level'], scope: string | null = 'prefix:npm run'): TeamTaskRuleSubject =>
    ({ kind: 'command', level, identity: identity(scope) });

  it('gives a category to an ordinary command', () => {
    expect(teamTaskRuleCategory(command('warn'))).toBe('command:prefix:npm run');
    expect(teamTaskRuleCategory(command('safe'))).toBe('command:prefix:npm run');
  });

  it('gives no category to a dangerous, blocked or unclassified command', () => {
    expect(teamTaskRuleCategory(command('danger'))).toBeNull();
    expect(teamTaskRuleCategory(command('block'))).toBeNull();
    expect(teamTaskRuleCategory(command(undefined))).toBeNull();
  });

  it('gives no category without a trusted scope', () => {
    expect(teamTaskRuleCategory(command('warn', null))).toBeNull();
    expect(teamTaskRuleCategory({ kind: 'command', level: 'warn' })).toBeNull();
  });

  it('never gives a category to self-extension', () => {
    expect(teamTaskRuleCategory({ kind: 'self-extension', level: 'warn', identity: identity('x') })).toBeNull();
  });

  it('gives a file request its scope', () => {
    expect(teamTaskRuleCategory({ kind: 'file', identity: identity('write:/w/out') })).toBe('file:write:/w/out');
  });

  it('gives a browser request a category only where a standing grant could be offered', () => {
    const browser = (allowPersistentGrant: boolean | undefined): TeamTaskRuleSubject => ({
      kind: 'browser', level: 'warn', identity: identity('https://example.com'),
      browserPermissionResource: 'script', allowPersistentGrant,
    });
    expect(teamTaskRuleCategory(browser(true))).toBe('browser:script:https://example.com');
    expect(teamTaskRuleCategory(browser(false))).toBeNull();
    expect(teamTaskRuleCategory(browser(undefined))).toBeNull();
    expect(teamTaskRuleCategory({ ...browser(true), browserPermissionResource: undefined })).toBeNull();
  });

  it('keeps uploads apart from ordinary browser actions on the same site', () => {
    const upload: TeamTaskRuleSubject = { kind: 'browser-upload', level: 'warn', identity: identity('https://example.com'),
      browserPermissionResource: 'upload', allowPersistentGrant: true };
    expect(teamTaskRuleCategory(upload)).toBe('browser:upload:https://example.com');
  });
});
