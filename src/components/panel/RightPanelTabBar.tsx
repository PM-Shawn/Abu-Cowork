import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { FileText, X, PanelRight } from 'lucide-react';

/**
 * Tab bar at the top of the right panel card. Shows the always-present "task summary"
 * tab plus a "preview" tab when a file is open, and the panel-level controls
 * (fullscreen / collapse) on the right. File-specific controls (source/preview, version,
 * open-in-app) live in PreviewPanel's own toolbar row below, not here.
 */
export default function RightPanelTabBar({
  activeTab,
  previewFileName,
  onSelect,
  onClosePreview,
  onCollapse,
}: {
  activeTab: 'summary' | 'preview';
  previewFileName: string | null;
  onSelect: (tab: 'summary' | 'preview') => void;
  onClosePreview: () => void;
  onCollapse: () => void;
}) {
  const { t } = useI18n();
  const hasPreview = previewFileName !== null;

  return (
    <div className="shrink-0 flex items-center gap-1 h-11 px-2 border-b border-[var(--abu-border)]">
      {/* Tabs */}
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <button
          onClick={() => onSelect('summary')}
          className={cn(
            'flex items-center h-7 px-2.5 rounded-md text-[13px] font-medium shrink-0 transition-colors',
            activeTab === 'summary'
              ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
              : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]',
          )}
        >
          {t.panel.taskSummary}
        </button>

        {hasPreview && (
          <div
            className={cn(
              'flex items-center gap-1 h-7 pl-2 pr-1 rounded-md text-[13px] min-w-0 max-w-[220px] transition-colors',
              activeTab === 'preview'
                ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]',
            )}
          >
            <button onClick={() => onSelect('preview')} className="flex items-center gap-1.5 min-w-0" title={previewFileName ?? undefined}>
              <FileText className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{previewFileName}</span>
            </button>
            <button
              onClick={onClosePreview}
              className="shrink-0 p-0.5 rounded hover:bg-[var(--abu-bg-pressed)] text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]"
              title={t.panel.closePreview}
            >
              <X className="h-3 w-3" strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>

      {/* Panel-level controls — fullscreen lives in PreviewPanel's own toolbar (it's
          file-specific, gated by renderer type, and must stay clickable inside the
          fullscreen overlay). The tab bar only carries the panel collapse. */}
      <div className="flex items-center gap-0.5 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={onCollapse}
          className="h-6 w-6 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]"
          title={t.panel.hidePanel}
        >
          <PanelRight className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
      </div>
    </div>
  );
}
