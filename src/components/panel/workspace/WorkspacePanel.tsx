import { memo } from 'react';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { usePreviewStore, useVisibleTabs, isTabVisibleFor, workspaceTabButtonId, workspaceTabPanelId } from '@/stores/previewStore';
import { useI18n } from '@/i18n';
import TabStrip from './TabStrip';
import SummaryBody from './SummaryBody';
import PreviewPanel from '../PreviewPanel';
import TerminalTab from './TerminalTab';
import BrowserTab from './BrowserTab';
import SubagentTab from './SubagentTab';
import TeamTab from './TeamTab';

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
    { key: 'summary', icon: AppIcons.plan, label: t.workspace.summaryTitle, desc: t.workspace.summaryDesc, onClick: () => openSummary() },
    { key: 'browser', icon: AppIcons.webPage, label: t.workspace.browserTitle, desc: t.workspace.browserDesc, onClick: () => openBrowser() },
    { key: 'terminal', icon: AppIcons.terminal, label: t.workspace.terminalTitle, desc: t.workspace.terminalDesc, onClick: () => openTerminal() },
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col justify-center px-5">
      <p className="mb-2 px-2 text-ui-sm text-label-tertiary">{t.workspace.startHere}</p>
      {rows.map(({ key, icon, label, desc, onClick }) => (
        <Pressable
          key={key}
          onClick={onClick}
          className="flex h-8 items-center gap-3 rounded-control px-2 text-left hover:bg-fill-hover"
        >
          <Icon icon={icon} size="md" className="text-label-secondary" />
          <span className="shrink-0 text-ui text-label">{label}</span>
          <span className="truncate text-ui-sm text-label-tertiary">{desc}</span>
        </Pressable>
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
function WorkspacePanelImpl() {
  // Bodies are mounted for EVERY tab (keep-alive), including browser tabs
  // adopted for another conversation — their native view must survive. What
  // this conversation may *see* is `visibleTabs`; a foreign tab is therefore
  // never the active one, so its panel stays `hidden` and BrowserTab reads the
  // zero rect that hides its native layer.
  const tabs = usePreviewStore((s) => s.tabs);
  const conversationId = usePreviewStore((s) => s.currentConversationId);
  const visibleTabs = useVisibleTabs();
  const activeTabId = usePreviewStore((s) => s.activeTabId);
  const empty = visibleTabs.length === 0;

  return (
    <div className="flex flex-col h-full">
      <TabStrip key={conversationId ?? 'no-conversation'} />
      {empty && <WorkspaceEmptyState />}
      {tabs.length > 0 && (
        <div
          className="flex-1 min-h-0 relative"
          hidden={empty}
          // Inline display (not just `hidden`): a hidden body area must be
          // laid out at zero size, which is the only signal that takes the
          // native browser layer down with it.
          style={empty ? { display: 'none' } : undefined}
        >
          {tabs.map((tab) => (
            <div
              key={tab.id}
              id={workspaceTabPanelId(tab.id)}
              role="tabpanel"
              aria-labelledby={workspaceTabButtonId(tab.id)}
              hidden={tab.id !== activeTabId}
              className="h-full"
            >
              {tab.kind === 'summary' ? (
                isTabVisibleFor(tab, conversationId) ? <SummaryBody /> : null
              ) : tab.kind === 'preview' ? (
                <PreviewPanel filePath={tab.filePath} tabId={tab.id} embedded />
              ) : tab.kind === 'terminal' ? (
                <TerminalTab tabId={tab.id} />
              ) : tab.kind === 'browser' ? (
                <BrowserTab tabId={tab.id} url={tab.url} />
              ) : tab.kind === 'team' ? (
                <TeamTab conversationId={tab.conversationId} />
              ) : (
                <SubagentTab identity={tab.identity} taskIndex={tab.taskIndex} title={tab.title} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(WorkspacePanelImpl);
