type ModelRef = { providerId: string; modelId: string };

export interface ModelPickDeps {
  selectModel(providerId: string, modelId: string): void;
  touchRecentModel(providerId: string, modelId: string): void;
  setConversationModel(convId: string, model: ModelRef): void;
}

/**
 * Route a composer model pick (issue #545). Inside a conversation the pick is
 * scoped to that conversation only; the global activeModel is the default for
 * NEW conversations and changes only when picking on the new-task page.
 */
export function applyModelPick(
  pick: { activeConversationId: string | null | undefined } & ModelRef,
  deps: ModelPickDeps,
): void {
  const { activeConversationId, providerId, modelId } = pick;
  if (activeConversationId) {
    deps.setConversationModel(activeConversationId, { providerId, modelId });
    deps.touchRecentModel(providerId, modelId);
    return;
  }
  deps.selectModel(providerId, modelId);
}
