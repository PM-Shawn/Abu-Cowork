// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DiagnosticUpload from './DiagnosticUpload';
import { DesignSystemProvider } from '@/components/ds/provider';
import { useFeedbackDraftStore } from '@/stores/feedbackDraftStore';
import { useChatStore } from '@/stores/chatStore';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';

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

// The real mapper reads the language outside React; this one knows a full disk and nothing else.
vi.mock('@/core/diagnostic/errorMap', () => ({
  mapPermissionsError: (raw: string) => ({ message: /disk full/i.test(raw) ? 'Disk is full' : 'unknown' }),
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

function renderUpload(description = '', onExportSuccess: (result: unknown) => void = vi.fn()) {
  return render(
    <DiagnosticUpload onExportSuccess={onExportSuccess} description={description} onDescriptionChange={vi.fn()} />,
    { wrapper: DesignSystemProvider },
  );
}

// A promise the test settles by hand, to look at the form while a bundle is being made.
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const uploadButton = () => screen.getByRole('button', { name: /Upload bundle/ });
const exportButton = () => screen.getByRole('button', { name: /Export offline bundle/ });

describe('DiagnosticUpload required fields', () => {
  beforeEach(() => {
    collectAndZip.mockReset().mockResolvedValue({ bytes: new Uint8Array(), filename: 'x.zip' });
    produceBundle.mockReset().mockResolvedValue({ path: '/x', sizeBytes: 1, scrubbedTextCount: 0, fileList: [] });
    uploadDiagnosticBundle.mockReset().mockResolvedValue(undefined);
    useChatStore.setState({ activeConversationId: null });
    // The form lives in the settings window; it acts only while that window is open.
    useSettingsStore.setState({ systemSettingsOpen: true });
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

// What the two buttons hand to the bundle functions. Every value is made up.
describe('DiagnosticUpload export and upload', () => {
  const addToast = vi.fn();
  const RESULT = {
    path: '/made-up/Downloads/Abu-Diagnostic/abu-diagnostic-c1-20261002.zip',
    sizeBytes: 2048,
    scrubbedTextCount: 3,
    fileList: ['manifest.json'],
  };
  const ZIP = { bytes: new Uint8Array([9, 9]), filename: 'abu-diagnostic-c1-20261002.zip' };
  const PNG = new Uint8Array([1, 2, 3]);
  const JPEG = new Uint8Array([4, 5]);
  const FIELDS = {
    includeRawText: true,
    conversationIds: ['c1', 'c2'],
    description: 'It froze after sending.',
    screenshots: [{ name: '01.png', bytes: PNG }, { name: '02.jpg', bytes: JPEG }],
  };

  beforeEach(() => {
    addToast.mockReset();
    collectAndZip.mockReset().mockResolvedValue(ZIP);
    produceBundle.mockReset().mockResolvedValue(RESULT);
    uploadDiagnosticBundle.mockReset().mockResolvedValue(undefined);
    useToastStore.setState({ addToast });
    useChatStore.setState({ activeConversationId: null });
    useSettingsStore.setState({ systemSettingsOpen: true });
    useDiagnosticStore.setState({
      includeRawText: useDiagnosticStore.getInitialState().includeRawText,
      exportInProgress: false,
      lastExportPath: null,
    });
    useFeedbackDraftStore.setState({
      description: '',
      selectedConversationIds: ['c1', 'c2'],
      touchedSelection: true,
      screenshots: [
        { id: 's1', name: 'first.png', bytes: PNG, mediaType: 'image/png', previewUrl: 'blob:made-up-1' },
        { id: 's2', name: 'second.jpeg', bytes: JPEG, mediaType: 'image/jpeg', previewUrl: 'blob:made-up-2' },
      ],
    });
  });

  afterEach(cleanup);

  it('includes message text unless the switch is turned off, and hands that choice to the export', async () => {
    const user = userEvent.setup();
    expect(useDiagnosticStore.getInitialState().includeRawText).toBe(true);
    renderUpload('');
    const includeText = screen.getByRole('switch');
    expect(includeText).toHaveAttribute('aria-checked', 'true');

    await user.click(exportButton());
    await waitFor(() => expect(produceBundle).toHaveBeenCalledTimes(1));
    expect(produceBundle.mock.calls[0][0]).toMatchObject({ includeRawText: true });
    await waitFor(() => expect(exportButton()).toBeEnabled());

    await user.click(includeText);
    expect(includeText).toHaveAttribute('aria-checked', 'false');
    expect(useDiagnosticStore.getState().includeRawText).toBe(false);

    await user.click(exportButton());
    await waitFor(() => expect(produceBundle).toHaveBeenCalledTimes(2));
    expect(produceBundle.mock.calls[1][0]).toMatchObject({ includeRawText: false });
  });

  it('exports the chosen conversations, the trimmed description and the screenshots under numbered names', async () => {
    const user = userEvent.setup();
    renderUpload('  It froze after sending.  ');

    await user.click(exportButton());

    await waitFor(() => expect(produceBundle).toHaveBeenCalledTimes(1));
    expect(produceBundle.mock.calls[0]).toEqual([FIELDS]);
    expect(collectAndZip).not.toHaveBeenCalled();
    expect(uploadDiagnosticBundle).not.toHaveBeenCalled();
  });

  it('exports without a description when none was typed', async () => {
    const user = userEvent.setup();
    renderUpload('   ');

    await user.click(exportButton());

    await waitFor(() => expect(produceBundle).toHaveBeenCalledTimes(1));
    expect(produceBundle.mock.calls[0][0].description).toBeUndefined();
  });

  it('uploads the same fields, says so, and clears the draft', async () => {
    const user = userEvent.setup();
    renderUpload('  It froze after sending.  ');

    await user.click(uploadButton());

    await waitFor(() => expect(uploadDiagnosticBundle).toHaveBeenCalledTimes(1));
    expect(collectAndZip.mock.calls).toEqual([[FIELDS]]);
    expect(uploadDiagnosticBundle.mock.calls[0]).toEqual([ZIP.bytes, ZIP.filename, 'It froze after sending.']);
    expect(produceBundle).not.toHaveBeenCalled();
    await waitFor(() => expect(addToast).toHaveBeenCalledWith({ title: 'Uploaded', type: 'success', duration: 3000 }));
    expect(useFeedbackDraftStore.getState().screenshots).toEqual([]);
    expect(useFeedbackDraftStore.getState().selectedConversationIds).toEqual([]);
  });

  it('leaves the upload button usable while the description is empty', () => {
    renderUpload('');

    expect(uploadButton()).toBeEnabled();
    expect(exportButton()).toBeEnabled();
  });

  it('takes no press on either button while a bundle is being exported', async () => {
    const user = userEvent.setup();
    const gate = pending<typeof RESULT>();
    produceBundle.mockReturnValue(gate.promise);
    renderUpload('It froze after sending.');
    const upload = uploadButton();
    const exportOffline = exportButton();

    await user.click(exportOffline);

    expect(screen.getByText('Packing…')).toBeInTheDocument();
    expect(upload).toBeDisabled();
    expect(exportOffline).toBeDisabled();
    await user.click(upload);
    await user.click(exportOffline);
    expect(produceBundle).toHaveBeenCalledTimes(1);
    expect(collectAndZip).not.toHaveBeenCalled();

    gate.resolve(RESULT);
    await waitFor(() => expect(exportOffline).toBeEnabled());
    expect(upload).toBeEnabled();
    expect(screen.queryByText('Packing…')).not.toBeInTheDocument();
  });

  it('takes no press on either button while a bundle is being uploaded', async () => {
    const user = userEvent.setup();
    const gate = pending<typeof ZIP>();
    collectAndZip.mockReturnValue(gate.promise);
    renderUpload('It froze after sending.');
    const upload = uploadButton();
    const exportOffline = exportButton();

    await user.click(upload);

    expect(screen.getByText('Uploading…')).toBeInTheDocument();
    expect(upload).toBeDisabled();
    expect(exportOffline).toBeDisabled();
    await user.click(exportOffline);
    await user.click(upload);
    expect(collectAndZip).toHaveBeenCalledTimes(1);
    expect(produceBundle).not.toHaveBeenCalled();

    gate.resolve(ZIP);
    await waitFor(() => expect(upload).toBeEnabled());
    expect(exportOffline).toBeEnabled();
    expect(screen.queryByText('Uploading…')).not.toBeInTheDocument();
  });

  it('hands a finished export to the page and remembers where it went', async () => {
    const user = userEvent.setup();
    const onExportSuccess = vi.fn();
    renderUpload('', onExportSuccess);

    await user.click(exportButton());

    await waitFor(() => expect(onExportSuccess).toHaveBeenCalledTimes(1));
    expect(onExportSuccess).toHaveBeenCalledWith(RESULT);
    expect(useDiagnosticStore.getState().lastExportPath).toBe(RESULT.path);
    expect(addToast).not.toHaveBeenCalled();
  });

  it('says why when the export fails, and hands nothing to the page', async () => {
    const user = userEvent.setup();
    const onExportSuccess = vi.fn();
    produceBundle.mockRejectedValue(new Error('made-up failure'));
    renderUpload('', onExportSuccess);

    await user.click(exportButton());

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(addToast).toHaveBeenCalledWith({ title: 'Export failed', message: 'made-up failure', type: 'error', duration: 6000 });
    expect(onExportSuccess).not.toHaveBeenCalled();
    expect(useDiagnosticStore.getState().lastExportPath).toBeNull();
    await waitFor(() => expect(exportButton()).toBeEnabled());
  });

  it('puts the known cause before the raw text when the export fails for a known reason', async () => {
    const user = userEvent.setup();
    produceBundle.mockRejectedValue(new Error('ENOSPC: disk full'));
    renderUpload('');

    await user.click(exportButton());

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(addToast.mock.calls[0][0]).toMatchObject({ title: 'Export failed', message: 'Disk is full\nENOSPC: disk full', type: 'error' });
  });

  it('shows one turning indicator under the buttons while a bundle is made, and none inside them', async () => {
    const user = userEvent.setup();
    const gate = pending<typeof RESULT>();
    produceBundle.mockReturnValue(gate.promise);
    const { container } = renderUpload('It froze after sending.');
    expect(container.querySelector('[data-ds-spinner]')).toBeNull();

    await user.click(exportButton());

    const turning = container.querySelectorAll('[data-ds-spinner]');
    expect(turning).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Packing…');
    expect(screen.getByRole('status').contains(turning[0])).toBe(true);
    // Both buttons keep their words and take no indicator.
    expect(uploadButton().querySelector('[data-ds-spinner]')).toBeNull();
    expect(exportButton().querySelector('[data-ds-spinner]')).toBeNull();
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(1);

    gate.resolve(RESULT);
    await waitFor(() => expect(container.querySelector('[data-ds-spinner]')).toBeNull());
  });

  it('says the upload went through under the buttons, with a mark', async () => {
    const user = userEvent.setup();
    renderUpload('It froze after sending.');

    await user.click(uploadButton());

    const done = await screen.findByRole('status');
    expect(done).toHaveTextContent('Uploaded');
    expect(done.querySelector('svg')).not.toBeNull();
    expect(done.querySelector('[data-ds-spinner]')).toBeNull();
    expect(uploadButton()).toBeEnabled();
  });

  it('names the switch after its label and toggles it from the label', async () => {
    const user = userEvent.setup();
    renderUpload('');
    const includeText = screen.getByRole('switch', { name: 'Include raw text' });

    await user.click(screen.getByText('Include raw text'));

    expect(includeText).toHaveAttribute('aria-checked', 'false');
    expect(useDiagnosticStore.getState().includeRawText).toBe(false);
  });

  // This switch decides whether message text goes into a bundle, and its value is kept for later
  // bundles: a stray press on the empty part of its row must not move it.
  it('leaves the switch alone on a press beside its words, and toggles it on a press on the words', async () => {
    const user = userEvent.setup();
    renderUpload('');
    const includeText = screen.getByRole('switch', { name: 'Include raw text' });
    const words = screen.getByText('Include raw text');
    // The box that takes the spare width of the row, from the words to the switch.
    const spare = words.closest('.flex-1');
    if (!spare) throw new Error('No box takes the spare width of the row');

    await user.click(spare);
    expect(includeText).toHaveAttribute('aria-checked', 'true');
    expect(useDiagnosticStore.getState().includeRawText).toBe(true);
    expect(words).not.toHaveClass('flex-1');
    expect(spare).not.toBe(words);

    await user.click(words);
    expect(includeText).toHaveAttribute('aria-checked', 'false');
    expect(useDiagnosticStore.getState().includeRawText).toBe(false);
  });

  it('explains the conversation choice in a panel that opens on a press and closes on Escape', async () => {
    const user = userEvent.setup();
    renderUpload('');
    const about = screen.getByRole('button', { name: 'info' });
    expect(screen.queryByText('info')).not.toBeInTheDocument();

    await user.click(about);
    const panel = screen.getByText('info');
    expect(panel.closest('[data-ds-layer]')).not.toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('info')).not.toBeInTheDocument());
  });

  describe('while the settings window is closing', () => {
    // The window stays on the page while it fades out; the keyboard can still reach its buttons.
    beforeEach(() => {
      useSettingsStore.setState({ systemSettingsOpen: false });
    });

    it('exports nothing', async () => {
      const user = userEvent.setup();
      const onExportSuccess = vi.fn();
      renderUpload('It froze after sending.', onExportSuccess);

      exportButton().focus();
      await user.keyboard('{Enter}');
      await user.keyboard(' ');

      expect(produceBundle).not.toHaveBeenCalled();
      expect(onExportSuccess).not.toHaveBeenCalled();
      expect(useDiagnosticStore.getState().exportInProgress).toBe(false);
    });

    it('uploads nothing and shows no required-field error', async () => {
      const user = userEvent.setup();
      renderUpload('');

      uploadButton().focus();
      await user.keyboard('{Enter}');

      expect(collectAndZip).not.toHaveBeenCalled();
      expect(uploadDiagnosticBundle).not.toHaveBeenCalled();
      expect(screen.queryByText('Please describe the problem')).not.toBeInTheDocument();
    });
  });

  it('says so when the upload fails and keeps the draft', async () => {
    const user = userEvent.setup();
    uploadDiagnosticBundle.mockRejectedValue(new Error('made-up upload failure'));
    renderUpload('It froze after sending.');

    await user.click(uploadButton());

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(addToast).toHaveBeenCalledWith({ title: 'Upload failed', message: 'made-up upload failure', type: 'error', duration: 6000 });
    expect(useFeedbackDraftStore.getState().screenshots).toHaveLength(2);
  });
});
