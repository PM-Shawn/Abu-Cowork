interface ConversationOwnedOverlay {
  conversationId: string;
}

/**
 * Native browser views paint above the renderer, so any blocking approval
 * rendered for the active conversation must temporarily hide the view.
 */
export function hasVisibleBlockingApproval(
  activeConversationId: string | null,
  approvals: readonly (ConversationOwnedOverlay | null)[],
  globalBlockingOverlay = false,
): boolean {
  if (globalBlockingOverlay) return true;
  if (!activeConversationId) return false;
  return approvals.some(
    (approval) => approval?.conversationId === activeConversationId,
  );
}
