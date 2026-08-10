#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { assertWebsiteReleaseCanAdvance } from './website-release-metadata.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`invalid argument: ${key || ''}`);
    args[key.slice(2)] = value;
  }
  if (!args.candidate || !args.metadata) {
    throw new Error(
      'usage: validate-website-release-version.mjs --candidate <version> --metadata <latest-release.json>',
    );
  }
  return args;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = assertWebsiteReleaseCanAdvance(
      args.candidate,
      fs.readFileSync(path.resolve(args.metadata), 'utf8'),
    );
    console.log(
      `Website release ${result.candidateVersion} may replace published ${result.currentVersion}.`,
    );
  } catch (error) {
    console.error(
      `Website release version check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}
