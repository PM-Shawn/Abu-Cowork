#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function validateDiagnosticUploadTarget(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('VITE_CONSOLE_URL is required for official builds');
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new Error('VITE_CONSOLE_URL must be a valid absolute URL');
  }

  if (target.protocol !== 'https:') {
    throw new Error('VITE_CONSOLE_URL must use HTTPS for official builds');
  }
  if (target.username || target.password) {
    throw new Error('VITE_CONSOLE_URL must not contain credentials');
  }
  if (target.search || target.hash) {
    throw new Error('VITE_CONSOLE_URL must not contain a query or fragment');
  }

  return target.href.replace(/\/$/, '');
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    validateDiagnosticUploadTarget(process.env.VITE_CONSOLE_URL);
    console.log('Diagnostic upload target is configured for this official build.');
  } catch (error) {
    console.error(
      `Diagnostic upload target check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}
