// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { DesignSystemProvider } from '@/components/ds/provider';
import PreviewPanel from './PreviewPanel';

vi.mock('@/hooks/usePreviewFileWatch', () => ({ usePreviewFileWatch: () => {} }));
vi.mock('@/utils/atomicFs', () => ({ atomicWrite: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/utils/canvasVersions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/canvasVersions')>()),
  snapshotVersion: vi.fn().mockResolvedValue(undefined),
  listVersions: vi.fn().mockResolvedValue([]),
}));

const SOURCE = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n';

/** The line that holds the cursor: the editor marks it as the active line. */
function activeLineText(): string | null {
  return document.querySelector('.cm-activeLine')?.textContent ?? null;
}

function renderPanel(line?: number) {
  return render(
    <DesignSystemProvider>
      <PreviewPanel filePath="/w/main.ts" tabId="t1" embedded line={line} />
    </DesignSystemProvider>,
  );
}

describe('PreviewPanel line', () => {
  beforeEach(() => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockResolvedValue(SOURCE);
  });

  afterEach(() => {
    cleanup();
    vi.mocked(exists).mockResolvedValue(false);
    vi.mocked(readTextFile).mockResolvedValue('');
  });

  it('shows the requested line of a source file once the file is loaded', async () => {
    renderPanel(3);

    await waitFor(() => expect(activeLineText()).toBe('const c = 3;'));
  });

  it('moves to the line of a later request for the same file', async () => {
    const view = renderPanel(3);
    await waitFor(() => expect(activeLineText()).toBe('const c = 3;'));

    view.rerender(
      <DesignSystemProvider>
        <PreviewPanel filePath="/w/main.ts" tabId="t1" embedded line={2} />
      </DesignSystemProvider>,
    );

    await waitFor(() => expect(activeLineText()).toBe('const b = 2;'));
  });

  it('opens at the first line when no line is requested', async () => {
    renderPanel();

    await waitFor(() => expect(activeLineText()).toBe('const a = 1;'));
  });

  describe('Markdown file', () => {
    const MARKDOWN = '# Report\n\nFirst paragraph.\n\nSecond paragraph.\n';

    function renderMarkdown(line?: number, lineRequest?: number) {
      return (
        <DesignSystemProvider>
          <PreviewPanel filePath="/w/report.md" tabId="t1" embedded line={line} lineRequest={lineRequest} />
        </DesignSystemProvider>
      );
    }

    beforeEach(() => {
      vi.mocked(readTextFile).mockResolvedValue(MARKDOWN);
    });

    it('shows the source at the requested line', async () => {
      render(renderMarkdown(5, 1));

      await waitFor(() => expect(activeLineText()).toBe('Second paragraph.'));
      expect(screen.queryByRole('heading', { name: 'Report' })).toBeNull();
    });

    it('shows the rendered document when no line is requested', async () => {
      render(renderMarkdown());

      expect(await screen.findByRole('heading', { name: 'Report' })).toBeInTheDocument();
      expect(document.querySelector('.cm-editor')).toBeNull();
    });

    it('turns the rendered document into the source when a line is requested for it', async () => {
      const view = render(renderMarkdown());
      await screen.findByRole('heading', { name: 'Report' });

      view.rerender(renderMarkdown(3, 1));

      await waitFor(() => expect(activeLineText()).toBe('First paragraph.'));
      expect(screen.queryByRole('heading', { name: 'Report' })).toBeNull();
    });
  });
});
