'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { preflightCommandHost } = require('./commandHost.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'abu-command-preflight-'));
}

test('a missing launcher names the file and tells the user what to do about it', () => {
  const absent = path.join(tmpDir(), 'sandbox-launcher');

  const problem = preflightCommandHost(absent, undefined);

  assert.ok(problem, '缺少启动器必须被拦下来');
  assert.ok(problem.includes(absent), '提示要指名启动器的位置');
  assert.ok(problem.includes('安全软件'), '提示要说明这个文件通常是怎么没的');
  assert.ok(!/ENOENT/.test(problem), '不把 child_process 的英文原文透传出去');
});

test('a missing working directory names the directory, not the launcher', () => {
  const root = tmpDir();
  const launcher = path.join(root, 'sandbox-launcher');
  fs.writeFileSync(launcher, '');
  const absentCwd = path.join(root, 'no-such-directory');

  const problem = preflightCommandHost(launcher, absentCwd);

  assert.ok(problem, '工作目录不存在必须被拦下来');
  assert.ok(problem.includes(absentCwd), '提示要指名工作目录');
  assert.ok(!problem.includes(launcher), '提示不能再指向启动器');
});

test('a working directory that is a file is rejected as such', () => {
  const root = tmpDir();
  const launcher = path.join(root, 'sandbox-launcher');
  fs.writeFileSync(launcher, '');
  const file = path.join(root, 'a-file.txt');
  fs.writeFileSync(file, 'x');

  const problem = preflightCommandHost(launcher, file);

  assert.ok(problem?.includes(file), '提示要指名那个路径');
  assert.ok(problem.includes('不是一个目录'), '要说清它不是目录');
});

test('an existing launcher and working directory pass through', () => {
  const root = tmpDir();
  const launcher = path.join(root, 'sandbox-launcher');
  fs.writeFileSync(launcher, '');

  assert.equal(preflightCommandHost(launcher, root), null);
  assert.equal(preflightCommandHost(launcher, undefined), null);
});
