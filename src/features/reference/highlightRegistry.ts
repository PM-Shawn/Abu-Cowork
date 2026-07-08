// Best-effort 引用高亮：把「已加入对话」的选段用 CSS Custom Highlight API 留浅底纹。
// 不支持的环境(老 WebView / happy-dom) 全 no-op。范围与当前预览 DOM 绑定，
// 换文件或删 chip 时清除。
const HIGHLIGHT_NAME = 'abu-reference';
const ranges = new Map<string, Range>();

interface HighlightLike { has(r: Range): boolean; add(r: Range): void; delete(r: Range): void; clear(): void }

function supported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

function apply(): void {
  if (!supported()) return;
  const hl = new Highlight(...ranges.values()) as unknown as HighlightLike;
  (CSS as unknown as { highlights: Map<string, unknown> }).highlights.set(HIGHLIGHT_NAME, hl);
}

export const highlightRegistry = {
  add(id: string, range: Range): void {
    ranges.set(id, range);
    apply();
  },
  remove(id: string): void {
    ranges.delete(id);
    apply();
  },
  clear(): void {
    ranges.clear();
    if (supported()) (CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete(HIGHLIGHT_NAME);
  },
  size(): number {
    return ranges.size;
  },
};
