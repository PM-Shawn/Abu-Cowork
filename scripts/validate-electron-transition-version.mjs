#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

export function normalizeTransitionVersion(value) {
  const raw = String(value || '').trim();
  const withoutPrefix = raw.startsWith('v') ? raw.slice(1) : raw;
  const normalized = semver.valid(withoutPrefix);
  if (!normalized) throw new Error(`invalid transition version: ${raw || '<empty>'}`);
  return normalized;
}

export function assertNewerTransitionVersion(candidate, current) {
  const candidateVersion = normalizeTransitionVersion(candidate);
  const currentVersion = normalizeTransitionVersion(current);
  if (!semver.gt(candidateVersion, currentVersion)) {
    throw new Error(
      `transition version ${candidateVersion} must be newer than published ${currentVersion}`
    );
  }
  return { candidateVersion, currentVersion };
}

export function assertNotOlderTransitionVersion(candidate, current) {
  const candidateVersion = normalizeTransitionVersion(candidate);
  const currentVersion = normalizeTransitionVersion(current);
  if (semver.lt(candidateVersion, currentVersion)) {
    throw new Error(
      `transition version ${candidateVersion} must not replace newer published ${currentVersion}`
    );
  }
  return { candidateVersion, currentVersion };
}

export async function validateAgainstLatestFeed(
  candidate,
  latestUrl,
  fetchImpl = fetch,
  options = {}
) {
  const response = await fetchImpl(latestUrl, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`could not read current updater feed: HTTP ${response.status}`);
  }
  const latest = await response.json();
  if (!latest || typeof latest.version !== 'string') {
    throw new Error('current updater feed has no version');
  }
  return options.allowEqual
    ? assertNotOlderTransitionVersion(candidate, latest.version)
    : assertNewerTransitionVersion(candidate, latest.version);
}

// Backwards-compatible aliases used by the Windows transition tests.
export const normalizeVersion = normalizeTransitionVersion;
export const assertNewerVersion = assertNewerTransitionVersion;
export async function validateLiveVersion(candidate, latestUrl, fetchImpl = fetch) {
  return validateAgainstLatestFeed(candidate, latestUrl, fetchImpl);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[++i];
    if (!key?.startsWith('--') || !value) {
      throw new Error(`invalid argument: ${key || '<empty>'}`);
    }
    args[key.slice(2)] = value;
  }
  if (!args.candidate || !args['latest-url']) {
    throw new Error(
      'usage: validate-electron-transition-version.mjs --candidate <version> --latest-url <url>'
    );
  }
  return args;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await validateAgainstLatestFeed(
      args.candidate,
      args['latest-url'],
      fetch,
      { allowEqual: args['allow-equal'] === 'true' }
    );
    console.log(
      `Transition version ${result.candidateVersion} is valid against published ${result.currentVersion}.`
    );
  } catch (error) {
    console.error(
      `Transition version check failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}
