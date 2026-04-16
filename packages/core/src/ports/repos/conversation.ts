import type {
  Conversation,
  ConversationStatus,
  Message,
} from '../../../../../src/types';

export interface ConversationListFilter {
  status?: ConversationStatus;
  projectId?: string;
  imChannelId?: string;
  triggerId?: string;
  limit?: number;
  cursor?: string;
}

export interface CheckpointInfo {
  id: string;
  conversationId: string;
  createdAt: number;
  label?: string;
}

export interface ConversationRepo {
  get(id: string): Promise<Conversation | null>;
  list(filter?: ConversationListFilter): Promise<Conversation[]>;
  create(
    conv: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Conversation>;
  update(id: string, patch: Partial<Conversation>): Promise<void>;
  delete(id: string): Promise<void>;

  appendMessage(convId: string, msg: Message): Promise<void>;
  updateMessage(convId: string, msgId: string, patch: Partial<Message>): Promise<void>;
  deleteMessage(convId: string, msgId: string): Promise<void>;

  /** 大结果卸载到外部存储，返回一个引用 id；load 时凭引用取回 */
  saveBlob(convId: string, msgId: string, blob: Uint8Array): Promise<string>;
  loadBlob(ref: string): Promise<Uint8Array>;

  saveCheckpoint(convId: string, snapshot: Conversation, label?: string): Promise<string>;
  loadCheckpoint(checkpointId: string): Promise<Conversation>;
  listCheckpoints(convId: string): Promise<CheckpointInfo[]>;
  deleteCheckpoint(checkpointId: string): Promise<void>;
}
