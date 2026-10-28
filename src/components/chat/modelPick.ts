type ModelRef = { providerId: string; modelId: string };

export interface ModelPickDeps {
  selectModel(providerId: string, modelId: string): void;
  setConversationModel(convId: string, model: ModelRef, options: { durable: true }): void;
}

/**
 * Remember each explicit pick for new conversations and for the open conversation.
 * Other conversations retain their own saved selections.
 */
export function applyModelPick(
  pick: { activeConversationId: string | null | undefined } & ModelRef,
  deps: ModelPickDeps,
): void {
  const { activeConversationId, providerId, modelId } = pick;
  if (activeConversationId) {
    // The user's own choice: on disk before the write reports done, so a quit right after keeps it.
    deps.setConversationModel(activeConversationId, { providerId, modelId }, { durable: true });
  }
  deps.selectModel(providerId, modelId);
}
