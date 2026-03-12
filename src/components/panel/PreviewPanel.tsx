import { useState, useEffect, lazy, Suspense } from 'react';
import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { getBaseName, loadLocalImage } from '@/utils/pathUtils';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n } from '@/i18n';
import { ScrollArea } from '@/components/ui/scroll-area';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Loader2, X, FolderOpen, Code, Eye, Globe, FileCode, FileText, FileImage, FileSpreadsheet, FileType, File } from 'lucide-react';
import { Button } from '@/components/ui/button';

const PdfPreview = lazy(() => import('@/components/preview/PdfPreview'));
const DocxPreview = lazy(() => import('@/components/preview/DocxPreview'));
const XlsxPreview = lazy(() => import('@/components/preview/XlsxPreview'));
const CsvPreview = lazy(() => import('@/components/preview/CsvPreview'));

type RendererType = 'markdown' | 'code' | 'image' | 'text' | 'html' | 'pdf' | 'docx' | 'xlsx' | 'csv' | 'unsupported';

/** Binary types that handle their own file reading */
const BINARY_TYPES = new Set<RendererType>(['pdf', 'docx', 'xlsx']);

function isDataUrl(path: string): boolean {
  return path.startsWith('data:');
}

function getRendererType(filePath: string): RendererType {
  if (isDataUrl(filePath) && filePath.startsWith('data:image/')) return 'image';
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (ext === 'md') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (ext === 'csv') return 'csv';
  if ([
    'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h',
    'json', 'yaml', 'yml', 'toml', 'xml', 'css', 'scss', 'less',
    'sh', 'bash', 'zsh', 'sql', 'graphql', 'rb', 'php', 'swift', 'kt'
  ].includes(ext)) return 'code';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return 'image';
  if (['txt', 'log'].includes(ext)) return 'text';
  return 'unsupported';
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', json: 'json', yaml: 'yaml', yml: 'yaml',
    html: 'html', css: 'css', sh: 'bash', bash: 'bash',
  };
  return langMap[ext] || ext || 'text';
}

function getFileIcon(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'html', 'css', 'json'].includes(ext)) return FileCode;
  if (['md', 'txt', 'log'].includes(ext)) return FileText;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return FileImage;
  if (['xlsx', 'xls', 'csv'].includes(ext)) return FileSpreadsheet;
  if (ext === 'pdf' || ext === 'docx') return FileType;
  return File;
}

function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-5 h-5 text-[#d97757] animate-spin" />
    </div>
  );
}

