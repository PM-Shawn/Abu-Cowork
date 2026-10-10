// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readFile, readTextFile, watch, type WatchEvent } from '@tauri-apps/plugin-fs';
import * as XLSX from 'xlsx';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { atomicWrite } from '@/utils/atomicFs';
import PreviewPanel from './PreviewPanel';

// pdf.js needs a canvas and a worker; the stand-in shows the bytes it was given as text.
vi.mock('react-pdf', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    pdfjs: { GlobalWorkerOptions: {} },
    Document: ({ file, children, onLoadSuccess }: {
      file: { data: Uint8Array };
      children: ReactNode;
      onLoadSuccess: (doc: { numPages: number }) => void;
    }) => {
      // The stand-in loads once per file object, like a real document.
      const loaded = useRef<{ data: Uint8Array } | null>(null);
      useEffect(() => {
        if (loaded.current === file) return;
        loaded.current = file;
        onLoadSuccess({ numPages: 1 });
      }, [file, onLoadSuccess]);
      return <div><p>{new TextDecoder().decode(file.data)}</p>{children}</div>;
    },
    Page: () => <div data-testid="pdf-page" />,
  };
});

// The Word and slide renderers need layout; the stand-ins write the bytes they were given as text.
vi.mock('docx-preview', () => ({
  renderAsync: async (data: Uint8Array, container: HTMLElement) => {
    const text = new TextDecoder().decode(data);
    if (text.startsWith('BROKEN')) throw new Error('not a zip file');
    container.textContent = text;
  },
}));

vi.mock('pptx-preview', () => ({
  init: (container: HTMLElement) => ({
    preview: async (data: ArrayBuffer) => {
      const text = new TextDecoder().decode(data);
      if (text.startsWith('BROKEN')) throw new Error('not a zip file');
      const slide = document.createElement('div');
      slide.className = 'pptx-preview-slide-wrapper';
      slide.textContent = text;
      container.appendChild(slide);
    },
    destroy: () => { container.innerHTML = ''; },
  }),
}));

// The real editor needs layout; a text box drives the same value/onChange pair.
vi.mock('./CodeMirrorEditor', async () => {
  const { TextArea } = await import('@/components/ds/text-area');
  return {
    default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
      <TextArea aria-label="source" value={value} onChange={(event) => onChange(event.target.value)} />
    ),
  };
});

// The loopback preview server belongs to the host; the frame gets an empty page.
vi.mock('@/utils/previewUrl', () => ({ buildPreviewUrl: vi.fn().mockResolvedValue('about:blank') }));
vi.mock('@/utils/atomicFs', () => ({ atomicWrite: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/utils/canvasVersions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/canvasVersions')>()),
  snapshotVersion: vi.fn().mockResolvedValue(undefined),
  listVersions: vi.fn().mockResolvedValue([]),
}));

const WATCH_DEBOUNCE_MS = 250;
const AUTOSAVE_DEBOUNCE_MS = 1000;

type Bytes = Uint8Array<ArrayBuffer>;

// The folder the fs bridge serves in this file, and the watchers registered on it.
const disk = new Map<string, Bytes>();
const watchers: ((event: WatchEvent) => void)[] = [];

function utf8(text: string): Bytes {
  return new Uint8Array(new TextEncoder().encode(text));
}

function workbook(marker: string): Bytes {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['name'], [marker]]), 'Sheet1');
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

async function fileChangedOnDisk(path: string) {
  for (const notify of watchers) notify({ type: 'any', paths: [path], attrs: {} });
  await act(() => vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS));
}

function openPreview(path: string) {
  return render(
    <DesignSystemProvider>
      <PreviewPanel filePath={path} tabId="t1" embedded />
    </DesignSystemProvider>,
  );
}

const BINARY_KINDS = [
  { kind: 'PDF', path: '/w/report.pdf', write: utf8 },
  { kind: 'Word', path: '/w/report.docx', write: utf8 },
  { kind: 'PowerPoint', path: '/w/report.pptx', write: utf8 },
  { kind: 'Excel', path: '/w/report.xlsx', write: workbook },
] as const;

