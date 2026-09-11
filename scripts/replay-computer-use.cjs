'use strict';
const fs = require('node:fs');
const { replayComputerUseTrajectory } = require('../electron/computerUseTrajectory.cjs');
const MAX_BYTES = 10 * 1024 * 1024;

function replayFile(file, { maxBytes = MAX_BYTES } = {}) {
  const limit = Math.max(1, Math.min(MAX_BYTES, Number.isSafeInteger(maxBytes) ? maxBytes : MAX_BYTES));
  let fd;
  let bytes;
  try {
    fd = fs.openSync(file, 'r');
    if (!fs.fstatSync(fd).isFile()) throw new Error('not a regular file');
    bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    bytes = bytes.subarray(0, count);
  } catch {
    // Paths and OS error text may contain private data; never echo them.
    throw new Error('computer-use-log-unavailable');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (bytes.length > limit) throw new Error('computer-use-log-too-large');
  return replayComputerUseTrajectory(bytes.toString('utf8').split('\n'));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help') {
    process.stdout.write('Usage: npm run replay:computer-use -- <runtime-observability.jsonl>\nRead-only diagnostics; never replays computer input.\n');
    process.exitCode = args[0] === '--help' ? 0 : 2;
  } else {
    try {
      const report = replayFile(args[0]);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.complete && report.runs.length > 0 ? 0 : 2;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    }
  }
}
module.exports = { replayFile };
