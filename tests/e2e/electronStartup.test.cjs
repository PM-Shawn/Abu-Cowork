'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'electronStartup.cjs'), 'utf8');

function initialize(temporaryDirectory, calls) {
  vm.runInNewContext(source, {
    process: { env: { ABU_E2E_TEMP_DIRECTORY: temporaryDirectory, TEMP: path.resolve('.agent/other') } },
    require(name) {
      if (name === 'node:path') return path;
      assert.equal(name, 'electron');
      return { app: {
        setPath: (name, value) => calls.push({ name, value }),
        whenReady: () => assert.fail('Startup configuration must be synchronous'),
      } };
    },
  });
}

test('startup sets the exact requested path synchronously, including spaces and Unicode', () => {
  const calls = [];
  const directory = path.resolve('.agent/startup directory/目录');
  initialize(directory, calls);
  assert.deepEqual(calls, [{ name: 'temp', value: directory }]);
});

for (const [label, directory] of [['missing', undefined], ['empty', ''], ['relative', 'relative-directory']]) {
  test(`${label} startup configuration fails before setting any path`, () => {
    const calls = [];
    assert.throws(() => initialize(directory, calls), /absolute temporary directory/);
    assert.deepEqual(calls, []);
  });
}
