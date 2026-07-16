import { usePreviewStore } from '@/stores/previewStore';
import TabStrip from './TabStrip';
import PreviewPanel from '../PreviewPanel';
import TerminalTab from './TerminalTab';
import BrowserTab from './BrowserTab';

/**
 * Owns the tab strip and the keep-alive tab bodies. Every open tab stays
 * mounted at all times — inactive ones are hidden with CSS (never
 * unmounted) so switching back preserves preview editor drafts, terminal
 * scrollback, and browser page/history state. See "Why keep-alive mount" in
 * docs/2026-07-17-workspace-tabs-design.md.
 */
export default function WorkspacePanel() {
  const tabs = usePreviewStore((s) => s.tabs);
  const activeTabId = usePreviewStore((s) => s.activeTabId);

  return (
    <div className="flex flex-col h-full">
      <TabStrip />
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <div key={tab.id} hidden={tab.id !== activeTabId} className="h-full">
            {tab.kind === 'preview' ? (
              <PreviewPanel filePath={tab.filePath} tabId={tab.id} embedded />
            ) : tab.kind === 'terminal' ? (
              <TerminalTab tabId={tab.id} />
            ) : (
              <BrowserTab tabId={tab.id} url={tab.url} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
