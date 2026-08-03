import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDiagnosticUploadTarget } from './validate-diagnostic-upload-target.mjs';

test('accepts an HTTPS console origin and strips a trailing slash', () => {
  assert.equal(
    validateDiagnosticUploadTarget(' https://console.example.com/ '),
    'https://console.example.com',
  );
});

test('rejects a missing or malformed diagnostic upload target', () => {
  assert.throws(
    () => validateDiagnosticUploadTarget(''),
    /VITE_CONSOLE_URL is required/,
  );
  assert.throws(
    () => validateDiagnosticUploadTarget('not-a-url'),
    /valid absolute URL/,
  );
});

test('rejects insecure or credential-bearing diagnostic upload targets', () => {
  assert.throws(
    () => validateDiagnosticUploadTarget('http://console.example.com'),
    /must use HTTPS/,
  );
  assert.throws(
    () => validateDiagnosticUploadTarget('https://user:pass@console.example.com'),
    /must not contain credentials/,
  );
  assert.throws(
    () => validateDiagnosticUploadTarget('https://console.example.com?token=secret'),
    /must not contain a query or fragment/,
  );
});
