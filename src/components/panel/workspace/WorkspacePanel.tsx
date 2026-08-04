import { ListChecks, AppWindow, SquareTerminal } from 'lucide-react';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n } from '@/i18n';
import TabStrip from './TabStrip';
import SummaryBody from './SummaryBody';
import PreviewPanel from '../PreviewPanel';
import TerminalTab from './TerminalTab';
import BrowserTab from './BrowserTab';

/**
 * Empty state shown when every tab is closed (TRAE "从这里开始"): a launcher
 * listing the three things the panel can open.
 */
function WorkspaceEmptyState() {
  const { t } = useI18n();
  const openSummary = usePreviewStore((s) => s.openSummary);
  const openBrowser = usePreviewStore((s) => s.openBrowser);
  const openTerminal = usePreviewStore((s) => s.openTerminal);

  const rows = [
    { key: 'summary', Icon: ListChecks, label: t.workspace.summaryTitle, desc: t.workspace.summaryDesc, onClick: () => openSummary() },
    { key: 'browser', Icon: AppWindow, label: t.workspace.browserTitle, desc: t.workspace.browserDesc, onClick: () => openBrowser() },
    { key: 'terminal', Icon: SquareTerminal, label: t.workspace.terminalTitle, desc: t.workspace.terminalDesc, onClick: () => openTerminal() },
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col justify-center px-5">
      <p className="text-minor text-[var(--abu-text-tertiary)] mb-2 px-2">{t.workspace.startHere}</p>
      {rows.map(({ key, Icon, label, desc, onClick }) => (
        <button
          key={key}
          type="button"
          onClick={onClick}
          className="flex items-center gap-3 px-2 py-2.5 rounded-md hover:bg-[var(--abu-bg-hover)] text-left"
        >
          <Icon className="w-4 h-4 text-[var(--abu-text-secondary)] shrink-0" strokeWidth={1.5} />
          <span className="text-body text-[var(--abu-text-primary)] shrink-0">{label}</span>
          <span className="text-minor text-[var(--abu-text-tertiary)] truncate">{desc}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Owns the tab strip and the keep-alive tab bodies. Every open tab stays
 * mounted at all times — inactive ones are hidden with CSS (never unmounted) so
 * switching back preserves preview editor drafts, terminal scrollback, and
 * browser page/history state. When no tabs are open, shows the "从这里开始"
 * launcher. See docs/2026-07-17-workspace-tabs-design.md.
 */
export default function WorkspacePanel() {
  const tabs = usePreviewStore((s) => s.tabs);
  const activeTabId = usePreviewStore((s) => s.activeTabId);

  return (
    <div className="flex flex-col h-full">
      <TabStrip />
      {tabs.length === 0 ? (
        <WorkspaceEmptyState />
      ) : (
        <div className="flex-1 min-h-0 relative">
          {tabs.map((tab) => (
            <div key={tab.id} hidden={tab.id !== activeTabId} className="h-full">
              {tab.kind === 'summary' ? (
                <SummaryBody />
              ) : tab.kind === 'preview' ? (
                <PreviewPanel filePath={tab.filePath} tabId={tab.id} embedded />
              ) : tab.kind === 'terminal' ? (
                <TerminalTab tabId={tab.id} />
              ) : (
                <BrowserTab tabId={tab.id} url={tab.url} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
