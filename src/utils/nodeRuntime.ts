/**
 * Embedded Node.js Runtime
 * Resolves the path to Abu's bundled Node.js interpreter.
 *
 * Unlike the embedded Python runtime (which rewrites the command string to an
 * absolute interpreter path), Node is consumed by *prepending nothing* and
 * instead appending the bundled `node-runtime` bin directory to the child
 * process PATH inside the Rust `mcp_spawn` command. That is because `npx`/`npm`
 * are Node scripts (`#!/usr/bin/env node`) that must be able to find `node` on
 * PATH themselves — an absolute path rewrite would not help them.
 *
 * The only thing the TypeScript side needs is a cheap "is a bundled Node
 * available?" check, used to decide whether to surface the "please install
 * Node.js" pre-flight error when connecting an npx/node-based MCP server.
 */

import { resolveResource } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import { isWindows } from './platform';

let cachedPath: string | null | undefined = undefined; // undefined = not yet checked

/**
 * Get the path to the embedded Node binary.
 * Checks both bundled resource path (production) and src-tauri/ path (dev mode).
 * Returns null if not available.
 */
export async function getEmbeddedNodePath(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath;

  // Official Node dist layout: unix keeps binaries in bin/, Windows at the root.
  const bin = isWindows() ? 'node.exe' : 'bin/node';

  // Try 1: Bundled resource path (production build)
  try {
    const path = await resolveResource(`node-runtime/${bin}`);
    if (path && await exists(path)) {
      cachedPath = path;
      return path;
    }
  } catch {
    // resolveResource may fail in dev mode
  }

  // Try 2: Dev mode — check src-tauri/node-runtime/ (created by setup-node-runtime.sh)
  const devCandidates = [
    `../src-tauri/node-runtime/${bin}`,
    `src-tauri/node-runtime/${bin}`,
  ];
  for (const candidate of devCandidates) {
    try {
      const { resolve } = await import('@tauri-apps/api/path');
      const path = await resolve(candidate);
      if (path && await exists(path)) {
        cachedPath = path;
        return path;
      }
    } catch {
      // try next
    }
  }

  cachedPath = null;
  return null;
}

/**
 * Check if embedded Node.js runtime is available.
 */
export async function hasEmbeddedNode(): Promise<boolean> {
  return (await getEmbeddedNodePath()) !== null;
}
