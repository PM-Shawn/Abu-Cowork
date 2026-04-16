import type {
  StorageAdapter,
  FileStat,
  FileEntry,
  FileChangeEvent,
  UnwatchFn,
} from '../ports/adapters/storage';

interface Node {
  isFile: boolean;
  mtime: number;
  content?: Uint8Array;
  children?: Map<string, Node>;
}

type Watcher = (e: FileChangeEvent) => void;

function splitPath(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

export class MemoryStorageAdapter implements StorageAdapter {
  private root: Node = {
    isFile: false,
    mtime: Date.now(),
    children: new Map(),
  };
  private watchers = new Map<string, Set<Watcher>>();

  private getNode(path: string): Node | undefined {
    const parts = splitPath(path);
    let cur: Node | undefined = this.root;
    for (const part of parts) {
      if (!cur || cur.isFile || !cur.children) return undefined;
      cur = cur.children.get(part);
    }
    return cur;
  }

  private getParent(path: string): { parent: Node; name: string } | undefined {
    const parts = splitPath(path);
    if (parts.length === 0) return undefined;
    const name = parts[parts.length - 1];
    let cur: Node = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = cur.children?.get(parts[i]);
      if (!next || next.isFile || !next.children) return undefined;
      cur = next;
    }
    return { parent: cur, name };
  }

  private notify(path: string, type: FileChangeEvent['type']) {
    for (const [watched, set] of this.watchers.entries()) {
      if (path === watched || path.startsWith(watched + '/')) {
        for (const cb of set) cb({ type, path });
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.getNode(path) !== undefined;
  }

  async stat(path: string): Promise<FileStat> {
    const node = this.getNode(path);
    if (!node) throw new Error(`ENOENT: ${path}`);
    return {
      size: node.isFile ? (node.content?.byteLength ?? 0) : 0,
      mtime: node.mtime,
      isFile: node.isFile,
      isDirectory: !node.isFile,
    };
  }

  async lstat(path: string): Promise<FileStat> {
    return this.stat(path);
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const parts = splitPath(path);
    let cur: Node = this.root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (!cur.children) throw new Error(`ENOTDIR: ${path}`);
      let next = cur.children.get(name);
      if (!next) {
        if (!opts?.recursive && i < parts.length - 1) {
          throw new Error(`ENOENT: ${path}`);
        }
        next = { isFile: false, mtime: Date.now(), children: new Map() };
        cur.children.set(name, next);
        this.notify(parts.slice(0, i + 1).join('/'), 'create');
      } else if (next.isFile) {
        throw new Error(`EEXIST file: ${path}`);
      }
      cur = next;
    }
  }

  async readDir(path: string): Promise<FileEntry[]> {
    const node = this.getNode(path);
    if (!node) throw new Error(`ENOENT: ${path}`);
    if (node.isFile || !node.children) throw new Error(`ENOTDIR: ${path}`);
    const out: FileEntry[] = [];
    for (const [name, child] of node.children.entries()) {
      out.push({
        name,
        path: path === '' ? name : `${path}/${name}`,
        isFile: child.isFile,
        isDirectory: !child.isFile,
      });
    }
    return out;
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const info = this.getParent(path);
    if (!info) throw new Error(`ENOENT: ${path}`);
    const { parent, name } = info;
    const target = parent.children?.get(name);
    if (!target) throw new Error(`ENOENT: ${path}`);
    if (!target.isFile && target.children && target.children.size > 0 && !opts?.recursive) {
      throw new Error(`ENOTEMPTY: ${path}`);
    }
    parent.children!.delete(name);
    this.notify(path, 'remove');
  }

  async rename(from: string, to: string): Promise<void> {
    const fromInfo = this.getParent(from);
    const toInfo = this.getParent(to);
    if (!fromInfo || !toInfo) throw new Error(`ENOENT`);
    const node = fromInfo.parent.children?.get(fromInfo.name);
    if (!node) throw new Error(`ENOENT: ${from}`);
    fromInfo.parent.children!.delete(fromInfo.name);
    toInfo.parent.children!.set(toInfo.name, node);
    this.notify(from, 'rename');
    this.notify(to, 'rename');
  }

  async copyFile(from: string, to: string): Promise<void> {
    const src = this.getNode(from);
    if (!src || !src.isFile) throw new Error(`ENOENT: ${from}`);
    const content = src.content ? new Uint8Array(src.content) : new Uint8Array();
    await this.writeFile(to, content);
  }

  async readTextFile(path: string): Promise<string> {
    const bytes = await this.readFile(path);
    return new TextDecoder().decode(bytes);
  }

  async writeTextFile(
    path: string,
    content: string,
    opts?: { append?: boolean }
  ): Promise<void> {
    if (opts?.append) {
      const existing = (await this.exists(path)) ? await this.readTextFile(path) : '';
      await this.writeFile(path, new TextEncoder().encode(existing + content));
    } else {
      await this.writeFile(path, new TextEncoder().encode(content));
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const node = this.getNode(path);
    if (!node || !node.isFile) throw new Error(`ENOENT: ${path}`);
    return node.content ?? new Uint8Array();
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const info = this.getParent(path);
    if (!info) throw new Error(`ENOENT: ${path}`);
    const { parent, name } = info;
    if (!parent.children) throw new Error(`ENOTDIR: ${path}`);
    const existed = parent.children.has(name);
    parent.children.set(name, {
      isFile: true,
      mtime: Date.now(),
      content: new Uint8Array(content),
    });
    this.notify(path, existed ? 'modify' : 'create');
  }

  watch(path: string, onChange: Watcher): UnwatchFn {
    let set = this.watchers.get(path);
    if (!set) {
      set = new Set();
      this.watchers.set(path, set);
    }
    set.add(onChange);
    return () => {
      set!.delete(onChange);
      if (set!.size === 0) this.watchers.delete(path);
    };
  }
}
