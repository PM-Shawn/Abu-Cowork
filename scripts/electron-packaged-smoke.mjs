/**
 * Packaged-build smoke test (F12, first packaging slice).
 *
 * Launches the ACTUAL electron-builder output (an unsigned, unpacked app under
 * release-electron/) via Playwright-for-Electron and asserts the packaging
 * wiring is correct end-to-end — the thing a `--dir` build can prove without a
 * signing certificate:
 *   1. The packaged app launches and opens a window, then a real PTY command
 *      round-trips through renderer → preload → IPC → node-pty.
 *   2. It reports app.isPackaged === true (we're testing the real bundle, not
 *      a dev `electron .`).
 *   3. The bundled resources resolve under process.resourcesPath: sidecar,
 *      builtin-skills, native-helper, sandbox-launcher, Node, Python, and the
 *      browser runtime all exist there. The app launches with a hostile,
 *      host-runtime-free PATH and exercises each runtime through the production
 *      renderer → preload → IPC path.
 *   4. The REAL frontend rendered (React mounted into #root), not the
 *      placeholder page — i.e. dist-electron-spike was bundled and loads.
 *   5. A packaged HTML preview receives the shared element-picker script.
 *   6. The bundled browser MCP adopts a visible in-app tab and completes
 *      navigate/snapshot/fill/click/extract/screenshot through Chromium.
 *   7. With fully isolated temporary app data, the packaged frontend survives
 *      an HTML-widget child-frame navigation, reaches the packaged sidecar,
 *      completes a loopback-only model request, persists the conversation,
 *      restores it after restart, and kills command/MCP descendant trees on
 *      abort, timeout, stop, and hard crash.
 *
 * Run: npm run smoke:electron:packaged   (after `npm run pack:electron`)
 *
 * NOT covered here: signed-install behavior, auto-update delivery, and
 * cross-arch native rebuilds. Windows CI separately installs and launches the
 * unsigned NSIS artifact with scripts/electron-windows-installed-smoke.ps1.
 */
import { _electron as electron } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { isValidNativeHelperIdentity } from './electron-packaged-smoke-contract.mjs';

const require = createRequire(import.meta.url);
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const FUSE_DISABLED = '0'.charCodeAt(0);
const FUSE_ENABLED = '1'.charCodeAt(0);
const OUT = process.env.ABU_ELECTRON_SMOKE_OUTPUT || 'release-electron';
const E2E_OUT = `${OUT}-e2e`;
const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = /想让阿布帮你做点什么？|What can Abu help you with\?/;
const STOP_BUTTON_SELECTOR = 'button[aria-label="停止"], button[aria-label="Stop"]';
const TEST_API_KEY = 'abu-packaged-e2e-key-not-a-real-secret';
const TEST_MODEL_ID = 'abu-packaged-e2e-model';
const E2E_APP_DATA_ROOT_ENV = 'ABU_E2E_APP_DATA_ROOT';
const PACKAGED_E2E_ENV = 'ABU_PACKAGED_E2E';
const EXPECT_TAURI_MIGRATION_ENV = 'ABU_EXPECT_TAURI_MIGRATION';
const E2E_AUTO_CONFIRM_TRANSITION_ENV = 'ABU_E2E_AUTO_CONFIRM_TRANSITION';
const CHAT_RUNTIME_PROBE_PREFIX = 'ABU_PACKAGED_RUNTIME_PROBE=';
const SIGNATURE_VARIANT_RESOURCE_ROOTS = [
  'native-helper',
  'sandbox-launcher',
  'node-runtime',
  'python-runtime',
  path.join('app.asar.unpacked', 'node_modules', 'node-pty'),
];

/** Locate the packaged binary + its Resources dir across mac/win/linux --dir outputs. */
function findPackagedApp(outputRoot) {
  const macArches = ['mac-arm64', 'mac', 'mac-x64', 'mac-universal'];
  for (const a of macArches) {
    const appDir = path.join(outputRoot, a, 'Abu.app');
    const bin = path.join(appDir, 'Contents', 'MacOS', 'Abu');
    if (fs.existsSync(bin)) {
      return {
        appPath: appDir,
        bin,
        packageRoot: appDir,
        resources: path.join(appDir, 'Contents', 'Resources'),
      };
    }
  }
  // linux --dir
  for (const name of ['abu', 'Abu']) {
    const bin = path.join(outputRoot, 'linux-unpacked', name);
    if (fs.existsSync(bin)) {
      const packageRoot = path.join(outputRoot, 'linux-unpacked');
      return {
        appPath: bin,
        bin,
        packageRoot,
        resources: path.join(packageRoot, 'resources'),
      };
    }
  }
  // win --dir
  const winBin = path.join(outputRoot, 'win-unpacked', 'Abu.exe');
  if (fs.existsSync(winBin)) {
    const packageRoot = path.join(outputRoot, 'win-unpacked');
    return {
      appPath: winBin,
      bin: winBin,
      packageRoot,
      resources: path.join(packageRoot, 'resources'),
    };
  }
  return null;
}

function hashFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFilesRecursive(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
}

function readThinMachOSemantics(raw, label) {
  if (raw.length < 32) return null;

  const magic = raw.readUInt32BE(0);
  let littleEndian;
  let is64Bit;
  if (magic === 0xcffaedfe) {
    littleEndian = true;
    is64Bit = true;
  } else if (magic === 0xcefaedfe) {
    littleEndian = true;
    is64Bit = false;
  } else if (magic === 0xfeedfacf) {
    littleEndian = false;
    is64Bit = true;
  } else if (magic === 0xfeedface) {
    littleEndian = false;
    is64Bit = false;
  } else {
    // The caller unwraps fat Mach-O containers before reaching this parser.
    return null;
  }

  const readUInt32 = (offset) => (
    littleEndian ? raw.readUInt32LE(offset) : raw.readUInt32BE(offset)
  );
  const readUInt64 = (offset) => {
    const value = littleEndian
      ? raw.readBigUInt64LE(offset)
      : raw.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`oversized Mach-O value: ${label}`);
    }
    return Number(value);
  };
  const writeUnsigned = (buffer, offset, value, width) => {
    if (width === 8) {
      if (littleEndian) buffer.writeBigUInt64LE(BigInt(value), offset);
      else buffer.writeBigUInt64BE(BigInt(value), offset);
    } else if (littleEndian) {
      buffer.writeUInt32LE(value, offset);
    } else {
      buffer.writeUInt32BE(value, offset);
    }
  };
  const headerSize = is64Bit ? 32 : 28;
  const cpuType = readUInt32(4);
  const cpuSubtype = readUInt32(8);
  const commandCount = readUInt32(16);
  const commandBytes = readUInt32(20);
  const header = Buffer.from(raw.subarray(0, headerSize));
  // codesign may add LC_CODE_SIGNATURE, changing only these two header fields.
  header.fill(0, 16, 24);

  const semanticCommands = [];
  let cursor = headerSize;
  let firstSectionOffset = raw.length;
  let signatureOffset = raw.length;
  let signatureSize = 0;
  let hasSignatureCommand = false;
  let linkedit = null;

  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > raw.length) {
      throw new Error(`truncated Mach-O load command: ${label}`);
    }
    const command = readUInt32(cursor);
    const size = readUInt32(cursor + 4);
    if (size < 8 || cursor + size > raw.length) {
      throw new Error(`invalid Mach-O load command: ${label}`);
    }

    // LC_CODE_SIGNATURE contains only signing metadata and is the sole load
    // command codesign may add to an unsigned Mach-O.
    if (command === 0x1d) {
      if (hasSignatureCommand || size !== 16) {
        throw new Error(`invalid Mach-O signature command: ${label}`);
      }
      hasSignatureCommand = true;
      signatureOffset = readUInt32(cursor + 8);
      signatureSize = readUInt32(cursor + 12);
      cursor += size;
      continue;
    }

    const normalizedCommand = Buffer.from(raw.subarray(cursor, cursor + size));
    const segmentName = raw
      .toString('ascii', cursor + 8, cursor + 24)
      .replace(/\0.*$/, '');
    if (command === 0x19) {
      if (size < 72) {
        throw new Error(`invalid 64-bit Mach-O segment: ${label}`);
      }
      const sectionCount = readUInt32(cursor + 64);
      if (72 + sectionCount * 80 > size) {
        throw new Error(`invalid 64-bit Mach-O sections: ${label}`);
      }
      if (segmentName === '__LINKEDIT') {
        if (linkedit) throw new Error(`duplicate Mach-O __LINKEDIT: ${label}`);
        linkedit = {
          command: normalizedCommand,
          fileOffset: readUInt64(cursor + 40),
          fileSize: readUInt64(cursor + 48),
          fileSizeOffset: 48,
          valueWidth: 8,
          vmSize: readUInt64(cursor + 32),
          vmSizeOffset: 32,
        };
      }
      for (let section = 0; section < sectionCount; section += 1) {
        const offset = readUInt32(cursor + 72 + section * 80 + 48);
        if (offset > 0) firstSectionOffset = Math.min(firstSectionOffset, offset);
      }
    } else if (command === 0x1) {
      if (size < 56) {
        throw new Error(`invalid 32-bit Mach-O segment: ${label}`);
      }
      const sectionCount = readUInt32(cursor + 48);
      if (56 + sectionCount * 68 > size) {
        throw new Error(`invalid 32-bit Mach-O sections: ${label}`);
      }
      if (segmentName === '__LINKEDIT') {
        if (linkedit) throw new Error(`duplicate Mach-O __LINKEDIT: ${label}`);
        linkedit = {
          command: normalizedCommand,
          fileOffset: readUInt32(cursor + 32),
          fileSize: readUInt32(cursor + 36),
          fileSizeOffset: 36,
          valueWidth: 4,
          vmSize: readUInt32(cursor + 28),
          vmSizeOffset: 28,
        };
      }
      for (let section = 0; section < sectionCount; section += 1) {
        const offset = readUInt32(cursor + 56 + section * 68 + 40);
        if (offset > 0) firstSectionOffset = Math.min(firstSectionOffset, offset);
      }
    }

    semanticCommands.push(normalizedCommand);
    cursor += size;
  }

  if (
    cursor !== headerSize + commandBytes ||
    !linkedit ||
    linkedit.fileOffset + linkedit.fileSize !== raw.length ||
    firstSectionOffset >= raw.length
  ) {
    throw new Error(`invalid Mach-O layout: ${label}`);
  }
  const vmSizeIsValid =
    linkedit.vmSize === linkedit.fileSize ||
    (
      linkedit.vmSize >= linkedit.fileSize &&
      linkedit.vmSize - linkedit.fileSize < 16_384 &&
      linkedit.vmSize % 4_096 === 0
    );
  if (!vmSizeIsValid) {
    throw new Error(`invalid Mach-O __LINKEDIT mapping: ${label}`);
  }
  if (
    hasSignatureCommand &&
    (
      signatureOffset < linkedit.fileOffset ||
      signatureSize <= 0 ||
      signatureOffset + signatureSize !== raw.length
    )
  ) {
    throw new Error(`invalid Mach-O signature extent: ${label}`);
  }

  // The bytes between load commands and the first section are alignment only.
  // Reject hidden data there before omitting it from the semantic digest.
  for (let offset = cursor; offset < firstSectionOffset; offset += 1) {
    if (raw[offset] !== 0) {
      throw new Error(`non-zero Mach-O header padding: ${label}`);
    }
  }

  // Strip the zero suffix before the signature. Linkedit payloads such as the
  // string table can legitimately end in NUL before codesign adds its own
  // alignment, so the combined suffix is not bounded to one alignment unit.
  // A non-zero mutation remains part of the semantic digest and is rejected.
  let semanticEnd = signatureOffset;
  while (semanticEnd > firstSectionOffset && raw[semanticEnd - 1] === 0) {
    semanticEnd -= 1;
  }
  if (semanticEnd < linkedit.fileOffset) {
    throw new Error(`invalid Mach-O signature padding: ${label}`);
  }

  // Normalize only the part of __LINKEDIT occupied by non-signature content.
  // The raw values above were first required to cover the exact file extent.
  const logicalLinkeditSize = semanticEnd - linkedit.fileOffset;
  writeUnsigned(
    linkedit.command,
    linkedit.vmSizeOffset,
    logicalLinkeditSize,
    linkedit.valueWidth,
  );
  writeUnsigned(
    linkedit.command,
    linkedit.fileSizeOffset,
    logicalLinkeditSize,
    linkedit.valueWidth,
  );

  const digest = createHash('sha256');
  digest.update(header);
  for (const command of semanticCommands) digest.update(command);
  digest.update(raw.subarray(firstSectionOffset, semanticEnd));
  return {
    architecture: `${cpuType}:${cpuSubtype}`,
    commandBytes,
    commandCount,
    digest: digest.digest('hex'),
    firstSectionOffset,
    hasSignature: hasSignatureCommand,
  };
}

function readMachOSemantics(filePath) {
  const raw = fs.readFileSync(filePath);
  if (raw.length < 8) return null;

  const magic = raw.readUInt32BE(0);
  let littleEndian;
  let uses64BitEntries;
  if (magic === 0xcafebabe) {
    littleEndian = false;
    uses64BitEntries = false;
  } else if (magic === 0xbebafeca) {
    littleEndian = true;
    uses64BitEntries = false;
  } else if (magic === 0xcafebabf) {
    littleEndian = false;
    uses64BitEntries = true;
  } else if (magic === 0xbfbafeca) {
    littleEndian = true;
    uses64BitEntries = true;
  } else {
    const semantics = readThinMachOSemantics(raw, filePath);
    return semantics ? [semantics] : null;
  }

  const readUInt32 = (offset) => (
    littleEndian ? raw.readUInt32LE(offset) : raw.readUInt32BE(offset)
  );
  const readUInt64 = (offset) => {
    const value = littleEndian
      ? raw.readBigUInt64LE(offset)
      : raw.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`oversized fat Mach-O value: ${filePath}`);
    }
    return Number(value);
  };
  const sliceCount = readUInt32(4);
  const entrySize = uses64BitEntries ? 32 : 20;
  const headerEnd = 8 + sliceCount * entrySize;
  if (sliceCount < 1 || sliceCount > 32 || headerEnd > raw.length) {
    throw new Error(`invalid fat Mach-O header: ${filePath}`);
  }

  const slices = [];
  let previousEnd = headerEnd;
  for (let index = 0; index < sliceCount; index += 1) {
    const entryOffset = 8 + index * entrySize;
    const cpuType = readUInt32(entryOffset);
    const cpuSubtype = readUInt32(entryOffset + 4);
    const sliceOffset = uses64BitEntries
      ? readUInt64(entryOffset + 8)
      : readUInt32(entryOffset + 8);
    const sliceSize = uses64BitEntries
      ? readUInt64(entryOffset + 16)
      : readUInt32(entryOffset + 12);
    const alignment = readUInt32(entryOffset + (uses64BitEntries ? 24 : 16));
    if (
      sliceOffset < previousEnd ||
      sliceOffset + sliceSize > raw.length ||
      alignment > 30 ||
      sliceOffset % (2 ** alignment) !== 0
    ) {
      throw new Error(`invalid fat Mach-O slice: ${filePath}`);
    }
    for (let offset = previousEnd; offset < sliceOffset; offset += 1) {
      if (raw[offset] !== 0) {
        throw new Error(`non-zero fat Mach-O padding: ${filePath}`);
      }
    }
    const semantics = readThinMachOSemantics(
      raw.subarray(sliceOffset, sliceOffset + sliceSize),
      `${filePath}[${index}]`,
    );
    if (!semantics || semantics.architecture !== `${cpuType}:${cpuSubtype}`) {
      throw new Error(`fat Mach-O architecture mismatch: ${filePath}`);
    }
    slices.push(semantics);
    previousEnd = sliceOffset + sliceSize;
  }
  for (let offset = previousEnd; offset < raw.length; offset += 1) {
    if (raw[offset] !== 0) {
      throw new Error(`non-zero fat Mach-O trailer: ${filePath}`);
    }
  }
  return slices;
}

