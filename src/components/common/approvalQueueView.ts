interface ConversationOwned {
  conversationId: string;
}

export type VisibleApprovalKind = 'workspace' | 'command' | 'file';

// The chat view shows one approval at a time. A workspace request answers itself 60 seconds
// after it was asked, seen or not, so it goes first; command approvals and file grants wait
// without a time limit.
const ORDER: readonly VisibleApprovalKind[] = ['workspace', 'command', 'file'];

/**
 * Which pending approval the conversation in view shows: the first, in display order, that
 * belongs to it. The others stay in their queues, unanswered, until the one before them is.
 */
export function pickVisibleApproval(
  pending: {
    command: ConversationOwned | null;
    file: ConversationOwned | null;
    workspace: ConversationOwned | null;
  },
  activeConversationId: string | null,
): { kind: VisibleApprovalKind } | null {
  const kind = ORDER.find((candidate) => pending[candidate]?.conversationId === activeConversationId);
  return kind ? { kind } : null;
}
