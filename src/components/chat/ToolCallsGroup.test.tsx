// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

/**
 * ToolCallsGroup — sandbox-blocked result rendering.
 *
 * `annotateSandboxViolations` (electron/commandHost.cjs) prepends the
 * `[sandbox-blocked] <reasons>` line to the command's *stderr*, and
 * `run_command` then wraps that stderr in a `stderr:` header block (and may
 * emit `stdout:` / recovery blocks before it). So the marker line never sits
 * at index 0 of the tool result — the card has to find it wherever it is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { ToolCall, ToolResultContent } from '@/types';
import ToolCallsGroup, { ToolResultImagePreview } from './ToolCallsGroup';

const mockResolveOutputRefSource = vi.hoisted(() => vi.fn());
const mockLoadLocalImage = vi.hoisted(() => vi.fn());

vi.mock('@/core/session/outputSnapshots', () => ({
  resolveOutputRefSource: (...args: unknown[]) => mockResolveOutputRefSource(...args),
}));

vi.mock('@/utils/pathUtils', async () => {
  const actual = await vi.importActual<typeof import('@/utils/pathUtils')>('@/utils/pathUtils');
  return {
    ...actual,
    loadLocalImage: (...args: unknown[]) => mockLoadLocalImage(...args),
  };
});

const BLOCKED_REASON = 'command execution blocked by sandbox policy (exec)';

/** Realistic `run_command` output for a command the sandbox refused. */
const BLOCKED_RESULT = [
  'stderr:',
  `[sandbox-blocked] ${BLOCKED_REASON}`,
  '',
  'zsh:1: operation not permitted: ps',
].join('\n');

function commandCall(result: string): ToolCall {
  return {
    id: 'tc-sandbox-1',
    name: TOOL_NAMES.RUN_COMMAND,
    input: { command: 'ps aux' },
    result,
  };
}

/** Open the group, then the individual tool call's details panel. */
function renderExpanded(toolCall: ToolCall) {
  render(<ToolCallsGroup toolCalls={[toolCall]} />);
  // The group header is the only button until it is expanded; expanding adds
  // one row button per tool call, which is the one that reveals the output.
  fireEvent.click(screen.getAllByRole('button')[0]);
  const rows = screen.getAllByRole('button', { name: new RegExp(toolCall.name, 'i') });
  fireEvent.click(rows[rows.length - 1]);
}

describe('ToolCallsGroup sandbox-blocked output', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
  });

  it('highlights the [sandbox-blocked] reason line, not the stderr: header', () => {
    renderExpanded(commandCall(BLOCKED_RESULT));

    const reason = screen.getByTestId('sandbox-blocked-reason');
    expect(reason).toHaveTextContent(BLOCKED_REASON);
    expect(reason.textContent).not.toContain('[sandbox-blocked]');
    expect(reason.textContent?.trim()).not.toBe('stderr:');
  });

  it('keeps the remaining output — including the underlying error — in the details block', () => {
    renderExpanded(commandCall(BLOCKED_RESULT));

    const details = screen.getByTestId('sandbox-blocked-details');
    expect(details.textContent).toContain('zsh:1: operation not permitted: ps');
    expect(details.textContent).not.toContain(BLOCKED_REASON);
  });

  it('still handles a result whose first line is the marker', () => {
    renderExpanded(
      commandCall(`[sandbox-blocked] ${BLOCKED_REASON}\n\nzsh:1: operation not permitted: ps`),
    );

    expect(screen.getByTestId('sandbox-blocked-reason')).toHaveTextContent(BLOCKED_REASON);
    expect(screen.getByTestId('sandbox-blocked-details').textContent).toBe(
      'zsh:1: operation not permitted: ps',
    );
  });

  it('keeps output emitted before the marker, such as a stdout block', () => {
    renderExpanded(
      commandCall(
        [
          'stdout:',
          'partial output',
          '',
          'stderr:',
          `[sandbox-blocked] ${BLOCKED_REASON}`,
          '',
          'zsh:1: operation not permitted: ps',
        ].join('\n'),
      ),
    );

    const details = screen.getByTestId('sandbox-blocked-details');
    expect(details.textContent).toContain('partial output');
    expect(details.textContent).toContain('zsh:1: operation not permitted: ps');
  });

  it('renders a plain result without the sandbox card', () => {
    renderExpanded(commandCall('stdout:\nroot 1 launchd\n\nexit code: 0'));

    expect(screen.queryByTestId('sandbox-blocked-reason')).toBeNull();
    expect(screen.getByText(/root 1 launchd/)).toBeInTheDocument();
  });

  it('marks the blocked reason with the danger status icon', () => {
    renderExpanded(commandCall(BLOCKED_RESULT));

    const box = screen.getByTestId('sandbox-blocked-reason').parentElement!;
    expect(box.querySelector('svg.lucide-circle-x')).not.toBeNull();
    expect(screen.getByTestId('sandbox-blocked-reason')).toHaveClass('text-danger');
    expect(screen.getByTestId('sandbox-blocked-reason')).toHaveClass('font-code');
  });
});