function signatureVariantFilesMatch(leftPath, rightPath) {
  const leftSlices = readMachOSemantics(leftPath);
  const rightSlices = readMachOSemantics(rightPath);
  if (!leftSlices || !rightSlices || leftSlices.length !== rightSlices.length) return false;

  return leftSlices.every((left, index) => {
    const right = rightSlices[index];
    if (
      left.architecture !== right.architecture ||
      left.digest !== right.digest
    ) {
      return false;
    }
    if (left.hasSignature === right.hasSignature) {
      return (
        left.commandCount === right.commandCount &&
        left.commandBytes === right.commandBytes
      );
    }
    const signed = left.hasSignature ? left : right;
    const unsigned = left.hasSignature ? right : left;
    return (
      signed.commandCount === unsigned.commandCount + 1 &&
      signed.commandBytes === unsigned.commandBytes + 16
    );
  });
}

function isSignatureVariantResource(relativePath) {
  return SIGNATURE_VARIANT_RESOURCE_ROOTS.some((root) => (
    relativePath === root || relativePath.startsWith(`${root}${path.sep}`)
  ));
}

function directoryTreesMatch(leftRoot, rightRoot) {
  const visit = (leftDirectory, rightDirectory, relativeDirectory) => {
    const leftEntries = fs.readdirSync(leftDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    const rightEntries = fs.readdirSync(rightDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    if (
      leftEntries.length !== rightEntries.length ||
      leftEntries.some((entry, index) => entry.name !== rightEntries[index].name)
    ) {
      return false;
    }

    for (let index = 0; index < leftEntries.length; index += 1) {
      const leftEntry = leftEntries[index];
      const rightEntry = rightEntries[index];
      const leftPath = path.join(leftDirectory, leftEntry.name);
      const rightPath = path.join(rightDirectory, rightEntry.name);
      const relativePath = path.join(relativeDirectory, leftEntry.name);
      const leftStat = fs.lstatSync(leftPath);
      const rightStat = fs.lstatSync(rightPath);

      if (leftEntry.isDirectory() && rightEntry.isDirectory()) {
        if (
          (leftStat.mode & 0o777) !== (rightStat.mode & 0o777) ||
          !visit(leftPath, rightPath, relativePath)
        ) {
          return false;
        }
      } else if (leftEntry.isSymbolicLink() && rightEntry.isSymbolicLink()) {
        // Symlink mode bits are not portable or operationally meaningful; the
        // target entry's mode is compared separately.
        if (fs.readlinkSync(leftPath) !== fs.readlinkSync(rightPath)) return false;
      } else if (leftEntry.isFile() && rightEntry.isFile()) {
        if ((leftStat.mode & 0o777) !== (rightStat.mode & 0o777)) return false;
        if (leftStat.size === rightStat.size && hashFile(leftPath) === hashFile(rightPath)) {
          continue;
        }
        if (
          process.platform !== 'darwin' ||
          !isSignatureVariantResource(relativePath) ||
          !signatureVariantFilesMatch(leftPath, rightPath)
        ) {
          return false;
        }
      } else {
        return false;
      }
    }
    return true;
  };

  return visit(leftRoot, rightRoot, '');
}

function e2eCloneMatchesRelease(releasePackage, e2ePackage) {
  return directoryTreesMatch(releasePackage.resources, e2ePackage.resources);
}

function findUniversalMachO(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findUniversalMachO(entryPath);
      if (nested) return nested;
    } else if (entry.isFile()) {
      const semantics = readMachOSemantics(entryPath);
      if (semantics && semantics.length > 1) return entryPath;
    }
  }
  return null;
}

function verifyDarwinSignatureComparator(resources, testRoot) {
  if (process.platform !== 'darwin') return { passed: true };

  const thinSource = path.join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds',
    'darwin-x64',
    'pty.node',
  );
  const universalSource = findUniversalMachO(path.join(resources, 'python-runtime'));
  if (!universalSource) {
    return { passed: false, error: 'no universal bundled Python Mach-O found' };
  }

  let signatureAccepted = true;
  for (const [index, source] of [thinSource, universalSource].entries()) {
    const signedCopy = path.join(testRoot, `signature-variant-${index}.bin`);
    fs.copyFileSync(source, signedCopy);
    const unsignedHash = hashFile(signedCopy);
    const signResult = spawnSync(
      '/usr/bin/codesign',
      ['--force', '--sign', '-', signedCopy],
      { encoding: 'utf8', timeout: 30_000 },
    );
    if (signResult.status !== 0) {
      return {
        passed: false,
        error: [
          `source=${source}`,
          `status=${String(signResult.status)}`,
          `stdout=${signResult.stdout || ''}`,
          `stderr=${signResult.stderr || ''}`,
          signResult.error ? `error=${String(signResult.error)}` : '',
        ].filter(Boolean).join('\n'),
      };
    }
    signatureAccepted &&=
      unsignedHash !== hashFile(signedCopy) &&
      signatureVariantFilesMatch(source, signedCopy);
  }

  const signedCopy = path.join(testRoot, 'signature-variant-0.bin');
  const tamperedCopy = path.join(testRoot, 'tampered-pty.node');
  fs.copyFileSync(signedCopy, tamperedCopy);
  const tampered = fs.readFileSync(tamperedCopy);
  const [semantics] = readMachOSemantics(tamperedCopy);
  tampered[semantics.firstSectionOffset] ^= 0x01;
  fs.writeFileSync(tamperedCopy, tampered);
  const contentChangeRejected = !signatureVariantFilesMatch(thinSource, tamperedCopy);
  return {
    passed: signatureAccepted && contentChangeRejected,
    error: signatureAccepted
      ? 'signature comparator accepted a non-signature content mutation'
      : 'signature comparator rejected a codesign-only mutation',
  };
}

function requestPreview({ port, pathAndQuery }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: pathAndQuery },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

function sseChunk(content, finishReason) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-packaged-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{
      index: 0,
      delta: content ? { role: 'assistant', content } : {},
      finish_reason: finishReason,
    }],
  })}\n\n`;
}

function sseObject(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function completionObject(content) {
  return {
    id: 'chatcmpl-abu-packaged-e2e',
    object: 'chat.completion',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function toolCallsForFixture(fixture) {
  const definitions = typeof fixture === 'string'
    ? [{
      name: 'run_command',
      input: {
        command: fixture,
        cwd: process.platform === 'win32' ? os.tmpdir() : '/tmp',
        timeout: 120,
      },
    }]
    : Array.isArray(fixture) ? fixture : [fixture];
  return definitions.map((definition, index) => ({
    index,
    id: `call-${randomUUID()}`,
    type: 'function',
    function: {
      name: definition.name,
      arguments: JSON.stringify(definition.input),
    },
  }));
}

async function startOpenAiMock(responseText, toolTasks = new Map()) {
  const requests = [];
  const servedToolTasks = new Set();
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/browser-fixture') {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(`<!doctype html>
        <html>
          <head><title>Abu Packaged Browser E2E</title></head>
          <body style="min-height:1800px;margin:0;background:rgb(18,172,104);font:32px sans-serif">
            <section style="padding:48px">
              <h1>Abu Packaged Browser E2E</h1>
              <label>Query <input id="q" placeholder="Packaged query"></label>
              <button id="go" onclick="document.querySelector('#result').textContent=document.querySelector('#q').value">Go</button>
              <main id="result">Waiting</main>
            </section>
          </body>
        </html>`);
      return;
    }
    let rawBody = '';
    for await (const chunk of request) rawBody += String(chunk);

    let body = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Preserve malformed input in the smoke output if this regresses.
    }
    requests.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      pathname: requestUrl.pathname,
    });

    if (request.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unexpected packaged-smoke route' }));
      return;
    }

    const streaming = body?.stream === true;
    response.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': streaming
        ? 'text/event-stream; charset=utf-8'
        : 'application/json; charset=utf-8',
    });
    const serializedBody = JSON.stringify(body);
    const toolTask = Array.from(toolTasks.entries()).find(([taskPrompt]) =>
      !servedToolTasks.has(taskPrompt) && serializedBody.includes(taskPrompt)
    );
    if (toolTask) {
      const [taskPrompt, fixture] = toolTask;
      servedToolTasks.add(taskPrompt);
      console.log(`[packaged-smoke] serving tool fixture for ${taskPrompt}`);
      const toolCalls = toolCallsForFixture(fixture);
      if (!streaming) {
        response.end(JSON.stringify({
          id: 'chatcmpl-abu-packaged-tool-e2e',
          object: 'chat.completion',
          created: 0,
          model: TEST_MODEL_ID,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: call.type,
                function: call.function,
              })),
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      response.write(sseObject({
        id: 'chatcmpl-abu-packaged-tool-e2e',
        object: 'chat.completion.chunk',
        created: 0,
        model: TEST_MODEL_ID,
        choices: [{
          index: 0,
          delta: {
            tool_calls: toolCalls,
          },
          finish_reason: null,
        }],
      }));
      response.write(sseObject({
        id: 'chatcmpl-abu-packaged-tool-e2e',
        object: 'chat.completion.chunk',
        created: 0,
        model: TEST_MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }));
      response.end('data: [DONE]\n\n');
      return;
    }
    if (!streaming) {
      response.end(JSON.stringify(completionObject(responseText)));
      return;
    }
    // A single canonical assistant delta keeps this packaging smoke focused
    // on the app/sidecar boundary instead of depending on CI timer scheduling
    // between synthetic chunks. Adapter chunk-splitting remains unit-tested.
    response.write(sseChunk(responseText, 'stop'));
    response.end('data: [DONE]\n\n');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The packaged-smoke mock did not receive a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    browserUrl: `http://127.0.0.1:${address.port}/browser-fixture?run=${randomUUID()}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function configureLocalMockProvider(window, baseUrl) {
  await window.getByPlaceholder(CHAT_PLACEHOLDER).waitFor({
    state: 'visible',
    timeout: READY_TIMEOUT,
  });
  await window.evaluate(({ mockBaseUrl, testApiKey, testModelId }) => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before packaged-smoke setup');
    const persisted = JSON.parse(raw);
    const state = persisted.state;
    state.providers = [{
      id: 'abu-packaged-e2e-provider',
      source: 'custom',
      name: 'Abu packaged E2E loopback mock',
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl: mockBaseUrl,
      apiKey: testApiKey,
      models: [{
        id: testModelId,
        label: 'Abu packaged E2E deterministic model',
        isCustom: true,
        declaredCapabilities: { supportsTools: false },
      }],
      defaultModelId: testModelId,
      status: 'verified',
      sortOrder: 0,
      userAdded: true,
      declaredCapabilities: { supportsTools: false },
    }];
    state.activeModel = {
      providerId: 'abu-packaged-e2e-provider',
      modelId: testModelId,
    };
    state.recentModels = [];
    state.favoriteModels = [];
    state.permissionMode = 'autonomous';
    state.guideShown = true;
    state.guideOpen = false;
    state.hasAcknowledgedDisclaimer = true;
    state.hasRunSensitiveAudit_v015 = true;
    window.localStorage.setItem(
      'abu-settings',
      JSON.stringify({ ...persisted, state, version: 42 }),
    );
  }, {
    mockBaseUrl: baseUrl,
    testApiKey: TEST_API_KEY,
    testModelId: TEST_MODEL_ID,
  });
  await window.reload();
  await window.getByPlaceholder(CHAT_PLACEHOLDER).waitFor({
    state: 'visible',
    timeout: READY_TIMEOUT,
  });
}

async function enableMockProviderTools(window) {
  await window.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings missing while enabling packaged tool fixture');
    const persisted = JSON.parse(raw);
    const state = persisted.state;
    state.providers = state.providers.map((provider) => {
      if (provider.id !== 'abu-packaged-e2e-provider') return provider;
      return {
        ...provider,
        declaredCapabilities: { ...provider.declaredCapabilities, supportsTools: true },
        models: provider.models.map((model) => ({
          ...model,
          declaredCapabilities: { ...model.declaredCapabilities, supportsTools: true },
        })),
      };
    });
    window.localStorage.setItem('abu-settings', JSON.stringify({ ...persisted, state }));
  });
  await window.reload();
  await window.getByPlaceholder(CHAT_PLACEHOLDER).waitFor({
    state: 'visible',
    timeout: READY_TIMEOUT,
  });
}

