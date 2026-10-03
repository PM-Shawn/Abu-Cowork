// @vitest-environment happy-dom
import type { ReactElement, ReactNode } from 'react';
import { act, fireEvent, render as renderBare, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';

// The detail window is a design-system dialog, so the list renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
import AuthoredPluginList from './AuthoredPluginList';
import { DETAIL_WINDOW_CONTENT_HEIGHT } from '../windowHeight';
import { releasePreparedInstall, type InstallDisclosure } from '@/core/plugin/installer';
import { getI18n } from '@/i18n';
const state = vi.hoisted(() => ({ authors: [] as unknown[], installed: [] as unknown[], error: null as string | null, refresh: vi.fn(), prepare: vi.fn(), install: vi.fn(), edit: vi.fn(), remove: vi.fn(), toast: vi.fn() }));
vi.mock('@/stores/pluginAuthorStore', () => ({ usePluginAuthorStore: Object.assign((selector: (value: unknown) => unknown) => selector({ ...state }), { getState: () => state }) }));
vi.mock('@/stores/toastStore', () => ({ useToastStore: (selector: (value: unknown) => unknown) => selector({ addToast: state.toast }) }));
vi.mock('@/stores/pluginStore', () => ({ cleanupPluginConfiguration: vi.fn().mockResolvedValue(undefined), usePluginStore: Object.assign((selector: (value: unknown) => unknown) => selector(state), { getState: () => state }) }));
vi.mock('@/core/plugin/installer', () => ({ releasePreparedInstall: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/components/toolbox/plugins/InstalledPluginDetail', async () => {
  const { Button } = await import('@/components/ds/button');
  return { default: ({ plugin, authorUpdate, authorActions }: { plugin: unknown; authorUpdate?: { available: boolean; onReview: () => void }; authorActions?: { id: string }[] }) => plugin && authorUpdate
    ? <Button data-author-actions={authorActions?.map(action => action.id).join(',')} onClick={authorUpdate.onReview}>{authorUpdate.available ? getI18n().toolbox.pluginsPreviewUpdate : getI18n().toolbox.pluginsCheckChanges}</Button> : null };
});
vi.mock('@/components/toolbox/plugins/UninstallPluginDialog', () => ({ default: () => null }));
vi.mock('@/components/toolbox/plugins/InstalledPluginCard', async () => {
  const { Button } = await import('@/components/ds/button');
  return { default: ({ onClick, actions }: { onClick: () => void; actions?: ReactNode }) => <Button data-testid="plugin-mine-row" onClick={onClick}>Installed{actions}</Button> };
});
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
  // The window carries the width; the height asked for sits on its content area.
  expect(panel).toHaveClass('max-w-2xl');
  expect(Array.from(panel.querySelectorAll('div')).some((area) => area.classList.contains(DETAIL_WINDOW_CONTENT_HEIGHT))).toBe(true);
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
  await userEvent.click(screen.getByTestId('plugin-author-menu'));
  fireEvent.click(screen.getByTestId('plugin-author-menu-delete'));
  // The chosen action runs once the menu has gone.
  const question = await screen.findByRole('alertdialog');
  expect(question).toHaveAccessibleName(getI18n().toolbox.pluginsDeleteDraft);
  expect(question).toHaveTextContent(getI18n().toolbox.pluginsDeleteDraftWarning);
  expect(question).toHaveTextContent(author.sourceDir);
  expect(state.remove).not.toHaveBeenCalled();
  fireEvent.click(within(question).getByRole('button', { name: getI18n().toolbox.pluginsDeleteDraft }));
  await waitFor(() => expect(state.remove).toHaveBeenCalledExactlyOnceWith(author.id));
  // The draft is gone, so its window closes.
  await waitFor(() => expect(screen.queryByTestId('plugin-author-detail')).toBeNull());
});

async function askToDeleteDraft() {
  fireEvent.click(within(screen.getByTestId('plugin-mine-draft')).getByRole('button'));
  await userEvent.click(screen.getByTestId('plugin-author-menu'));
  fireEvent.click(screen.getByTestId('plugin-author-menu-delete'));
  return screen.findByRole('alertdialog');
}

