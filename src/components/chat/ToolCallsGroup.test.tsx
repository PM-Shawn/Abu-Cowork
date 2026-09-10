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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { ToolCall } from '@/types';
import ToolCallsGroup from './ToolCallsGroup';

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
});
