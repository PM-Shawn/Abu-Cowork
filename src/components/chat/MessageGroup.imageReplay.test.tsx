// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import type { Conversation, Message, ToolResultContent } from '@/types';
import type { ExecutionStepSnapshot } from '@/types/execution';
import MessageGroup from './MessageGroup';

/**
 * History-replay regression guard for tool-result images.
 *
 * The escape this pins: an execution's live DetailBlock carries the image
 * base64 in `imageData`, but the persisted `ExecutionStepSnapshot` does not.
 * Once the loop ends and `evictExecution` drops the live data, MessageGroup
 * re-renders the group from the snapshot — and every core-layer test still
 * passed while the UI silently degraded to the placeholder line
 * "Image: /tmp/line_chart.png (37KB, image/png)".
 *
 * So these tests assert on the rendered DOM of a *settled* group (no live
 * execution), walking the same two clicks a user makes when reopening a
 * finished task: expand the task block, then expand the image detail block.
 */

/** Smallest valid PNG — keeps the fixture deterministic and tiny. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PLACEHOLDER = 'Image: /tmp/line_chart.png (37KB, image/png)';
const LOOP_ID = 'loop-image-replay';
const TOOL_CALL_ID = 'toolu_image';

const IMAGE_RESULT_CONTENT: ToolResultContent[] = [
  { type: 'text', text: PLACEHOLDER },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } },
];

function imageSnapshot(toolCallId?: string): ExecutionStepSnapshot[] {
  return [
    {
      id: 'step-1',
      toolCallId,
      type: 'file-read',
      label: 'Read line_chart.png',
      status: 'completed',
      toolName: 'read_file',
      duration: 2,
      // Exactly what snapshotExecutionSteps persists: no imageData.
      detailBlocks: [
        { id: 'step-1-image', title: 'Image', type: 'image', content: PLACEHOLDER },
      ],
    },
  ];
}

/**
 * A finished group in its on-disk shape: the tool call (with resultContent)
 * rides an earlier assistant message, the execution snapshot rides the last
 * one. Kept text-free so the group has no trailing answer segment — the
 * work-process fold is a separate concern and would just add a third click.
 */
function buildMessages(options: {
  snapshotToolCallId?: string;
  resultContent?: ToolResultContent[];
}): Message[] {
  const userMessage: Message = {
    id: 'user-1',
    role: 'user',
    content: 'read /tmp/line_chart.png',
    timestamp: 1_000,
    loopId: LOOP_ID,
    runState: 'completed',
    runEndedAt: 3_000,
  };
  const toolCallMessage: Message = {
    id: 'assistant-tools',
    role: 'assistant',
    content: '',
    timestamp: 1_500,
    loopId: LOOP_ID,
    toolCalls: [
      {
        id: TOOL_CALL_ID,
        name: 'read_file',
        input: { path: '/tmp/line_chart.png' },
        result: PLACEHOLDER,
        resultContent: options.resultContent,
      },
    ],
  };
  const snapshotMessage: Message = {
    id: 'assistant-final',
    role: 'assistant',
    content: '',
    timestamp: 2_000,
    loopId: LOOP_ID,
    executionSteps: imageSnapshot(options.snapshotToolCallId),
  };
  return [userMessage, toolCallMessage, snapshotMessage];
}

function renderReplayedGroup(messages: Message[]) {
  const conversation: Conversation = {
    id: 'conversation-image-replay',
    title: 'Chart task',
    messages,
    createdAt: 1_000,
    updatedAt: 3_000,
    status: 'idle',
  };
  useChatStore.setState({
    activeConversationId: conversation.id,
    conversations: { [conversation.id]: conversation },
    agentStatus: 'idle',
  });
  return render(<MessageGroup conversationId="conv-image-replay" messages={messages} isLastGroup />);
}

/**
 * Expand the settled task block, then the image detail block — the two clicks
 * a user makes when reopening a finished task. A settled TaskBlock mounts
 * collapsed (its timeline is not rendered at all), and a restored detail block
 * comes back with `isExpanded: false`, so neither content is in the DOM until
 * these fire. The collapsed header shows the derived summary ("Read file"),
 * not the persisted step label.
 */
function openImageBlock() {
  fireEvent.click(screen.getByText('Read file').closest('button')!);
  fireEvent.click(screen.getByRole('button', { name: /Image/ }));
}

