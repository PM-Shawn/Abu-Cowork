// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import AuthoredPluginList from './AuthoredPluginList';
import { releasePreparedInstall, type InstallDisclosure } from '@/core/plugin/installer';
import { getI18n } from '@/i18n';
const state = vi.hoisted(() => ({ authors: [] as unknown[], installed: [] as unknown[], refresh: vi.fn(), prepare: vi.fn(), install: vi.fn(), edit: vi.fn(), remove: vi.fn() }));
vi.mock('@/stores/pluginAuthorStore', () => ({ usePluginAuthorStore: Object.assign((selector: (value: unknown) => unknown) => selector({ ...state, error: null }), { getState: () => state }) }));
vi.mock('@/stores/pluginStore', () => ({ cleanupPluginConfiguration: vi.fn().mockResolvedValue(undefined), usePluginStore: Object.assign((selector: (value: unknown) => unknown) => selector(state), { getState: () => state }) }));
vi.mock('@/core/plugin/installer', () => ({ releasePreparedInstall: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/components/toolbox/plugins/InstalledPluginDetail', () => ({ default: ({ plugin, authorUpdate }: { plugin: unknown; authorUpdate?: { available: boolean; onReview: () => void } }) => plugin && authorUpdate ? <button onClick={authorUpdate.onReview}>{authorUpdate.available ? getI18n().toolbox.pluginsPreviewUpdate : getI18n().toolbox.pluginsCheckChanges}</button> : null }));
vi.mock('@/components/toolbox/plugins/UninstallPluginDialog', () => ({ default: () => null }));
vi.mock('@/components/toolbox/plugins/InstalledPluginCard', () => ({ default: ({ onClick, actions }: { onClick: () => void; actions?: ReactNode }) => <button data-testid="plugin-mine-row" onClick={onClick}>Installed{actions}</button> }));
const author = { id: 'a'.repeat(32), name: null, key: null, sourceDir: '/home/Abu Plugins/a', marketplace: 'author-a', prepared: null };
const disclosure: InstallDisclosure = { preparedToken: 'preview', key: 'demo@author-a', name: 'demo', version: '1', marketplace: 'author-a', manifest: { name: 'demo' }, sourceDir: author.sourceDir, skills: [], mcpServers: [], agents: [], ignoredPayloads: [] };
beforeEach(() => {
  vi.clearAllMocks(); state.authors = [author]; state.installed = [];
  state.refresh.mockResolvedValue(undefined);
  state.prepare.mockResolvedValue({ author: { ...author, name: 'demo', key: disclosure.key, prepared: { checksum: 'new' } }, disclosure });
});
async function openPreview() {
  fireEvent.click(within(screen.getByTestId('plugin-mine-draft')).getByRole('button'));
  fireEvent.click(screen.getByRole('button', { name: getI18n().toolbox.pluginsReviewChanges }));
  await screen.findByTestId('plugin-install-confirm');
}
it('keeps the prepared snapshot alive while an installation outlives its page', async () => {
  let finish!: () => void;
  state.install.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = render(<AuthoredPluginList home="/home" searchQuery="" />);
  await openPreview();
  fireEvent.click(screen.getByTestId('plugin-install-confirm'));
  await waitFor(() => expect(state.install).toHaveBeenCalledOnce());
  view.unmount();
  expect(releasePreparedInstall).not.toHaveBeenCalled();
  await act(async () => { finish(); });
  expect(releasePreparedInstall).toHaveBeenCalledExactlyOnceWith('preview');
});
it('releases a late preview when the author page was already closed', async () => {
  let finish!: (value: unknown) => void;
  state.prepare.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<AuthoredPluginList home="/home" searchQuery="" />);
  fireEvent.click(within(screen.getByTestId('plugin-mine-draft')).getByRole('button'));
  fireEvent.click(screen.getByRole('button', { name: getI18n().toolbox.pluginsReviewChanges }));
  view.unmount();
  await act(async () => { finish({ author, disclosure }); });
  expect(releasePreparedInstall).toHaveBeenCalledExactlyOnceWith('preview');
  expect(state.install).not.toHaveBeenCalled();
});

it('keeps the preview shell stable while validating and returns to details on cancel', async () => {
  let finish!: (value: unknown) => void;
  state.prepare.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  fireEvent.click(within(screen.getByTestId('plugin-mine-draft')).getByRole('button'));
  fireEvent.click(screen.getByRole('button', { name: getI18n().toolbox.pluginsReviewChanges }));
  const panel = screen.getByTestId('plugin-install-disclosure');
  expect(panel).toHaveClass('max-w-2xl', 'h-[min(640px,85vh)]');
  expect(screen.getByRole('status')).toHaveTextContent(getI18n().toolbox.pluginsDisclosureLoading);
  await act(async () => { finish({ author, disclosure }); });
  expect(screen.getByTestId('plugin-install-disclosure')).toBe(panel);
  expect(screen.getByRole('status')).toHaveTextContent(getI18n().toolbox.pluginsValidationPassed);
  fireEvent.click(screen.getByRole('button', { name: getI18n().common.cancel }));
  expect(screen.queryByTestId('plugin-install-disclosure')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: getI18n().toolbox.pluginsReviewChanges })).toBeVisible();
  expect(releasePreparedInstall).toHaveBeenCalledWith('preview');
});
it('shows validated updates on the card and offers a direct update review', async () => {
  const preparedAuthor = { ...author, name: 'demo', key: disclosure.key, prepared: { checksum: 'new' } };
  state.authors = [preparedAuthor];
  state.installed = [{ key: disclosure.key, authoringId: author.id, checksum: 'old' }];
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  expect(screen.getByTestId('plugin-mine-row')).toHaveTextContent(getI18n().toolbox.pluginsAuthorUpdateAvailable);
  fireEvent.click(screen.getByTestId('plugin-mine-row'));
  fireEvent.click(screen.getByRole('button', { name: getI18n().toolbox.pluginsPreviewUpdate }));
  const confirm = await screen.findByTestId('plugin-install-confirm');
  expect(confirm).toHaveTextContent(getI18n().toolbox.pluginsUpdate);
  expect(screen.getByRole('dialog')).toHaveAccessibleName(getI18n().toolbox.pluginsUpdateDisclosureTitle);
});
it('shows no-change feedback inside the preview without offering a redundant update', async () => {
  const preparedAuthor = { ...author, name: 'demo', key: disclosure.key, prepared: { checksum: 'new' } };
  state.authors = [preparedAuthor];
  state.installed = [{ key: disclosure.key, authoringId: author.id, checksum: 'new' }];
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  fireEvent.click(screen.getByTestId('plugin-mine-row'));
  fireEvent.click(screen.getByRole('button', { name: getI18n().toolbox.pluginsCheckChanges }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(getI18n().toolbox.pluginsUnchanged));
  expect(screen.queryByTestId('plugin-install-confirm')).not.toBeInTheDocument();
  expect(releasePreparedInstall).toHaveBeenCalledWith('preview');
});

it('requires an honest source-retention confirmation before deleting a draft', async () => {
  state.remove.mockResolvedValue(undefined);
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  fireEvent.click(within(screen.getByTestId('plugin-mine-draft')).getByRole('button'));
  fireEvent.click(screen.getByTestId('plugin-author-menu'));
  fireEvent.click(screen.getByTestId('plugin-author-menu-delete'));
  expect(screen.getByText(getI18n().toolbox.pluginsDeleteDraftWarning)).toBeVisible();
  expect(screen.getByText(author.sourceDir)).toBeVisible();
  expect(state.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: getI18n().toolbox.pluginsDeleteDraft }));
  await waitFor(() => expect(state.remove).toHaveBeenCalledWith(author.id));
});
