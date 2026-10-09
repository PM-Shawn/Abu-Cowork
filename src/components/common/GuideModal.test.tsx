// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { APPROVAL_TITLE, approvalProbe, closingWindow, keepClosingLayersOnScreen, windowBox } from '@/test/dsWindows';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import GuideModal from './GuideModal';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();

const ui = {
  window: () => document.querySelector<HTMLElement>('[data-abu-guide-modal="true"]'),
  dismiss: () => screen.getByRole('button', { name: t().guide.dismiss }),
  link: () => screen.queryByRole('button', { name: t().guide.step1Link }),
  escape: () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }),
};

function open(withLink = true) {
  const calls: string[] = [];
  const onClose = vi.fn(() => { calls.push('onClose'); });
  const onNavigateToAIServices = vi.fn(() => { calls.push('onNavigateToAIServices'); });
  const view = render(<GuideModal open onClose={onClose} onNavigateToAIServices={withLink ? onNavigateToAIServices : undefined} />);
  return { calls, onClose, onNavigateToAIServices, view };
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  initLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GuideModal', () => {
  describe('what it shows', () => {
    it('shows the title and the four steps, numbered', () => {
      open();
      const guide = ui.window()!;

      expect(guide).toHaveTextContent(t().guide.title);
      for (const [index, step] of [
        [1, { title: t().guide.step1Title, desc: t().guide.step1Desc }],
        [2, { title: t().guide.step2Title, desc: t().guide.step2Desc }],
        [3, { title: t().guide.step3Title, desc: t().guide.step3Desc }],
        [4, { title: t().guide.step4Title, desc: t().guide.step4Desc }],
      ] as const) {
        expect(screen.getByText(String(index), { exact: true })).toBeInTheDocument();
        expect(screen.getByText(step.title, { exact: true })).toBeInTheDocument();
        expect(guide).toHaveTextContent(step.desc);
      }
    });

    it('carries the mark the first-run helpers look for, with the dismiss button inside it', () => {
      open();
      expect(ui.window()).not.toBeNull();
      expect(ui.window()).toContainElement(ui.dismiss());
    });

    it('shows nothing while closed', () => {
      render(<GuideModal open={false} onClose={vi.fn()} />);
      expect(ui.window()).toBeNull();
    });

    it('has no link to the AI services page when it is given nowhere to go', () => {
      open(false);
      expect(ui.link()).not.toBeInTheDocument();
    });
  });

  describe('closing', () => {
    it('closes with the dismiss button', () => {
      const { onClose, onNavigateToAIServices } = open();

      fireEvent.click(ui.dismiss());

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onNavigateToAIServices).not.toHaveBeenCalled();
    });

    it('closes first and then goes to the AI services page from the link in step one', () => {
      const { calls } = open();

      fireEvent.click(ui.link()!);

      expect(calls).toEqual(['onClose', 'onNavigateToAIServices']);
    });

    it('closes on Escape', () => {
      const { onClose, onNavigateToAIServices } = open();

      ui.escape();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onNavigateToAIServices).not.toHaveBeenCalled();
    });
  });

  describe('as a design-system window', () => {
    it('is a dialog named by its title, and the mark is on the dialog itself', () => {
      open();

      const window = screen.getByRole('dialog', { name: t().guide.title });
      expect(window).toBe(ui.window());
      expect(window).toHaveAttribute('data-electron-no-drag');
      expect(screen.getByRole('button', { name: t().common.close })).toBeInTheDocument();
    });

    it('has one filled button, the one that dismisses, and opens on it', () => {
      open();

      expect(ui.dismiss()).toHaveClass('bg-emphasis');
      expect(ui.link()).not.toHaveClass('bg-emphasis');
      expect(ui.dismiss()).toHaveFocus();
    });

    it('shows the step numbers as tags and the link as a text button', () => {
      open();

      expect(screen.getByText('1', { exact: true })).toHaveClass('bg-fill');
      expect(ui.link()).toHaveClass('text-link');
    });

    it('does nothing more once it is closing', () => {
      keepClosingLayersOnScreen();
      const onClose = vi.fn();
      const onNavigateToAIServices = vi.fn();
      const view = render(<GuideModal open onClose={onClose} onNavigateToAIServices={onNavigateToAIServices} />);
      view.rerender(<GuideModal open={false} onClose={onClose} onNavigateToAIServices={onNavigateToAIServices} />);
      expect(closingWindow()).toHaveTextContent(t().guide.title);

      fireEvent.click(screen.getByRole('button', { name: t().guide.step1Link, hidden: true }));
      fireEvent.click(screen.getByRole('button', { name: t().guide.dismiss, hidden: true }));

      expect(onNavigateToAIServices).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    // It holds nothing typed and no work: an approval takes its place, and it counts as read.
    it('is closed for an approval that arrives', () => {
      const onAnswer = vi.fn();
      const onClose = vi.fn();
      function Host({ approval }: { approval: boolean }) {
        const [isOpen, setOpen] = useState(true);
        return (
          <>
            <GuideModal open={isOpen} onClose={() => { onClose(); setOpen(false); }} />
            {approvalProbe(approval, onAnswer)}
          </>
        );
      }
      const view = render(<Host approval={false} />);

      view.rerender(<Host approval />);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(windowBox(t().guide.title)).toBeNull();
      expect(windowBox(APPROVAL_TITLE)).not.toBeNull();
      expect(onAnswer).not.toHaveBeenCalled();
    });
  });
});
