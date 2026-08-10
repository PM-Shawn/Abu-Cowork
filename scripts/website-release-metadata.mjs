#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

export const WEBSITE_RELEASE_REMOTE = 'electron/latest-release.json';

const DOWNLOAD_EXTENSIONS = {
  'mac-arm64': '.dmg',
  'mac-x64': '.dmg',
  'windows-x64': '.exe',
};

const CJK = /[㐀-鿿　-〿＀-￯]/;

export function normalizeReleaseTag(value, label = 'release') {
  const raw = String(value || '').trim();
  const version = semver.valid(raw.replace(/^v/, ''));
  if (!version) throw new Error(`invalid ${label} version: ${raw || '<empty>'}`);
  return { version, tag: `v${version}` };
}

export function extractReleaseNotes(changelogPath, version) {
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

function requireInstallerFilename(value, key) {
  const filename = String(value || '').trim();
  if (!filename || path.basename(filename) !== filename) {
    throw new Error(`${key} installer must be a plain filename`);
  }
  if (!filename.toLowerCase().endsWith(DOWNLOAD_EXTENSIONS[key])) {
    throw new Error(`${key} installer must end with ${DOWNLOAD_EXTENSIONS[key]}`);
  }
  return filename;
}

export function createWebsiteReleaseMetadata(options) {
  const { version, tag } = normalizeReleaseTag(options.version);
  const releaseBaseUrl = String(options.releaseBaseUrl || '').replace(/\/+$/, '');
  if (!releaseBaseUrl.startsWith('https://')) {
    throw new Error('release base URL must use https');
  }
  const notesEn = String(options.notesEn || '').trim();
  const notesZh = String(options.notesZh || '').trim();
  if (!notesEn) throw new Error(`missing English release notes for ${tag}`);
  if (!notesZh) throw new Error(`missing Chinese release notes for ${tag}`);
  if (CJK.test(notesEn)) {
    throw new Error(`English release notes for ${tag} must not contain CJK text`);
  }
  if (!CJK.test(notesZh)) {
    throw new Error(`Chinese release notes for ${tag} must contain CJK text`);
  }

  const downloads = {};
  for (const key of Object.keys(DOWNLOAD_EXTENSIONS)) {
    const filename = requireInstallerFilename(options.downloads?.[key], key);
    downloads[key] = { url: `${releaseBaseUrl}/${filename}` };
  }

  return {
    schema_version: 1,
    version: tag,
    downloads,
    notes_i18n: {
      'en-US': notesEn,
      'zh-CN': notesZh,
    },
  };
}

export function readWebsiteReleaseVersion(source) {
  let metadata;
  try {
    metadata = JSON.parse(String(source || ''));
  } catch {
    throw new Error('published website release metadata is not valid JSON');
  }
  if (metadata?.schema_version !== 1) {
    throw new Error('published website release metadata has an unsupported schema');
  }
  return normalizeReleaseTag(metadata.version, 'published website release').version;
}

export function assertWebsiteReleaseCanAdvance(candidate, source) {
  const candidateVersion = normalizeReleaseTag(candidate, 'candidate').version;
  const currentVersion = readWebsiteReleaseVersion(source);
  if (semver.lt(candidateVersion, currentVersion)) {
    throw new Error(
      `website release candidate ${candidateVersion} must not replace newer published ${currentVersion}`,
    );
  }
  return { candidateVersion, currentVersion };
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
    'version',
    'release-base-url',
    'changelog-en',
    'changelog-zh',
    'mac-arm64',
    'mac-x64',
    'windows-x64',
    'output',
  ]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  return args;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { version } = normalizeReleaseTag(args.version);
    const metadata = createWebsiteReleaseMetadata({
      version: args.version,
      releaseBaseUrl: args['release-base-url'],
      downloads: {
        'mac-arm64': args['mac-arm64'],
        'mac-x64': args['mac-x64'],
        'windows-x64': args['windows-x64'],
      },
      notesEn: extractReleaseNotes(path.resolve(args['changelog-en']), version),
      notesZh: extractReleaseNotes(path.resolve(args['changelog-zh']), version),
    });
    const output = path.resolve(args.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    console.log(`Wrote website release metadata for ${metadata.version} to ${output}.`);
  } catch (error) {
    console.error(
      `Website release metadata generation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}