async function waitUntil(predicate, description, timeoutMs = READY_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForChatIdle(window) {
  const stopButton = window.locator(STOP_BUTTON_SELECTOR).last();
  await waitUntil(
    async () => {
      try {
        return !(await stopButton.isVisible());
      } catch {
        return true;
      }
    },
    'the packaged chat task to become idle',
  );
}

function findToolFollowup(requests, startIndex, prompt, minimumToolMessages) {
  return requests.slice(startIndex).find((candidate) => {
    const serialized = JSON.stringify(candidate.body);
    const messages = candidate.body?.messages;
    return (
      serialized.includes(prompt) &&
      Array.isArray(messages) &&
      messages.filter((message) => message?.role === 'tool').length >= minimumToolMessages
    );
  });
}

function diskContains(rootDir, expectedText, fileName = 'messages.jsonl') {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) return diskContains(entryPath, expectedText, fileName);
    if (entry.name !== fileName) return false;
    try {
      return fs.readFileSync(entryPath, 'utf8').includes(expectedText);
    } catch {
      return false;
    }
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForPidDead(pid, description, timeoutMs = 15_000) {
  await waitUntil(() => !pidAlive(pid), description, timeoutMs);
}

function shellQuote(value) {
  const text = String(value);
  if (process.platform === 'win32') {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function pathIsWithin(candidate, root) {
  if (!candidate) return false;
  let resolvedCandidate = path.resolve(candidate);
  let resolvedRoot = path.resolve(root);
  if (process.platform === 'win32') {
    resolvedCandidate = resolvedCandidate.toLowerCase();
    resolvedRoot = resolvedRoot.toLowerCase();
  }
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(resolvedRoot + path.sep)
  );
}

function taggedTreeProbeScript(resultPath) {
  return `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const marker = process.argv[1];
    const child = cp.spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', marker],
      { stdio: 'ignore' },
    );
    if (!Number.isInteger(child.pid)) throw new Error('command child did not start');
    fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
      pid: process.pid,
      childPid: child.pid,
      marker,
    }));
    setInterval(() => {}, 1000);
  `;
}

function longRunningTreeCommand(resultPath, marker) {
  const script = taggedTreeProbeScript(resultPath);
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  // Use the same opaque PowerShell-safe shape as the bundled-runtime probe
  // above. Passing a multiline `node -e` source directly works in POSIX
  // shells but can be reparsed before reaching node.exe on Windows. Remove the
  // encoded payload from argv so the decoded probe continues to receive its
  // marker at process.argv[1].
  const loader = [
    'const encoded = process.argv[1]',
    'process.argv.splice(1, 1)',
    "eval(Buffer.from(encoded, 'base64').toString('utf8'))",
  ].join(';');
  return `node -e ${shellQuote(loader)} ${shellQuote(encoded)} ${shellQuote(marker)}`;
}

function markerProcesses(marker) {
  if (process.platform === 'win32') {
    const powershell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `$marker = ${shellQuote(marker)}`,
      '$items = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ("*" + $marker + "*") } | Select-Object ProcessId, CommandLine)',
      '$items | ConvertTo-Json -Compress',
    ].join('; ');
    const result = spawnSync(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) {
      throw new Error(
        `Windows marker process query failed (${String(result.status)}): ${result.stderr.trim()}`,
      );
    }
    if (!result.stdout.trim()) return [];
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({
      pid: Number(row.ProcessId),
      command: String(row.CommandLine || ''),
    }));
  }
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/s);
    if (!match || !match[2].includes(marker)) return [];
    return [{ pid: Number(match[1]), command: match[2] }];
  });
}

function readLiveTaggedTree(resultPath, marker, description) {
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (result.marker !== marker) {
    throw new Error(`${description} marker mismatch: ${JSON.stringify(result)}`);
  }
  assertLiveTaggedPid(result.pid, marker, `${description} parent`);
  assertLiveTaggedPid(result.childPid, marker, `${description} child`);
  const processes = markerProcesses(marker);
  const pids = new Set(processes.map((entry) => entry.pid));
  if (!pids.has(result.pid) || !pids.has(result.childPid)) {
    throw new Error(`${description} marker tree was incomplete: ${JSON.stringify(processes)}`);
  }
  return { ...result, processes };
}

async function waitForMarkerGone(marker, description) {
  await waitUntil(
    () => markerProcesses(marker).length === 0,
    `${description} to leave no marker processes`,
    15_000,
  );
}

async function cleanupMarkerProcesses(marker) {
  const terminate = (signal) => {
    for (const entry of markerProcesses(marker)) {
      if (entry.pid === process.pid) continue;
      try {
        process.kill(entry.pid, signal);
      } catch {
        // The process may have exited between enumeration and termination.
      }
    }
  };
  terminate('SIGTERM');
  try {
    await waitForMarkerGone(marker, 'packaged smoke cleanup');
  } catch {
    terminate('SIGKILL');
    await waitForMarkerGone(marker, 'forced packaged smoke cleanup');
  }
}

function commandResultPaths(testRoot, name) {
  const id = `${name}-${randomUUID()}`;
  return {
    resultPath: path.join(testRoot, `${id}.json`),
    marker: `${id}-marker`,
  };
}

function bareRuntimeProbeCommand() {
  const script = `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const envPath = process.env.PATH || process.env.Path || '';
    const resolveCommand = (command) => {
      const extensions = process.platform === 'win32'
        ? ['', '.cmd', '.exe', '.bat']
        : [''];
      for (const directory of envPath.split(path.delimiter)) {
        for (const extension of extensions) {
          const candidate = path.join(directory, command + extension);
          try {
            if (fs.statSync(candidate).isFile()) return candidate;
          } catch {
            // Continue through the production runtime PATH.
          }
        }
      }
      return '';
    };
    const nodeRoot = process.platform === 'win32'
      ? path.dirname(process.execPath)
      : path.resolve(path.dirname(process.execPath), '..');
    const npmCli = path.join(
      nodeRoot,
      process.platform === 'win32'
        ? 'node_modules/npm/bin/npm-cli.js'
        : 'lib/node_modules/npm/bin/npm-cli.js',
    );
    const npxCli = path.join(
      nodeRoot,
      process.platform === 'win32'
        ? 'node_modules/npm/bin/npx-cli.js'
        : 'lib/node_modules/npm/bin/npx-cli.js',
    );
    const runCli = (cli) => {
      const result = cp.spawnSync(process.execPath, [cli, '--version'], {
        encoding: 'utf8',
        shell: false,
      });
      if (result.status !== 0) {
        throw new Error(cli + ' failed: ' + (result.stderr || result.error || result.status));
      }
      return result.stdout.trim();
    };
    const payload = JSON.stringify({
      executable: process.execPath,
      nodeOptions: process.env.NODE_OPTIONS || null,
      path: envPath,
      npmWrapperPath: resolveCommand('npm'),
      npxWrapperPath: resolveCommand('npx'),
      npmPath: npmCli,
      npxPath: npxCli,
      npm: runCli(npmCli),
      npx: runCli(npxCli),
    });
    process.stdout.write(
      ${JSON.stringify(CHAT_RUNTIME_PROBE_PREFIX)} +
      Buffer.from(payload, 'utf8').toString('base64'),
    );
  `;
  // Keep the PowerShell command a single opaque line. Encoding avoids
  // platform-specific quote/newline parsing while still resolving bare
  // `node` through the production bundled PATH.
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  // PowerShell removes double quotes while serializing arguments for a native
  // Windows executable. Single quotes survive that native argv boundary and
  // remain JavaScript string delimiters for Node's `-e` source.
  const loader = "eval(Buffer.from(process.argv[1], 'base64').toString('utf8'))";
  return `node -e ${shellQuote(loader)} ${shellQuote(encoded)}`;
}

function runtimeProbeFromFollowup(followup) {
  const toolPayload = JSON.stringify(
    followup?.body?.messages?.filter((message) => message?.role === 'tool') ?? [],
  );
  const match = toolPayload.match(
    new RegExp(`${CHAT_RUNTIME_PROBE_PREFIX}([A-Za-z0-9+/=]+)`),
  );
  if (!match) {
    throw new Error(`real Chat runtime probe returned no payload: ${toolPayload}`);
  }
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

function pidCommandLine(pid) {
  if (process.platform === 'win32') {
    const powershell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const result = spawnSync(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
    ], { encoding: 'utf8', timeout: 10_000 });
    return result.status === 0 ? result.stdout.trim() : '';
  }
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function assertLiveTaggedPid(pid, marker, description) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`${description} returned invalid pid ${String(pid)}`);
  }
  if (!pidAlive(pid)) {
    throw new Error(`${description} pid ${pid} was not alive before cleanup`);
  }
  const commandLine = pidCommandLine(pid);
  if (!commandLine.includes(marker)) {
    throw new Error(
      `${description} pid ${pid} did not carry marker ${marker}: ${JSON.stringify(commandLine)}`,
    );
  }
}

function createHostRuntimeTrap(testRoot) {
  const dir = path.join(testRoot, 'host-runtime-trap');
  const marker = path.join(testRoot, 'HOST_RUNTIME_WAS_USED');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['node', 'nodejs', 'npm', 'npx', 'python', 'python3', 'py']) {
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(dir, `${name}.cmd`),
        `@echo ${name}>>"${marker}"\r\n@exit /b 97\r\n`,
      );
    } else {
      const executable = path.join(dir, name);
      fs.writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s\\n' ${shellQuote(name)} >> ${shellQuote(marker)}\nexit 97\n`,
      );
      fs.chmodSync(executable, 0o755);
    }
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const systemPaths = process.platform === 'win32'
    ? [
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      path.join(systemRoot, 'System32'),
      systemRoot,
    ]
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return {
    dir,
    marker,
    cleanPath: [dir, ...systemPaths].join(path.delimiter),
  };
}

function cleanPackagedEnvironment(runtimeTrap) {
  const env = { ...process.env };
  const removed = new Set([
    'electron_run_as_node',
    'node_channel_fd',
    'node_extra_ca_certs',
    'node_options',
    'node_path',
    'node_repl_history',
    'npm_config_globalconfig',
    'npm_config_prefix',
    'npm_config_userconfig',
    'npm_execpath',
    'npm_node_execpath',
    'nvm_bin',
    'nvm_dir',
    'pythonhome',
    'pythoninspect',
    'pythonpath',
    'pythonstartup',
    'pythonuserbase',
    'pyenv_root',
    'virtual_env',
  ]);
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (normalized === 'path' || removed.has(normalized)) delete env[key];
  }
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = runtimeTrap.cleanPath;
  return env;
}

async function spawnPackagedMcpTree(window, resultPath, runtimeTrap, idPrefix) {
  const id = `${idPrefix}-${randomUUID()}`;
  const marker = `${id}-marker`;
  const probeScript = `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const marker = process.argv[1];
    const child = cp.spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', marker],
      { stdio: 'ignore' },
    );
    if (!Number.isInteger(child.pid)) throw new Error('MCP child did not start');
    fs.writeFileSync(
      ${JSON.stringify(resultPath)},
      JSON.stringify({
        executable: process.execPath,
        pid: process.pid,
        childPid: child.pid,
        marker,
      }),
    );
    setInterval(() => {}, 1000);
  `;
  await window.evaluate(
    ({ mcpId, script, processMarker, pathKey, cleanPath }) =>
      window.__TAURI_INTERNALS__.invoke('mcp_spawn', {
        id: mcpId,
        command: 'node',
        args: ['-e', script, processMarker],
        env: { [pathKey]: cleanPath },
      }),
    {
      mcpId: id,
      script: probeScript,
      processMarker: marker,
      pathKey: process.platform === 'win32' ? 'Path' : 'PATH',
      cleanPath: runtimeTrap.cleanPath,
    },
  );
  await waitUntil(() => fs.existsSync(resultPath), `${idPrefix} MCP runtime probe`);
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (result.marker !== marker) {
    throw new Error(`${idPrefix} MCP marker mismatch: ${JSON.stringify(result)}`);
  }
  assertLiveTaggedPid(result.pid, marker, `${idPrefix} MCP parent`);
  assertLiveTaggedPid(result.childPid, marker, `${idPrefix} MCP child`);
  return { id, ...result };
}

async function createRendererMcpClient(window, mcpId, env) {
  const stashKey = `__abuPackagedMcp_${randomUUID().replaceAll('-', '')}`;
  await window.evaluate(
    async ({ eventName, key }) => {
      globalThis[key] = [];
      const callbackId = window.__TAURI_INTERNALS__.transformCallback((entry) => {
        globalThis[key].push(entry.payload);
      });
      await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
        event: eventName,
        target: { kind: 'Any' },
        handler: callbackId,
      });
    },
    { eventName: `mcp-msg-${mcpId}`, key: stashKey },
  );
  await window.evaluate(
    ({ id, childEnv }) => window.__TAURI_INTERNALS__.invoke('mcp_spawn', {
      id,
      command: 'abu-browser-runtime',
      args: [],
      env: childEnv,
    }),
    { id: mcpId, childEnv: env },
  );

  let nextId = 1;
  const write = (message) => window.evaluate(
    ({ id, line }) => window.__TAURI_INTERNALS__.invoke('mcp_write', {
      id,
      message: JSON.stringify(line),
    }),
    { id: mcpId, line: message },
  );
  const request = async (method, params) => {
    const id = nextId++;
    await write({ jsonrpc: '2.0', id, method, params });
    let matched;
    await waitUntil(async () => {
      const lines = await window.evaluate((key) => globalThis[key] || [], stashKey);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            matched = parsed;
            return true;
          }
        } catch {
          // Ignore non-RPC diagnostics; the matching response remains required.
        }
      }
      return false;
    }, `packaged browser MCP response for ${method}`);
    if (matched.error) {
      throw new Error(`packaged browser MCP ${method} failed: ${JSON.stringify(matched.error)}`);
    }
    return matched.result;
  };
  return {
    request,
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    write,
    kill: () => window.evaluate(
      (id) => window.__TAURI_INTERNALS__.invoke('mcp_kill', { id }),
      mcpId,
    ),
  };
}

function mcpText(result) {
  const entry = result?.content?.find?.((item) => item?.type === 'text');
  if (!entry || typeof entry.text !== 'string' || entry.text.startsWith('Error:')) {
    throw new Error(`unexpected MCP text result: ${JSON.stringify(result)}`);
  }
  return entry.text;
}

