export interface PathAdapter {
  appDataDir(): Promise<string>;
  homeDir(): Promise<string>;
  tempDir(): Promise<string>;
  documentDir(): Promise<string>;
  downloadDir(): Promise<string>;
  desktopDir(): Promise<string>;
  resolveResource(relative: string): Promise<string>;

  join(...segments: string[]): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  normalize(p: string): string;
}
