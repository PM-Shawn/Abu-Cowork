/** Frozen identity for a local welcome; it never grants runtime authority. */
export interface ExpertIdentity {
  key: string;
  kind: 'agent' | 'team';
  name: string;
  avatar?: string;
  agentName?: string;
}

export interface ExpertContact {
  identity: ExpertIdentity;
  introduction?: string;
}

/** An unconfirmed receipt is recoverable from this conversation's ledger. */
export interface ExpertContactReceipt {
  conversationId: string;
  confirmed: boolean;
}
