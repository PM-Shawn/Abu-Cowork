/**
 * Embedded Python Runtime
 * Resolves the path to Abu's bundled Python interpreter.
 * Falls back to system Python if embedded runtime is not available (dev mode).
 */

import { resolveResource } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import { isWindows } from './platform';

let cachedPath: string | null | undefined = undefined; // undefined = not yet checked

/**
 * Get the path to the embedded Python binary.
 * Checks both bundled resource path (production) and src-tauri/ path (dev mode).
 * Returns null if not available.
 */
export async function getEmbeddedPythonPath(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath;

  const bin = isWindows() ? 'python.exe' : 'bin/python3';

  // Try 1: Bundled resource path (production build)
  try {
    const path = await resolveResource(`python-runtime/${bin}`);
    if (path && await exists(path)) {
      cachedPath = path;
      return path;
    }
  } catch {
    // resolveResource may fail in dev mode
  }

  // Try 2: Dev mode — check src-tauri/python-runtime/ (created by setup-python-runtime.sh)
  const devCandidates = [
    `../src-tauri/python-runtime/${bin}`,
    `src-tauri/python-runtime/${bin}`,
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
 * Check if embedded Python runtime is available.
 */
export async function hasEmbeddedPython(): Promise<boolean> {
  return (await getEmbeddedPythonPath()) !== null;
}

/**
 * Replace python3/python command prefix with embedded Python path.
 * Only replaces if the command starts with python3 or python (not inside a path).
 * Adds -I (isolated mode) to prevent interference from user's PYTHONPATH.
 *
 * Returns the original command unchanged if embedded Python is not available.
 */
export async function resolveCommandPython(command: string): Promise<string> {
  const embeddedPath = await getEmbeddedPythonPath();
  if (!embeddedPath) return command;

  // Match: python3 or python at the start of command (with possible leading whitespace)
  // Also match: python3.12, python3.11 etc.
  // Do NOT match: /usr/bin/python3, ./venv/bin/python (already absolute/relative paths)
  const pythonCmdPattern = /^(\s*)(python3(?:\.\d+)?|python)(\s|$)/;
  const match = command.match(pythonCmdPattern);

  if (!match) return command;

  const [, leadingSpace, , trailing] = match;
  const quoted = embeddedPath.includes(' ') ? `"${embeddedPath}"` : embeddedPath;
  return `${leadingSpace}${quoted} -I${trailing}${command.slice(match[0].length)}`;
}
