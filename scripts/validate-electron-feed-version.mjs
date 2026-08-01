#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import YAML from 'yaml';

function normalizeVersion(value, label) {
  const raw = String(value || '').trim();
  const normalized = semver.valid(raw.startsWith('v') ? raw.slice(1) : raw);
  if (!normalized) {
    throw new Error(`invalid ${label} version: ${raw || '<empty>'}`);
  }
  return normalized;
}

export function readElectronFeedVersion(source) {
  const metadata = YAML.parse(String(source || ''));
  return normalizeVersion(metadata?.version, 'published Electron feed');
}

export function assertElectronFeedCanAdvance(candidate, source) {
  const candidateVersion = normalizeVersion(candidate, 'candidate');
  const currentVersion = readElectronFeedVersion(source);
  if (semver.lt(candidateVersion, currentVersion)) {
    throw new Error(
      `Electron feed candidate ${candidateVersion} must not replace newer published ${currentVersion}`,
    );
  }
  return { candidateVersion, currentVersion };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    args[key.slice(2)] = value;
  }
  if (!args.candidate || !args.metadata) {
    throw new Error(
      'usage: validate-electron-feed-version.mjs --candidate <version> --metadata <latest.yml>',
    );
  }
  return args;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = assertElectronFeedCanAdvance(
      args.candidate,
      fs.readFileSync(path.resolve(args.metadata), 'utf8'),
    );
    console.log(
      `Electron feed ${result.candidateVersion} may replace published ${result.currentVersion}.`,
    );
  } catch (error) {
    console.error(
      `Electron feed version check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}
