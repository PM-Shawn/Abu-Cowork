import type {
  MessageContent,
  ImageAttachment,
  AgentStatus,
} from '../../../../src/types';
import type { StreamEvent } from './stream';

export interface SendMessageInput {
  conversationId: string;
  content: string | MessageContent[];
  attachments?: ImageAttachment[];
  /** @skill 提示，core 内按名字加载 */
  skillHints?: string[];
  /** @agent 委派，为空走默认 agent */
  delegateAgent?: string;
}

export interface IAgent {
  send(input: SendMessageInput): AsyncIterable<StreamEvent>;
  abort(conversationId: string): Promise<void>;
  getStatus(conversationId: string): AgentStatus;
}
