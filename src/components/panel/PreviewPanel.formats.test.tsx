// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readFile, readTextFile } from '@tauri-apps/plugin-fs';
import * as XLSX from 'xlsx';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import PreviewPanel from './PreviewPanel';

vi.mock('@/hooks/usePreviewFileWatch', () => ({ usePreviewFileWatch: () => {} }));

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
  });

  afterEach(() => {
    cleanup();
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
});
