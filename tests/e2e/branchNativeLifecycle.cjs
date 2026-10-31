const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const control = process.env.ABU_BRANCH_LIFECYCLE_CONTROL;
if (process.type === 'browser' && control) {
  const binary = path.resolve(__dirname, '../../electron/native-helper/target/release/native-helper');
  const spawn = childProcess.spawn;
  let held;
  globalThis.resumeBranchNativeHelper = () => {
    if (!held || held.killed || held.exitCode !== null || held.signalCode !== null) {
      throw new Error('Paused native helper is no longer running');
    }
    process.kill(held.pid, 'SIGCONT');
    held = undefined;
  };
  childProcess.spawn = function (...args) {
    const child = spawn.apply(this, args);
    if (args[0] === binary && fs.existsSync(control)) {
      fs.unlinkSync(control);
      if (!child.pid) throw new Error('Native helper did not start');
      process.kill(child.pid, 'SIGSTOP');
      held = child;
      const status = { pid: child.pid, state: 'paused' };
      fs.writeFileSync(`${control}.status`, JSON.stringify(status));
      child.once('exit', (code, signal) => {
        fs.writeFileSync(`${control}.status`, JSON.stringify({ ...status, state: 'exited', code, signal }));
      });
    }
    return child;
  };
  fs.writeFileSync(`${control}.ready`, 'ready');
}
