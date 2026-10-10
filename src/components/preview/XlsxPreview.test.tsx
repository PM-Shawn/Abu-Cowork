// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The first bytes of a zip archive followed by nothing an archive holds.
function brokenWorkbookBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

describe('XlsxPreview', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('switches between worksheets and reports the current one as pressed', async () => {
    render(<XlsxPreview data={workbookBytes({
      Customers: [['Name', 'City'], ['Ada', 'London']],
      Orders: [['Order', 'Total'], ['A-1', '42']],
    })} />);

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
    render(<XlsxPreview data={workbookBytes({ Only: [['Name'], ['Ada']] })} />);
    expect(await screen.findByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows one spinner with its sentence until the workbook is parsed', async () => {
    const { container } = render(<XlsxPreview data={workbookBytes({ Only: [['Name'], ['Ada']] })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading...');
    expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);

    expect(await screen.findByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(0);
  });

  it('replaces the sheets with new bytes, keeps the sheet in view and shows no loading state', async () => {
    const { rerender } = render(<XlsxPreview data={workbookBytes({
      Customers: [['Name'], ['Ada']],
      Orders: [['Order'], ['A-1']],
    })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Orders' }));
    expect(screen.getByRole('cell', { name: 'A-1' })).toBeInTheDocument();

    rerender(<XlsxPreview data={workbookBytes({
      Customers: [['Name'], ['Ada']],
      Orders: [['Order'], ['B-2']],
    })} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(await screen.findByRole('cell', { name: 'B-2' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'A-1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Orders' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('goes back to the first sheet when the sheet in view is gone from the new bytes', async () => {
    const { rerender } = render(<XlsxPreview data={workbookBytes({
      Customers: [['Name'], ['Ada']],
      Orders: [['Order'], ['A-1']],
    })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Orders' }));

    rerender(<XlsxPreview data={workbookBytes({ Customers: [['Name'], ['Grace']] })} />);
    expect(await screen.findByRole('cell', { name: 'Grace' })).toBeInTheDocument();
  });

  it('reports bytes it cannot parse with the fixed sentence, and draws the next bytes', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<XlsxPreview data={brokenWorkbookBytes()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Failed to read file$/);
    expect(errorLog).toHaveBeenCalled();

    rerender(<XlsxPreview data={workbookBytes({ Only: [['Name'], ['Ada']] })} />);
    expect(await screen.findByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
