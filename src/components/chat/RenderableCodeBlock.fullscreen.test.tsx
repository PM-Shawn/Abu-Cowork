// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import RenderableCodeBlock, { type CodeBlockRendererConfig } from './RenderableCodeBlock';

const CODE = '<p>fixture widget</p>';
const buildFullscreenHtml = (code: string, isDark: boolean) => `<!doctype html><html><body data-fullscreen-fixture="${isDark ? 'dark' : 'light'}">${code}</body></html>`;

function widgetConfig(): CodeBlockRendererConfig {
  return {
    label: 'widget-fullscreen-test',
    fallbackLanguage: 'html',
    seamless: true,
    debounceMs: 10,
    render: async (_code, container) => { container.innerHTML = '<div>inline widget</div>'; },
    buildFullscreenHtml,
    i18n: { loading: 'Rendering', renderError: 'Failed', expand: 'Expand', collapse: 'Collapse' },
  };
}

async function renderWidget() {
  render(<DesignSystemProvider><RenderableCodeBlock code={CODE} config={widgetConfig()} /></DesignSystemProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
}

// The frame of the enlarged widget: the inline widget of this fixture draws no frame.
const fullscreenFrame = () => document.querySelector('iframe');

describe('RenderableCodeBlock fullscreen', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.classList.remove('dark');
  });

  it('draws the enlarged widget in a new frame that may run scripts and nothing else', async () => {
    await renderWidget();
    expect(fullscreenFrame()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '全屏查看' }));

    const frame = fullscreenFrame();
    expect(frame).not.toBeNull();
    expect(frame).toHaveAttribute('srcdoc', buildFullscreenHtml(CODE, false));
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('builds the enlarged widget for the dark appearance while the page carries the dark class', async () => {
    document.documentElement.classList.add('dark');
    await renderWidget();
    fireEvent.click(screen.getByRole('button', { name: '全屏查看' }));
    expect(fullscreenFrame()).toHaveAttribute('srcdoc', buildFullscreenHtml(CODE, true));
  });

  it('rebuilds the enlarged widget when the appearance changes while it is open', async () => {
    await renderWidget();
    fireEvent.click(screen.getByRole('button', { name: '全屏查看' }));
    expect(fullscreenFrame()).toHaveAttribute('srcdoc', buildFullscreenHtml(CODE, false));

    await act(async () => {
      document.documentElement.classList.add('dark');
      await Promise.resolve();
    });
    expect(fullscreenFrame()).toHaveAttribute('srcdoc', buildFullscreenHtml(CODE, true));

    await act(async () => {
      document.documentElement.classList.remove('dark');
      await Promise.resolve();
    });
    expect(fullscreenFrame()).toHaveAttribute('srcdoc', buildFullscreenHtml(CODE, false));
  });

  it('opens the enlarged widget as a viewer window, on its close button and not in the frame', async () => {
    await renderWidget();
    const opener = screen.getByRole('button', { name: '全屏查看' });
    act(() => { opener.focus(); });
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: '全屏查看' });
    expect(dialog).toHaveClass('inset-6');
    expect(dialog).toHaveAttribute('data-ds-layer');
    expect(dialog.contains(fullscreenFrame())).toBe(true);
    // One scrim, the design system's; the window is not white in the dark appearance.
    expect(document.querySelectorAll('.bg-scrim')).toHaveLength(1);
    expect(dialog).toHaveClass('bg-raised');

    // A frame that has the focus keeps every key, Escape included: the window opens on its way out.
    const close = screen.getByRole('button', { name: '关闭' });
    expect(dialog.contains(close)).toBe(true);
    expect(close).toHaveFocus();
    expect(fullscreenFrame()).not.toHaveFocus();
    // The frame is below the close button, not under it.
    expect(fullscreenFrame()!.parentElement).toHaveClass('pt-13');
  });

  it('closes on Escape and on the close button, and gives the focus back to the toolbar button', async () => {
    await renderWidget();
    const opener = screen.getByRole('button', { name: '全屏查看' });
    act(() => { opener.focus(); });
    fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: '全屏查看' })).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fullscreenFrame()).toBeNull();
    expect(opener).toHaveFocus();

    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fullscreenFrame()).toBeNull();
  });
});
