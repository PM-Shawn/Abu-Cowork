// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { openPath } from '@tauri-apps/plugin-opener';
import { DesignSystemProvider } from '@/components/ds/provider';
import { useToastStore } from '@/stores/toastStore';
import { atomicWrite } from '@/utils/atomicFs';
import { OPEN_REFUSED_RUNS_BY_DEFAULT } from '@/utils/openWithDefaultApp';
import PreviewPanel from './PreviewPanel';

const layerRenders = vi.hoisted(() => ({ iconButton: vi.fn(), menu: vi.fn() }));

// Counts renders of the toolbar's floating-layer controls (button tooltips, the two menus).
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      layerRenders.iconButton(props);
      return actual.IconButton(props);
    },
  };
});

vi.mock('@/components/ds/menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/menu')>();
  return {
    ...actual,
    Menu: (props: ComponentProps<typeof actual.Menu>) => {
      layerRenders.menu();
      return actual.Menu(props);
    },
  };
});

// The real editor needs layout; a text box drives the same value/onChange pair.
vi.mock('./CodeMirrorEditor', async () => {
  const { TextArea } = await import('@/components/ds/text-area');
  return {
    default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
      <TextArea aria-label="source" value={value} onChange={(event) => onChange(event.target.value)} />
    ),
  };
});

vi.mock('@/hooks/usePreviewFileWatch', () => ({ usePreviewFileWatch: () => {} }));
vi.mock('@/utils/atomicFs', () => ({ atomicWrite: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/utils/canvasVersions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/canvasVersions')>()),
  snapshotVersion: vi.fn().mockResolvedValue(undefined),
  listVersions: vi.fn().mockResolvedValue([]),
}));

describe('PreviewPanel toolbar', () => {
  beforeEach(() => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockResolvedValue('const a = 1;\n');
    layerRenders.iconButton.mockClear();
    layerRenders.menu.mockClear();
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(exists).mockResolvedValue(false);
    vi.mocked(readTextFile).mockResolvedValue('');
  });

  it('does not re-render its tooltips and menus for each character typed in the editor', async () => {
    render(
      <DesignSystemProvider>
        <PreviewPanel filePath="/w/main.ts" tabId="t1" embedded />
      </DesignSystemProvider>,
    );
    const editor = await screen.findByRole('textbox', { name: 'source' });
    expect(screen.getByRole('button', { name: 'Version history' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();

    // The first character moves the save state from "Saved" to "Saving…": one toolbar render.
    fireEvent.change(editor, { target: { value: 'const a = 1;\nx' } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saving…'));
    // 「Saved」 and 「Saving…」 share one slot and one text size.
    expect(screen.getByText('Saving…')).toHaveClass('text-ui');
    const iconButtons = layerRenders.iconButton.mock.calls.length;
    const menus = layerRenders.menu.mock.calls.length;
    expect(iconButtons).toBeGreaterThan(0);
    expect(menus).toBeGreaterThan(0);

    for (const text of ['xy', 'xyz', 'xyz1', 'xyz12']) {
      fireEvent.change(editor, { target: { value: `const a = 1;\n${text}` } });
    }
    expect(editor).toHaveValue('const a = 1;\nxyz12');
    expect(layerRenders.iconButton.mock.calls.length).toBe(iconButtons);
    expect(layerRenders.menu.mock.calls.length).toBe(menus);
  });

  // The tab strip sits right above the toolbar: a tooltip that opened upward would cover the tab titles.
  it('opens the tooltip of every toolbar button below the button', async () => {
    render(
      <DesignSystemProvider>
        <PreviewPanel filePath="/w/notes.md" tabId="t1" embedded />
      </DesignSystemProvider>,
    );
    await screen.findByRole('button', { name: 'Version history' });

    const sides = new Map(layerRenders.iconButton.mock.calls.map(([props]) => [props.label, props.tooltipSide]));
    expect([...sides.keys()].sort()).toEqual(['Fullscreen', 'More actions', 'Open in default app', 'Preview', 'Reload', 'Source', 'Version history'].sort());
    expect([...new Set(sides.values())]).toEqual(['bottom']);
  });

  it('offers no open-in-app button for code the system would run', async () => {
    render(
      <DesignSystemProvider>
        <PreviewPanel filePath="/w/job.py" tabId="t1" embedded />
      </DesignSystemProvider>,
    );
    await screen.findByRole('button', { name: 'Version history' });
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in default app' })).toBeNull();
  });

  it('takes the open-in-app button away once the main process has refused to open the file', async () => {
    vi.mocked(openPath).mockRejectedValueOnce(new Error(`Error invoking remote method 'tauri:invoke': Error: ${OPEN_REFUSED_RUNS_BY_DEFAULT}`));
    render(
      <DesignSystemProvider>
        <PreviewPanel filePath="/w/main.ts" tabId="t1" embedded />
      </DesignSystemProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open in default app' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open in default app' })).toBeNull());
    expect(openPath).toHaveBeenCalledWith('/w/main.ts');
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', title: 'Failed to open file', message: 'Could not open this file in a local app' }),
    ]);
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
  });

  it('says so in the toolbar when a save fails, with the failure mark', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(atomicWrite).mockRejectedValueOnce(new Error('disk is full'));
    try {
      render(
        <DesignSystemProvider>
          <PreviewPanel filePath="/w/main.ts" tabId="t1" embedded />
        </DesignSystemProvider>,
      );
      const editor = await screen.findByRole('textbox', { name: 'source' });
      const saved = screen.getByText('Saved');
      expect(saved).toHaveClass('text-label-secondary');

      fireEvent.change(editor, { target: { value: 'const a = 2;\n' } });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saving…'));
      await act(() => vi.advanceTimersByTimeAsync(1100));

      const failed = await screen.findByText('Save failed', { selector: 'span' });
      expect(failed).toHaveClass('text-danger');
      expect(failed.querySelector('svg')).toHaveClass('text-danger');
      expect(screen.queryByText('Saved')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(useToastStore.getState().toasts.map(({ type, title, message }) => ({ type, title, message })))
        .toEqual([{ type: 'error', title: 'Save failed', message: 'disk is full' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
