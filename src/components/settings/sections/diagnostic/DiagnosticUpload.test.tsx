// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DiagnosticUpload from './DiagnosticUpload';
import { useFeedbackDraftStore } from '@/stores/feedbackDraftStore';
import { useChatStore } from '@/stores/chatStore';

const collectAndZip = vi.fn();
const produceBundle = vi.fn();
vi.mock('@/core/diagnostic/bundle', () => ({
  collectAndZip: (...a: unknown[]) => collectAndZip(...a),
  produceBundle: (...a: unknown[]) => produceBundle(...a),
}));

const uploadDiagnosticBundle = vi.fn();
vi.mock('@/utils/consoleDiagnostic', () => ({
  uploadDiagnosticBundle: (...a: unknown[]) => uploadDiagnosticBundle(...a),
  isDiagnosticUploadUnavailable: () => false,
}));

// Child pickers carry their own store/DOM dependencies — out of scope here.
vi.mock('./ConversationPicker', () => ({ default: () => <div data-testid="conversation-picker" /> }));
vi.mock('./ScreenshotUpload', () => ({ default: () => <div data-testid="screenshot-upload" /> }));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      diagnostic: {
        descriptionLabel: 'Problem description',
        descriptionRequired: 'Please describe the problem',
        conversationRequired: 'Please select at least one conversation to attach',
        uploadDescriptionPlaceholder: 'Describe the issue',
        screenshotTitle: 'Attach screenshots',
        screenshotCount: '{n}/5',
        conversationPickerTitle: 'Select conversations',
        conversationPickerInfoTooltip: 'info',
        exportIncludeRaw: 'Include raw text',
        exportIncludeRawHint: 'hint',
        uploadAutoIncludedHint: 'auto-included',
        uploadButton: 'Upload bundle',
        uploadInProgress: 'Uploading…',
        uploadSuccess: 'Uploaded',
        uploadFailed: 'Upload failed',
        uploadUnavailable: 'unavailable',
        exportButton: 'Export offline bundle',
        exportInProgress: 'Packing…',
        exportFailed: 'Export failed',
        errMap: { unknown: 'unknown' },
      },
    },
  }),
  format: (tpl: string) => tpl,
}));

function renderUpload(description = '') {
  return render(
    <DiagnosticUpload onExportSuccess={vi.fn()} description={description} onDescriptionChange={vi.fn()} />,
  );
}

describe('DiagnosticUpload required fields', () => {
  beforeEach(() => {
    collectAndZip.mockReset().mockResolvedValue({ bytes: new Uint8Array(), filename: 'x.zip' });
    produceBundle.mockReset().mockResolvedValue({ path: '/x', sizeBytes: 1, scrubbedTextCount: 0, fileList: [] });
    uploadDiagnosticBundle.mockReset().mockResolvedValue(undefined);
    useChatStore.setState({ activeConversationId: null });
    useFeedbackDraftStore.setState({
      description: '',
      selectedConversationIds: [],
      touchedSelection: true, // stop the effect from re-syncing to the active conversation
      screenshots: [],
    });
  });

  afterEach(cleanup);

  it('blocks upload and shows both errors when description and conversations are empty', async () => {
    const user = userEvent.setup();
    renderUpload('');

    await user.click(screen.getByRole('button', { name: /Upload bundle/ }));

    expect(collectAndZip).not.toHaveBeenCalled();
    expect(uploadDiagnosticBundle).not.toHaveBeenCalled();
    expect(screen.getByText('Please describe the problem')).toBeInTheDocument();
    expect(screen.getByText('Please select at least one conversation to attach')).toBeInTheDocument();
  });

  it('whitespace-only description still counts as empty', async () => {
    const user = userEvent.setup();
    useFeedbackDraftStore.setState({ selectedConversationIds: ['c1'] });
    renderUpload('   \n  ');

    await user.click(screen.getByRole('button', { name: /Upload bundle/ }));

    expect(uploadDiagnosticBundle).not.toHaveBeenCalled();
    expect(screen.getByText('Please describe the problem')).toBeInTheDocument();
    expect(screen.queryByText('Please select at least one conversation to attach')).not.toBeInTheDocument();
  });

  it('shows only the conversation error when just the description is filled', async () => {
    const user = userEvent.setup();
    renderUpload('It crashed when I sent a message');

    await user.click(screen.getByRole('button', { name: /Upload bundle/ }));

    expect(uploadDiagnosticBundle).not.toHaveBeenCalled();
    expect(screen.queryByText('Please describe the problem')).not.toBeInTheDocument();
    expect(screen.getByText('Please select at least one conversation to attach')).toBeInTheDocument();
  });

  it('uploads when both fields are filled', async () => {
    const user = userEvent.setup();
    useFeedbackDraftStore.setState({ selectedConversationIds: ['c1'] });
    renderUpload('It crashed when I sent a message');

    await user.click(screen.getByRole('button', { name: /Upload bundle/ }));

    expect(collectAndZip).toHaveBeenCalledTimes(1);
    expect(uploadDiagnosticBundle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Please describe the problem')).not.toBeInTheDocument();
    expect(screen.queryByText('Please select at least one conversation to attach')).not.toBeInTheDocument();
  });

  it('offline export stays available without the required fields', async () => {
    const user = userEvent.setup();
    renderUpload('');

    await user.click(screen.getByRole('button', { name: /Export offline bundle/ }));

    expect(produceBundle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Please describe the problem')).not.toBeInTheDocument();
  });
});