it('deletes nothing when the question is cancelled, and keeps the draft window open', async () => {
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  const question = await askToDeleteDraft();
  fireEvent.click(within(question).getByRole('button', { name: getI18n().common.cancel }));
  await act(async () => {});
  expect(state.remove).not.toHaveBeenCalled();
  expect(screen.getByTestId('plugin-author-detail')).toBeInTheDocument();
});

it('deletes nothing when the draft is gone by the time of the answer', async () => {
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  const question = await askToDeleteDraft();
  // Removed from somewhere else while the question was on screen.
  state.authors = [];
  fireEvent.click(within(question).getByRole('button', { name: getI18n().toolbox.pluginsDeleteDraft }));
  await act(async () => {});
  expect(state.remove).not.toHaveBeenCalled();
});

it('deletes nothing when the draft was installed by the time of the answer', async () => {
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  const question = await askToDeleteDraft();
  state.installed = [{ key: 'demo@author-a', authoringId: author.id, checksum: 'new' }];
  fireEvent.click(within(question).getByRole('button', { name: getI18n().toolbox.pluginsDeleteDraft }));
  await act(async () => {});
  expect(state.remove).not.toHaveBeenCalled();
});

it('ends the delete question with the draft window when the page leaves the screen, and deletes nothing', async () => {
  function Shell({ page }: { page: boolean }) {
    return page ? <AuthoredPluginList home="/home" searchQuery="" /> : <p>another view</p>;
  }
  const view = render(<Shell page />);
  await askToDeleteDraft();
  view.rerender(<Shell page={false} />);
  await act(async () => {});

  // The question was asked over the draft's window: it is answered with cancel when that window goes.
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(state.remove).not.toHaveBeenCalled();
});

it('reports a failed delete once and lets the draft be deleted again', async () => {
  state.remove.mockRejectedValueOnce(new Error('record locked')).mockResolvedValueOnce(undefined);
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  fireEvent.click(within(await askToDeleteDraft()).getByRole('button', { name: getI18n().toolbox.pluginsDeleteDraft }));
  await waitFor(() => expect(state.remove).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(state.toast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'error', message: 'Error: record locked' }));
  // The window is still open on the draft; the guard was released.
  await userEvent.click(screen.getByTestId('plugin-author-menu'));
  fireEvent.click(screen.getByTestId('plugin-author-menu-delete'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: getI18n().toolbox.pluginsDeleteDraft }));
  await waitFor(() => expect(state.remove).toHaveBeenCalledTimes(2));
});

it('offers delete for a draft only, never for a plugin that is installed', async () => {
  const preparedAuthor = { ...author, name: 'demo', key: disclosure.key, prepared: { checksum: 'new' } };
  state.authors = [preparedAuthor];
  state.installed = [{ key: disclosure.key, authoringId: author.id, checksum: 'new' }];
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  fireEvent.click(screen.getByTestId('plugin-mine-row'));
  expect(screen.getByRole('button', { name: getI18n().toolbox.pluginsCheckChanges })).toHaveAttribute('data-author-actions', 'edit,source');
});

it('shows a store error as an announced message in the grid', () => {
  state.error = 'author records unreadable';
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  expect(screen.getByRole('alert')).toHaveTextContent('author records unreadable');
  state.error = null;
});

it('gives the focus back to the draft card when the window that closes last was opened from another window', async () => {
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  const card = within(screen.getByTestId('plugin-mine-draft')).getByRole('button');
  card.focus();
  fireEvent.click(card);
  // Detail → preview → cancel → detail: this second detail window opened from the preview's Cancel button, which is gone.
  const review = screen.getByRole('button', { name: getI18n().toolbox.pluginsReviewChanges });
  review.focus();
  fireEvent.click(review);
  await screen.findByTestId('plugin-install-confirm');
  const cancel = screen.getByRole('button', { name: getI18n().common.cancel });
  cancel.focus();
  fireEvent.click(cancel);
  expect(screen.getByTestId('plugin-author-detail')).toBeInTheDocument();

  fireEvent.keyDown(screen.getByTestId('plugin-author-detail'), { key: 'Escape' });
  expect(screen.queryByTestId('plugin-author-detail')).toBeNull();
  await waitFor(() => expect(card).toHaveFocus());
});

