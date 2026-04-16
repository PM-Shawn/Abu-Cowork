import type {
  ConversationRepo,
  ConversationListFilter,
  CheckpointInfo,
} from '../ports/repos/conversation';
import type { Conversation, Message } from '../../../../src/types';

function genId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class MemoryConversationRepo implements ConversationRepo {
  private convs = new Map<string, Conversation>();
  private blobs = new Map<string, Uint8Array>();
  private checkpoints = new Map<string, { info: CheckpointInfo; snapshot: Conversation }>();

  async get(id: string) {
    return this.convs.get(id) ?? null;
  }

  async list(filter?: ConversationListFilter) {
    let arr = [...this.convs.values()];
    if (filter?.status) arr = arr.filter((c) => c.status === filter.status);
    if (filter?.projectId) arr = arr.filter((c) => c.projectId === filter.projectId);
    if (filter?.imChannelId) arr = arr.filter((c) => c.imChannelId === filter.imChannelId);
    if (filter?.triggerId) arr = arr.filter((c) => c.triggerId === filter.triggerId);
    arr.sort((a, b) => b.updatedAt - a.updatedAt);
    if (filter?.limit) arr = arr.slice(0, filter.limit);
    return arr;
  }

  async create(conv: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt'>) {
    const now = Date.now();
    const full: Conversation = { ...conv, id: genId('conv'), createdAt: now, updatedAt: now };
    this.convs.set(full.id, full);
    return full;
  }

  async update(id: string, patch: Partial<Conversation>) {
    const cur = this.convs.get(id);
    if (!cur) throw new Error(`Conversation not found: ${id}`);
    this.convs.set(id, { ...cur, ...patch, id, updatedAt: Date.now() });
  }

  async delete(id: string) {
    this.convs.delete(id);
  }

  async appendMessage(convId: string, msg: Message) {
    const c = this.convs.get(convId);
    if (!c) throw new Error(`Conversation not found: ${convId}`);
    c.messages.push(msg);
    c.updatedAt = Date.now();
  }

  async updateMessage(convId: string, msgId: string, patch: Partial<Message>) {
    const c = this.convs.get(convId);
    if (!c) throw new Error(`Conversation not found: ${convId}`);
    const idx = c.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) throw new Error(`Message not found: ${msgId}`);
    c.messages[idx] = { ...c.messages[idx], ...patch, id: msgId };
    c.updatedAt = Date.now();
  }

  async deleteMessage(convId: string, msgId: string) {
    const c = this.convs.get(convId);
    if (!c) return;
    c.messages = c.messages.filter((m) => m.id !== msgId);
    c.updatedAt = Date.now();
  }

  async saveBlob(_convId: string, _msgId: string, blob: Uint8Array) {
    const ref = genId('blob');
    this.blobs.set(ref, new Uint8Array(blob));
    return ref;
  }

  async loadBlob(ref: string) {
    const b = this.blobs.get(ref);
    if (!b) throw new Error(`Blob not found: ${ref}`);
    return b;
  }

  async saveCheckpoint(convId: string, snapshot: Conversation, label?: string) {
    const id = genId('ckpt');
    this.checkpoints.set(id, {
      info: { id, conversationId: convId, createdAt: Date.now(), label },
      snapshot: JSON.parse(JSON.stringify(snapshot)),
    });
    return id;
  }

  async loadCheckpoint(checkpointId: string) {
    const entry = this.checkpoints.get(checkpointId);
    if (!entry) throw new Error(`Checkpoint not found: ${checkpointId}`);
    return JSON.parse(JSON.stringify(entry.snapshot));
  }

  async listCheckpoints(convId: string) {
    return [...this.checkpoints.values()]
      .filter((e) => e.info.conversationId === convId)
      .map((e) => e.info)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteCheckpoint(checkpointId: string) {
    this.checkpoints.delete(checkpointId);
  }
}
