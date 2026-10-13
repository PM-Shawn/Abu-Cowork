// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile, watch, type WatchEvent } from '@tauri-apps/plugin-fs';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { atomicWrite } from '@/utils/atomicFs';
import { snapshotVersion } from '@/utils/canvasVersions';
import PreviewPanel from './PreviewPanel';

// The real editor needs layout; a text box drives the same value/onChange pair and shows `readOnly`.
vi.mock('./CodeMirrorEditor', async () => {
  const { TextArea } = await import('@/components/ds/text-area');
  return {
    default: ({ value, onChange, readOnly }: { value: string; onChange: (value: string) => void; readOnly?: boolean }) => (
      <TextArea aria-label="source" value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />
    ),
  };
});

vi.mock('@/utils/atomicFs', () => ({ atomicWrite: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/utils/canvasVersions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/canvasVersions')>()),
  snapshotVersion: vi.fn().mockResolvedValue(undefined),
  listVersions: vi.fn().mockResolvedValue([]),
}));

const WATCH_DEBOUNCE_MS = 250;
const AUTOSAVE_DEBOUNCE_MS = 1000;
const COPY = '/data/conversations/c1/outputs/files/ab12/notes.txt';
const MARKDOWN_COPY = '/data/conversations/c1/outputs/files/ab12/notes.md';
const ORIGINAL = '/w/notes.txt';

const COPY_FOLDER = '/data/conversations/c1/outputs/files/ab12';

const disk = new Map<string, string>();
const watchers: ((event: WatchEvent) => void)[] = [];
const onDisk = async (path: string | URL) => [COPY_FOLDER, '/w'].includes(String(path)) || disk.has(String(path));

async function fileChangedOnDisk(path: string) {
  for (const notify of watchers) notify({ type: 'any', paths: [path], attrs: {} });
  await act(() => vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS));
}

function openPreview(path: string, keptCopy: boolean) {
  return render(
    <DesignSystemProvider>
      <PreviewPanel filePath={path} tabId="t1" embedded keptCopy={keptCopy} />
    </DesignSystemProvider>,
  );
}

const notice = () => screen.queryByText(getI18n().panel.keptCopyNotice);
const historyButton = () => screen.queryByRole('button', { name: getI18n().panel.versionHistory });

describe('PreviewPanel for a kept copy', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    initLanguage('en-US');
    disk.clear();
    watchers.length = 0;
    vi.mocked(exists).mockImplementation(onDisk);
    vi.mocked(readTextFile).mockImplementation(async (path) => disk.get(String(path))!);
    vi.mocked(watch).mockImplementation(async (_dir, onEvent) => {
      watchers.push(onEvent);
      return () => {};
    });
    vi.mocked(atomicWrite).mockClear();
    vi.mocked(snapshotVersion).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.mocked(exists).mockReset().mockResolvedValue(false);
    vi.mocked(readTextFile).mockReset().mockResolvedValue('');
    vi.mocked(watch).mockReset().mockResolvedValue(() => {});
  });

  it('says that the original file is gone, above a read-only source view', async () => {
    disk.set(COPY, 'first line');
    openPreview(COPY, true);

    const editor = await screen.findByRole('textbox', { name: 'source' });
    expect(editor).toHaveValue('first line');
    expect(editor).toHaveAttribute('readonly');
    expect(screen.getByRole('status')).toHaveTextContent(getI18n().panel.keptCopyNotice);
  });

  it('offers no version history and shows no save state', async () => {
    disk.set(COPY, 'first line');
    openPreview(COPY, true);
    await screen.findByRole('textbox', { name: 'source' });

    expect(historyButton()).toBeNull();
    expect(screen.queryByText(getI18n().panel.saved)).toBeNull();
    // The actions that write nothing to the copy stay.
    expect(screen.getByRole('button', { name: getI18n().panel.moreActions })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: getI18n().panel.reloadPreview })).toBeInTheDocument();
  });

  it('records no version of the copy and writes nothing to it, also when its buffer is changed', async () => {
    disk.set(COPY, 'first line');
    openPreview(COPY, true);
    const editor = await screen.findByRole('textbox', { name: 'source' });

    fireEvent.change(editor, { target: { value: 'first line, edited' } });
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2));

    expect(atomicWrite).not.toHaveBeenCalled();
    expect(snapshotVersion).not.toHaveBeenCalled();
  });

  it('shows the copy as it is on disk after the copy is rewritten', async () => {
    disk.set(COPY, 'first line');
    openPreview(COPY, true);
    expect(await screen.findByRole('textbox', { name: 'source' })).toHaveValue('first line');

    disk.set(COPY, 'second version');
    await fileChangedOnDisk(COPY);

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'source' })).toHaveValue('second version'));
    expect(snapshotVersion).not.toHaveBeenCalled();
  });

  it('shows the line in the rendered view of a Markdown copy and keeps its source view read-only', async () => {
    disk.set(MARKDOWN_COPY, '# Kept heading');
    openPreview(MARKDOWN_COPY, true);

    expect(await screen.findByRole('heading', { name: 'Kept heading' })).toBeInTheDocument();
    expect(notice()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: getI18n().panel.sourceMode }));
    expect(await screen.findByRole('textbox', { name: 'source' })).toHaveAttribute('readonly');
    expect(notice()).toBeInTheDocument();
  });
});

describe('PreviewPanel for a file at its own path', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    initLanguage('en-US');
    disk.clear();
    watchers.length = 0;
    vi.mocked(exists).mockImplementation(onDisk);
    vi.mocked(readTextFile).mockImplementation(async (path) => disk.get(String(path))!);
    vi.mocked(watch).mockImplementation(async (_dir, onEvent) => {
      watchers.push(onEvent);
      return () => {};
    });
    vi.mocked(atomicWrite).mockClear();
    vi.mocked(snapshotVersion).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.mocked(exists).mockReset().mockResolvedValue(false);
    vi.mocked(readTextFile).mockReset().mockResolvedValue('');
    vi.mocked(watch).mockReset().mockResolvedValue(() => {});
  });

  it('shows no line about a copy, an editable source view and the version history', async () => {
    disk.set(ORIGINAL, 'first line');
    openPreview(ORIGINAL, false);

    const editor = await screen.findByRole('textbox', { name: 'source' });
    expect(editor).not.toHaveAttribute('readonly');
    expect(notice()).toBeNull();
    expect(historyButton()).toBeInTheDocument();
    expect(screen.getByText(getI18n().panel.saved)).toBeInTheDocument();
    expect(snapshotVersion).toHaveBeenCalledWith(ORIGINAL, 'first line');
  });

  it('saves an edit to the file one second after the last change and records the version', async () => {
    disk.set(ORIGINAL, 'first line');
    openPreview(ORIGINAL, false);
    const editor = await screen.findByRole('textbox', { name: 'source' });
    vi.mocked(snapshotVersion).mockClear();

    fireEvent.change(editor, { target: { value: 'first line, edited' } });
    expect(atomicWrite).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS));

    expect(atomicWrite).toHaveBeenCalledWith(ORIGINAL, 'first line, edited');
    expect(snapshotVersion).toHaveBeenCalledWith(ORIGINAL, 'first line, edited');
  });
});
