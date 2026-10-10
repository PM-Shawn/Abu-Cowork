// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLanguage } from '@/i18n';
import CsvPreview from './CsvPreview';

function headers(): string[] {
  return screen.getAllByRole('columnheader').map((cell) => cell.textContent ?? '');
}

function rows(): string[][] {
  return screen.getAllByRole('row').slice(1).map((row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? ''));
}

describe('CsvPreview', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
  });

  it('splits on commas when no delimiter is given, and keeps a tab inside a cell', () => {
    render(<CsvPreview content={'name,note\nAda,"likes, commas"\nGrace,a\tb\n'} />);
    expect(headers()).toEqual(['name', 'note']);
    expect(rows()).toEqual([['Ada', 'likes, commas'], ['Grace', 'a\tb']]);
  });

  it('opens a quoted section at a quote anywhere in a comma-separated cell', () => {
    render(<CsvPreview content={'size,note\n5" pipe,A\n6" pipe,B\nlast,"x"y"z"\n'} />);
    expect(headers()).toEqual(['size', 'note']);
    expect(rows()).toEqual([['5 pipe,A\n6 pipe', 'B'], ['last', 'xyz']]);
  });

  describe('with the tab delimiter', () => {
    it('splits on tabs and keeps a comma inside a cell', () => {
      render(<CsvPreview content={'name\tvalue\tnote\nAda\t1\thas, comma\n'} delimiter={'\t'} />);
      expect(headers()).toEqual(['name', 'value', 'note']);
      expect(rows()).toEqual([['Ada', '1', 'has, comma']]);
    });

    it('reads a quoted field, with a doubled quote as one quote', () => {
      render(<CsvPreview content={'name\tquote\n"Ada"\t"she said ""hi"""\n'} delimiter={'\t'} />);
      expect(rows()).toEqual([['Ada', 'she said "hi"']]);
    });

    it('keeps a tab and a line break that sit inside a quoted field', () => {
      render(<CsvPreview content={'name\tnote\r\nAda\t"first\tsecond"\r\nGrace\t"line one\nline two"\r\n'} delimiter={'\t'} />);
      expect(headers()).toEqual(['name', 'note']);
      expect(rows()).toEqual([['Ada', 'first\tsecond'], ['Grace', 'line one\nline two']]);
    });

    it('reads a lone quote inside a cell as text and keeps the rows apart', () => {
      render(<CsvPreview content={'尺寸\t名称\n5" 管\tA\n6" 管\tB\n'} delimiter={'\t'} />);
      expect(headers()).toEqual(['尺寸', '名称']);
      expect(rows()).toEqual([['5" 管', 'A'], ['6" 管', 'B']]);
    });

    it('reads quotes that open after the first character of a cell as text', () => {
      render(<CsvPreview content={'size\tnote\n5"\tsaid "hi" twice\n12" x 8"\tend"\n'} delimiter={'\t'} />);
      expect(rows()).toEqual([['5"', 'said "hi" twice'], ['12" x 8"', 'end"']]);
    });

    it('reads a quote after a quoted field has closed as text', () => {
      render(<CsvPreview content={'a\tb\n"x"y"\tz\n'} delimiter={'\t'} />);
      expect(rows()).toEqual([['xy"', 'z']]);
    });

    it('reads Chinese headers and cells', () => {
      render(<CsvPreview content={'姓名\t城市\t备注\n张三\t北京\t"含\t制表符"\n李四\t上海\t\n'} delimiter={'\t'} />);
      expect(headers()).toEqual(['姓名', '城市', '备注']);
      expect(rows()).toEqual([['张三', '北京', '含\t制表符'], ['李四', '上海', '']]);
    });

    it('shows the empty state for a file with no rows', () => {
      render(<CsvPreview content={''} delimiter={'\t'} />);
      expect(screen.getByText('No data')).toBeInTheDocument();
      expect(screen.queryByRole('table')).toBeNull();
    });
  });
});
