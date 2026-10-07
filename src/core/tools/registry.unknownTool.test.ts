import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';
import { describe, it, expect, beforeEach } from 'vitest';
import { executeAnyTool } from './registry';

describe('a tool name that does not exist', () => {
  beforeEach(() => {
    setMigratedBrowserSettings({ labs: {} });
  });

  it('lists the offered tools, sorted and without duplicates', async () => {
    const result = await executeAnyTool('reed_file', { path: 'a.txt' }, undefined, undefined, {
      offeredToolNames: ['write_file', 'read_file', 'read_file'],
    });
    expect(result).toBe('Error: Unknown tool "reed_file". Available tools: read_file, write_file. Call one of them again with its exact name.');
  });

  it('keeps the short form when the run did not say what it offered', async () => {
    const result = await executeAnyTool('reed_file', { path: 'a.txt' });
    expect(result).toBe('Error: Unknown tool "reed_file"');
  });
});
