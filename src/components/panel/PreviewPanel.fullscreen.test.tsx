// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PreviewPanel from './PreviewPanel';

const testPlatform = vi.hoisted(() => ({ current: 'windows' }));

vi.mock('@/utils/platform', () => ({
  isWindows: () => testPlatform.current === 'windows',
  isMacOS: () => testPlatform.current === 'macos',
}));

function renderImagePreview() {
  return render(
    <PreviewPanel
      filePath="data:image/png;base64,iVBORw0KGgo="
      tabId="preview-test"
      embedded
    />,
  );
}

describe('PreviewPanel fullscreen layout', () => {
  beforeEach(() => {
    testPlatform.current = 'windows';
  });

  it('keeps the Windows native title bar above the maximized content', () => {
    const { container } = renderImagePreview();

    fireEvent.click(screen.getByTitle(/全屏|Fullscreen/i));

    expect(container.firstElementChild).toHaveClass('fixed', 'inset-0');
    expect(container.firstElementChild).toHaveStyle({
      top: 'calc(env(titlebar-area-y, 0px) + env(titlebar-area-height, 36px))',
    });
  });

  it('leaves the existing macOS fullscreen geometry unchanged', () => {
    testPlatform.current = 'macos';
    const { container } = renderImagePreview();

    fireEvent.click(screen.getByTitle(/全屏|Fullscreen/i));

    expect(container.firstElementChild).toHaveClass('fixed', 'inset-0');
    expect(container.firstElementChild).not.toHaveAttribute('style');
    expect(container.querySelector('.pl-20')).not.toBeNull();
  });
});
