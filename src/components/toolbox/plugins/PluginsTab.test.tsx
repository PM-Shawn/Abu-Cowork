// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { act, render as renderBare, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';

// The archive question is a design-system confirmation, so the tab renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  // The store reads through the result variant so a failed read cannot pass
  // for an empty one (pluginStore module doc).
  readInstalledResult: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));
vi.mock('@/core/plugin/builtinMarket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/plugin/builtinMarket')>()),
  resolveBuiltinMarketDir: vi.fn().mockResolvedValue(null),
}));

// The two panels are exercised by their own suites; here only "which one is
// mounted, with what props" matters, so they are stubbed to record that.
vi.mock('./MarketplaceBrowser', async () => {
  const { Button } = await import('@/components/ds/button');
  return {
    default: (props: { home: string; onAddMarketplace: () => void }) => (
      <div data-testid="stub-marketplace-browser" data-home={String(props.home)}>
        <Button data-testid="stub-add-cta" onClick={props.onAddMarketplace}>add from the empty market</Button>
      </div>
    ),
  };
});
vi.mock('./AuthoredPluginList', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="stub-authored-list" data-home={String(props.home)} />
  ),
}));
// The dialog's own flow (pick a folder, parse its manifest) has its own suite;
// here only what the tab does with the result matters, so the stub just fires
// `onAdded` on demand.
vi.mock('./AddMarketplaceDialog', async () => {
  const { Button } = await import('@/components/ds/button');
  return {
    default: ({ open, onAdded }: { open: boolean; onAdded?: (name: string) => void }) => (
      <Button data-testid="stub-added-marketplace" data-open={String(open)} onClick={() => onAdded?.('demo-market')}>added</Button>
    ),
  };
});

vi.mock('@/core/plugin/operationBridge', async importOriginal => ({ ...(await importOriginal<object>()), archivePluginOperation: vi.fn() }));
vi.mock('@/stores/pluginStore', async importOriginal => ({ ...(await importOriginal<object>()), bootstrapPluginUpdates: vi.fn() }));
import { archivePluginOperation } from '@/core/plugin/operationBridge';
import { getI18n } from '@/i18n';
import { bootstrapPluginUpdates, usePluginStore } from '@/stores/pluginStore';
import { DEFAULT_SOURCES, useExtensionSourceStore } from '@/stores/extensionSourceStore';
import PluginsTab from './PluginsTab';

beforeEach(() => {
  vi.clearAllMocks();
  usePluginStore.setState({ marketplaces: [], installed: [], loading: false, error: null, recoveryError: null, unreadableOperation: null });
  useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
});

describe('PluginsTab', () => {
  it('mounts the marketplace browser for 市场', async () => {
    render(<PluginsTab searchQuery="" source="market" />);
    const browser = await screen.findByTestId('stub-marketplace-browser');
    expect(browser).toHaveAttribute('data-home', '/Users/testuser');
    // One shelf at a time: the authored list is 「我的」's.
    expect(screen.queryByTestId('stub-authored-list')).toBeNull();
  });

  it('gives 我的 one list, with what the user created here inside it', async () => {
    render(<PluginsTab searchQuery="" source="mine" />);
    const list = await screen.findByTestId('stub-authored-list');
    expect(list).toHaveAttribute('data-home', '/Users/testuser');
    // One list, so the authored cards sit inside the shelf's own container.
    expect(screen.getByTestId('plugin-mine-group')).toContainElement(list);
    expect(screen.queryByTestId('stub-marketplace-browser')).toBeNull();
  });

  it('defaults to the market panel when no source is passed', async () => {
    // 市场 is the default shelf on every tab, and a standalone mount must still
    // render something rather than a blank panel.
    render(<PluginsTab searchQuery="" />);
    await screen.findByTestId('stub-marketplace-browser');
  });

  it('jumps to 市场 when a marketplace is added from 我的', async () => {
    // The new market is browsed on 市场, and `requestedMarket` is consumed by
    // MarketplaceBrowser — which 我的 does not mount. Without the jump, adding
    // one from 我的 closes the dialog onto an unchanged authored list: a
    // silent no-op the user reads as a failed add.
    useExtensionSourceStore.getState().setSource('plugins', 'mine');
    render(<PluginsTab searchQuery="" source="mine" />);
    fireEvent.click(await screen.findByTestId('stub-added-marketplace'));
    expect(useExtensionSourceStore.getState().sources.plugins).toBe('market');
    // Only that tab moves — a marketplace add says nothing about the others.
    expect(useExtensionSourceStore.getState().sources.skills).toBe('market');
  });

  it('no longer renders the 已安装 / 插件市场 sub-tabs', async () => {
    render(<PluginsTab searchQuery="" />);
    await screen.findByTestId('stub-marketplace-browser');
    await waitFor(() =>
      expect(screen.queryByText(/^(已安装|Installed)$/)).toBeNull(),
    );
    expect(screen.queryByText(/^(插件市场|Marketplace)$/)).toBeNull();
  });
});