it('gives the focus to the card that took the place of a deleted draft', async () => {
  const other = { ...author, id: 'b'.repeat(32), name: 'other-draft', sourceDir: '/home/Abu Plugins/b', marketplace: 'author-b' };
  state.authors = [author, other];
  state.remove.mockImplementation(async (id: string) => { state.authors = state.authors.filter(item => (item as { id: string }).id !== id); });
  const view = render(<AuthoredPluginList home="/home" searchQuery="" />);
  const first = within(screen.getAllByTestId('plugin-mine-draft')[0]).getByRole('button');
  first.focus();
  fireEvent.click(first);
  await userEvent.click(screen.getByTestId('plugin-author-menu'));
  fireEvent.click(screen.getByTestId('plugin-author-menu-delete'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: getI18n().toolbox.pluginsDeleteDraft }));
  await waitFor(() => expect(state.remove).toHaveBeenCalledExactlyOnceWith(author.id));
  // The store drops the draft; the list renders without it.
  view.rerender(<AuthoredPluginList home="/home" searchQuery="" />);
  await waitFor(() => expect(screen.queryByTestId('plugin-author-detail')).toBeNull());

  expect(screen.getAllByTestId('plugin-mine-draft')).toHaveLength(1);
  await waitFor(() => expect(within(screen.getByTestId('plugin-mine-draft')).getByRole('button')).toHaveFocus());
});

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out.
function keepClosingLayersOnScreen() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

it('keeps showing the draft while its window fades out', () => {
  const computedStyle = keepClosingLayersOnScreen();
  try {
    state.authors = [{ ...author, name: 'demo', prepared: { checksum: 'new', description: 'A greeting plugin' } }];
    render(<AuthoredPluginList home="/home" searchQuery="" />);
    fireEvent.click(within(screen.getByTestId('plugin-mine-draft')).getByRole('button'));
    fireEvent.keyDown(screen.getByTestId('plugin-author-detail'), { key: 'Escape' });

    const closing = screen.getByTestId('plugin-author-detail');
    expect(closing).toHaveAttribute('data-state', 'closed');
    expect(closing).toHaveTextContent('demo');
    expect(closing).toHaveTextContent('A greeting plugin');
  } finally {
    computedStyle.mockRestore();
  }
});

it('edits nothing and prepares nothing from a draft window that is closing', async () => {
  const computedStyle = keepClosingLayersOnScreen();
  try {
    state.edit.mockResolvedValue(undefined);
    render(<AuthoredPluginList home="/home" searchQuery="" />);
    fireEvent.click(within(screen.getByTestId('plugin-mine-draft')).getByRole('button'));
    fireEvent.keyDown(screen.getByTestId('plugin-author-detail'), { key: 'Escape' });
    expect(screen.getByTestId('plugin-author-detail')).toHaveAttribute('data-state', 'closed');

    fireEvent.click(screen.getByRole('button', { name: getI18n().toolbox.pluginsContinueEditing, hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: getI18n().toolbox.pluginsReviewChanges, hidden: true }));
    await act(async () => {});

    expect(state.edit).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(screen.queryByTestId('plugin-install-disclosure')).toBeNull();
  } finally {
    computedStyle.mockRestore();
  }
});

it('marks a draft as ready to install once it has been validated', () => {
  state.authors = [{ ...author, name: 'demo', prepared: { checksum: 'new', description: 'A greeting plugin' } }];
  render(<AuthoredPluginList home="/home" searchQuery="" />);
  const draft = screen.getByTestId('plugin-mine-draft');
  expect(draft).toHaveTextContent('demo');
  expect(draft).toHaveTextContent('A greeting plugin');
  expect(draft).toHaveTextContent(getI18n().toolbox.pluginsReadyToInstall);
});
