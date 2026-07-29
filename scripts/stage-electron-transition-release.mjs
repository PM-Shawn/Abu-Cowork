#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import semver from 'semver';

function requireDirectory(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label} is missing: ${directory}`);
  }
}

function filesIn(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name));
}

function requireUnique(directory, predicate, label) {
  const matches = filesIn(directory).filter((file) => predicate(path.basename(file)));
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one file, found ${matches.length}`);
  }
  return matches[0];
}

function sha512(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    throw new Error(`staged filename collision: ${path.basename(destination)}`);
  }
  fs.copyFileSync(source, destination);
}

function safeBasename(value, label) {
  if (typeof value !== 'string' || !value || path.basename(value) !== value) {
    throw new Error(`${label} must be a plain filename`);
  }
  return value;
}

function extractNotes(changelogPath, version) {
  const text = fs.readFileSync(changelogPath, 'utf8');
  const heading = /^## v([0-9A-Za-z.+-]+)[^\n]*$/gm;
  let match;
  while ((match = heading.exec(text)) !== null) {
    if (semver.clean(match[1]) !== version) continue;
    const bodyStart = heading.lastIndex;
    const next = heading.exec(text);
    return text.slice(bodyStart, next ? next.index : text.length).trim();
  }
  return '';
}

function validateUpdaterFeed({ sourceDir, metadataName, version, requiredExtension, destination }) {
  const metadataPath = path.join(sourceDir, metadataName);
  if (!fs.existsSync(metadataPath)) throw new Error(`missing ${metadataName} in ${sourceDir}`);
  const metadata = YAML.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (semver.clean(String(metadata?.version || '')) !== version) {
    throw new Error(`${metadataName} version does not match ${version}`);
  }
  const entries = Array.isArray(metadata?.files) ? metadata.files : [];
  if (!entries.some((entry) => String(entry?.url || '').endsWith(requiredExtension))) {
    throw new Error(`${metadataName} has no ${requiredExtension} updater artifact`);
  }

  const copied = [];
  for (const entry of entries) {
    const filename = safeBasename(entry?.url, `${metadataName} files[].url`);
    const source = path.join(sourceDir, filename);
    if (!fs.existsSync(source)) throw new Error(`${metadataName} references missing ${filename}`);
    if (entry.sha512 !== sha512(source)) {
      throw new Error(`${metadataName} sha512 mismatch for ${filename}`);
    }
    if (entry.size !== undefined && Number(entry.size) !== fs.statSync(source).size) {
      throw new Error(`${metadataName} size mismatch for ${filename}`);
    }
    copy(source, path.join(destination, filename));
    copied.push(filename);

    const blockmap = `${source}.blockmap`;
    if (entry.blockMapSize !== undefined) {
      if (!fs.existsSync(blockmap)) throw new Error(`missing blockmap for ${filename}`);
      if (Number(entry.blockMapSize) !== fs.statSync(blockmap).size) {
        throw new Error(`${metadataName} blockmap size mismatch for ${filename}`);
      }
      copy(blockmap, path.join(destination, `${filename}.blockmap`));
      copied.push(`${filename}.blockmap`);
    }
  }
  copy(metadataPath, path.join(destination, metadataName));
  return { metadata, copied };
}

function writeMap(file, rows) {
  fs.writeFileSync(
    file,
    rows.map(({ local, remote }) => `${local}\t${remote}`).join('\n') + '\n',
    'utf8'
  );
}

