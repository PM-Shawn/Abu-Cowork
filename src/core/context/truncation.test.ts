import { describe, it, expect } from 'vitest';
import { truncateToolResult } from './truncation';

describe('truncation', () => {
  // ── No truncation needed ──
  describe('no truncation needed', () => {
    it('returns empty string as-is', () => {
      expect(truncateToolResult('read_file', '')).toBe('');
    });

    it('returns short result as-is for read_file', () => {
      const short = 'Hello world\nLine 2';
      expect(truncateToolResult('read_file', short)).toBe(short);
    });

    it('returns short result as-is for unknown tool', () => {
      const short = 'Short result';
      expect(truncateToolResult('unknown_tool', short)).toBe(short);
    });

    it('returns result within maxChars as-is', () => {
      // read_file maxChars = 15000, this is under that
      const text = 'x'.repeat(14999);
      expect(truncateToolResult('read_file', text)).toBe(text);
    });
  });

  // ── Line-based truncation (read_file) ──
  // read_file: headLines=150, tailLines=20, maxChars=15000
  describe('line-based truncation — read_file', () => {
    it('truncates with head and tail lines when exceeding maxChars', () => {
      // 500 lines × 100 chars each = 50000 chars (exceeds maxChars=15000)
      const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${'x'.repeat(90)}`);
      const result = truncateToolResult('read_file', lines.join('\n'));
      expect(result).toContain('Line 1:');
      // Line-based truncation creates head(150)+omission+tail(20) → still > 15000 chars
      // Then char-level truncation kicks in, so we check for the omission message
      expect(result).toContain('omitted');
      expect(result.length).toBeLessThan(lines.join('\n').length);
    });
  });

  // ── Line-based truncation (list_directory) ──
  // list_directory: headLines=100, tailLines=0, maxChars=8000
  describe('line-based truncation — list_directory', () => {
    it('truncates with headLines only (no tail)', () => {
      // 300 lines × 40 chars = 12000 chars (exceeds maxChars=8000)
      const lines = Array.from({ length: 300 }, (_, i) => `file_${i}.txt${'_'.repeat(25)}`);
      const result = truncateToolResult('list_directory', lines.join('\n'));
      expect(result).toContain('file_0.txt');
      expect(result).toContain('file_99.txt'); // headLines = 100
      expect(result).toContain('lines omitted');
    });
  });

  // ── Line-based truncation (run_command) ──
  // run_command: headLines=150, tailLines=30, maxChars=15000
  describe('line-based truncation — run_command', () => {
    it('truncates command output with head and tail', () => {
      // 400 lines × 80 chars = 32000 chars (exceeds maxChars=15000)
      const lines = Array.from({ length: 400 }, (_, i) => `Output line ${i + 1}: ${'y'.repeat(60)}`);
      const result = truncateToolResult('run_command', lines.join('\n'));
      expect(result).toContain('Output line 1:');
      expect(result).toContain('Output line 150:'); // headLines = 150
      expect(result).toContain('lines omitted');
      expect(result).toContain('Output line 400:'); // tailLines = 30
    });
  });

  // ── Character-based truncation (default rule) ──
  // default: headLines=0, tailLines=0, maxChars=3500
  describe('character-based truncation — default', () => {
    it('truncates long result for unknown tool', () => {
      const longText = 'x'.repeat(5000);
      const result = truncateToolResult('unknown_tool', longText);
      expect(result.length).toBeLessThan(5000);
      expect(result).toContain('characters omitted');
    });

    it('preserves head and tail in char truncation', () => {
      const text = 'HEAD' + 'x'.repeat(5000) + 'TAIL';
      const result = truncateToolResult('unknown_tool', text);
      expect(result).toContain('HEAD');
      expect(result).toContain('TAIL');
    });
  });

  // ── Search tools ──
  // search_files: headLines=50, tailLines=0, maxChars=8000
  // find_files: headLines=100, tailLines=0, maxChars=8000
  describe('search tools', () => {
    it('truncates search_files results', () => {
      // 200 lines × 60 chars = 12000 chars (exceeds maxChars=8000)
      const lines = Array.from({ length: 200 }, (_, i) => `match_${i}: found ${'_'.repeat(40)}`);
      const result = truncateToolResult('search_files', lines.join('\n'));
      expect(result).toContain('match_0');
      expect(result).toContain('lines omitted');
    });

    it('truncates find_files results', () => {
      // 200 lines × 60 chars = 12000 chars
      const lines = Array.from({ length: 200 }, (_, i) => `/path/to/project/file_${i}.ts${'_'.repeat(30)}`);
      const result = truncateToolResult('find_files', lines.join('\n'));
      expect(result).toContain('file_0');
      expect(result).toContain('lines omitted');
    });
  });

  // ── Further char truncation after line truncation ──
  describe('combined truncation', () => {
    it('applies char truncation if line-truncated result still exceeds maxChars', () => {
      // read_file maxChars = 15000, headLines = 150
      // Create 250 lines of 200 chars each → head 200 lines = 40000 chars → exceeds maxChars
      const lines = Array.from({ length: 250 }, () => 'x'.repeat(200));
      const result = truncateToolResult('read_file', lines.join('\n'));
      expect(result.length).toBeLessThanOrEqual(21000); // maxChars + some overhead
      expect(result).toContain('characters omitted');
    });
  });
});
