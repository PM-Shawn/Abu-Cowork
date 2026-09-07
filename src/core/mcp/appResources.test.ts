// Pure MCP Apps helpers — no SDK, no transport.

import { describe, expect, it } from 'vitest';
import { isMcpAppMimeType } from './appResources';

describe('isMcpAppMimeType', () => {
  it('accepts the MCP App HTML profile in any casing / spacing / quoting', () => {
    for (const mime of [
      'text/html;profile=mcp-app',
      'text/html; profile=mcp-app',
      'TEXT/HTML; profile="mcp-app"',
      'text/html; charset=utf-8; PROFILE=mcp-app',
      '  text/html ; profile = mcp-app ',
    ]) {
      expect(isMcpAppMimeType(mime), mime).toBe(true);
    }
  });

  it('rejects look-alikes a substring test used to accept', () => {
    for (const mime of [
      // A different media type that merely starts with `text/html`.
      'text/html-fragment;profile=mcp-app',
      // A different parameter that merely ends with `profile`.
      'text/html;xprofile=mcp-app',
    ]) {
      expect(isMcpAppMimeType(mime), mime).toBe(false);
    }
  });

  it('rejects plain HTML, other media types and malformed input', () => {
    for (const mime of [
      'text/html',
      'text/html; charset=utf-8',
      'text/plain;profile=mcp-app',
      'application/json',
      'text/html;profile=mcp-apps',
      'text/html;profile',
      '',
    ]) {
      expect(isMcpAppMimeType(mime), mime).toBe(false);
    }
  });
});
