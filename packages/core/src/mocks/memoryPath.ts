import type { PathAdapter } from '../ports/adapters/path';

export interface MemoryPathConfig {
  appData?: string;
  home?: string;
  temp?: string;
  documents?: string;
  downloads?: string;
  desktop?: string;
  resources?: string;
}

export class MemoryPathAdapter implements PathAdapter {
  private cfg: Required<MemoryPathConfig>;

  constructor(cfg: MemoryPathConfig = {}) {
    this.cfg = {
      appData: cfg.appData ?? '/appdata',
      home: cfg.home ?? '/home/user',
      temp: cfg.temp ?? '/tmp',
      documents: cfg.documents ?? '/home/user/Documents',
      downloads: cfg.downloads ?? '/home/user/Downloads',
      desktop: cfg.desktop ?? '/home/user/Desktop',
      resources: cfg.resources ?? '/resources',
    };
  }

  async appDataDir() {
    return this.cfg.appData;
  }
  async homeDir() {
    return this.cfg.home;
  }
  async tempDir() {
    return this.cfg.temp;
  }
  async documentDir() {
    return this.cfg.documents;
  }
  async downloadDir() {
    return this.cfg.downloads;
  }
  async desktopDir() {
    return this.cfg.desktop;
  }
  async resolveResource(relative: string) {
    return this.join(this.cfg.resources, relative);
  }

  join(...segments: string[]): string {
    const parts: string[] = [];
    const isAbs = segments[0]?.startsWith('/');
    for (const seg of segments) {
      for (const p of seg.split('/')) {
        if (p === '' || p === '.') continue;
        if (p === '..') parts.pop();
        else parts.push(p);
      }
    }
    return (isAbs ? '/' : '') + parts.join('/');
  }
  dirname(p: string): string {
    const i = p.lastIndexOf('/');
    if (i < 0) return '.';
    if (i === 0) return '/';
    return p.slice(0, i);
  }
  basename(p: string, ext?: string): string {
    const i = p.lastIndexOf('/');
    let base = i < 0 ? p : p.slice(i + 1);
    if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
    return base;
  }
  extname(p: string): string {
    const base = this.basename(p);
    const i = base.lastIndexOf('.');
    return i <= 0 ? '' : base.slice(i);
  }
  normalize(p: string): string {
    const isAbs = p.startsWith('/');
    return (isAbs ? '/' : '') + this.join(p).replace(/^\//, '');
  }
}
