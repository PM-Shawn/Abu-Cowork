import type { ConversationWorkspaceFiles } from '@/core/files/workspaceFiles';

/**
 * One in-memory disk behind the three file interfaces turnChanges uses:
 * plugin-fs (the conversation directory), the fs bridge (the user's files) and
 * atomicWrite. Every write advances a counter that serves as modification time.
 */
export interface MemoryHostFs {
  files: Map<string, Uint8Array>;
  /** Writes the text of a user file. */
  write(path: string, text: string): void;
  writeBytes(path: string, bytes: Uint8Array): void;
  read(path: string): string;
  readJson<T>(path: string): T;
  has(path: string): boolean;
  delete(path: string): void;
  makeDir(path: string): void;
  /** Paths under `prefix`, sorted. */
  list(prefix: string): string[];
  /** The list `listConversationWorkspaceFiles` would give for `root`. */
  listWorkspace(root: string): ConversationWorkspaceFiles;
  /** Makes the next read of `path` through either interface reject once. */
  failNextRead(path: string): void;
  /** Makes the next plugin-fs or whole-file write of `path` reject once. */
  failNextWrite(path: string): void;
  /** Paths moved to the trash, in order. */
  trashed: string[];
  /** The host's `move_to_trash`: removes the path and records it. */
  moveToTrash(path: string): Promise<void>;
  pluginFs: {
    exists(path: string): Promise<boolean>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    readTextFile(path: string): Promise<string>;
    /** `createNew` refuses a path that holds a file; `create: false` refuses one that holds none. */
    writeFile(path: string, bytes: Uint8Array, options?: { create?: boolean; createNew?: boolean }): Promise<void>;
    remove(path: string, options?: { recursive?: boolean }): Promise<void>;
    readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }>>;
    stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; isSymlink: boolean; size: number }>;
  };
  bridge: {
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; isSymlink: boolean; size: number; mtime: Date | null }>;
    readFile(path: string): Promise<Uint8Array>;
  };
  atomicWrite(path: string, content: string): Promise<void>;
  /** The host's `write_file_atomic`: 'replace' refuses a path that holds no file, 'create' one that holds a file. */
  writeFileAtomic(path: string, bytes: Uint8Array, mode: 'replace' | 'create'): Promise<void>;
}

export function createMemoryHostFs(): MemoryHostFs {
  const files = new Map<string, Uint8Array>();
  const mtimes = new Map<string, number>();
  const dirs = new Set<string>();
  const failing = new Set<string>();
  const failingWrites = new Set<string>();
  const trashed: string[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let clock = 1_000;

  const noEntry = (path: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });

  function addParents(path: string): void {
    let cut = path.lastIndexOf('/');
    while (cut > 0) {
      dirs.add(path.slice(0, cut));
      cut = path.lastIndexOf('/', cut - 1);
    }
  }

  function writeBytes(path: string, bytes: Uint8Array): void {
    addParents(path);
    files.set(path, bytes);
    clock += 1_000;
    mtimes.set(path, clock);
  }

  function readBytes(path: string): Uint8Array {
    if (failing.delete(path)) throw new Error(`EIO: read failed, open '${path}'`);
    const bytes = files.get(path);
    if (!bytes) throw noEntry(path);
    return bytes;
  }

  function removeTree(path: string): void {
    const prefix = `${path}/`;
    for (const key of [...files.keys()]) if (key === path || key.startsWith(prefix)) files.delete(key);
    for (const key of [...dirs]) if (key === path || key.startsWith(prefix)) dirs.delete(key);
  }

  return {
    files,
    write: (path, text) => writeBytes(path, encoder.encode(text)),
    writeBytes,
    read: (path) => decoder.decode(readBytes(path)),
    readJson: <T>(path: string) => JSON.parse(decoder.decode(readBytes(path))) as T,
    has: (path) => files.has(path) || dirs.has(path),
    delete: (path) => removeTree(path),
    makeDir: (path) => {
      addParents(`${path}/.`);
    },
    list: (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)).sort(),
    listWorkspace: (root) => {
      const prefix = `${root}/`;
      return {
        root,
        exceeded: false,
        files: [...files.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((key) => ({
            path: key.slice(prefix.length),
            size: (files.get(key) as Uint8Array).length,
            mtimeMs: mtimes.get(key) as number,
          })),
      };
    },
    failNextRead: (path) => {
      failing.add(path);
    },
    failNextWrite: (path) => {
      failingWrites.add(path);
    },
    trashed,
    moveToTrash: async (path) => {
      if (!files.has(path) && !dirs.has(path)) throw noEntry(path);
      removeTree(path);
      trashed.push(path);
    },
    pluginFs: {
      exists: async (path) => files.has(path) || dirs.has(path),
      mkdir: async (path) => {
        addParents(`${path}/.`);
      },
      readFile: async (path) => readBytes(path),
      readTextFile: async (path) => decoder.decode(readBytes(path)),
      writeFile: async (path, bytes, options) => {
        if (failingWrites.delete(path)) throw new Error(`EIO: write failed, open '${path}'`);
        if (options?.createNew && files.has(path)) throw new Error(`fs: file already exists and createNew is set: ${path}`);
        if (options?.create === false && !options.createNew && !files.has(path)) {
          throw new Error(`fs: file does not exist and create is false: ${path}`);
        }
        writeBytes(path, bytes);
      },
      remove: async (path) => {
        if (!files.has(path) && !dirs.has(path)) throw noEntry(path);
        removeTree(path);
      },
      readDir: async (path) => {
        if (!dirs.has(path)) throw noEntry(path);
        const prefix = `${path}/`;
        const names = new Map<string, boolean>();
        for (const key of dirs) {
          if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) names.set(key.slice(prefix.length), true);
        }
        for (const key of files.keys()) {
          if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) names.set(key.slice(prefix.length), false);
        }
        return [...names].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory, isSymlink: false }));
      },
      stat: async (path) => {
        const bytes = files.get(path);
        if (bytes) return { isFile: true, isDirectory: false, isSymlink: false, size: bytes.length };
        if (dirs.has(path)) return { isFile: false, isDirectory: true, isSymlink: false, size: 0 };
        throw noEntry(path);
      },
    },
    bridge: {
      exists: async (path) => files.has(path) || dirs.has(path),
      stat: async (path) => {
        const bytes = files.get(path);
        if (bytes) {
          return { isFile: true, isDirectory: false, isSymlink: false, size: bytes.length, mtime: new Date(mtimes.get(path) as number) };
        }
        if (dirs.has(path)) return { isFile: false, isDirectory: true, isSymlink: false, size: 0, mtime: null };
        throw noEntry(path);
      },
      readFile: async (path) => readBytes(path),
    },
    atomicWrite: async (path, content) => writeBytes(path, encoder.encode(content)),
    writeFileAtomic: async (path, bytes, mode) => {
      if (failingWrites.delete(path)) throw new Error(`EIO: write failed, open '${path}'`);
      if (mode === 'replace' && !files.has(path)) throw noEntry(path);
      if (mode === 'create' && files.has(path)) {
        throw Object.assign(new Error(`EEXIST: file already exists, link '${path}'`), { code: 'EEXIST' });
      }
      writeBytes(path, bytes);
    },
  };
}
