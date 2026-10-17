import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { charsOmittedMarker, linesOmittedMarker, truncateToolResult } from '@/core/context/truncation';
import { DURABLE_RESULT_OMITTED_NOTE } from '@/core/session/durableToolResultContent';
import { COMMAND_OUTPUT_CUT_NOTE, foldToolResult, toResultRows } from './toolResultFold';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('toResultRows', () => {
  it('turns the line-omission marker and its blank padding into one note row', () => {
    const rows = toResultRows(truncateToolResult('run_command', lines(5000)));
    expect(rows.filter((row) => row.kind === 'note')).toEqual([{ kind: 'note', note: 'linesNotRead', count: 4820 }]);
    expect(rows.filter((row) => row.kind === 'text')).toHaveLength(180);
  });

  it('reads the character-omission marker with its count', () => {
    const note = toResultRows(truncateToolResult('web_fetch', 'x'.repeat(10_000))).find((row) => row.kind === 'note');
    expect(note).toEqual({ kind: 'note', note: 'charsNotRead', count: expect.any(Number) });
    expect(note?.kind === 'note' ? note.count : 0).toBeGreaterThan(6000);
  });

  it('reads the command cut note as the rest not kept', () => {
    expect(toResultRows(`a\n${COMMAND_OUTPUT_CUT_NOTE}\n\nexit code: 0`)).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'note', note: 'restNotKept' },
      { kind: 'text', text: 'exit code: 0' },
    ]);
  });

  it('reads the durable storage note as part of the step not saved, since it also stands for dropped images', () => {
    expect(toResultRows(`a\n\n${DURABLE_RESULT_OMITTED_NOTE}`)).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'note', note: 'partNotSaved' },
    ]);
  });

  it('only reads a note from a whole line', () => {
    const text = `see ${linesOmittedMarker(3)} here`;
    expect(toResultRows(text)).toEqual([{ kind: 'text', text }]);
  });

  it('matches the note the command host writes', () => {
    expect(readFileSync('electron/commandHost.cjs', 'utf8')).toContain(COMMAND_OUTPUT_CUT_NOTE);
  });

  it('matches the markers truncation writes', () => {
    expect(toResultRows(`a\n${linesOmittedMarker(7)}\nb`)[1]).toEqual({ kind: 'note', note: 'linesNotRead', count: 7 });
    expect(toResultRows(`a\n${charsOmittedMarker(9)}\nb`)[1]).toEqual({ kind: 'note', note: 'charsNotRead', count: 9 });
  });
});

describe('foldToolResult', () => {
  it('shows a result of nine lines whole', () => {
    expect(foldToolResult(lines(9)).hidden).toBeNull();
  });

  it('folds ten lines to the first five and the last four, counting the lines', () => {
    const fold = foldToolResult(lines(10));
    expect(fold.hidden).toEqual({ unit: 'lines', count: 10 });
    expect(fold.head.map((row) => row.kind === 'text' && row.text)).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
    expect(fold.tail.map((row) => row.kind === 'text' && row.text)).toEqual(['line 7', 'line 8', 'line 9', 'line 10']);
  });

  it('counts only the lines Abu read, without the note', () => {
    expect(foldToolResult(truncateToolResult('run_command', lines(5000))).hidden).toEqual({ unit: 'lines', count: 180 });
  });

  it('keeps a note that ends the result in the folded tail', () => {
    const fold = foldToolResult(`${lines(12)}\n\n${DURABLE_RESULT_OMITTED_NOTE}`);
    expect(fold.tail.at(-1)).toEqual({ kind: 'note', note: 'partNotSaved' });
  });

  it('shows 1000 characters on few lines whole and folds 1001 by characters', () => {
    expect(foldToolResult('a'.repeat(1000)).hidden).toBeNull();
    const fold = foldToolResult(`${'a'.repeat(700)}b${'c'.repeat(300)}`);
    expect(fold.hidden).toEqual({ unit: 'chars', count: 1001 });
    expect(fold.head).toEqual([{ kind: 'text', text: 'a'.repeat(700) }]);
    expect(fold.tail).toEqual([{ kind: 'text', text: 'c'.repeat(300) }]);
  });

  it('never cuts a character in two when folding by characters', () => {
    const fold = foldToolResult('😀'.repeat(1100));
    const head = fold.head[0];
    expect(head.kind === 'text' && Array.from(head.text).every((char) => char === '😀')).toBe(true);
    expect(fold.hidden).toEqual({ unit: 'chars', count: 1100 });
  });
});