function isPngBase64(value) {
  if (typeof value !== 'string' || value.length < 1000) return false;
  const bytes = Buffer.from(value.replace(/^data:image\/png;base64,/, ''), 'base64');
  return bytes.length > 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

async function inspectPackagedBrowserView(app, tabId, screenshotData) {
  return app.evaluate(
    async (
      {
        app: electronApp,
        BrowserWindow,
        desktopCapturer,
        nativeImage,
        screen,
        systemPreferences,
      },
      { targetTabId, pngBase64 },
    ) => {
      const analyze = (image) => {
        const size = image.getSize();
        const bitmap = image.toBitmap();
        let fixturePixels = 0;
        for (let index = 0; index + 3 < bitmap.length; index += 4) {
          const first = bitmap[index];
          const green = bitmap[index + 1];
          const third = bitmap[index + 2];
          const colorMatches =
            green >= 130 &&
            green - first >= 35 &&
            green - third >= 35;
          if (colorMatches) fixturePixels += 1;
        }
        return { ...size, fixturePixels };
      };
      const windows = BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed());
      const mainWindow = windows.find((candidate) => candidate.isVisible()) ?? windows[0];
      if (!mainWindow) throw new Error('packaged browser inspection found no BrowserWindow');

      const findView = (view) => {
        if (view?.webContents?.id === targetTabId) return view;
        for (const child of view?.children ?? []) {
          const match = findView(child);
          if (match) return match;
        }
        return null;
      };
      const browserView = findView(mainWindow.contentView);
      if (!browserView) {
        throw new Error(`packaged browser inspection found no view for tab ${targetTabId}`);
      }
      const bounds = browserView.getBounds();
      const contentBounds = mainWindow.getContentBounds();
      const intersection = {
        width: Math.max(
          0,
          Math.min(bounds.x + bounds.width, contentBounds.width) - Math.max(bounds.x, 0),
        ),
        height: Math.max(
          0,
          Math.min(bounds.y + bounds.height, contentBounds.height) - Math.max(bounds.y, 0),
        ),
      };

      const screenshot = nativeImage.createFromBuffer(
        Buffer.from(pngBase64.replace(/^data:image\/png;base64,/, ''), 'base64'),
      );
      let windowComposite = null;
      let compositeError = '';
      let windowCompositeTrusted = false;
      let screenCaptureGranted = false;
      let compositeSourceType = 'window';
      let compositeSourceId = '';
      let windowCompositePng = '';
      if (process.platform === 'darwin') {
        try {
          screenCaptureGranted =
            systemPreferences.getMediaAccessStatus('screen') === 'granted';
        } catch {
          screenCaptureGranted = false;
        }
      }
      try {
        const windowBounds = mainWindow.getBounds();
        electronApp.focus({ steal: true });
        mainWindow.show();
        mainWindow.focus();
        mainWindow.moveTop();
        await new Promise((resolve) => setTimeout(resolve, 200));

        if (process.platform === 'darwin' && screenCaptureGranted) {
          compositeSourceType = 'screen';
          const display = screen.getDisplayMatching(windowBounds);
          const displays = screen.getAllDisplays();
          const displayIndex = displays.findIndex((candidate) => candidate.id === display.id);
          const scaleFactor = Math.max(Number(display.scaleFactor) || 1, 1);
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
              width: Math.max(Math.round(display.size.width * scaleFactor), 1),
              height: Math.max(Math.round(display.size.height * scaleFactor), 1),
            },
            fetchWindowIcons: false,
          });
          const compositeSource =
            sources.find((source) => source.display_id === String(display.id)) ??
            sources[displayIndex] ??
            sources[0];
          if (compositeSource) {
            // TCC status alone is not proof that desktopCapturer produced an
            // authoritative screen image. Only make composition mandatory
            // after Electron returns a concrete source, matching Windows.
            windowCompositeTrusted = true;
            compositeSourceId = `${compositeSource.id}:${compositeSource.display_id}`;
            const sourceSize = compositeSource.thumbnail.getSize();
            const scaleX = sourceSize.width / display.bounds.width;
            const scaleY = sourceSize.height / display.bounds.height;
            const x = Math.max(
              0,
              Math.round((windowBounds.x - display.bounds.x) * scaleX),
            );
            const y = Math.max(
              0,
              Math.round((windowBounds.y - display.bounds.y) * scaleY),
            );
            const width = Math.min(
              Math.max(Math.round(windowBounds.width * scaleX), 1),
              sourceSize.width - x,
            );
            const height = Math.min(
              Math.max(Math.round(windowBounds.height * scaleY), 1),
              sourceSize.height - y,
            );
            if (width > 0 && height > 0) {
              const cropped = compositeSource.thumbnail.crop({ x, y, width, height });
              windowComposite = analyze(cropped);
              if (windowComposite.fixturePixels < 500) {
                windowCompositePng = cropped.toPNG().toString('base64');
              }
            }
          } else {
            compositeError = 'screen capture was granted but returned no desktop source';
          }
        } else if (process.platform !== 'darwin') {
          const mediaSourceId = mainWindow.getMediaSourceId();
          const sources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: {
              width: Math.max(windowBounds.width * 2, 1),
              height: Math.max(windowBounds.height * 2, 1),
            },
            fetchWindowIcons: false,
          });
          const compositeSource = sources.find((source) => source.id === mediaSourceId);
          if (compositeSource) {
            // GitHub's non-interactive Windows runner can expose no capturable
            // top-level windows. Treat composition as authoritative only when
            // Electron actually returned this window as a desktop source.
            windowCompositeTrusted = true;
            compositeSourceId = `${compositeSource.id}:${compositeSource.display_id}`;
            windowComposite = analyze(compositeSource.thumbnail);
          }
        }
      } catch (error) {
        // macOS denies desktopCapturer without Screen Recording/TCC, and
        // service-hosted Windows runners may have no interactive desktop.
        // Exact View draw state remains mandatory; system composition is an
        // additive check only when the OS returned an authoritative source.
        compositeError = String(error);
      }
      return {
        bounds,
        contentSize: {
          width: contentBounds.width,
          height: contentBounds.height,
        },
        intersection,
        drawn: browserView.getVisible(),
        mcpScreenshot: analyze(screenshot),
        windowComposite,
        windowCompositeTrusted,
        compositeSourceType,
        compositeSourceId,
        windowCompositePng,
        compositeError,
      };
    },
    { targetTabId: tabId, pngBase64: screenshotData },
  );
}

async function runPackagedBrowserFlow(app, window, browserUrl, runtimeTrap) {
  const mcpId = `packaged-browser-${randomUUID()}`;
  const client = await createRendererMcpClient(window, mcpId, {
    [process.platform === 'win32' ? 'Path' : 'PATH']: runtimeTrap.cleanPath,
  });
  let killed = false;
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'abu-packaged-browser-e2e', version: '0.0.0' },
    });
    await client.notify('notifications/initialized', {});

    const tabs = JSON.parse(mcpText(await client.request('tools/call', {
      name: 'get_tabs',
      arguments: {},
    })));
    const tabId = tabs?.summary?.currentTabId;
    if (!Number.isInteger(tabId)) {
      throw new Error(`packaged browser runtime did not return a tab id: ${JSON.stringify(tabs)}`);
    }

    await client.request('tools/call', {
      name: 'navigate',
      arguments: { tabId, url: browserUrl, action: 'goto' },
    });
    const address = window.getByPlaceholder(/输入网址或搜索|Enter a URL or search/);
    await address.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
    await waitUntil(
      async () => (await address.inputValue()) === browserUrl,
      'the packaged browser tab to expose its navigated URL',
    );

    const snapshot = JSON.parse(mcpText(await client.request('tools/call', {
      name: 'snapshot',
      arguments: { tabId },
    })));
    const hasInput = snapshot?.elements?.some?.((element) => element.tag === 'input');
    const hasButton = snapshot?.elements?.some?.((element) => element.tag === 'button');
    if (!hasInput || !hasButton) {
      throw new Error(`packaged browser snapshot lacked fixture controls: ${JSON.stringify(snapshot)}`);
    }

    const value = `packaged-browser-value-${randomUUID()}`;
    await client.request('tools/call', {
      name: 'fill',
      arguments: { tabId, locator: JSON.stringify({ css: '#q' }), value },
    });
    await client.request('tools/call', {
      name: 'click',
      arguments: { tabId, locator: JSON.stringify({ css: '#go' }) },
    });
    const extracted = mcpText(await client.request('tools/call', {
      name: 'extract_text',
      arguments: { tabId, selector: '#result' },
    }));
    if (extracted !== value) {
      throw new Error(`packaged browser DOM round trip returned ${JSON.stringify(extracted)}`);
    }

    const screenshot = await client.request('tools/call', {
      name: 'screenshot',
      arguments: { tabId },
    });
    const image = screenshot?.content?.find?.((entry) => entry?.type === 'image');
    if (image?.mimeType !== 'image/png' || !isPngBase64(image.data)) {
      throw new Error(`packaged browser screenshot was not PNG: ${JSON.stringify(screenshot)}`);
    }
    const view = await inspectPackagedBrowserView(app, tabId, image.data);
    const windowCompositePng = view.windowCompositePng;
    delete view.windowCompositePng;
    const viewPixelCount = view.mcpScreenshot.width * view.mcpScreenshot.height;
    const viewArea = view.bounds.width * view.bounds.height;
    const intersectionArea = view.intersection.width * view.intersection.height;
    const visibleTabAdopted =
      view.drawn === true &&
      view.bounds.width >= 200 &&
      view.bounds.height >= 200 &&
      view.mcpScreenshot.width >= 200 &&
      view.mcpScreenshot.height >= 200 &&
      view.intersection.width >= 200 &&
      view.intersection.height >= 200 &&
      intersectionArea >= viewArea * 0.8 &&
      view.mcpScreenshot.fixturePixels >= viewPixelCount * 0.2 &&
      (
        !view.windowCompositeTrusted ||
        (
          view.windowComposite !== null &&
          view.windowComposite.fixturePixels >= 500
        )
      );
    if (!visibleTabAdopted) {
      let artifact = '';
      if (windowCompositePng) {
        artifact = path.join(os.tmpdir(), 'abu-packaged-browser-composite.png');
        fs.writeFileSync(artifact, Buffer.from(windowCompositePng, 'base64'));
      }
      throw new Error(
        `packaged browser view was not visibly composed: ${JSON.stringify(view)}` +
        (artifact ? `; composite=${artifact}` : ''),
      );
    }

    await client.kill();
    killed = true;
    let rejectedAfterKill = false;
    try {
      await client.write({ jsonrpc: '2.0', id: 99_999, method: 'tools/list', params: {} });
    } catch (error) {
      rejectedAfterKill = /no live process/i.test(String(error));
    }
    if (!rejectedAfterKill) {
      throw new Error('packaged browser MCP still accepted input after mcp_kill');
    }

    return {
      initialized:
        typeof initialized?.protocolVersion === 'string' &&
        initialized?.serverInfo?.name === 'abu-electron-browser-runtime',
      visibleTabAdopted,
      domRoundTrip: true,
      screenshot: true,
      stopped: true,
    };
  } finally {
    if (!killed) {
      try {
        await client.kill();
      } catch {
        // Best-effort cleanup; the caller records the original browser failure.
      }
    }
  }
}

async function closePackagedApp(app, knownChild) {
  if (!app && !knownChild) return 'not-running';
  let child = knownChild;
  if (!child && app) {
    try {
      child = app.process();
    } catch {
      // A crashed Electron process can close Playwright's transport first.
    }
  }
  if (app) {
    try {
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
    } catch {
      // Playwright commonly loses its transport before quit() returns.
    }
  }
  if (!child) return 'connection-closed';
  if (await waitForChildExit(child, 5_000)) {
    return child.signalCode === null && child.exitCode === 0
      ? 'quit'
      : `unexpected-exit:${String(child.exitCode)}:${String(child.signalCode)}`;
  }
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 3_000)) return 'sigterm';
  child.kill('SIGKILL');
  return await waitForChildExit(child, 2_000) ? 'sigkill' : 'stuck';
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function waitForPidExit(pid, timeoutMs) {
  await waitUntil(
    () => !pidAlive(pid),
    `process ${pid} to exit`,
    timeoutMs,
  );
}

function launchPackagedApp(found, userDataDir, appDataDir, runtimeTrap, expectMigration = false) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(appDataDir, { recursive: true });
  const env = {
    ...cleanPackagedEnvironment(runtimeTrap),
    [E2E_APP_DATA_ROOT_ENV]: appDataDir,
    [PACKAGED_E2E_ENV]: '1',
  };
  if (expectMigration) {
    // The production auto-confirm guard requires the generic CI marker plus
    // both Abu-specific harness markers. Set all three here so the packaged
    // migration smoke behaves identically when run locally and on Actions.
    env.CI = 'true';
    env[E2E_AUTO_CONFIRM_TRANSITION_ENV] = '1';
  }
  return electron.launch({
    executablePath: found.bin,
    args: [`--user-data-dir=${userDataDir}`],
    env,
    timeout: 60_000,
  });
}

