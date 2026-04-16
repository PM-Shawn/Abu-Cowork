import assert from 'node:assert/strict';
import { MemoryStorageAdapter, MemoryPathAdapter, MemoryIPCAdapter } from '../../mocks';
import { SkillLoader } from '../loader';
import {
  substituteVariables,
  executeInlineCommands,
} from '../preprocessor';
import {
  matchWildcard,
  matchesToolName,
  matchesToolPattern,
  parseToolPatterns,
  filterToolsByPatterns,
} from '../toolFilter';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

async function main() {
  console.log('skill toolFilter:');
  await test('matchWildcard 基本', () => {
    assert.equal(matchWildcard('read_file', 'read_*'), true);
    assert.equal(matchWildcard('mcp__gh__x', 'mcp__gh__*'), true);
    assert.equal(matchWildcard('foo', 'bar'), false);
  });

  await test('matchesToolPattern with constraint', () => {
    assert.equal(
      matchesToolPattern('run_command', 'run_command(npm *)', { command: 'npm install' }),
      true
    );
    assert.equal(
      matchesToolPattern('run_command', 'run_command(npm *)', { command: 'rm -rf /' }),
      false
    );
  });

  await test('parseToolPatterns 区分通配与精确', () => {
    const { allowedToolNames, inputValidators } = parseToolPatterns([
      'read_file',
      'mcp__*',
      'run_command(npm *)',
    ]);
    assert.ok(allowedToolNames.has('read_file'));
    assert.ok(allowedToolNames.has('mcp__*'));
    assert.equal(inputValidators.size, 1);
  });

  await test('filterToolsByPatterns', () => {
    const r = filterToolsByPatterns(
      ['read_file', 'write_file', 'mcp__gh__issue', 'list_dir'],
      ['read_*', 'mcp__*']
    );
    assert.deepEqual(r.sort(), ['mcp__gh__issue', 'read_file']);
  });

  await test('matchesToolName', () => {
    assert.equal(matchesToolName('anything', '*'), true);
  });

  console.log('\nskill preprocessor:');
  await test('substituteVariables 基本替换', () => {
    const r = substituteVariables(
      'Hello $0, args=$ARGUMENTS, dir=${ABU_SKILL_DIR}, session=${ABU_SESSION_ID}',
      'alice bob',
      '/skills/hello',
      'sess_1'
    );
    assert.ok(r.includes('Hello alice'));
    assert.ok(r.includes('args=alice bob'));
    assert.ok(r.includes('dir=/skills/hello'));
    assert.ok(r.includes('session=sess_1'));
  });

  await test('Claude Code alias 变量', () => {
    const r = substituteVariables(
      '${CLAUDE_SKILL_DIR}/${CLAUDE_SESSION_ID}',
      '',
      '/d',
      's1'
    );
    assert.equal(r, '/d/s1');
  });

  await test('无 $ARGUMENTS 时自动追加', () => {
    const r = substituteVariables('no args here', 'xyz', '/', 's');
    assert.ok(r.endsWith('ARGUMENTS: xyz'));
  });

  await test('executeInlineCommands 走 IPCAdapter', async () => {
    const ipc = new MemoryIPCAdapter();
    ipc.register('run_shell_command', (payload) => ({
      stdout: `ran:${(payload as { command: string }).command}`,
      stderr: '',
      code: 0,
    }));
    const r = await executeInlineCommands('result: !`date` end', '/tmp', ipc);
    assert.ok(r.includes('ran:date'));
  });

  await test('executeInlineCommands 无 IPC 时降级', async () => {
    const r = await executeInlineCommands('result: !`date` end', '/tmp');
    assert.ok(r.includes('IPC shell not available'));
  });

  console.log('\nskill SkillLoader:');
  await test('SkillLoader 扫描并解析 SKILL.md', async () => {
    const storage = new MemoryStorageAdapter();
    const path = new MemoryPathAdapter({ home: '/home/x' });

    await storage.mkdir('/home/x/.abu/skills/hello', { recursive: true });
    await storage.writeTextFile(
      '/home/x/.abu/skills/hello/SKILL.md',
      `---
name: hello
description: a test skill
allowed-tools:
  - read_file
trigger: 你好
---

这是技能正文`
    );

    const loader = new SkillLoader({ storage, path });
    const skills = await loader.discoverSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'hello');
    const skill = loader.getSkill('hello');
    assert.ok(skill);
    assert.deepEqual(skill!.allowedTools, ['read_file']);
    assert.ok(skill!.content.includes('这是技能正文'));
  });

  await test('findMatchingSkills 按描述模糊匹配', async () => {
    const storage = new MemoryStorageAdapter();
    const path = new MemoryPathAdapter({ home: '/home/x' });
    await storage.mkdir('/home/x/.abu/skills/report', { recursive: true });
    await storage.writeTextFile(
      '/home/x/.abu/skills/report/SKILL.md',
      `---
name: report
description: 生成周报
trigger: 周报
---

body`
    );
    const loader = new SkillLoader({ storage, path });
    await loader.discoverSkills();
    // findMatchingSkills 按空白切词，英文/日志关键词场景工作良好
    const matched = loader.findMatchingSkills('report pipeline');
    assert.equal(matched.length, 1);
    assert.equal(matched[0].name, 'report');
  });

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
