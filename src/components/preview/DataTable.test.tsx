// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getI18n, initLanguage } from '@/i18n';
import DataTable from './DataTable';

describe('DataTable', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the header row pinned above the rows on the code surface', () => {
    render(<DataTable headers={['Name', 'City']} rows={[['Ada', 'London']]} />);
    const headerRow = screen.getByRole('columnheader', { name: 'Name' }).closest('tr');
    expect(headerRow).not.toBeNull();
    expect(headerRow).toHaveClass('sticky');
    expect(headerRow).toHaveClass('z-sticky');
    expect(headerRow).toHaveClass('bg-code');
  });

  // The header sticks to its nearest scroller. Any scrolling wrapper between the scroll
  // area and the table would become that scroller and let the header leave with the rows.
  it('puts the table directly in the scroll area so the header stays in view', () => {
    render(<DataTable headers={['Name']} rows={[['Ada']]} />);
    const table = screen.getByRole('table');
    expect(table.parentElement?.parentElement).toHaveAttribute('data-radix-scroll-area-viewport');
    // Separate borders travel with the pinned header cells; collapsed ones stay with the table.
    expect(table).toHaveClass('border-separate');
    expect(table).toHaveClass('border-spacing-0');
  });

  // The sideways scrollbar lies over the bottom edge of the scroll area; the space after
  // the table lets the last row scroll clear of it.
  it('leaves room after the last row for the sideways scrollbar', () => {
    render(<DataTable headers={['Name']} rows={[['Ada']]} />);
    expect(screen.getByRole('table')).toHaveClass('mb-2');
  });

  it('gives data rows the compact row height', () => {
    render(<DataTable headers={['Name']} rows={[['Ada']]} />);
    expect(screen.getByRole('cell', { name: 'Ada' })).toHaveClass('h-7');
  });

  it('names a column without a header by its spreadsheet letter', () => {
    render(<DataTable headers={['', '']} rows={[['1', '2']]} />);
    expect(screen.getByRole('columnheader', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'B' })).toBeInTheDocument();
  });

  it('keeps every row and column of the data', () => {
    const rows = Array.from({ length: 5 }, (_, index) => [`r${index}`, `c${index}`, `d${index}`]);
    render(<DataTable headers={['One', 'Two', 'Three']} rows={rows} />);
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(screen.getAllByRole('row')).toHaveLength(6);
    expect(screen.getAllByRole('cell')).toHaveLength(15);
    expect(screen.getByRole('cell', { name: 'd4' })).toBeInTheDocument();
  });

  it('stripes the rows with the card surface and the code surface', () => {
    render(<DataTable headers={['One']} rows={[['a'], ['b']]} />);
    const first = screen.getByRole('cell', { name: 'a' }).closest('tr');
    expect(first).toHaveClass('odd:bg-surface');
    expect(first).toHaveClass('even:bg-code');
  });

  it('says how many rows are shown when the sheet has more', () => {
    render(<DataTable headers={['One']} rows={[['a'], ['b']]} totalRows={2500} />);
    expect(screen.getByText('Showing 2 of 2500 rows')).toBeInTheDocument();
  });

  it('leaves the row count out when every row is shown', () => {
    render(<DataTable headers={['One']} rows={[['a'], ['b']]} totalRows={2} />);
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it('says there is no data for an empty table', () => {
    render(<DataTable headers={[]} rows={[]} />);
    expect(screen.getByText(getI18n().panel.csvNoData)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