async function waitForMainWindow(app, firstWindow, expectMigration) {
  if (!expectMigration) return firstWindow;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      const url = candidate.url();
      if (url.includes('/dist-electron-spike/index.html')) {
        return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('transition build did not open the real Abu main window');
}

async function main() {
  const expectMigration = process.env[EXPECT_TAURI_MIGRATION_ENV] === 'true';
  const releasePackage = findPackagedApp(OUT);
  if (!releasePackage) {
    console.error(
      `[packaged-smoke] no packaged app found under ${OUT}/ — run \`npm run pack:electron\` first`
    );
    process.exit(1);
  }
  const found = findPackagedApp(E2E_OUT);
  if (!found) {
    console.error(
      `[packaged-smoke] no pre-fuse E2E clone found under ${E2E_OUT}/ — run \`npm run pack:electron\` first`
    );
    process.exit(1);
  }
  console.log(`[packaged-smoke] release package ${releasePackage.bin}`);
  console.log(`[packaged-smoke] launching pre-fuse E2E clone ${found.bin}`);

  const checks = {};
  const errors = {};
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-packaged-e2e-'));
  try {
    const signatureComparator = verifyDarwinSignatureComparator(
      releasePackage.resources,
      testRoot,
    );
    checks.packagedSignatureComparatorVerified = signatureComparator.passed;
    if (!signatureComparator.passed) {
      errors.packagedSignatureComparator = signatureComparator.error;
    }
  } catch (err) {
    checks.packagedSignatureComparatorVerified = false;
    errors.packagedSignatureComparator = String(err);
  }
  const releaseFuseWire = await getCurrentFuseWire(releasePackage.appPath);
  const e2eFuseWire = await getCurrentFuseWire(found.appPath);
  checks.packagedRunAsNodeFuseEnabled =
    releaseFuseWire[FuseV1Options.RunAsNode] === FUSE_ENABLED &&
    e2eFuseWire[FuseV1Options.RunAsNode] === FUSE_ENABLED;
  checks.packagedNodeInjectionFusesDisabled =
    releaseFuseWire[FuseV1Options.EnableNodeOptionsEnvironmentVariable] === FUSE_DISABLED &&
    releaseFuseWire[FuseV1Options.EnableNodeCliInspectArguments] === FUSE_DISABLED;
  checks.packagedE2ECloneMatchesRelease =
    e2eFuseWire[FuseV1Options.EnableNodeOptionsEnvironmentVariable] === FUSE_ENABLED &&
    e2eFuseWire[FuseV1Options.EnableNodeCliInspectArguments] === FUSE_ENABLED &&
    e2eCloneMatchesRelease(releasePackage, found);
  const runtimeTrap = createHostRuntimeTrap(testRoot);
  const previewFixtureDir = path.join(testRoot, 'preview');
  const userDataDir = path.join(testRoot, 'user-data');
  const appDataDir = path.join(testRoot, 'app-data');
  const runtimeArtifactsDir = path.join(testRoot, 'runtime artifacts');
  const mcpRuntimePath = path.join(testRoot, 'mcp-runtime.json');
  const normalQuitMcpPath = path.join(testRoot, 'normal-quit-mcp-runtime.json');
  const migrationFixtureName = `packaged-transition-${randomUUID()}`;
  const tauriMigrationFixture = path.join(
    appDataDir,
    'com.abu.app',
    'sessions',
    migrationFixtureName,
  );
  const electronMigrationFixture = path.join(
    appDataDir,
    'com.abu.app.electron',
    'sessions',
    migrationFixtureName,
  );
  let tauriLegacySymlink = null;
  let electronLegacySymlink = null;
  if (expectMigration) {
    fs.mkdirSync(tauriMigrationFixture, { recursive: true });
    fs.writeFileSync(
      path.join(tauriMigrationFixture, 'messages.jsonl'),
      '{"role":"user","content":"tauri-packaged-source"}',
    );
    fs.mkdirSync(electronMigrationFixture, { recursive: true });
    fs.writeFileSync(
      path.join(electronMigrationFixture, 'messages.jsonl'),
      '{"role":"user","content":"electron-packaged-conflict"}',
    );
    fs.writeFileSync(
      path.join(electronMigrationFixture, 'electron-only.txt'),
      'electron-only',
    );
    if (process.platform !== 'win32') {
      const relativeTarget = '../image-size/bin/image-size.js';
      const tauriBinDir = path.join(
        tauriMigrationFixture,
        'outputs',
        'node_modules',
        '.bin',
      );
      const tauriPackageBin = path.join(
        tauriMigrationFixture,
        'outputs',
        'node_modules',
        'image-size',
        'bin',
      );
      const electronBinDir = path.join(
        electronMigrationFixture,
        'outputs',
        'node_modules',
        '.bin',
      );
      const electronPackageBin = path.join(
        electronMigrationFixture,
        'outputs',
        'node_modules',
        'image-size',
        'bin',
      );
      fs.mkdirSync(tauriBinDir, { recursive: true });
      fs.mkdirSync(tauriPackageBin, { recursive: true });
      fs.mkdirSync(electronBinDir, { recursive: true });
      fs.mkdirSync(electronPackageBin, { recursive: true });
      fs.writeFileSync(
        path.join(tauriPackageBin, 'image-size.js'),
        '#!/usr/bin/env node\n',
      );
      fs.writeFileSync(
        path.join(electronPackageBin, 'image-size.js'),
        '#!/usr/bin/env node\n',
      );
      tauriLegacySymlink = path.join(tauriBinDir, 'image-size');
      electronLegacySymlink = path.join(electronBinDir, 'image-size');
      fs.symlinkSync(relativeTarget, tauriLegacySymlink, 'file');
      fs.symlinkSync(
        path.resolve(tauriBinDir, relativeTarget),
        electronLegacySymlink,
        'file',
      );
      fs.writeFileSync(
        path.join(appDataDir, 'com.abu.app.electron', 'tauri-migration.json'),
        JSON.stringify({ version: 1, status: 'complete' }),
      );
    }
  }
  fs.mkdirSync(previewFixtureDir, { recursive: true });
  fs.mkdirSync(runtimeArtifactsDir, { recursive: true });
  fs.writeFileSync(
    path.join(previewFixtureDir, 'index.html'),
    '<!doctype html><html><body><main>packaged preview smoke</main></body></html>'
  );
  const prompt = `abu-packaged-prompt-${randomUUID()}`;
  const responseText = `abu-packaged-answer-${randomUUID()}`;
  const stopPrompt = `abu-packaged-stop-task-${randomUUID()}`;
  const crashPrompt = `abu-packaged-crash-task-${randomUUID()}`;
  const runtimePrompt = `abu-packaged-bare-runtime-task-${randomUUID()}`;
  const officeReadPrompt = `abu-packaged-office-read-task-${randomUUID()}`;
  const pidRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const abortTree = commandResultPaths(pidRoot, 'abu-packaged-abort');
  const timeoutTree = commandResultPaths(pidRoot, 'abu-packaged-timeout');
  const stopTree = commandResultPaths(pidRoot, 'abu-packaged-stop');
  const crashTree = commandResultPaths(pidRoot, 'abu-packaged-crash');
  const commandTrees = [abortTree, timeoutTree, stopTree, crashTree];
  const officeArtifacts = [
    { file: path.join(runtimeArtifactsDir, 'smoke.docx'), sentinel: 'Abu packaged DOCX sentinel' },
    { file: path.join(runtimeArtifactsDir, 'smoke.xlsx'), sentinel: 'Abu packaged XLSX sentinel' },
    { file: path.join(runtimeArtifactsDir, 'smoke.pptx'), sentinel: 'Abu packaged PPTX sentinel' },
    { file: path.join(runtimeArtifactsDir, 'smoke.pdf'), sentinel: 'Abu packaged PDF sentinel' },
  ];
  const officeArtifactPaths = officeArtifacts.map((artifact) => artifact.file);
  const recentTitle = `${prompt.slice(0, 30)}...`;
  const mock = await startOpenAiMock(responseText, new Map([
    [
      stopPrompt,
      longRunningTreeCommand(stopTree.resultPath, stopTree.marker),
    ],
    [
      crashPrompt,
      longRunningTreeCommand(crashTree.resultPath, crashTree.marker),
    ],
    [runtimePrompt, bareRuntimeProbeCommand()],
    [officeReadPrompt, officeArtifactPaths.map((file) => ({
      name: 'read_file',
      input: { path: file },
    }))],
  ]));

  let app;
  let appProcess;
  try {
    app = await launchPackagedApp(
      found,
      userDataDir,
      appDataDir,
      runtimeTrap,
      expectMigration,
    );
    appProcess = app.process();
    const firstWindow = await app.firstWindow({ timeout: 30_000 });
    let window = await waitForMainWindow(app, firstWindow, expectMigration);
    checks.windowOpened = Boolean(window);
    await window.waitForLoadState('domcontentloaded', { timeout: 30_000 });

    // ── main-process assertion: we launched the REAL packaged bundle ──
    // (Keep this evaluate trivial — Playwright's eval scope has no `require`, so
    // do filesystem checks below from the test process instead.)
    const isPackaged = await app.evaluate(({ app: a }) => a.isPackaged);
    checks.isPackaged = isPackaged === true;
    const packagedAppName = await app.evaluate(({ app: a }) => a.getName());
    checks.packagedProductIdentity = packagedAppName === 'Abu';
    const reportedAppData = await app.evaluate(({ app: a }) => a.getPath('appData'));
    checks.appDataIsolated = path.resolve(reportedAppData) === path.resolve(appDataDir);
    const reportedUserData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    checks.userDataIsolated =
      path.resolve(reportedUserData) ===
      path.resolve(appDataDir, 'Abu-e2e-user-data');
    const windowChrome = await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL().includes('/dist-electron-spike/index.html'));
      if (!mainWindow) return null;
      return {
        menuVisible: mainWindow.isMenuBarVisible() === true,
        menuBarAutoHide: mainWindow.isMenuBarAutoHide(),
      };
    });
    checks.packagedWindowsNativeMenuHidden =
      process.platform !== 'win32' ||
      (windowChrome?.menuVisible === false && windowChrome?.menuBarAutoHide === true);

    // Exercise the same BrowserWindow close event produced by the native ×.
    // A fresh profile defaults to "ask", so the close must reach React and
    // render an actionable prompt instead of being swallowed by main.
    await window.getByPlaceholder(CHAT_PLACEHOLDER).waitFor({
      state: 'visible',
      timeout: READY_TIMEOUT,
    });
    // A fully isolated profile legitimately opens the first-run guide after
    // persisted settings hydrate. Exercise that user-visible step before
    // checking title-bar controls; otherwise its modal backdrop correctly
    // intercepts every click and produces a false Windows interaction failure.
    const firstRunGuide = window.locator('[data-abu-guide-modal="true"]');
    await firstRunGuide.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    if (await firstRunGuide.isVisible()) {
      await firstRunGuide
        .getByRole('button', { name: /^(我知道了|Got it)$/ })
        .click();
      await firstRunGuide.waitFor({ state: 'hidden', timeout: READY_TIMEOUT });
    }
    checks.packagedFirstRunGuideHandled = !(await firstRunGuide.isVisible());
    if (process.platform === 'win32') {
      const toolbarLayout = await window.evaluate(() => {
        const titlebar = document.querySelector('[data-abu-windows-native-titlebar]');
        const titlebarSafeArea = document.querySelector('[data-abu-windows-titlebar-safe-area]');
        const toolbar = document.querySelector('[data-abu-windows-toolbar]');
        const appLayout = document.querySelector('[data-abu-app-layout]');
        const main = document.querySelector('main');
        if (!titlebar || !titlebarSafeArea || !toolbar || !appLayout || !main) return null;
        const titlebarRect = titlebar.getBoundingClientRect();
        const titlebarSafeAreaRect = titlebarSafeArea.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        const menus = [...document.querySelectorAll('[data-window-menu]')]
          .map((menu) => {
            const rect = menu.getBoundingClientRect();
            const style = getComputedStyle(menu);
            return {
              group: menu.getAttribute('data-window-menu'),
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              pointerEvents: style.pointerEvents,
              visible: rect.width > 0 && rect.height > 0,
            };
          });
        const dragRegions = [...document.querySelectorAll('[data-abu-windows-drag-region]')]
          .map((region) => {
            const rect = region.getBoundingClientRect();
            return {
              group: region.getAttribute('data-abu-windows-drag-region'),
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              appRegion: getComputedStyle(region).webkitAppRegion,
            };
          });
        const controls = [...document.querySelectorAll('[data-window-control]')]
          .map((control) => {
            const rect = control.getBoundingClientRect();
            const style = getComputedStyle(control);
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              pointerEvents: style.pointerEvents,
            };
          });
        return {
          viewportWidth: window.innerWidth,
          titlebar: {
            left: titlebarRect.left,
            right: titlebarRect.right,
            top: titlebarRect.top,
            bottom: titlebarRect.bottom,
            height: titlebarRect.height,
            background: getComputedStyle(titlebar).backgroundColor,
          },
          titlebarSafeArea: {
            left: titlebarSafeAreaRect.left,
            right: titlebarSafeAreaRect.right,
            top: titlebarSafeAreaRect.top,
            bottom: titlebarSafeAreaRect.bottom,
          },
          toolbar: {
            left: toolbarRect.left,
            right: toolbarRect.right,
            top: toolbarRect.top,
            bottom: toolbarRect.bottom,
            height: toolbarRect.height,
            background: getComputedStyle(toolbar).backgroundColor,
          },
          appPaddingTop: Number.parseFloat(getComputedStyle(appLayout).paddingTop),
          appBackground: getComputedStyle(appLayout).backgroundColor,
          toolbarBottom: toolbarRect.bottom,
          mainTop: mainRect.top,
          menus,
          dragRegions,
          controls,
        };
      });
      checks.packagedWindowsTitlebarLayout =
        toolbarLayout !== null &&
        Math.abs(toolbarLayout.titlebar.height - 36) <= 1 &&
        toolbarLayout.titlebar.background === toolbarLayout.appBackground &&
        toolbarLayout.titlebar.left >= -1 &&
        toolbarLayout.titlebar.right <= toolbarLayout.viewportWidth + 1 &&
        toolbarLayout.menus.length === 3 &&
        toolbarLayout.menus.map((menu) => menu.group).join(',') === 'edit,window,help' &&
        toolbarLayout.menus.every((menu) => (
          menu.visible &&
          menu.pointerEvents !== 'none' &&
          menu.left >= toolbarLayout.titlebarSafeArea.left - 1 &&
          menu.right <= toolbarLayout.titlebarSafeArea.right + 1 &&
          menu.top >= toolbarLayout.titlebarSafeArea.top - 1 &&
          menu.bottom <= toolbarLayout.titlebarSafeArea.bottom + 1
        )) &&
        toolbarLayout.dragRegions.length === 2 &&
        toolbarLayout.dragRegions.map((region) => region.group).join(',') === 'titlebar,toolbar' &&
        toolbarLayout.dragRegions.every((region) => (
          region.appRegion === 'drag' &&
          region.width >= 32 &&
          Math.abs(region.height - 36) <= 1
        ));
      checks.packagedWindowsToolbarLayout =
        toolbarLayout !== null &&
        Math.abs(toolbarLayout.toolbar.height - 36) <= 1 &&
        toolbarLayout.appPaddingTop <= 0.5 &&
        toolbarLayout.mainTop >= toolbarLayout.toolbarBottom + 7 &&
        toolbarLayout.toolbar.background === toolbarLayout.appBackground &&
        toolbarLayout.toolbar.left >= -1 &&
        toolbarLayout.toolbar.right <= toolbarLayout.viewportWidth + 1 &&
        toolbarLayout.controls.length >= 2 &&
        toolbarLayout.controls.every((control) => (
          control.pointerEvents !== 'none' &&
          control.left >= toolbarLayout.toolbar.left - 1 &&
          control.right <= toolbarLayout.toolbar.right + 1 &&
          control.top >= toolbarLayout.toolbar.top - 1 &&
          control.bottom <= toolbarLayout.toolbar.bottom + 1
        ));

      // CSS app-region checks cannot prove that Windows' native hit testing
      // actually starts a system move. Drag the packaged window through the
      // renderer-owned title-bar lane with the bundled native helper, assert
      // its native bounds changed, then restore the original position so the
      // rest of the smoke remains stable. DevTools mouse events stay inside
      // Chromium and cannot prove Windows' WM_NCHITTEST/HTCAPTION path.
      let dragPlan = null;
      try {
        dragPlan = await app.evaluate(({ BrowserWindow, screen }) => {
          const mainWindow = BrowserWindow.getAllWindows()
            .find((candidate) => candidate.webContents.getURL().includes('/dist-electron-spike/index.html'));
          if (!mainWindow) throw new Error('main window missing for Windows drag check');
          if (mainWindow.isMaximized() || mainWindow.isFullScreen()) {
            throw new Error('main window must be restored for Windows drag check');
          }
          const bounds = mainWindow.getBounds();
          const contentBounds = mainWindow.getContentBounds();
          const workArea = screen.getDisplayMatching(bounds).workArea;
          const roomRight = workArea.x + workArea.width - (bounds.x + bounds.width);
          const roomDown = workArea.y + workArea.height - (bounds.y + bounds.height);
          mainWindow.focus();
          mainWindow.moveTop();
          return {
            originalX: bounds.x,
            originalY: bounds.y,
            contentX: contentBounds.x,
            contentY: contentBounds.y,
            processId: process.pid,
            deltaX: roomRight >= 64 ? 48 : -48,
            deltaY: roomDown >= 48 ? 32 : -32,
          };
        });
        const dragLane = window.locator('[data-abu-windows-drag-region="titlebar"]');
        const dragBox = await dragLane.boundingBox();
        if (!dragBox || dragBox.width < 32 || dragBox.height < 20) {
          throw new Error(`Windows title-bar drag lane is unusable: ${JSON.stringify(dragBox)}`);
        }
        const startX = dragBox.x + dragBox.width / 2;
        const startY = dragBox.y + dragBox.height / 2;
        const screenStartX = Math.round(dragPlan.contentX + startX);
        const screenStartY = Math.round(dragPlan.contentY + startY);
        const dragHelperName = process.platform === 'win32' ? 'native-helper.exe' : 'native-helper';
        const dragHelperPath = path.join(found.resources, 'native-helper', dragHelperName);
        const helperResult = spawnSync(dragHelperPath, [], {
          input: `${JSON.stringify({
            id: 1,
            method: 'mouse_drag',
            params: {
              start_x: screenStartX,
              start_y: screenStartY,
              end_x: screenStartX + dragPlan.deltaX,
              end_y: screenStartY + dragPlan.deltaY,
              expected_bundle_id: 'abu.packaged-smoke',
              expected_process_id: dragPlan.processId,
            },
          })}\n`,
          encoding: 'utf8',
          timeout: 10_000,
        });
        const helperResponse = JSON.parse(String(helperResult.stdout || '').trim());
        if (helperResult.status !== 0 || helperResponse?.error) {
          throw new Error([
            `native drag helper status=${String(helperResult.status)}`,
            `response=${JSON.stringify(helperResponse)}`,
            `stderr=${JSON.stringify(helperResult.stderr || '')}`,
          ].join(' '));
        }
        await waitUntil(
          () => app.evaluate(({ BrowserWindow }, original) => {
            const mainWindow = BrowserWindow.getAllWindows()
              .find((candidate) => candidate.webContents.getURL().includes('/dist-electron-spike/index.html'));
            if (!mainWindow) return false;
            const [x, y] = mainWindow.getPosition();
            return x !== original.x || y !== original.y;
          }, { x: dragPlan.originalX, y: dragPlan.originalY }),
          'the packaged Windows title-bar drag to move the native window',
          5_000,
        );
        checks.packagedWindowsWindowDrag = true;
      } catch (err) {
        checks.packagedWindowsWindowDrag = false;
        errors.windowsWindowDrag = String(err);
      } finally {
        if (dragPlan) {
          await app.evaluate(({ BrowserWindow }, original) => {
            const mainWindow = BrowserWindow.getAllWindows()
              .find((candidate) => candidate.webContents.getURL().includes('/dist-electron-spike/index.html'));
            mainWindow?.setPosition(original.x, original.y);
          }, { x: dragPlan.originalX, y: dragPlan.originalY });
        }
      }
    } else {
      checks.packagedWindowsTitlebarLayout = true;
      checks.packagedWindowsToolbarLayout = true;
      checks.packagedWindowsWindowDrag = true;
    }

    if (process.platform === 'darwin') {
      const macToolbarLayout = await window.evaluate(() => {
        const overlay = document.querySelector('[data-abu-macos-titlebar]');
        const dragStrip = document.querySelector('[data-abu-macos-drag-strip]');
        const appLayout = document.querySelector('[data-abu-app-layout]');
        const main = document.querySelector('main');
        if (!overlay || !dragStrip || !appLayout || !main) return null;
        const overlayRect = overlay.getBoundingClientRect();
        const dragStripRect = dragStrip.getBoundingClientRect();
        const appLayoutRect = appLayout.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        return {
          overlayHeight: overlayRect.height,
          overlayPosition: getComputedStyle(overlay).position,
          overlayAppRegion: getComputedStyle(overlay).webkitAppRegion,
          dragStripHeight: dragStripRect.height,
          dragStripAppRegion: getComputedStyle(dragStrip).webkitAppRegion,
          appLayoutTop: appLayoutRect.top,
          mainTop: mainRect.top,
        };
      });
      checks.packagedMacToolbarLayout =
        macToolbarLayout !== null &&
        Math.abs(macToolbarLayout.overlayHeight - 44) <= 1 &&
        macToolbarLayout.overlayPosition === 'fixed' &&
        macToolbarLayout.overlayAppRegion !== 'drag' &&
        Math.abs(macToolbarLayout.dragStripHeight - 8) <= 1 &&
        macToolbarLayout.dragStripAppRegion === 'drag' &&
        macToolbarLayout.appLayoutTop <= 0.5 &&
        Math.abs(macToolbarLayout.mainTop - 8) <= 1;
    } else {
      checks.packagedMacToolbarLayout = true;
    }

    // Exercise all three controls on every real packaged desktop platform.
    // A drag-region regression manifests as Playwright's click being intercepted,
    // which is exactly the RC25 macOS and early Windows failure mode.
    const sidebarControl = window.locator('[data-window-control="sidebar"]');
    const initialSidebarTitle = await sidebarControl.getAttribute('title');
    if (!initialSidebarTitle) throw new Error('sidebar control label is missing');
    checks.packagedDesktopToolbarNativeHitTesting = await window.evaluate(() => {
      const controls = [...document.querySelectorAll('[data-window-control]')];
      return controls.length >= 2 && controls.every((control) => {
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        const layers = document.elementsFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return (
          getComputedStyle(control).webkitAppRegion === 'no-drag' &&
          !layers.some((layer) => (
            layer !== control &&
            !control.contains(layer) &&
            !layer.contains(control) &&
            getComputedStyle(layer).webkitAppRegion === 'drag'
          )) &&
          Boolean(hit && (hit === control || control.contains(hit)))
        );
      });
    });
    const newTaskControl = window.locator('[data-window-control="new-task"]');
    let sidebarChangedForNewTask = false;
    if (!(await newTaskControl.isVisible())) {
      await sidebarControl.click();
      await waitUntil(
        async () => (await sidebarControl.getAttribute('title')) !== initialSidebarTitle,
        'the packaged sidebar control to toggle',
      );
      await newTaskControl.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
      sidebarChangedForNewTask = true;
    }
    await newTaskControl.click();

    const searchControl = window.locator('[data-window-control="search"]');
    const searchTitle = await searchControl.getAttribute('title');
    if (!searchTitle) throw new Error('search control label is missing');
    await searchControl.click();
    const searchInput = window.getByPlaceholder(searchTitle);
    await searchInput.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
    await window.keyboard.press('Escape');
    await searchInput.waitFor({ state: 'hidden', timeout: READY_TIMEOUT });

    if (sidebarChangedForNewTask) {
      await sidebarControl.click();
      await waitUntil(
        async () => (await sidebarControl.getAttribute('title')) === initialSidebarTitle,
        'the packaged sidebar control to restore',
      );
    }
    checks.packagedDesktopToolbarControlsInteractive = true;
    await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL().includes('/dist-electron-spike/index.html'));
      if (!mainWindow) throw new Error('main window missing for native close check');
      mainWindow.close();
    });
    const nativeClosePrompt = window.getByText(
      /你想要退出应用还是最小化到系统托盘？|Would you like to quit the app or minimize to system tray\?/,
    );
    await nativeClosePrompt.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
    checks.packagedNativeClosePrompt = true;
    await window.keyboard.press('Escape');
    await nativeClosePrompt.waitFor({ state: 'hidden', timeout: READY_TIMEOUT });
    checks.packagedNativeCloseCancelKeepsWindow = await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL().includes('/dist-electron-spike/index.html'));
      return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
    });
    if (expectMigration) {
      const migratedFile = path.join(electronMigrationFixture, 'messages.jsonl');
      checks.packagedTauriSourceWins =
        fs.readFileSync(migratedFile, 'utf8') ===
        '{"role":"user","content":"tauri-packaged-source"}';
      checks.packagedTauriSourcePreserved =
        fs.readFileSync(
          path.join(tauriMigrationFixture, 'messages.jsonl'),
          'utf8',
        ) === '{"role":"user","content":"tauri-packaged-source"}';
      checks.packagedElectronOnlyPreserved =
        fs.readFileSync(
          path.join(electronMigrationFixture, 'electron-only.txt'),
          'utf8',
        ) === 'electron-only';
      const backupRoot = path.join(
        appDataDir,
        'com.abu.app.electron-backups',
      );
      const recoveredConflicts = fs.existsSync(backupRoot)
        ? listFilesRecursive(backupRoot).filter((file) => (
            file.endsWith(
              path.join(
                'sessions',
                migrationFixtureName,
                'messages.jsonl',
              ),
            ) &&
            fs.readFileSync(file, 'utf8') ===
              '{"role":"user","content":"electron-packaged-conflict"}'
          ))
        : [];
      checks.packagedElectronConflictRecoverable =
        recoveredConflicts.length >= 1;
      checks.packagedLegacySymlinkRepair =
        process.platform === 'win32' ||
        (
          tauriLegacySymlink !== null &&
          electronLegacySymlink !== null &&
          fs.readlinkSync(tauriLegacySymlink) ===
            '../image-size/bin/image-size.js' &&
          fs.readlinkSync(electronLegacySymlink) ===
            '../image-size/bin/image-size.js' &&
          fs.readFileSync(electronLegacySymlink, 'utf8') ===
            '#!/usr/bin/env node\n'
        );
      checks.packagedLegacySymlinkRepairBackedUp =
        process.platform === 'win32' ||
        (
          fs.existsSync(backupRoot) &&
          listFilesRecursive(backupRoot).some(
            (file) => path.basename(file) === 'legacy-symlink-repairs.json',
          )
        );
    }
    const packagedPath = await app.evaluate(() => process.env.PATH || process.env.Path || '');
    checks.hostRuntimePathSanitized =
      packagedPath.split(path.delimiter)[0] === runtimeTrap.dir &&
      !packagedPath.includes(path.dirname(process.execPath));

    // ── bundled resources landed under Contents/Resources ── (checked locally)
    checks.sidecarInResources = fs.existsSync(path.join(found.resources, 'sidecar', 'index.mjs'));
    checks.skillsInResources = fs.existsSync(path.join(found.resources, 'builtin-skills'));
    const helperName = process.platform === 'win32' ? 'native-helper.exe' : 'native-helper';
    const helperPath = path.join(found.resources, 'native-helper', helperName);
    checks.helperInResources = fs.existsSync(helperPath);
    const transitionReaderName =
      process.platform === 'win32'
        ? 'tauri-transition-reader.exe'
        : 'tauri-transition-reader';
    checks.transitionReaderInResources = fs.existsSync(
      path.join(found.resources, 'native-helper', transitionReaderName),
    );
    const launcherName = process.platform === 'win32' ? 'sandbox-launcher.exe' : 'sandbox-launcher';
    const launcherPath = path.join(found.resources, 'sandbox-launcher', process.platform, launcherName);
    checks.sandboxLauncherInResources = fs.existsSync(launcherPath);
    const bundledNodePath = path.join(
      found.resources,
      'node-runtime',
      process.platform === 'win32' ? 'node.exe' : 'bin/node',
    );
    checks.nodeRuntimeInResources = fs.existsSync(bundledNodePath);
    checks.pythonRuntimeInResources = fs.existsSync(path.join(
      found.resources,
      'python-runtime',
      process.platform === 'win32' ? 'python.exe' : 'bin/python3',
    ));
    checks.runtimeMetadataInResources = fs.existsSync(
      path.join(found.resources, 'runtime-metadata', 'runtime-manifest.json'),
    );
    checks.browserRuntimeInResources = fs.existsSync(
      path.join(found.resources, 'browser-runtime', 'server.mjs'),
    );
    checks.browserExtensionInResources = [
      'manifest.json',
      'background.js',
      'content.js',
    ].every((file) => fs.existsSync(path.join(found.resources, 'browser-extension', file)));
    const runtimeVerification = spawnSync(
      process.execPath,
      ['scripts/verify-electron-runtimes.mjs', '--resource-root', found.resources],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 },
    );
    checks.packagedRuntimesVerify = runtimeVerification.status === 0;
    if (!checks.packagedRuntimesVerify) {
      errors.packagedRuntimeVerification = [
        `status=${String(runtimeVerification.status)}`,
        `stdout=${runtimeVerification.stdout || ''}`,
        `stderr=${runtimeVerification.stderr || ''}`,
        runtimeVerification.error ? `error=${String(runtimeVerification.error)}` : '',
      ].filter(Boolean).join('\n');
    }
    try {
      const marker = `abu-packaged-launcher-${randomUUID()}`;
      const launcherResult = spawnSync(launcherPath, [], {
        input: JSON.stringify({
          file: bundledNodePath,
          args: ['-e', `process.stdout.write(${JSON.stringify(marker)})`],
          sandboxEnabled: false,
        }),
        encoding: 'utf8',
        timeout: 10_000,
      });
      checks.sandboxLauncherExecutes =
        launcherResult.status === 0 && launcherResult.stdout === marker;
      if (!checks.sandboxLauncherExecutes) {
        errors.sandboxLauncher = [
          `status=${String(launcherResult.status)}`,
          `signal=${String(launcherResult.signal)}`,
          `stdout=${JSON.stringify(launcherResult.stdout)}`,
          `stderr=${JSON.stringify(launcherResult.stderr)}`,
          launcherResult.error ? `error=${String(launcherResult.error)}` : '',
        ].filter(Boolean).join(' ');
      }
    } catch (err) {
      checks.sandboxLauncherExecutes = false;
      errors.sandboxLauncher = String(err);
    }
    try {
      const helperResult = spawnSync(helperPath, [], {
        input: `${JSON.stringify({ id: 1, method: 'hello', params: {} })}\n`,
        encoding: 'utf8',
        timeout: 10_000,
      });
      const response = JSON.parse(String(helperResult.stdout || '').trim());
      checks.nativeHelperHandshake = isValidNativeHelperIdentity(
        response,
        helperResult.status,
        process.platform,
      );
      if (!checks.nativeHelperHandshake) {
        errors.nativeHelperHandshake = [
          `status=${String(helperResult.status)}`,
          `stdout=${JSON.stringify(helperResult.stdout)}`,
          `stderr=${JSON.stringify(helperResult.stderr)}`,
          helperResult.error ? `error=${String(helperResult.error)}` : '',
        ].filter(Boolean).join(' ');
      }
    } catch (err) {
      checks.nativeHelperHandshake = false;
      errors.nativeHelperHandshake = String(err);
    }
    try {
      const helperResult = spawnSync(helperPath, [], {
        input: `${JSON.stringify({ id: 1, method: 'ping', params: {} })}\n`,
        encoding: 'utf8',
        timeout: 10_000,
      });
      const response = JSON.parse(String(helperResult.stdout || '').trim());
      checks.nativeHelperPing =
        helperResult.status === 0 &&
        response?.id === 1 &&
        response?.result?.pong === true;
      if (!checks.nativeHelperPing) {
        errors.nativeHelper = [
          `status=${String(helperResult.status)}`,
          `stdout=${JSON.stringify(helperResult.stdout)}`,
          `stderr=${JSON.stringify(helperResult.stderr)}`,
          helperResult.error ? `error=${String(helperResult.error)}` : '',
        ].filter(Boolean).join(' ');
      }
    } catch (err) {
      checks.nativeHelperPing = false;
      errors.nativeHelper = String(err);
    }

    // ── real packaged command path: renderer → preload → IPC → commandHost ──
    try {
      const marker = `abu-packaged-command-${randomUUID()}`;
      const commandId = `packaged-command-${randomUUID()}`;
      const commandResult = await window.evaluate(
        ({ expectedMarker, id }) => window.__TAURI_INTERNALS__.invoke(
          'run_argv_command',
          {
            program: 'node',
            args: [
              '-e',
              'process.stdout.write(JSON.stringify({ marker: process.argv[1], executable: process.execPath }))',
              expectedMarker,
            ],
            cwd: null,
            timeout: 10,
            sandboxEnabled: true,
            extraWritablePaths: [],
            networkIsolation: false,
            commandId: id,
          },
        ),
        { expectedMarker: marker, id: commandId },
      );
      const commandOutput = JSON.parse(commandResult.stdout);
      checks.packagedSandboxCommandRuns = commandResult.code === 0 && commandOutput.marker === marker;
      checks.packagedCommandUsesBundledNode = path.resolve(commandOutput.executable).startsWith(
        path.resolve(path.join(found.resources, 'node-runtime')) + path.sep,
      );

      const ptyMarker = `abu-packaged-pty-${randomUUID()}`;
      const ptyId = `packaged-pty-${randomUUID()}`;
      const ptyOutput = await window.evaluate(
        ({ id, marker, windows }) => new Promise((resolve, reject) => {
          const internals = window.__TAURI_INTERNALS__;
          let eventId;
          let output = '';
          let settled = false;
          const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
          };
          const timeout = setTimeout(async () => {
            if (settled) return;
            settled = true;
            try {
              await internals.invoke('pty_kill', { id });
              if (eventId !== undefined) {
                await internals.invoke('plugin:event|unlisten', { eventId });
              }
            } catch {
              // Preserve the original timeout as the actionable failure.
            }
            reject(new Error(`PTY did not echo marker within 15 seconds: ${output}`));
          }, 15_000);
          const callbackId = internals.transformCallback(async (event) => {
            if (settled) return;
            output += String.fromCharCode(...new Uint8Array(event.payload));
            if (!output.includes(marker)) return;
            settled = true;
            clearTimeout(timeout);
            try {
              await internals.invoke('pty_kill', { id });
              if (eventId !== undefined) {
                await internals.invoke('plugin:event|unlisten', { eventId });
              }
              resolve(output);
            } catch (error) {
              reject(error);
            }
          });

          void internals.invoke('plugin:event|listen', {
            event: `pty://data/${id}`,
            handler: callbackId,
          }).then(async (registeredEventId) => {
            eventId = registeredEventId;
            await internals.invoke('pty_spawn', { id, cols: 80, rows: 24, cwd: null });
            const command = windows
              ? `Write-Output '${marker}'; exit\r`
              : `printf '${marker}\\n'; exit\n`;
            await internals.invoke('pty_write', { id, data: command });
          }).catch((error) => {
            internals.unregisterCallback(callbackId);
            fail(error);
          });
        }),
        { id: ptyId, marker: ptyMarker, windows: process.platform === 'win32' },
      );
      checks.packagedPtyRoundTrip = ptyOutput.includes(ptyMarker);

      const abortCommandId = `packaged-abort-${randomUUID()}`;
      const abortScript = taggedTreeProbeScript(abortTree.resultPath);
      const runningCommand = window.evaluate(
        ({ id, script, marker: processMarker, writableRoot }) =>
          window.__TAURI_INTERNALS__.invoke(
          'run_argv_command',
          {
            program: 'node',
            args: ['-e', script, processMarker],
            cwd: writableRoot,
            timeout: 30,
            sandboxEnabled: true,
            extraWritablePaths: [writableRoot],
            networkIsolation: false,
            commandId: id,
          },
        ),
        {
          id: abortCommandId,
          script: abortScript,
          marker: abortTree.marker,
          writableRoot: pidRoot,
        },
      );
      await waitUntil(
        () => fs.existsSync(abortTree.resultPath),
        'the explicitly aborted command tree to start',
      );
      readLiveTaggedTree(abortTree.resultPath, abortTree.marker, 'explicit abort');
      let abortAccepted = false;
      await waitUntil(async () => {
        abortAccepted = await window.evaluate(
          (id) => window.__TAURI_INTERNALS__.invoke('abort_command', { commandId: id }),
          abortCommandId,
        );
        return abortAccepted;
      }, 'the packaged command host to accept abort_command', 10_000);
      const abortedResult = await runningCommand;
      await waitForMarkerGone(abortTree.marker, 'explicit abort');
      checks.packagedSandboxCommandAborts =
        abortAccepted === true && abortedResult.code !== 0;

      const timeoutScript = taggedTreeProbeScript(timeoutTree.resultPath);
      const timedCommand = window.evaluate(
        ({ script, marker: processMarker, writableRoot, id }) =>
          window.__TAURI_INTERNALS__.invoke('run_argv_command', {
            program: 'node',
            args: ['-e', script, processMarker],
            cwd: writableRoot,
            timeout: 3,
            sandboxEnabled: true,
            extraWritablePaths: [writableRoot],
            networkIsolation: false,
            commandId: id,
          }),
        {
          script: timeoutScript,
          marker: timeoutTree.marker,
          writableRoot: pidRoot,
          id: `packaged-timeout-${randomUUID()}`,
        },
      );
      await waitUntil(
        () => fs.existsSync(timeoutTree.resultPath),
        'the timed-out command tree to start',
      );
      readLiveTaggedTree(timeoutTree.resultPath, timeoutTree.marker, 'command timeout');
      const timeoutResult = await timedCommand;
      await waitForMarkerGone(timeoutTree.marker, 'command timeout');
      checks.packagedCommandTimeoutKillsTree = timeoutResult.code !== 0;

      const toolVersions = await window.evaluate(async () => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const run = (program) => invoke('run_argv_command', {
          program,
          args: ['--version'],
          cwd: null,
          timeout: 20,
          sandboxEnabled: false,
          extraWritablePaths: [],
          networkIsolation: false,
        });
        return {
          npm: await run('npm'),
          npx: await run('npx'),
        };
      });
      checks.packagedNpmRuns =
        toolVersions.npm.code === 0 && /^\d+\.\d+\.\d+/.test(toolVersions.npm.stdout.trim());
      checks.packagedNpxRuns =
        toolVersions.npx.code === 0 && /^\d+\.\d+\.\d+/.test(toolVersions.npx.stdout.trim());

      const pythonScript = `
import json
import pathlib
import sys
from docx import Document
from openpyxl import Workbook, load_workbook
from pptx import Presentation
from pypdf import PdfReader
from reportlab.pdfgen import canvas

root = pathlib.Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
docx_path = root / "smoke.docx"
xlsx_path = root / "smoke.xlsx"
pptx_path = root / "smoke.pptx"
pdf_path = root / "smoke.pdf"

document = Document()
document.add_paragraph("Abu packaged DOCX sentinel")
document.save(docx_path)
assert Document(docx_path).paragraphs[0].text == "Abu packaged DOCX sentinel"

workbook = Workbook()
workbook.active["A1"] = "Abu packaged XLSX sentinel"
workbook.save(xlsx_path)
assert load_workbook(xlsx_path).active["A1"].value == "Abu packaged XLSX sentinel"

presentation = Presentation()
slide = presentation.slides.add_slide(presentation.slide_layouts[6])
shape = slide.shapes.add_textbox(0, 0, 1000000, 1000000)
shape.text = "Abu packaged PPTX sentinel"
presentation.save(pptx_path)
assert len(Presentation(pptx_path).slides) == 1

pdf = canvas.Canvas(str(pdf_path))
pdf.drawString(72, 720, "Abu packaged PDF sentinel")
pdf.save()
assert len(PdfReader(pdf_path).pages) == 1

print(json.dumps({"executable": sys.executable, "files": [str(p) for p in [docx_path, xlsx_path, pptx_path, pdf_path]]}))
`;
      const pythonResult = await window.evaluate(
        ({ script, outputDir }) => window.__TAURI_INTERNALS__.invoke('run_argv_command', {
          program: 'python3',
          args: ['-I', '-c', script, outputDir],
          cwd: outputDir,
          timeout: 60,
          sandboxEnabled: true,
          extraWritablePaths: [outputDir],
          networkIsolation: false,
        }),
        { script: pythonScript, outputDir: runtimeArtifactsDir },
      );
      const pythonOutput = JSON.parse(pythonResult.stdout);
      checks.packagedPythonUsesBundledRuntime =
        pythonResult.code === 0 &&
        path.resolve(pythonOutput.executable).startsWith(
          path.resolve(path.join(found.resources, 'python-runtime')) + path.sep,
        );
      checks.packagedOfficePdfRoundTrip =
        pythonOutput.files.length === 4 &&
        pythonOutput.files.every((file) => fs.existsSync(file) && fs.statSync(file).size > 0);

      const mcpRuntime = await spawnPackagedMcpTree(
        window,
        mcpRuntimePath,
        runtimeTrap,
        'packaged-runtime',
      );
      checks.packagedMcpUsesBundledNode = path.resolve(mcpRuntime.executable).startsWith(
        path.resolve(path.join(found.resources, 'node-runtime')) + path.sep,
      );
      await window.evaluate(
        (id) => window.__TAURI_INTERNALS__.invoke('mcp_kill', { id }),
        mcpRuntime.id,
      );
      await waitForMarkerGone(mcpRuntime.marker, 'mcp_kill');
      checks.packagedMcpKillKillsTree = true;

      const updaterProbe = await window.evaluate(async () => {
        try {
          await window.__TAURI_INTERNALS__.invoke('plugin:updater|check', {});
          return { loaded: true, error: '' };
        } catch (error) {
          const message = String(error);
          return {
            loaded: !/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(message),
            error: message,
          };
        }
      });
      checks.packagedUpdaterDependenciesLoad = updaterProbe.loaded;
      if (!updaterProbe.loaded) errors.packagedUpdater = updaterProbe.error;
    } catch (err) {
      checks.packagedSandboxCommandRuns ??= false;
      checks.packagedSandboxCommandAborts ??= false;
      checks.packagedCommandTimeoutKillsTree ??= false;
      checks.packagedCommandUsesBundledNode ??= false;
      checks.packagedPtyRoundTrip ??= false;
      checks.packagedNpmRuns ??= false;
      checks.packagedNpxRuns ??= false;
      checks.packagedPythonUsesBundledRuntime ??= false;
      checks.packagedOfficePdfRoundTrip ??= false;
      checks.packagedMcpUsesBundledNode ??= false;
      checks.packagedMcpKillKillsTree ??= false;
      checks.packagedUpdaterDependenciesLoad ??= false;
      errors.packagedCommand = String(err);
    }

    // ── renderer assertion: real frontend mounted (not the placeholder) ──
    try {
      await window.waitForFunction(
        () => {
          const root = document.querySelector('#root');
          return !!root && root.children.length > 0;
        },
        { timeout: 20_000 }
      );
      checks.realFrontendRendered = true;
    } catch (err) {
      checks.realFrontendRendered = false;
      errors.frontend = String(err);
    }

    // ── packaged preview assertion: the picker must be inside app.asar ──
    try {
      const preview = await window.evaluate(async (directory) => {
        const info = await window.__TAURI_INTERNALS__.invoke('get_preview_server_info');
        const rootId = await window.__TAURI_INTERNALS__.invoke('register_preview_root', { path: directory });
        return { ...info, rootId };
      }, previewFixtureDir);
      const response = await requestPreview({
        port: preview.port,
        pathAndQuery: `/files/${preview.token}/${preview.rootId}/index.html`,
      });
      checks.previewPickerInjected =
        response.status === 200 && response.body.includes('__ABU_PREVIEW_INSPECT__');

      await window.evaluate((rootId) => window.__TAURI_INTERNALS__.invoke('unregister_preview_root', { rootId }), preview.rootId);
    } catch (err) {
      checks.previewPickerInjected = false;
      errors.preview = String(err);
    }

    // ── packaged task assertion: renderer → packaged sidecar → local mock ──
    try {
      await configureLocalMockProvider(window, mock.baseUrl);
      // Regression for the v0.37 Windows spinner: an HTML widget's `srcdoc`
      // child-frame navigation used to trigger `did-start-loading` and clear
      // the top-level renderer's sidecar subscriptions. Arm the exact failure
      // mode immediately before the real user task; the response assertion
      // below proves the packaged main→preload sidecar channel survived it.
      await window.evaluate(() => new Promise((resolve, reject) => {
        const iframe = document.createElement('iframe');
        iframe.hidden = true;
        const timeout = setTimeout(() => {
          iframe.remove();
          reject(new Error('srcdoc child frame did not load'));
        }, 5_000);
        iframe.addEventListener('load', () => {
          clearTimeout(timeout);
          iframe.remove();
          resolve(true);
        }, { once: true });
        iframe.srcdoc = '<!doctype html><title>sidecar lifecycle regression</title>';
        document.body.appendChild(iframe);
      }));
      const input = window.getByPlaceholder(CHAT_PLACEHOLDER);
      await input.fill(prompt);
      await input.press('Enter');
      await waitUntil(
        () => mock.requests.some((candidate) => JSON.stringify(candidate.body).includes(prompt)),
        'the packaged model request',
      );
      const request = mock.requests.find((candidate) =>
        JSON.stringify(candidate.body).includes(prompt)
      );
      checks.packagedTaskReachedMock =
        !!request &&
        request.method === 'POST' &&
        request.pathname === '/v1/chat/completions' &&
        request.authorization === `Bearer ${TEST_API_KEY}` &&
        JSON.stringify(request.body).includes(prompt);
      await window.getByText(responseText, { exact: true }).waitFor({
        state: 'visible',
        timeout: READY_TIMEOUT,
      });
      checks.packagedTaskRendered = true;
      checks.packagedTaskSurvivesChildFrameNavigation = true;

      if (process.platform === 'win32') {
        let rightPanel = window.locator('[data-abu-right-panel]');
        if (!(await rightPanel.count())) {
          const rightPanelToggle = window.locator('[data-window-control="right-panel"]');
          await rightPanelToggle.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
          await rightPanelToggle.click();
          rightPanel = window.locator('[data-abu-right-panel]');
        }
        await rightPanel.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
        const rightPanelLayout = await window.evaluate(() => {
          const toolbar = document.querySelector('[data-abu-windows-toolbar]');
          const panel = document.querySelector('[data-abu-right-panel]');
          const tabs = document.querySelector('[data-abu-workspace-tabs]');
          if (!toolbar || !panel || !tabs) return null;
          const toolbarRect = toolbar.getBoundingClientRect();
          const panelRect = panel.getBoundingClientRect();
          const tabsRect = tabs.getBoundingClientRect();
          return {
            toolbarBottom: toolbarRect.bottom,
            panelTop: panelRect.top,
            tabsTop: tabsRect.top,
            panelRight: panelRect.right,
            viewportWidth: window.innerWidth,
          };
        });
        checks.packagedWindowsRightPanelClearsToolbar =
          rightPanelLayout !== null &&
          rightPanelLayout.panelTop >= rightPanelLayout.toolbarBottom + 7 &&
          rightPanelLayout.tabsTop >= rightPanelLayout.toolbarBottom + 7 &&
          rightPanelLayout.panelRight <= rightPanelLayout.viewportWidth + 1;
      } else {
        checks.packagedWindowsRightPanelClearsToolbar = true;
      }

      const browserResult = await runPackagedBrowserFlow(app, window, mock.browserUrl, runtimeTrap);
      checks.packagedBrowserMcpInitializes = browserResult.initialized;
      checks.packagedBrowserVisibleTabAdopted = browserResult.visibleTabAdopted;
      checks.packagedBrowserDomRoundTrip = browserResult.domRoundTrip;
      checks.packagedBrowserScreenshot = browserResult.screenshot;
      checks.packagedBrowserMcpStops = browserResult.stopped;

      const normalQuitMcp = await spawnPackagedMcpTree(
        window,
        normalQuitMcpPath,
        runtimeTrap,
        'packaged-normal-quit',
      );
      // Finish through the user-visible native-close → renderer prompt → Quit
      // route. This catches a regression where Electron prevents the native
      // close but the renderer never handles it, leaving an unclosable window.
      await app.evaluate(({ BrowserWindow }) => {
        const mainWindow = BrowserWindow.getAllWindows()
          .find((candidate) => candidate.webContents.getURL().includes('/dist-electron-spike/index.html'));
        if (!mainWindow) throw new Error('main window missing for normal quit check');
        mainWindow.close();
      });
      const quitButton = window.getByRole('button', { name: /^(退出|Quit)$/ });
      await quitButton.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
      try {
        await quitButton.click();
      } catch (error) {
        // The successful click tears down Playwright's transport immediately;
        // only ignore that expected race, never a selector or interaction error.
        if (!/closed|target|connection/i.test(String(error))) throw error;
      }
      const exitedNormally =
        await waitForChildExit(appProcess, 10_000) &&
        appProcess.signalCode === null &&
        appProcess.exitCode === 0;
      if (!exitedNormally) {
        await closePackagedApp(app, appProcess);
        throw new Error('packaged app did not exit through the native close prompt');
      }
      app = undefined;
      appProcess = undefined;
      await waitForMarkerGone(normalQuitMcp.marker, 'normal packaged app quit');
      checks.packagedNormalQuitKillsMcpTree = true;

      app = await launchPackagedApp(
        found,
        userDataDir,
        appDataDir,
        runtimeTrap,
        expectMigration,
      );
      appProcess = app.process();
      window = await app.firstWindow({ timeout: READY_TIMEOUT });
      await window.getByPlaceholder(CHAT_PLACEHOLDER).waitFor({
        state: 'visible',
        timeout: READY_TIMEOUT,
      });
      const showSidebar = window.getByTitle(/显示侧栏|Show sidebar/);
      if (await showSidebar.count()) {
        await showSidebar.click();
      }
      const recentConversation = window.getByRole('button', { name: recentTitle }).first();
      await recentConversation.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
      await recentConversation.click();
      await window.getByText(prompt, { exact: true }).waitFor({
        state: 'visible',
        timeout: READY_TIMEOUT,
      });
      await window.getByText(responseText, { exact: true }).waitFor({
        state: 'visible',
        timeout: READY_TIMEOUT,
      });
      checks.packagedConversationRestored = true;
      // Verify durability at the user-visible boundary: a normal quit and
      // fresh process must restore both messages from JSONL. An immediate
      // pre-quit filesystem poll races the renderer's intentionally batched
      // write queue and is weaker than this actual restart contract.
      checks.packagedTaskPersisted =
        diskContains(appDataDir, prompt) &&
        diskContains(appDataDir, responseText);
      if (!checks.packagedTaskPersisted) {
        throw new Error('restored packaged conversation was missing from messages.jsonl');
      }
      await enableMockProviderTools(window);

      const restoredInput = window.getByPlaceholder(CHAT_PLACEHOLDER);
      const runtimeRequestStart = mock.requests.length;
      await restoredInput.fill(runtimePrompt);
      await restoredInput.press('Enter');
      let runtimeFollowup;
      await waitUntil(
        () => {
          runtimeFollowup = findToolFollowup(
            mock.requests,
            runtimeRequestStart,
            runtimePrompt,
            1,
          );
          return !!runtimeFollowup;
        },
        'the real Chat bare-runtime tool result to reach the model',
      );
      const chatRuntime = runtimeProbeFromFollowup(runtimeFollowup);
      const bundledNodeRoot = path.join(found.resources, 'node-runtime');
      checks.packagedChatUsesBundledRuntimes =
        pathIsWithin(chatRuntime.executable, bundledNodeRoot) &&
        pathIsWithin(chatRuntime.path.split(path.delimiter)[0], bundledNodeRoot) &&
        pathIsWithin(chatRuntime.npmWrapperPath, bundledNodeRoot) &&
        pathIsWithin(chatRuntime.npxWrapperPath, bundledNodeRoot) &&
        pathIsWithin(chatRuntime.npmPath, bundledNodeRoot) &&
        pathIsWithin(chatRuntime.npxPath, bundledNodeRoot) &&
        fs.existsSync(chatRuntime.npmWrapperPath) &&
        fs.existsSync(chatRuntime.npxWrapperPath) &&
        fs.existsSync(chatRuntime.npmPath) &&
        fs.existsSync(chatRuntime.npxPath) &&
        chatRuntime.nodeOptions === null &&
        /^\d+\.\d+\.\d+/.test(chatRuntime.npm) &&
        /^\d+\.\d+\.\d+/.test(chatRuntime.npx);
      await waitForChatIdle(window);

      const officeRequestStart = mock.requests.length;
      await restoredInput.fill(officeReadPrompt);
      await restoredInput.press('Enter');
      let officeFollowup;
      await waitUntil(() => {
        officeFollowup = findToolFollowup(
          mock.requests,
          officeRequestStart,
          officeReadPrompt,
          officeArtifactPaths.length,
        );
        return !!officeFollowup;
      }, 'the packaged Office/PDF read_file results to reach the model');
      const officeMessages = officeFollowup.body.messages;
      const officeToolCalls = officeMessages.flatMap((message) =>
        message?.role === 'assistant' && Array.isArray(message.tool_calls)
          ? message.tool_calls
          : []
      );
      const officePathByCallId = new Map(officeToolCalls.flatMap((call) => {
        try {
          const args = JSON.parse(call?.function?.arguments ?? '{}');
          return typeof call?.id === 'string' && typeof args.path === 'string'
            ? [[call.id, path.resolve(args.path)]]
            : [];
        } catch {
          return [];
        }
      }));
      const officeResultByPath = new Map(
        officeMessages
          .filter((message) => message?.role === 'tool')
          .flatMap((message) => {
            const artifactPath = officePathByCallId.get(message.tool_call_id);
            return artifactPath
              ? [[artifactPath, JSON.stringify(message.content)]]
              : [];
          }),
      );
      checks.packagedOfficeToolsReadArtifacts =
        officeResultByPath.size === officeArtifacts.length &&
        officeArtifacts.every(({ file, sentinel }) =>
          officeResultByPath.get(path.resolve(file))?.includes(sentinel)
        );
      await waitForChatIdle(window);

      // Real user stop path: ChatInput Stop → AbortRegistry → agent.abort →
      // sidecar tool signal → scoped abort_command → native launcher.
      await restoredInput.fill(stopPrompt);
      await restoredInput.press('Enter');
      await waitUntil(
        () => fs.existsSync(stopTree.resultPath),
        'the real Stop command tree to start',
      );
      readLiveTaggedTree(stopTree.resultPath, stopTree.marker, 'real Chat Stop');
      const stopButton = window.locator(STOP_BUTTON_SELECTOR).last();
      await stopButton.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
      await stopButton.click();
      await waitForMarkerGone(stopTree.marker, 'the real Stop path');
      checks.packagedTaskStopKillsCommandTree = true;

      // SIGKILL bypasses JavaScript cleanup. Read the real Electron main PID
      // from inside the app: on Windows Playwright can expose a short-lived
      // launcher wrapper through app.process(), and killing that wrapper does
      // not crash the packaged application.
      await restoredInput.waitFor({ state: 'visible', timeout: READY_TIMEOUT });
      await restoredInput.fill(crashPrompt);
      await restoredInput.press('Enter');
      await waitUntil(
        () => fs.existsSync(crashTree.resultPath),
        'the hard-crash command tree to start',
      );
      readLiveTaggedTree(crashTree.resultPath, crashTree.marker, 'hard Electron crash');
      const electronMainPid = await app.evaluate(() => process.pid);
      process.kill(electronMainPid, 'SIGKILL');
      await waitForPidExit(electronMainPid, 5_000);
      await waitForMarkerGone(crashTree.marker, 'the launcher cleanup after a hard Electron crash');
      checks.packagedHardCrashKillsCommandTree = true;
    } catch (err) {
      checks.packagedTaskReachedMock ??= false;
      checks.packagedTaskRendered ??= false;
      checks.packagedTaskSurvivesChildFrameNavigation ??= false;
      checks.packagedTaskPersisted ??= false;
      checks.packagedBrowserMcpInitializes ??= false;
      checks.packagedBrowserVisibleTabAdopted ??= false;
      checks.packagedBrowserDomRoundTrip ??= false;
      checks.packagedBrowserScreenshot ??= false;
      checks.packagedBrowserMcpStops ??= false;
      checks.packagedNormalQuitKillsMcpTree ??= false;
      checks.packagedConversationRestored ??= false;
      checks.packagedChatUsesBundledRuntimes ??= false;
      checks.packagedOfficeToolsReadArtifacts ??= false;
      checks.packagedTaskStopKillsCommandTree ??= false;
      checks.packagedHardCrashKillsCommandTree ??= false;
      const lastRequest = mock.requests.at(-1);
      let visibleText = '';
      try {
        visibleText = (await window.locator('body').innerText()).slice(-2000);
      } catch {
        // App may already be gone in the intentional hard-crash step.
      }
      errors.packagedTask = [
        String(err),
        lastRequest ? `lastRequest=${JSON.stringify({
          messageRoles: lastRequest.body?.messages?.map?.((message) => message?.role),
          tools: lastRequest.body?.tools?.length ?? 0,
          containsStopPrompt: JSON.stringify(lastRequest.body).includes(stopPrompt),
          containsCrashPrompt: JSON.stringify(lastRequest.body).includes(crashPrompt),
        })}` : 'lastRequest=none',
        visibleText ? `visibleTextTail=${JSON.stringify(visibleText)}` : '',
      ].filter(Boolean).join('\n');
    }
  } catch (err) {
    errors.launch = String(err);
  } finally {
    const cleanupMode = await closePackagedApp(app, appProcess);
    if (cleanupMode === 'stuck') {
      errors.appCleanup = 'packaged Electron process remained alive after SIGKILL';
    }
    await mock.close();
    checks.hostRuntimeTrapUnused = !fs.existsSync(runtimeTrap.marker);
    if (!checks.hostRuntimeTrapUnused) {
      errors.hostRuntimeTrap = fs.readFileSync(runtimeTrap.marker, 'utf8').trim();
    }
    const cleanupFailures = [];
    for (const commandTree of commandTrees) {
      try {
        await cleanupMarkerProcesses(commandTree.marker);
      } catch (err) {
        cleanupFailures.push(`${commandTree.marker}: ${String(err)}`);
      }
      try {
        fs.rmSync(commandTree.resultPath, { force: true });
      } catch (err) {
        cleanupFailures.push(`${commandTree.resultPath}: ${String(err)}`);
      }
    }
    try {
      fs.rmSync(testRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      });
    } catch (err) {
      cleanupFailures.push(`${testRoot}: ${String(err)}`);
    }
    if (cleanupFailures.length > 0) {
      errors.cleanup = cleanupFailures.join('\n');
    }
  }

  const passed =
    Object.values(checks).length > 0 &&
    Object.values(checks).every(Boolean) &&
    Object.keys(errors).length === 0;
  console.log('[packaged-smoke] checks = ' + JSON.stringify(checks, null, 2));
  if (Object.keys(errors).length) {
    console.log('[packaged-smoke] errors = ' + JSON.stringify(errors, null, 2));
  }
  console.log('[packaged-smoke] PASSED = ' + passed);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('[packaged-smoke] fatal', err);
  process.exit(1);
});
