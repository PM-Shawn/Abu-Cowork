/**
 * An in-memory `ConversationFsPrimitives` for writer-level unit tests.
 *
 * It holds the files a writer wrote, the order of the primitive calls it made,
 * and two hooks a test needs that no real filesystem offers on demand: an
 * append that rejects once, and a canonical path this tier does or does not
 * have.
 */
import type { ConversationFsPrimitives } from '@/core/session/conversationWriter';

export interface MemoryConversationFs extends ConversationFsPrimitives {
  readonly files: Map<string, string>;
  /** Every primitive call in order, `"<name> <path>"`. */
  readonly calls: string[];
  /** Makes the next `appendText` on `path` reject with `error`. */
  failNextAppend(path: string, error: Error): void;
  /** What `canonicalPath` answers; default is "no primitive" (null). */
  setCanonical(resolve: ((path: string) => string) | null): void;
}

export function createMemoryConversationFs(): MemoryConversationFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const calls: string[] = [];
  const appendFailures = new Map<string, Error>();
  let canonical: ((path: string) => string) | null = null;

  const noteParents = (path: string): void => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  };

  return {
    files,
    calls,
    failNextAppend: (path, error) => { appendFailures.set(path, error); },
    setCanonical: (resolve) => { canonical = resolve; },
    async exists(path) { calls.push(`exists ${path}`); return files.has(path) || dirs.has(path); },
    async readTextFile(path) {
      calls.push(`readTextFile ${path}`);
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return content;
    },
    async mkdir(path) { calls.push(`mkdir ${path}`); dirs.add(path); noteParents(path); },
    async remove(path, options) {
      calls.push(`remove ${path}${options?.recursive ? ' recursive' : ''}`);
      for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      for (const dir of [...dirs]) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
    },
    async readDir(path) {
      calls.push(`readDir ${path}`);
      const names = new Map<string, boolean>();
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(`${path}/`)) continue;
        const name = key.slice(path.length + 1).split('/')[0];
        names.set(name, names.get(name) === true || dirs.has(`${path}/${name}`));
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    async stat(path) {
      calls.push(`stat ${path}`);
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return { size: new TextEncoder().encode(content).byteLength };
    },
    async appendText(path, data) {
      calls.push(`appendText ${path}`);
      const failure = appendFailures.get(path);
      if (failure) { appendFailures.delete(path); throw failure; }
      files.set(path, (files.get(path) ?? '') + data);
      noteParents(path);
    },
    async atomicWriteText(path, content) {
      calls.push(`atomicWriteText ${path}`);
      files.set(path, content);
      noteParents(path);
    },
    async canonicalPath(path) { calls.push(`canonicalPath ${path}`); return canonical ? canonical(path) : null; },
  };
}