it('archives only after consequence confirmation and retains backup paths afterward', async () => {
  const backup = '/profile/.abu/plugin-packages/market/demo/.abu-plugin-backup-1';
  const archivedPath = '/profile/.abu/plugin-operations/corrupt-1.enc';
  usePluginStore.setState({ recoveryError: 'unreadable', unreadableOperation: { unreadable: true, fingerprint: 'identity', backupPaths: [backup] } });
  vi.mocked(archivePluginOperation).mockResolvedValue({ archivedPath, backupPaths: [backup] });
  render(<PluginsTab searchQuery="" />);
  const pageButton = () => within(screen.getByRole('alert')).getByRole('button', { name: getI18n().toolbox.pluginsArchiveContinue });
  fireEvent.click(pageButton());
  const question = await screen.findByRole('alertdialog');
  // The question says what archiving does and names every backup the user has to keep.
  expect(question).toHaveTextContent(getI18n().toolbox.pluginsArchiveWarning);
  expect(question).toHaveTextContent(backup);
  expect(archivePluginOperation).not.toHaveBeenCalled();
  fireEvent.click(within(question).getByRole('button', { name: getI18n().common.cancel }));
  await act(async () => {});
  expect(archivePluginOperation).not.toHaveBeenCalled();
  fireEvent.click(pageButton());
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: getI18n().toolbox.pluginsArchiveContinue }));
  await waitFor(() => expect(archivePluginOperation).toHaveBeenCalledExactlyOnceWith('identity'));
  const notice = await screen.findByRole('status');
  expect(within(notice).getByText(archivedPath)).toBeVisible();
  expect(within(notice).getByText(backup)).toBeVisible();
});

