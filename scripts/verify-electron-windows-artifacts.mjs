#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputArgIndex = process.argv.indexOf('--output');
if (outputArgIndex >= 0 && !process.argv[outputArgIndex + 1]) {
  throw new Error('--output requires a directory');
}
const OUTPUT = outputArgIndex >= 0
  ? path.resolve(process.argv[outputArgIndex + 1])
  : path.join(ROOT, 'release-electron');
const METADATA = path.join(OUTPUT, 'latest.yml');
const UNPACKED_RESOURCES = path.join(OUTPUT, 'win-unpacked', 'resources');
const APP_UPDATE = path.join(UNPACKED_RESOURCES, 'app-update.yml');
const EXPECTED_FEED =
  process.env.ABU_EXPECTED_ELECTRON_FEED ||
  'https://abu-agent.oss-cn-beijing.aliyuncs.com/electron/';

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

async function sha512(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('base64');
}

async function main() {
  requireFile(METADATA, 'Windows update metadata');
  requireFile(APP_UPDATE, 'Packaged updater configuration');

  const metadata = YAML.parse(fs.readFileSync(METADATA, 'utf8'));
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const installerEntry = files.find((entry) =>
    typeof entry?.url === 'string' && /-windows-x64-setup\.exe$/i.test(entry.url)
  );
  if (!installerEntry) {
    throw new Error('latest.yml has no Windows x64 NSIS installer entry');
  }

  const installer = path.join(OUTPUT, path.basename(installerEntry.url));
  requireFile(installer, 'Windows NSIS installer');
  const blockmap = `${installer}.blockmap`;
  requireFile(blockmap, 'Windows NSIS blockmap');

  const actualSize = fs.statSync(installer).size;
  const actualBlockmapSize = fs.statSync(blockmap).size;
  if (Number(installerEntry.size) !== actualSize) {
    throw new Error(
      `latest.yml installer size mismatch: expected ${String(installerEntry.size)}, got ${actualSize}`,
    );
  }
  if (
    installerEntry.blockMapSize !== undefined &&
    Number(installerEntry.blockMapSize) !== actualBlockmapSize
  ) {
    throw new Error(
      `latest.yml blockmap size mismatch: expected ${
        String(installerEntry.blockMapSize)
      }, got ${actualBlockmapSize}`,
    );
  }
  const actualSha512 = await sha512(installer);
  if (installerEntry.sha512 !== actualSha512) {
    throw new Error('latest.yml installer sha512 does not match the generated NSIS installer');
  }
  if (metadata.path !== installerEntry.url || metadata.sha512 !== installerEntry.sha512) {
    throw new Error('latest.yml top-level path/sha512 do not match its installer entry');
  }

  const updater = YAML.parse(fs.readFileSync(APP_UPDATE, 'utf8'));
  if (updater?.provider !== 'generic' || updater?.url !== EXPECTED_FEED) {
    throw new Error(
      `unexpected packaged update feed: ${JSON.stringify({
        provider: updater?.provider,
        url: updater?.url,
      })}`,
    );
  }

  console.log(JSON.stringify({
    installer: path.relative(ROOT, installer),
    blockmap: path.relative(ROOT, blockmap),
    metadata: path.relative(ROOT, METADATA),
    updaterConfig: path.relative(ROOT, APP_UPDATE),
    size: actualSize,
    blockmapSize: actualBlockmapSize,
    sha512: actualSha512,
    feed: EXPECTED_FEED,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(
    `[windows-artifacts] verification failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }`,
  );
  process.exit(1);
}
