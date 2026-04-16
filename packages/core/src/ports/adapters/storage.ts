export interface FileStat {
  size: number;
  mtime: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileChangeEvent {
  type: 'create' | 'modify' | 'remove' | 'rename';
  path: string;
}

export type UnwatchFn = () => void;

export interface StorageAdapter {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;

  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readDir(path: string): Promise<FileEntry[]>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;

  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string, opts?: { append?: boolean }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;

  watch(path: string, onChange: (e: FileChangeEvent) => void): UnwatchFn;
}