describe('PluginsTab: recovery and archiving', () => {
  const backups = ['/profile/.abu/plugin-packages/market/demo/.abu-plugin-backup-1', '/profile/.abu/plugin-packages/market/demo/.abu-plugin-backup-2'];
  const unreadable = { unreadable: true as const, fingerprint: 'identity', backupPaths: backups };
  const tb = () => getI18n().toolbox;
  const archiveButton = () => within(screen.getByRole('alert')).getByRole('button', { name: tb().pluginsArchiveContinue });
  const answerYes = async () => {
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: tb().pluginsArchiveContinue }));
    await act(async () => {});
  };

  it('announces a failed recovery with its reason and the backup paths', () => {
    usePluginStore.setState({ recoveryError: 'operation record unreadable', unreadableOperation: unreadable });
    render(<PluginsTab searchQuery="" />);
    const message = screen.getByRole('alert');
    expect(message).toHaveTextContent(tb().pluginsRecoveryNeeded);
    expect(message).toHaveTextContent('operation record unreadable');
    for (const path of backups) expect(within(message).getByText(path)).toBeInTheDocument();
  });

  it('joins the backup paths with 、 in the question', async () => {
    usePluginStore.setState({ recoveryError: 'unreadable', unreadableOperation: unreadable });
    render(<PluginsTab searchQuery="" />);
    fireEvent.click(archiveButton());
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(`${tb().pluginsArchiveWarning} ${backups.join('、')}`);
  });

  it('archives once when the answer is given twice, and the button shows it is working', async () => {
    let finish!: (value: { archivedPath: string; backupPaths: string[] }) => void;
    vi.mocked(archivePluginOperation).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    usePluginStore.setState({ recoveryError: 'unreadable', unreadableOperation: unreadable });
    render(<PluginsTab searchQuery="" />);
    fireEvent.click(archiveButton());
    await answerYes();
    expect(archivePluginOperation).toHaveBeenCalledTimes(1);
    // Working, not disabled: the focus stays on the button.
    expect(archiveButton()).toHaveAttribute('aria-disabled', 'true');
    expect(archiveButton()).not.toBeDisabled();

    // A press on the working button asks nothing; a second question answered while the first archive runs archives nothing.
    fireEvent.click(archiveButton());
    await act(async () => {});
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(archivePluginOperation).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ archivedPath: '/profile/.abu/plugin-operations/corrupt-1.enc', backupPaths: backups }); });
  });

  it('archives nothing when the unreadable record is gone or another one by the time of the answer', async () => {
    usePluginStore.setState({ recoveryError: 'unreadable', unreadableOperation: unreadable });
    render(<PluginsTab searchQuery="" />);
    fireEvent.click(archiveButton());
    await screen.findByRole('alertdialog');
    act(() => { usePluginStore.setState({ unreadableOperation: { ...unreadable, fingerprint: 'another' } }); });
    await answerYes();
    expect(archivePluginOperation).not.toHaveBeenCalled();
  });

  it('archives nothing when the question is answered after the plugins page has left the screen', async () => {
    usePluginStore.setState({ recoveryError: 'unreadable', unreadableOperation: unreadable });
    // The app shows another view in place of the page (a notification click, the new-task action).
    function Shell({ page }: { page: boolean }) {
      return page ? <PluginsTab searchQuery="" /> : <p>another view</p>;
    }
    const view = render(<Shell page />);
    fireEvent.click(archiveButton());
    await screen.findByRole('alertdialog');
    view.rerender(<Shell page={false} />);
    expect(screen.getByText('another view')).toBeInTheDocument();

    // The question is a page-level layer: it is still there, and its answer is for nobody.
    await answerYes();
    expect(archivePluginOperation).not.toHaveBeenCalled();
    expect(bootstrapPluginUpdates).not.toHaveBeenCalled();
  });

  it('puts a failed archive into the recovery message', async () => {
    vi.mocked(archivePluginOperation).mockRejectedValue(new Error('archive refused'));
    usePluginStore.setState({ recoveryError: 'unreadable', unreadableOperation: unreadable });
    render(<PluginsTab searchQuery="" />);
    fireEvent.click(archiveButton());
    await answerYes();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('archive refused'));
    expect(bootstrapPluginUpdates).not.toHaveBeenCalled();
  });

  it('retries recovery once per press while the retry is running', async () => {
    let finish!: () => void;
    vi.mocked(bootstrapPluginUpdates).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    usePluginStore.setState({ recoveryError: 'recovery failed', unreadableOperation: null });
    render(<PluginsTab searchQuery="" />);
    const retry = () => screen.getByRole('button', { name: tb().pluginsRetryRecovery });
    fireEvent.click(retry());
    fireEvent.click(retry());
    expect(bootstrapPluginUpdates).toHaveBeenCalledTimes(1);
    expect(retry()).toHaveAttribute('aria-disabled', 'true');
    await act(async () => { finish(); });
    expect(retry()).not.toHaveAttribute('aria-disabled');
  });
});

describe('PluginsTab: the add window', () => {
  it('opens from the empty market\'s own button and from the page\'s add trigger', async () => {
    const view = render(<PluginsTab searchQuery="" />);
    const dialog = await screen.findByTestId('stub-added-marketplace');
    expect(dialog).toHaveAttribute('data-open', 'false');
    fireEvent.click(screen.getByTestId('stub-add-cta'));
    expect(dialog).toHaveAttribute('data-open', 'true');
    view.unmount();

    const again = render(<PluginsTab searchQuery="" addTrigger={0} />);
    expect(await screen.findByTestId('stub-added-marketplace')).toHaveAttribute('data-open', 'false');
    again.rerender(<PluginsTab searchQuery="" addTrigger={1} />);
    expect(screen.getByTestId('stub-added-marketplace')).toHaveAttribute('data-open', 'true');
  });
});
