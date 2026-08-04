import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { savePreviewCopy } from './previewFileActions';

describe('savePreviewCopy', () => {
  beforeEach(() => {
    vi.mocked(copyFile).mockClear();
    vi.mocked(writeTextFile).mockClear();
  });

  it('writes the live editor buffer for editable previews', async () => {
    await savePreviewCopy({
      sourcePath: '/work/report.md',
      destinationPath: '/exports/report.md',
      currentText: 'latest unsaved draft',
    });

    expect(writeTextFile).toHaveBeenCalledWith('/exports/report.md', 'latest unsaved draft');
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('copies source bytes for binary previews', async () => {
    await savePreviewCopy({
      sourcePath: '/work/report.pdf',
      destinationPath: '/exports/report.pdf',
    });

    expect(copyFile).toHaveBeenCalledWith('/work/report.pdf', '/exports/report.pdf');
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