export default function PreviewPanel() {
  const { previewFilePath, closePreview } = usePreviewStore();
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [htmlViewMode, setHtmlViewMode] = useState<'preview' | 'source'>('preview');

  const rendererType = previewFilePath ? getRendererType(previewFilePath) : 'unsupported';
  const fileName = previewFilePath && isDataUrl(previewFilePath) ? '图片预览' : (previewFilePath ? getBaseName(previewFilePath) : '');
  const Icon = previewFilePath ? (isDataUrl(previewFilePath) ? FileImage : getFileIcon(previewFilePath)) : File;

  useEffect(() => {
    if (!previewFilePath) {
      setContent(null);
      setImageUrl(null);
      return;
    }

    let cancelled = false;
    let blobUrl: string | null = null;

    const loadFile = async () => {
      setLoading(true);
      setError(null);
      setContent(null);
      setImageUrl(null);

      try {
        // Binary types and unsupported types don't need text reading from parent
        if (rendererType === 'unsupported' || BINARY_TYPES.has(rendererType)) {
          setLoading(false);
          return;
        }

        // Data URL: use directly
        if (isDataUrl(previewFilePath)) {
          setImageUrl(previewFilePath);
          setLoading(false);
          return;
        }

        // Check if file exists before attempting to read
        const fileExists = await exists(previewFilePath);
        if (cancelled) return;
        if (!fileExists) {
          setError(`${t.panel.fileNotFound}: ${getBaseName(previewFilePath)}`);
          setLoading(false);
          return;
        }

        if (rendererType === 'image') {
          blobUrl = await loadLocalImage(previewFilePath);
          if (cancelled) { URL.revokeObjectURL(blobUrl); blobUrl = null; return; }
          setImageUrl(blobUrl);
        } else {
          const text = await readTextFile(previewFilePath);
          if (cancelled) return;
          setContent(text);
        }
      } catch (err) {
        if (cancelled) return;
        console.error('[PreviewPanel] Failed to read file:', previewFilePath, err);
        const message = err instanceof Error ? err.message : String(err);
        setError(message || t.panel.failedToReadFile);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadFile();
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable from i18n singleton
  }, [previewFilePath, rendererType]);

  const handleOpenInFinder = async () => {
    if (previewFilePath) {
      try {
        await revealItemInDir(previewFilePath);
      } catch (err) {
        console.error('Failed to open folder:', err);
      }
    }
  };

  const handleOpenInBrowser = async () => {
    if (!previewFilePath) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const platform = navigator.platform.toLowerCase();
      const command = platform.includes('win')
        ? `start "" "${previewFilePath}"`
        : platform.includes('linux')
          ? `xdg-open "${previewFilePath}"`
          : `open "${previewFilePath}"`;
      await invoke('run_shell_command', {
        command,
        cwd: null,
        background: true,
        timeout: 5,
        sandboxEnabled: false,
      });
    } catch (err) {
      console.error('[PreviewPanel] Failed to open in browser:', err);
    }
  };

  if (!previewFilePath) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Header — mt-7 to clear the overlay title bar drag region */}
      <div className="shrink-0 px-3 py-2.5 mt-7 border-b border-[#e5e2db] flex items-center gap-2">
        <Icon className="w-4 h-4 text-[#656358] shrink-0" />
        <span className="text-[13px] font-medium text-[#29261b] truncate flex-1">
          {fileName}
        </span>
        {rendererType === 'html' && (
          <>
            <div className="flex items-center bg-[#e8e5de] rounded p-0.5 mr-1">
              <button
                onClick={() => setHtmlViewMode('preview')}
                className={`p-1 rounded text-[10px] ${htmlViewMode === 'preview' ? 'bg-white shadow-sm' : ''}`}
                title={t.panel.previewMode}
              >
                <Eye className="w-3 h-3" />
              </button>
              <button
                onClick={() => setHtmlViewMode('source')}
                className={`p-1 rounded text-[10px] ${htmlViewMode === 'source' ? 'bg-white shadow-sm' : ''}`}
                title={t.panel.sourceMode}
              >
                <Code className="w-3 h-3" />
              </button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleOpenInBrowser}
              className="h-6 w-6 text-[#656358] hover:text-[#d97757]"
              title={t.chat.openInBrowser}
            >
              <Globe className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={closePreview}
          className="h-6 w-6 text-[#656358] hover:text-[#29261b]"
          title={t.panel.closePreview}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 text-[#d97757] animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <p className="text-[13px] text-red-500">{error}</p>
          </div>
        ) : rendererType === 'pdf' || rendererType === 'docx' || rendererType === 'xlsx' || (rendererType === 'csv' && content !== null) ? (
          <Suspense fallback={<LazyFallback />}>
            {rendererType === 'pdf' && <PdfPreview filePath={previewFilePath} />}
            {rendererType === 'docx' && <DocxPreview filePath={previewFilePath} />}
            {rendererType === 'xlsx' && <XlsxPreview filePath={previewFilePath} />}
            {rendererType === 'csv' && content !== null && <CsvPreview content={content} />}
          </Suspense>
        ) : rendererType === 'image' && imageUrl ? (
          <div className="flex items-center justify-center h-full p-4 bg-[#e8e5de]/30">
            <img src={imageUrl} alt={fileName} className="max-w-full max-h-full object-contain" />
          </div>
        ) : rendererType === 'markdown' && content !== null ? (
          <ScrollArea className="h-full">
            <div className="p-4">
              <MarkdownRenderer content={content} />
            </div>
          </ScrollArea>
        ) : rendererType === 'html' && content !== null ? (
          htmlViewMode === 'preview' ? (
            <iframe
              srcDoc={content}
              title={fileName}
              sandbox="allow-scripts"
              className="w-full h-full border-0 bg-white"
            />
          ) : (
            <ScrollArea className="h-full bg-[#1e1e1e]">
              <SyntaxHighlighter
                style={oneDark}
                language="html"
                customStyle={{ margin: 0, padding: '12px', fontSize: '11px', background: '#1e1e1e' }}
              >
                {content}
              </SyntaxHighlighter>
            </ScrollArea>
          )
        ) : rendererType === 'code' && content !== null ? (
          <ScrollArea className="h-full bg-[#1e1e1e]">
            <SyntaxHighlighter
              style={oneDark}
              language={getLanguage(previewFilePath)}
              showLineNumbers
              customStyle={{ margin: 0, padding: '12px', fontSize: '11px', background: '#1e1e1e' }}
              lineNumberStyle={{ minWidth: '2em', paddingRight: '0.5em', color: '#666' }}
            >
              {content}
            </SyntaxHighlighter>
          </ScrollArea>
        ) : rendererType === 'text' && content !== null ? (
          <ScrollArea className="h-full">
            <pre className="p-4 text-[12px] text-[#29261b] font-mono whitespace-pre-wrap break-words">
              {content}
            </pre>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <p className="text-[13px] text-[#656358]">{t.panel.unsupportedFileType}</p>
            <Button variant="outline" size="sm" onClick={handleOpenInFinder} className="mt-3">
              <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
              {t.panel.showInFinder}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