describe('PreviewPanel following the file on disk', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    initLanguage('en-US');
    disk.clear();
    watchers.length = 0;
    vi.mocked(exists).mockImplementation(async (path) => path === '/w' || disk.has(String(path)));
    vi.mocked(readFile).mockImplementation(async (path) => {
      const bytes = disk.get(String(path));
      if (!bytes) throw new Error(`Error invoking remote method 'tauri:invoke': Error: ENOENT: no such file or directory, open '${String(path)}'`);
      return new Uint8Array(bytes);
    });
    vi.mocked(readTextFile).mockImplementation(async (path) => {
      const bytes = disk.get(String(path));
      if (!bytes) throw new Error(`Error invoking remote method 'tauri:invoke': Error: ENOENT: no such file or directory, open '${String(path)}'`);
      return new TextDecoder().decode(bytes);
    });
    vi.mocked(watch).mockImplementation(async (_dir, onEvent) => {
      watchers.push(onEvent);
      return () => {};
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(exists).mockReset().mockResolvedValue(false);
    vi.mocked(readFile).mockReset().mockResolvedValue(new Uint8Array());
    vi.mocked(readTextFile).mockReset().mockResolvedValue('');
    vi.mocked(watch).mockReset().mockResolvedValue(() => {});
    vi.mocked(atomicWrite).mockReset().mockResolvedValue(undefined);
  });

  describe.each(BINARY_KINDS)('a $kind file', ({ path, write }) => {
    const name = path.slice('/w/'.length);

    it('shows the new content after the file is rewritten on disk', async () => {
      disk.set(path, write('MARK-V1'));
      openPreview(path);
      expect(await screen.findByText('MARK-V1')).toBeInTheDocument();

      disk.set(path, write('MARK-V2'));
      await fileChangedOnDisk(path);
      expect(await screen.findByText('MARK-V2')).toBeInTheDocument();
      expect(screen.queryByText('MARK-V1')).toBeNull();
    });

    it('re-reads the file when Reload is pressed', async () => {
      disk.set(path, write('MARK-V1'));
      openPreview(path);
      expect(await screen.findByText('MARK-V1')).toBeInTheDocument();

      disk.set(path, write('MARK-V2'));
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(await screen.findByText('MARK-V2')).toBeInTheDocument();
      expect(screen.queryByText('MARK-V1')).toBeNull();
    });

    it('keeps the shown content, with no loading state, while a changed file is read again', async () => {
      disk.set(path, write('MARK-V1'));
      openPreview(path);
      expect(await screen.findByText('MARK-V1')).toBeInTheDocument();

      let finish: (bytes: Bytes) => void = () => {};
      vi.mocked(readFile).mockReturnValueOnce(new Promise<Bytes>((resolve) => { finish = resolve; }));
      await fileChangedOnDisk(path);
      await waitFor(() => expect(vi.mocked(readFile)).toHaveBeenCalledTimes(2));
      expect(screen.getByText('MARK-V1')).toBeInTheDocument();
      expect(screen.queryByRole('status')).toBeNull();

      await act(async () => { finish(write('MARK-V2')); });
      expect(await screen.findByText('MARK-V2')).toBeInTheDocument();
    });

    it('says the file was not found when it is missing at open, and shows it once it appears', async () => {
      openPreview(path);
      expect(await screen.findByRole('alert')).toHaveTextContent(`File not found: ${name}`);
      expect(screen.queryByRole('button', { name: 'Open in PowerPoint' })).toBeNull();

      disk.set(path, write('MARK-V1'));
      await fileChangedOnDisk(path);
      expect(await screen.findByText('MARK-V1')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('replaces the content with "File not found" when the file is removed, and shows it again when it returns', async () => {
      disk.set(path, write('MARK-V1'));
      openPreview(path);
      expect(await screen.findByText('MARK-V1')).toBeInTheDocument();

      disk.delete(path);
      await fileChangedOnDisk(path);
      expect(await screen.findByRole('alert')).toHaveTextContent(`File not found: ${name}`);
      expect(screen.queryByText('MARK-V1')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Open in PowerPoint' })).toBeNull();

      disk.set(path, write('MARK-V3'));
      await fileChangedOnDisk(path);
      expect(await screen.findByText('MARK-V3')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows "Failed to read file" for another read failure and keeps the host text in the console', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      disk.set(path, write('MARK-V1'));
      vi.mocked(readFile).mockRejectedValue(
        new Error(`Error invoking remote method 'tauri:invoke': Error: EACCES: permission denied, open '${path}' token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`),
      );
      openPreview(path);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/^Failed to read file$/);
      expect(document.body.textContent).not.toContain('tauri:invoke');
      expect(document.body.textContent).not.toContain('EACCES');
      expect(document.body.textContent).not.toContain('/w/');
      expect(screen.queryByRole('button', { name: 'Open in PowerPoint' })).toBeNull();

      const logged = errorLog.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(logged).toContain('EACCES');
      expect(logged).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    });
  });

  describe.each([
    { kind: 'plain text', path: '/w/notes.txt', write: (marker: string) => marker },
    { kind: 'Markdown', path: '/w/notes.md', write: (marker: string) => `# ${marker}` },
    { kind: 'JSON', path: '/w/notes.json', write: (marker: string) => `{"marker":"${marker}"}` },
    { kind: 'HTML', path: '/w/notes.html', write: (marker: string) => `<p>${marker}</p>` },
  ])('a $kind file', ({ kind, path, write }) => {
    const name = path.slice('/w/'.length);

    // Markdown is drawn as a page, HTML in a frame with its source one press away, the rest in the
    // editor. The source view, once chosen, stays through reloads of the same file.
    async function expectShown(marker: string) {
      if (kind === 'Markdown') {
        expect(await screen.findByRole('heading', { name: marker })).toBeInTheDocument();
        return;
      }
      const source = screen.queryByRole('button', { name: 'Source' });
      if (kind === 'HTML' && source?.getAttribute('aria-pressed') === 'false') {
        expect(await screen.findByTitle(name)).toBeInTheDocument();
        fireEvent.click(source);
      }
      expect(await screen.findByRole('textbox', { name: 'source' })).toHaveValue(write(marker));
    }

    it('says the file was not found when it is removed, and shows it again when it returns', async () => {
      disk.set(path, utf8(write('MARK-V1')));
      openPreview(path);
      await expectShown('MARK-V1');

      disk.delete(path);
      await fileChangedOnDisk(path);
      expect(await screen.findByRole('alert')).toHaveTextContent(`File not found: ${name}`);
      expect(screen.queryByRole('textbox', { name: 'source' })).toBeNull();

      disk.set(path, utf8(write('MARK-V3')));
      await fileChangedOnDisk(path);
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      await expectShown('MARK-V3');
    });
  });

  // An edit that is not saved yet when the file is found missing stays in the pending autosave,
  // which writes the file anew; the preview then shows the file with that edit.
  it('writes an unsaved edit of a removed text file with the pending autosave and shows the file again', async () => {
    vi.mocked(atomicWrite).mockImplementation(async (path, content) => { disk.set(path, utf8(content)); });
    disk.set('/w/notes.txt', utf8('first line'));
    openPreview('/w/notes.txt');
    const editor = await screen.findByRole('textbox', { name: 'source' });
    expect(editor).toHaveValue('first line');

    disk.delete('/w/notes.txt');
    fireEvent.change(editor, { target: { value: 'first line, edited' } });
    await fileChangedOnDisk('/w/notes.txt');
    expect(await screen.findByRole('alert')).toHaveTextContent('File not found: notes.txt');
    expect(vi.mocked(atomicWrite)).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS));
    expect(vi.mocked(atomicWrite)).toHaveBeenCalledWith('/w/notes.txt', 'first line, edited');

    await fileChangedOnDisk('/w/notes.txt');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await screen.findByRole('textbox', { name: 'source' })).toHaveValue('first line, edited');
  });

  describe('a file type with no preview', () => {
    const UNSUPPORTED = 'This file type is not supported for preview';

    it('says the file was not found when it is removed, and offers its two buttons again when it returns', async () => {
      disk.set('/w/report.doc', utf8('old Word format'));
      openPreview('/w/report.doc');
      expect(await screen.findByText(UNSUPPORTED)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show in File Manager' })).toBeInTheDocument();

      disk.delete('/w/report.doc');
      await fileChangedOnDisk('/w/report.doc');
      expect(await screen.findByRole('alert')).toHaveTextContent('File not found: report.doc');
      expect(screen.queryByText(UNSUPPORTED)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Show in File Manager' })).toBeNull();

      disk.set('/w/report.doc', utf8('old Word format'));
      await fileChangedOnDisk('/w/report.doc');
      expect(await screen.findByText(UNSUPPORTED)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Show in File Manager' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Open in default app' })).toHaveLength(2);
    });

    it('keeps its message, with no loading state, while a changed file is checked again', async () => {
      disk.set('/w/report.doc', utf8('old Word format'));
      openPreview('/w/report.doc');
      expect(await screen.findByText(UNSUPPORTED)).toBeInTheDocument();

      const checksBefore = vi.mocked(exists).mock.calls.length;
      let finish: (found: boolean) => void = () => {};
      vi.mocked(exists).mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve; }));
      await fileChangedOnDisk('/w/report.doc');
      await waitFor(() => expect(vi.mocked(exists).mock.calls.length).toBe(checksBefore + 1));
      expect(screen.getByText(UNSUPPORTED)).toBeInTheDocument();
      expect(screen.queryByRole('status')).toBeNull();

      await act(async () => { finish(true); });
      expect(screen.getByText(UNSUPPORTED)).toBeInTheDocument();
    });
  });

  it('offers the PowerPoint fallback only for a deck that was read and cannot be drawn', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    disk.set('/w/deck.pptx', utf8('BROKEN'));
    openPreview('/w/deck.pptx');
    expect(await screen.findByRole('button', { name: 'Open in PowerPoint' })).toBeInTheDocument();
    expect(screen.getByText('In-app preview does not support this PPT. Open in PowerPoint to view the full slides.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();

    disk.set('/w/deck.pptx', utf8('MARK-V2'));
    await fileChangedOnDisk('/w/deck.pptx');
    expect(await screen.findByText('MARK-V2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in PowerPoint' })).toBeNull();
  });

  it('shows "Failed to read file" for a Word file that was read and cannot be drawn, and draws it once it is rewritten', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    disk.set('/w/broken.docx', utf8('BROKEN'));
    openPreview('/w/broken.docx');
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Failed to read file$/);
    expect(document.body.textContent).not.toContain('not a zip file');
    expect(errorLog.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toContain('not a zip file');

    disk.set('/w/broken.docx', utf8('MARK-V2'));
    await fileChangedOnDisk('/w/broken.docx');
    expect(await screen.findByText('MARK-V2')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
