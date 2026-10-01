// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { DesignSystemProvider } from '@/components/ds/provider';
import PreviewPanel from './PreviewPanel';

const layerRenders = vi.hoisted(() => ({ iconButton: vi.fn(), menu: vi.fn() }));

// Counts renders of the toolbar's floating-layer controls (button tooltips, the two menus).
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      layerRenders.iconButton();
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
vi.mock('./CodeMirrorEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="source" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

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
});
