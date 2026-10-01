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