// One spinner per place: a tool group's header holds the only moving
// indicator; each running row shows the same loading glyph standing still.
describe('ToolCallsGroup status icons', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
  });

  const call = (id: string, name: string, extra: Partial<ToolCall> = {}): ToolCall => ({
    id,
    name,
    input: {},
    ...extra,
  });
  it('spins once in the header while two tools run', () => {
    render(
      <ToolCallsGroup
        toolCalls={[
          call('a', 'read_file', { isExecuting: true }),
          call('b', 'list_directory', { isExecuting: true }),
        ]}
      />,
    );
    const header = screen.getAllByRole('button')[0];
    fireEvent.click(header);

    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(header.contains(statuses[0])).toBe(true);
    expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    const rows = screen.getAllByRole('button').slice(1);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.querySelector('svg.lucide-loader-circle')).not.toBeNull();
      expect(r.querySelector('[data-ds-spinner]')).toBeNull();
    }
  });

  it('shows a check for finished tools and a cross for failed ones, with no spinner', () => {
    render(
      <ToolCallsGroup
        toolCalls={[
          call('a', 'read_file', { result: 'ok' }),
          call('b', 'run_command', { result: 'boom', isError: true }),
        ]}
      />,
    );
    const header = screen.getAllByRole('button')[0];
    expect(header.querySelector('svg.lucide-circle-x')).not.toBeNull();
    fireEvent.click(header);

    const [okRow, failedRow] = screen.getAllByRole('button').slice(1);
    expect(okRow.querySelector('svg.lucide-circle-check')).not.toBeNull();
    expect(failedRow.querySelector('svg.lucide-circle-x')).not.toBeNull();
    expect(document.querySelector('[data-ds-spinner]')).toBeNull();
  });

  it('shows the success check on the header when every tool finished', () => {
    render(<ToolCallsGroup toolCalls={[call('a', 'read_file', { result: 'ok' })]} />);
    const header = screen.getAllByRole('button')[0];
    expect(header.querySelector('svg.lucide-circle-check')).not.toBeNull();
    expect(header.querySelector('svg.text-success')).not.toBeNull();
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('prints tool output on the code surface', () => {
    renderExpanded(commandCall('stdout:\nroot 1 launchd\n\nexit code: 0'));
    const output = screen.getByText(/root 1 launchd/);
    expect(output).toHaveClass('font-code');
    expect(output).toHaveClass('text-mono');
    expect(output.closest('.bg-code')).not.toBeNull();
  });
});

type ImageBlock = Extract<ToolResultContent, { type: 'image' }>;

describe('ToolResultImagePreview', () => {
  beforeEach(() => {
    initLanguage('en-US');
    mockResolveOutputRefSource.mockReset();
    mockLoadLocalImage.mockReset();
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  });

  afterEach(() => {
    cleanup();
  });

  const refBlock: ImageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: '' },
    outputRef: { relPath: 'files/hash/shot.png', basename: 'shot.png' },
  };
  const inlineBlock: ImageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
  };
  const renderPreview = (block: ImageBlock) => render(
    <ToolResultImagePreview block={block} conversationId="conv-1" alt="Screenshot" frameClassName="frame" thumbnailClassName="thumb" />,
  );

  it('names its loading spinner while the saved image is read', () => {
    mockResolveOutputRefSource.mockReturnValue(new Promise(() => {}));
    renderPreview(refBlock);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading image...');
    expect(status.querySelector('[data-ds-spinner]')).not.toBeNull();
  });

  it('offers a retry button when the saved image cannot be read', async () => {
    mockResolveOutputRefSource.mockResolvedValue({ status: 'missing', basename: 'shot.png', originalPath: 'files/hash/shot.png' });
    renderPreview(refBlock);

    expect(await screen.findByText('Image unavailable')).toBeInTheDocument();
    expect(document.querySelector('svg.lucide-image-off')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockResolveOutputRefSource).toHaveBeenCalledTimes(2));
  });

  it('opens the enlarged view from a thumbnail button', () => {
    renderPreview(inlineBlock);

    const thumbnail = screen.getByRole('button', { name: 'Screenshot' });
    expect(thumbnail.querySelector('svg.lucide-maximize2, svg.lucide-maximize-2')).not.toBeNull();
    fireEvent.click(thumbnail);
    expect(screen.getByRole('img', { name: 'Screenshot (full)' })).toBeInTheDocument();
  });
});
