// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { usePreviewStore } from '@/stores/previewStore';
import { resolveFileMention } from '@/utils/turnFileMentions';
import MarkdownRenderer from './MarkdownRenderer';

const TURN_PATHS = ['/ws/src/app.ts', '/ws/out/report.md', 'C:/ws/a.docx', '/ws/季度 报告.docx'];
const resolve = (text: string) => resolveFileMention(text, TURN_PATHS);

describe('MarkdownRenderer file mentions', () => {
  const originalOpenPreview = usePreviewStore.getState().openPreview;
  const openPreview = vi.fn<(filePath: string, options?: { line?: number }) => void>();

  beforeEach(() => {
    initLanguage('en-US');
    openPreview.mockClear();
    usePreviewStore.setState({ openPreview });
  });

  afterEach(() => {
    cleanup();
    usePreviewStore.setState({ openPreview: originalOpenPreview });
  });

  describe('inline code', () => {
    it('turns a file of the turn into a button that opens the side preview', () => {
      render(<MarkdownRenderer content={'Saved to `/ws/out/report.md`.'} resolveFileMention={resolve} />);

      const button = screen.getByRole('button', { name: 'Preview report.md' });
      expect(button).toHaveTextContent('/ws/out/report.md');
      expect(button.querySelector('code')).not.toBeNull();

      fireEvent.click(button);
      expect(openPreview).toHaveBeenCalledTimes(1);
      expect(openPreview).toHaveBeenCalledWith('/ws/out/report.md', { line: undefined });
    });

    it('matches a bare file name', () => {
      render(<MarkdownRenderer content={'See `app.ts` for the change.'} resolveFileMention={resolve} />);

      fireEvent.click(screen.getByRole('button', { name: 'Preview app.ts' }));
      expect(openPreview).toHaveBeenCalledWith('/ws/src/app.ts', { line: undefined });
    });

    it('opens at the line the text names', () => {
      render(<MarkdownRenderer content={'The bug is at `/ws/src/app.ts:24`.'} resolveFileMention={resolve} />);

      const button = screen.getByRole('button', { name: 'Preview app.ts' });
      expect(button).toHaveTextContent('/ws/src/app.ts:24');
      fireEvent.click(button);
      expect(openPreview).toHaveBeenCalledWith('/ws/src/app.ts', { line: 24 });
    });

    it('leaves other inline code as plain code', () => {
      const { container } = render(<MarkdownRenderer content={'Run `npm test` and read `other.md`.'} resolveFileMention={resolve} />);

      expect(screen.queryByRole('button')).toBeNull();
      const codes = Array.from(container.querySelectorAll('code')).map((node) => node.textContent);
      expect(codes).toEqual(['npm test', 'other.md']);
    });

    it('leaves a fenced code block alone', () => {
      render(
        <DesignSystemProvider>
          <MarkdownRenderer content={'```text\n/ws/out/report.md\n/ws/src/app.ts\n```'} resolveFileMention={resolve} />
        </DesignSystemProvider>,
      );

      expect(screen.queryByRole('button', { name: 'Preview report.md' })).toBeNull();
    });
  });

  describe('links', () => {
    it('turns a link to a file of the turn into a button', () => {
      const { container } = render(<MarkdownRenderer content={'Open [the report](/ws/out/report.md).'} resolveFileMention={resolve} />);

      const button = screen.getByRole('button', { name: 'Preview report.md' });
      expect(button).toHaveTextContent('the report');
      expect(container.querySelector('a')).toBeNull();

      fireEvent.click(button);
      expect(openPreview).toHaveBeenCalledWith('/ws/out/report.md', { line: undefined });
    });

    it('reads the line from the link target', () => {
      render(<MarkdownRenderer content={'See [app.ts](/ws/src/app.ts#L24).'} resolveFileMention={resolve} />);

      fireEvent.click(screen.getByRole('button', { name: 'Preview app.ts' }));
      expect(openPreview).toHaveBeenCalledWith('/ws/src/app.ts', { line: 24 });
    });

    it('matches a target with characters markdown percent-encodes', () => {
      render(<MarkdownRenderer content={'[报告](</ws/季度 报告.docx>)'} resolveFileMention={resolve} />);

      fireEvent.click(screen.getByRole('button', { name: 'Preview 季度 报告.docx' }));
      expect(openPreview).toHaveBeenCalledWith('/ws/季度 报告.docx', { line: undefined });
    });

    it('matches a Windows drive path', () => {
      render(<MarkdownRenderer content={'[a.docx](C:/ws/a.docx)'} resolveFileMention={resolve} />);

      fireEvent.click(screen.getByRole('button', { name: 'Preview a.docx' }));
      expect(openPreview).toHaveBeenCalledWith('C:/ws/a.docx', { line: undefined });
    });

    it('keeps a web link a link', () => {
      const { container } = render(<MarkdownRenderer content={'[site](https://example.com/report.md)'} resolveFileMention={resolve} />);

      expect(screen.queryByRole('button')).toBeNull();
      expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com/report.md');
    });

    it('keeps a link to a file outside the turn as it renders without the resolver', () => {
      const content = '[notes](/elsewhere/notes.md) and [drive](C:/elsewhere/b.docx)';
      const withResolver = render(<MarkdownRenderer content={content} resolveFileMention={resolve} />);
      const withResolverHtml = withResolver.container.innerHTML;
      withResolver.unmount();
      const without = render(<MarkdownRenderer content={content} />);

      expect(withResolverHtml).toBe(without.container.innerHTML);
      expect(screen.queryByRole('button')).toBeNull();
    });
  });

  describe('without a resolver', () => {
    it('renders file names and paths as plain code and plain links', () => {
      const { container } = render(<MarkdownRenderer content={'Saved `/ws/out/report.md`, see [the report](/ws/out/report.md).'} />);

      expect(screen.queryByRole('button')).toBeNull();
      expect(container.querySelector('code')).toHaveTextContent('/ws/out/report.md');
      expect(container.querySelector('a')).toHaveTextContent('the report');
      expect(openPreview).not.toHaveBeenCalled();
    });
  });
});