export function stageRelease(options) {
  const input = path.resolve(options.input);
  const output = path.resolve(options.output);
  const rawVersion = String(options.version || '').trim();
  const version = semver.valid(rawVersion.replace(/^v/, ''));
  if (!version) throw new Error(`invalid release version: ${rawVersion}`);
  const tag = `v${version}`;
  const repo = String(options.repo || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid GitHub repository: ${repo}`);
  }
  const releaseBaseUrl = String(options.releaseBaseUrl || '').replace(/\/+$/, '');
  if (!releaseBaseUrl.startsWith('https://')) {
    throw new Error('release base URL must use https');
  }

  const sources = {
    macArm64: path.join(input, 'mac-arm64'),
    macX64: path.join(input, 'mac-x64'),
    windowsX64: path.join(input, 'windows-x64'),
  };
  for (const [name, directory] of Object.entries(sources)) {
    requireDirectory(directory, name);
  }

  fs.rmSync(output, { recursive: true, force: true });
  const releaseAssets = path.join(output, 'release-assets');
  const feedRoots = {
    macArm64: path.join(output, 'feeds', 'mac-arm64'),
    macX64: path.join(output, 'feeds', 'mac-x64'),
    windowsX64: path.join(output, 'feeds', 'win-x64'),
  };

  const macConfigs = [
    {
      key: 'darwin-aarch64',
      source: sources.macArm64,
      feed: feedRoots.macArm64,
      archivePattern: /^Abu_aarch64_electron-transition\.app\.tar\.gz$/,
    },
    {
      key: 'darwin-x86_64',
      source: sources.macX64,
      feed: feedRoots.macX64,
      archivePattern: /^Abu_x64_electron-transition\.app\.tar\.gz$/,
    },
  ];

  const platforms = {};
  for (const config of macConfigs) {
    const archive = requireUnique(
      config.source,
      (name) => config.archivePattern.test(name),
      `${config.key} transition archive`
    );
    const signature = `${archive}.sig`;
    if (!fs.existsSync(signature) || !fs.readFileSync(signature, 'utf8').trim()) {
      throw new Error(`${config.key} transition signature is missing`);
    }
    copy(archive, path.join(releaseAssets, path.basename(archive)));
    copy(signature, path.join(releaseAssets, path.basename(signature)));
    for (const dmg of filesIn(config.source).filter((file) => file.endsWith('.dmg'))) {
      copy(dmg, path.join(releaseAssets, path.basename(dmg)));
    }
    validateUpdaterFeed({
      sourceDir: config.source,
      metadataName: 'latest-mac.yml',
      version,
      requiredExtension: '.zip',
      destination: config.feed,
    });
    platforms[config.key] = {
      signature: fs.readFileSync(signature, 'utf8').trim(),
      url: `${releaseBaseUrl}/${path.basename(archive)}`,
    };
  }

  const windowsInstaller = requireUnique(
    sources.windowsX64,
    (name) => /-windows-x64-setup\.exe$/i.test(name),
    'Windows x64 transition installer'
  );
  const windowsSignature = `${windowsInstaller}.sig`;
  if (!fs.existsSync(windowsSignature) || !fs.readFileSync(windowsSignature, 'utf8').trim()) {
    throw new Error('Windows x64 transition signature is missing');
  }
  copy(windowsInstaller, path.join(releaseAssets, path.basename(windowsInstaller)));
  copy(windowsSignature, path.join(releaseAssets, path.basename(windowsSignature)));
  validateUpdaterFeed({
    sourceDir: sources.windowsX64,
    metadataName: 'latest.yml',
    version,
    requiredExtension: '.exe',
    destination: feedRoots.windowsX64,
  });
  platforms['windows-x86_64'] = {
    signature: fs.readFileSync(windowsSignature, 'utf8').trim(),
    url: `${releaseBaseUrl}/${path.basename(windowsInstaller)}`,
  };

  const notesEn =
    extractNotes(path.resolve(options.changelogEn), version) ||
    `See https://github.com/${repo}/releases/tag/${tag}`;
  const notesZh = extractNotes(path.resolve(options.changelogZh), version) || notesEn;
  const latest = {
    version: tag,
    notes: notesEn,
    notes_i18n: { 'en-US': notesEn, 'zh-CN': notesZh },
    pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms,
  };
  fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(latest, null, 2), 'utf8');

  const contentRows = [];
  for (const file of filesIn(releaseAssets)) {
    contentRows.push({
      local: path.relative(output, file),
      remote: `releases/${tag}/${path.basename(file)}`,
    });
  }
  for (const [channel, directory] of Object.entries({
    'mac-arm64': feedRoots.macArm64,
    'mac-x64': feedRoots.macX64,
    'win-x64': feedRoots.windowsX64,
  })) {
    for (const file of filesIn(directory)) {
      if (path.basename(file) === 'latest-mac.yml' || path.basename(file) === 'latest.yml') {
        continue;
      }
      contentRows.push({
        local: path.relative(output, file),
        remote: `electron/${channel}/${path.basename(file)}`,
      });
    }
  }
  const pointerRows = [
    {
      local: path.relative(output, path.join(feedRoots.macArm64, 'latest-mac.yml')),
      remote: 'electron/mac-arm64/latest-mac.yml',
    },
    {
      local: path.relative(output, path.join(feedRoots.macX64, 'latest-mac.yml')),
      remote: 'electron/mac-x64/latest-mac.yml',
    },
    {
      local: path.relative(output, path.join(feedRoots.windowsX64, 'latest.yml')),
      remote: 'electron/win-x64/latest.yml',
    },
  ];
  writeMap(path.join(output, 'content-map.tsv'), contentRows);
  writeMap(path.join(output, 'feed-pointer-map.tsv'), pointerRows);

  const checksums = [...contentRows, ...pointerRows, { local: 'latest.json', remote: 'latest.json' }]
    .map((entry) => ({
      ...entry,
      sha256: sha256(path.join(output, entry.local)),
      size: fs.statSync(path.join(output, entry.local)).size,
    }));
  fs.writeFileSync(
    path.join(output, 'release-manifest.json'),
    JSON.stringify({ version: tag, checksums }, null, 2),
    'utf8'
  );
  return { version: tag, latest, contentRows, pointerRows, checksums };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`invalid argument: ${key || ''}`);
    args[key.slice(2)] = value;
  }
  for (const required of [
    'input',
    'output',
    'version',
    'repo',
    'release-base-url',
    'changelog-en',
    'changelog-zh',
  ]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  return args;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = stageRelease({
      input: args.input,
      output: args.output,
      version: args.version,
      repo: args.repo,
      releaseBaseUrl: args['release-base-url'],
      changelogEn: args['changelog-en'],
      changelogZh: args['changelog-zh'],
    });
    console.log(
      `[electron-release-stage] ${result.version}: ${result.checksums.length} verified file(s)`
    );
  } catch (error) {
    console.error(
      `[electron-release-stage] failed: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }`
    );
    process.exit(1);
  }
}
