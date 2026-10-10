// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readFile, readTextFile } from '@tauri-apps/plugin-fs';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import * as XLSX from 'xlsx';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import PreviewPanel from './PreviewPanel';

vi.mock('@/hooks/usePreviewFileWatch', () => ({ usePreviewFileWatch: () => {} }));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

const UNSUPPORTED = 'This file type is not supported for preview';

function openPreview(path: string) {
  return render(
    <DesignSystemProvider>
      <PreviewPanel filePath={path} tabId="t1" embedded />
    </DesignSystemProvider>,
  );
}

function workbook(bookType: XLSX.BookType): Uint8Array<ArrayBuffer> {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['姓名', 'value'], ['张三', 42]]), 'Sheet1');
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType }) as ArrayBuffer);
}

describe('PreviewPanel file types', () => {
  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(openPath).mockClear();
    vi.mocked(revealItemInDir).mockClear();
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(exists).mockReset().mockResolvedValue(false);
    vi.mocked(readFile).mockReset().mockResolvedValue(new Uint8Array());
    vi.mocked(readTextFile).mockReset().mockResolvedValue('');
  });

  it('shows a TSV file as a table split on tabs, with the toolbar of a previewed file', async () => {
    vi.mocked(readTextFile).mockResolvedValue('姓名\t备注\n张三\t"a, b"\n');
    openPreview('/w/people.tsv');

    expect(await screen.findByRole('columnheader', { name: '姓名' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '备注' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '张三' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'a, b' })).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    expect(screen.getByRole('button', { name: 'Open in default app' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
  });

  it('still splits a CSV file on commas', async () => {
    vi.mocked(readTextFile).mockResolvedValue('name,note\nAda,a\tb\n');
    openPreview('/w/people.csv');
    expect(await screen.findByRole('columnheader', { name: 'note' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeInTheDocument();
  });

  it('says a missing TSV file was not found', async () => {
    vi.mocked(exists).mockResolvedValue(false);
    openPreview('/w/gone.tsv');
    expect(await screen.findByRole('alert')).toHaveTextContent('File not found: gone.tsv');
  });

  it.each([
    { extension: 'xlsm', bookType: 'xlsm' },
    { extension: 'xlsb', bookType: 'xlsb' },
    { extension: 'ods', bookType: 'ods' },
    { extension: 'fods', bookType: 'fods' },
  ] as const)('shows a .$extension workbook as a table', async ({ extension, bookType }) => {
    vi.mocked(readFile).mockResolvedValue(workbook(bookType));
    openPreview(`/w/book.${extension}`);

    expect(await screen.findByRole('columnheader', { name: '姓名' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '张三' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '42' })).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
  });

  it.each(['doc', 'rtf', 'odt', 'odp', 'pages', 'numbers', 'key'])('leaves a .%s file without a preview', async (extension) => {
    openPreview(`/w/file.${extension}`);
    expect(await screen.findByText(UNSUPPORTED)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  describe('a file type with no preview', () => {
    it('offers to open the file in its default app beside "Show in File Manager"', async () => {
      openPreview('/w/报告.doc');
      const message = await screen.findByText(UNSUPPORTED);
      const content = message.parentElement as HTMLElement;

      const buttons = within(content).getAllByRole('button').map((button) => button.textContent);
      expect(buttons).toEqual(['Open in default app', 'Show in File Manager']);

      fireEvent.click(within(content).getByRole('button', { name: 'Open in default app' }));
      await waitFor(() => expect(openPath).toHaveBeenCalledWith('/w/报告.doc'));

      fireEvent.click(within(content).getByRole('button', { name: 'Show in File Manager' }));
      await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith('/w/报告.doc'));
    });

    it('has the "Open in default app" toolbar button of a previewed file', async () => {
      openPreview('/w/report.doc');
      const message = await screen.findByText(UNSUPPORTED);
      const content = message.parentElement as HTMLElement;
      const inContent = within(content).getByRole('button', { name: 'Open in default app' });
      const inToolbar = screen.getAllByRole('button', { name: 'Open in default app' }).filter((button) => button !== inContent);
      expect(inToolbar).toHaveLength(1);

      fireEvent.click(inToolbar[0]);
      await waitFor(() => expect(openPath).toHaveBeenCalledWith('/w/report.doc'));
    });

    it('tells the user when the file cannot be opened', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(openPath).mockRejectedValueOnce(new Error('no application is set to open /w/report.doc'));
      openPreview('/w/report.doc');
      const message = await screen.findByText(UNSUPPORTED);

      fireEvent.click(within(message.parentElement as HTMLElement).getByRole('button', { name: 'Open in default app' }));
      await waitFor(() => expect(useToastStore.getState().toasts.map(({ type, title, message: text }) => ({ type, title, text })))
        .toEqual([{ type: 'error', title: 'Failed to open file', text: 'Could not open this file in a local app' }]));
    });

    it.each(['doc', 'rtf', 'pages'])('offers both buttons for a .%s document', async (extension) => {
      openPreview(`/w/file.${extension}`);
      const content = (await screen.findByText(UNSUPPORTED)).parentElement as HTMLElement;
      expect(within(content).getAllByRole('button').map((button) => button.textContent))
        .toEqual(['Open in default app', 'Show in File Manager']);
      expect(screen.getAllByRole('button', { name: 'Open in default app' })).toHaveLength(2);
    });

    it.each([
      '/w/setup.command',
      '/w/Tool.app',
      '/w/Installer.pkg',
      '/w/Build.COMMAND',
      'C:\\w\\setup.exe',
      'C:\\w\\run.bat',
      'C:\\w\\Report.lnk',
      'C:\\w\\SETUP.EXE',
      '/w/app.jar',
      '/w/build',
    ])('only shows %s in the file manager, in the content and in the toolbar', async (path) => {
      openPreview(path);
      const content = (await screen.findByText(UNSUPPORTED)).parentElement as HTMLElement;

      expect(within(content).getAllByRole('button').map((button) => button.textContent)).toEqual(['Show in File Manager']);
      expect(screen.queryByRole('button', { name: 'Open in default app' })).toBeNull();

      fireEvent.click(within(content).getByRole('button', { name: 'Show in File Manager' }));
      await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith(path));
      expect(openPath).not.toHaveBeenCalled();
    });

    it('keeps the toolbar without "Open in default app" when such a file is missing', async () => {
      vi.mocked(exists).mockResolvedValue(false);
      openPreview('/w/gone.command');
      expect(await screen.findByRole('alert')).toHaveTextContent('File not found: gone.command');
      expect(screen.queryByRole('button', { name: 'Open in default app' })).toBeNull();
    });

    it('says a missing file was not found and offers neither button in its place', async () => {
      vi.mocked(exists).mockResolvedValue(false);
      openPreview('/w/gone.doc');
      expect(await screen.findByRole('alert')).toHaveTextContent('File not found: gone.doc');
      expect(screen.queryByText(UNSUPPORTED)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Show in File Manager' })).toBeNull();
      // The toolbar keeps its button, as it does for a missing file of a previewed type.
      expect(screen.getAllByRole('button', { name: 'Open in default app' })).toHaveLength(1);
    });
  });
});
