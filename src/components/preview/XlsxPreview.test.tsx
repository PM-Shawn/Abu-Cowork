// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from '@tauri-apps/plugin-fs';
import * as XLSX from 'xlsx';
import { initLanguage } from '@/i18n';
import XlsxPreview from './XlsxPreview';

function workbookBytes(sheets: Record<string, string[][]>): Uint8Array<ArrayBuffer> {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

describe('XlsxPreview', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    vi.mocked(readFile).mockResolvedValue(new Uint8Array());
  });

  it('switches between worksheets and reports the current one as pressed', async () => {
    vi.mocked(readFile).mockResolvedValue(workbookBytes({
      Customers: [['Name', 'City'], ['Ada', 'London']],
      Orders: [['Order', 'Total'], ['A-1', '42']],
    }));
    render(<XlsxPreview filePath="/work/book.xlsx" />);

    const customers = await screen.findByRole('button', { name: 'Customers' });
    const orders = screen.getByRole('button', { name: 'Orders' });
    expect(customers).toHaveAttribute('aria-pressed', 'true');
    expect(orders).toHaveAttribute('aria-pressed', 'false');
    expect(customers).toHaveClass('bg-fill-selected');
    expect(orders).not.toHaveClass('bg-fill-selected');
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeInTheDocument();

    fireEvent.click(orders);
    expect(orders).toHaveAttribute('aria-pressed', 'true');
    expect(customers).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('cell', { name: 'A-1' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Ada' })).toBeNull();
  });

  it('leaves the worksheet strip out of a single-sheet workbook', async () => {
    vi.mocked(readFile).mockResolvedValue(workbookBytes({ Only: [['Name'], ['Ada']] }));
    render(<XlsxPreview filePath="/work/single.xlsx" />);
    expect(await screen.findByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows one spinner with its sentence while the workbook is read', async () => {
    let finish: (data: Uint8Array<ArrayBuffer>) => void = () => {};
    vi.mocked(readFile).mockReturnValue(new Promise<Uint8Array<ArrayBuffer>>((resolve) => { finish = resolve; }));
    const { container } = render(<XlsxPreview filePath="/work/slow.xlsx" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading...');
    expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);

    finish(workbookBytes({ Only: [['Name'], ['Ada']] }));
    expect(await screen.findByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(0);
  });

  it('reports a workbook that cannot be read as an alert', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(readFile).mockRejectedValue(new Error('permission denied'));
    render(<XlsxPreview filePath="/work/locked.xlsx" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('permission denied'));
    errorLog.mockRestore();
  });
});
