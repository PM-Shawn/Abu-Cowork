// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import FeedbackSection from './FeedbackSection';

const openSystemSettings = vi.fn();

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { openSystemSettings: typeof openSystemSettings }) => unknown) =>
    selector({ openSystemSettings }),
}));

vi.mock('@/stores/feedbackDraftStore', () => ({
  useFeedbackDraftStore: (selector: (s: { description: string; setDescription: () => void }) => unknown) =>
    selector({ description: '', setDescription: vi.fn() }),
}));

// The upload form has its own tests and a heavy dependency graph; this file is
// about what the page does around it.
vi.mock('./diagnostic/DiagnosticUpload', () => ({ default: () => <div data-testid="upload-form" /> }));
vi.mock('./diagnostic/ExportSuccessCard', () => ({ default: () => null }));

describe('FeedbackSection', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('no longer carries the contact QR code itself', () => {
    render(<FeedbackSection />);

    expect(screen.getByTestId('upload-form')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText('联系开发者')).not.toBeInTheDocument();
  });

  it('points the person with a problem at the author page instead', async () => {
    render(<FeedbackSection />);

    expect(screen.getByText('想直接找作者？')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /去「关于作者」页/ }));

    expect(openSystemSettings).toHaveBeenCalledWith('author');
  });
});