describe('MessageGroup — finished-task image replay', () => {
  beforeEach(() => {
    initLanguage('en-US');
    // No live execution: this is the post-eviction state the bug lived in.
    useTaskExecutionStore.setState({
      executions: {},
      activeExecutionId: null,
      loopIdIndex: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a real <img> from the tool call resultContent when the snapshot has a toolCallId', () => {
    const { container } = renderReplayedGroup(
      buildMessages({ snapshotToolCallId: TOOL_CALL_ID, resultContent: IMAGE_RESULT_CONTENT }),
    );

    openImageBlock();

    const img = container.querySelector('img[src^="data:"]');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(`data:image/png;base64,${PNG_1X1}`);
    expect(img!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('backfills legacy snapshots that predate toolCallId via exact placeholder-text match', () => {
    const { container } = renderReplayedGroup(
      buildMessages({ snapshotToolCallId: undefined, resultContent: IMAGE_RESULT_CONTENT }),
    );

    openImageBlock();

    const img = container.querySelector('img[src^="data:"]');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(`data:image/png;base64,${PNG_1X1}`);
  });

  it('degrades to the placeholder text without crashing when resultContent has no image block', () => {
    const { container } = renderReplayedGroup(
      buildMessages({
        snapshotToolCallId: TOOL_CALL_ID,
        resultContent: [{ type: 'text', text: PLACEHOLDER }],
      }),
    );

    openImageBlock();

    expect(container.querySelector('img[src^="data:"]')).toBeNull();
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
  });

  it('degrades to the placeholder text when the tool call carries no resultContent at all', () => {
    const { container } = renderReplayedGroup(
      buildMessages({ snapshotToolCallId: TOOL_CALL_ID, resultContent: undefined }),
    );

    openImageBlock();

    expect(container.querySelector('img[src^="data:"]')).toBeNull();
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
  });
});

describe('MessageGroup — finished-task SUBAGENT image replay', () => {
  const SUB_TOOL_CALL_ID = 'toolu_subagent_shot';

  /**
   * The on-disk shape a delegate run leaves behind: the parent message's
   * toolCalls carry the delegate call itself PLUS the hidden `fromSubagent`
   * entry recorded by completeChildStep for the subagent's screenshot; the
   * snapshot's delegate step nests a child step whose image block (like every
   * persisted block) lost its imageData.
   */
  function buildDelegateMessages(options: { recordSubagentToolCall: boolean }): Message[] {
    const userMessage: Message = {
      id: 'user-1',
      role: 'user',
      content: 'have the researcher screenshot the page',
      timestamp: 1_000,
      loopId: LOOP_ID,
      runState: 'completed',
      runEndedAt: 3_000,
    };
    const toolCallMessage: Message = {
      id: 'assistant-tools',
      role: 'assistant',
      content: '',
      timestamp: 1_500,
      loopId: LOOP_ID,
      toolCalls: [
        {
          id: 'toolu_delegate',
          name: 'delegate_to_agent',
          input: { agent_name: 'researcher', task: 'screenshot the page' },
          result: 'done',
        },
        ...(options.recordSubagentToolCall
          ? [{
              id: SUB_TOOL_CALL_ID,
              name: 'computer',
              input: { action: 'screenshot' },
              result: PLACEHOLDER,
              resultContent: IMAGE_RESULT_CONTENT,
              hidden: true,
              fromSubagent: true,
            }]
          : []),
      ],
    };
    const snapshotMessage: Message = {
      id: 'assistant-final',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: LOOP_ID,
      executionSteps: [
        {
          id: 'step-delegate',
          toolCallId: 'toolu_delegate',
          type: 'delegate',
          label: 'Delegate to researcher',
          status: 'completed',
          toolName: 'delegate_to_agent',
          duration: 5,
          childSteps: [
            {
              id: 'child-1',
              toolCallId: SUB_TOOL_CALL_ID,
              type: 'tool',
              label: 'Screenshot',
              status: 'completed',
              toolName: 'computer',
              detailBlocks: [
                { id: 'child-1-image', title: 'Image', type: 'image', content: PLACEHOLDER },
              ],
            },
          ],
        },
      ],
    };
    return [userMessage, toolCallMessage, snapshotMessage];
  }

  beforeEach(() => {
    initLanguage('en-US');
    useTaskExecutionStore.setState({
      executions: {},
      activeExecutionId: null,
      loopIdIndex: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a real <img> for a child step from the recorded fromSubagent tool call', () => {
    const { container } = renderReplayedGroup(buildDelegateMessages({ recordSubagentToolCall: true }));

    fireEvent.click(screen.getByText('Called tool').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: /Image/ }));

    const img = container.querySelector('img[src^="data:"]');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(`data:image/png;base64,${PNG_1X1}`);
  });

  it('does not render the hidden fromSubagent tool call as a visible chat tool chip', () => {
    renderReplayedGroup(buildDelegateMessages({ recordSubagentToolCall: true }));
    // The subagent's raw computer call must stay out of the generic tool-call
    // list — it exists solely as the image payload's persistence home.
    expect(screen.queryByText('computer')).toBeNull();
  });

  it('degrades to the placeholder text when no fromSubagent entry was recorded', () => {
    const { container } = renderReplayedGroup(buildDelegateMessages({ recordSubagentToolCall: false }));

    fireEvent.click(screen.getByText('Called tool').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: /Image/ }));

    expect(container.querySelector('img[src^="data:"]')).toBeNull();
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
  });
});
