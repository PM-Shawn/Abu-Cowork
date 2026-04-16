import assert from 'node:assert/strict';
import {
  MemoryStorageAdapter,
  MemoryPathAdapter,
  FakeClockAdapter,
} from '../../mocks';
import { MemdirPaths, sanitizePath } from '../paths';
import { MemdirScanner } from '../scan';
import { MemdirWriter } from '../write';

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

function mkWriter() {
  const storage = new MemoryStorageAdapter();
  const path = new MemoryPathAdapter({ home: '/home/didi' });
  const clock = new FakeClockAdapter(1_700_000_000_000);
  const paths = new MemdirPaths(path);
  const scanner = new MemdirScanner({ storage, clock, paths });
  const writer = new MemdirWriter({ storage, clock, paths, scanner });
  return { storage, path, clock, paths, scanner, writer };
}

async function main() {
  console.log('memdir POC:');

  await test('sanitizePath 基本规则', () => {
    assert.equal(sanitizePath('/Users/didi/proj'), '-Users-didi-proj');
    assert.equal(sanitizePath('hello world!').length > 0, true);
  });

  await test('getMemoryDir 全局 vs 项目', async () => {
    const { paths } = mkWriter();
    const globalDir = await paths.getMemoryDir();
    const projDir = await paths.getMemoryDir('/Users/didi/x');
    assert.equal(globalDir, '/home/didi/.abu/memory');
    assert.ok(projDir.startsWith('/home/didi/.abu/projects/'));
    assert.ok(projDir.endsWith('/memory'));
  });

  await test('isMemoryPath 识别', async () => {
    const { paths } = mkWriter();
    assert.equal(await paths.isMemoryPath('/home/didi/.abu/memory/x.md'), true);
    assert.equal(
      await paths.isMemoryPath('/home/didi/.abu/projects/-Users-didi/memory/a.md'),
      true
    );
    assert.equal(await paths.isMemoryPath('/etc/passwd'), false);
  });

  await test('write + scan 往返', async () => {
    const { writer, scanner } = mkWriter();
    const fn = await writer.writeMemory({
      name: 'no force delete',
      description: 'User requires confirmation before any delete',
      type: 'feedback',
      content: '必须先确认再删除',
    });
    assert.ok(fn.startsWith('feedback_'));

    const headers = await scanner.scanMemoryFiles();
    assert.equal(headers.length, 1);
    assert.equal(headers[0].type, 'feedback');
    assert.equal(headers[0].name, 'no force delete');
  });

  await test('write 会建 MEMORY.md 索引', async () => {
    const { writer, scanner } = mkWriter();
    await writer.writeMemory({
      name: 'a',
      description: 'desc a',
      type: 'user',
      content: 'content a',
    });
    const idx = await scanner.loadMemoryIndex();
    assert.ok(idx.includes('Memory Index'));
    assert.ok(idx.includes('desc a'));
  });

  await test('delete 移除文件和索引条目', async () => {
    const { writer, scanner } = mkWriter();
    const fn = await writer.writeMemory({
      name: 'tmp',
      description: 'tmp mem',
      type: 'project',
      content: 'body',
    });
    await writer.deleteMemory(fn);
    const headers = await scanner.scanMemoryFiles();
    assert.equal(headers.length, 0);
    const idx = await scanner.loadMemoryIndex();
    assert.equal(idx.includes(fn), false);
  });

  await test('touchMemory 增加 accessCount 并更新时间', async () => {
    const { writer, scanner, clock } = mkWriter();
    const fn = await writer.writeMemory({
      name: 'touched',
      description: 'd',
      type: 'project',
      content: 'c',
    });
    const headers1 = await scanner.scanMemoryFiles();
    const filePath = headers1[0].filePath;
    const originalAccess = headers1[0].accessCount;

    clock.advance(60_000);
    await writer.touchMemory(filePath);

    const headers2 = await scanner.scanMemoryFiles();
    assert.equal(headers2[0].accessCount, originalAccess + 1);
    assert.ok(headers2[0].updated > headers1[0].updated);
  });

  await test('clearAllMemories 清空所有', async () => {
    const { writer, scanner } = mkWriter();
    await writer.writeMemory({ name: 'a', description: 'd', type: 'project', content: 'c' });
    await writer.writeMemory({ name: 'b', description: 'd', type: 'project', content: 'c' });
    const count = await writer.clearAllMemories();
    assert.equal(count, 2);
    assert.deepEqual(await scanner.scanMemoryFiles(), []);
  });

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
