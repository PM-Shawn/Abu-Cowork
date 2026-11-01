import { makeOwner, type Owner, type TabClaimStore } from './tabClaims.js';

/** Keep tab ownership until accepted browser work has actually completed. */
export function createClaimLifecycle(claims: TabClaimStore) {
  const deleted = new Set<string>();
  const requests = new Set<Owner>();
  const tabOperations = new Map<number, number>();
  const releases = new Map<string, { conversationId: string; runKey?: string }>();
  let disconnecting = false;

  function flush(): void {
    if (disconnecting && requests.size === 0 && tabOperations.size === 0) {
      claims.releaseAll();
      releases.clear();
      disconnecting = false;
      return;
    }
    for (const [key, scope] of releases) {
      // Sibling runs may explicitly use this run's tabs.
      if ([...requests].some(owner => owner.conversationId === scope.conversationId)) continue;
      if (claims.entries().some(({ tabId, owner }) =>
        owner.conversationId === scope.conversationId
        && (scope.runKey === undefined || owner.runKey === scope.runKey)
        && tabOperations.has(tabId))) continue;
      claims.releaseOwner(scope.conversationId, scope.runKey);
      releases.delete(key);
    }
  }

  function releaseOwner(conversationId: string, runKey?: string): void {
    const owner = makeOwner(conversationId, runKey);
    const scope = { conversationId: owner.conversationId, runKey };
    releases.set(JSON.stringify([scope.conversationId, runKey]), scope);
    flush();
  }

  return {
    beginRequest(owner: Owner): () => void {
      if (deleted.has(owner.conversationId)) throw new Error('Browser conversation was deleted');
      if (disconnecting) throw new Error('Previous browser connection still has active operations. Retry after they finish.');
      // The main run key is reused on the conversation's next turn.
      releases.delete(JSON.stringify([owner.conversationId, owner.runKey]));
      const entry = { ...owner };
      requests.add(entry);
      return () => {
        requests.delete(entry);
        flush();
      };
    },
    beginTabOperation(tabId: number): () => void {
      tabOperations.set(tabId, (tabOperations.get(tabId) ?? 0) + 1);
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        const remaining = (tabOperations.get(tabId) ?? 1) - 1;
        if (remaining === 0) tabOperations.delete(tabId);
        else tabOperations.set(tabId, remaining);
        flush();
      };
    },
    releaseOwner,
    deleteConversation(conversationId: string): void {
      const owner = makeOwner(conversationId);
      deleted.add(owner.conversationId);
      releaseOwner(owner.conversationId);
    },
    releaseAll(): void {
      disconnecting = true;
      flush();
    },
  };
}
