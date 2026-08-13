import type { CapabilitySetupRequest } from './setupBridge';
import type { Message } from '@/types';

const STORAGE_KEY = 'abu:computer-use-permission-resume:v1';
export const COMPUTER_USE_RESUME_TTL_MS = 10 * 60 * 1000;

export interface ComputerUseResumeToken {
  version: 1;
  conversationId: string;
  taskSummaryHash: string;
  requirements: {
    screenRead: boolean;
    uiControl: boolean;
  };
  createdAt: number;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isToken(value: unknown): value is ComputerUseResumeToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const token = value as Partial<ComputerUseResumeToken>;
  return token.version === 1
    && typeof token.conversationId === 'string'
    && token.conversationId.length > 0
    && token.conversationId.length <= 256
    && typeof token.taskSummaryHash === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(token.taskSummaryHash)
    && Number.isFinite(token.createdAt)
    && typeof token.requirements?.screenRead === 'boolean'
    && typeof token.requirements.uiControl === 'boolean';
}

/** The cross-relaunch token correlates the existing conversation task without
 * duplicating raw user text into localStorage. */
export async function hashComputerUseTaskSummary(summary: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(summary.trim()),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => (
    byte.toString(16).padStart(2, '0')
  )).join('')}`;
}

export function latestUserTaskSummary(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    return message.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
  }
  return null;
}

export async function resumeTokenMatchesTask(
  token: ComputerUseResumeToken,
  messages: Message[],
): Promise<boolean> {
  const summary = latestUserTaskSummary(messages);
  return summary !== null
    && await hashComputerUseTaskSummary(summary) === token.taskSummaryHash;
}

export function routedComputerUseTaskSummary(message: Message): string {
  const body = typeof message.content === 'string'
    ? message.content.trim()
    : message.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
      .trim();
  if (message.delegateAgent) {
    return body ? `@${message.delegateAgent.name} ${body}` : `@${message.delegateAgent.name}`;
  }
  if (message.skill) {
    return body ? `/${message.skill.name} ${body}` : `/${message.skill.name}`;
  }
  return body;
}

export function saveComputerUseResumeToken(request: CapabilitySetupRequest): boolean {
  if (
    request.target !== 'computer'
    || !request.taskSummaryHash
    || !request.computerUseRequirements
  ) {
    return false;
  }
  const target = getStorage();
  if (!target) return false;
  const token: ComputerUseResumeToken = {
    version: 1,
    conversationId: request.conversationId,
    taskSummaryHash: request.taskSummaryHash,
    requirements: { ...request.computerUseRequirements },
    createdAt: Date.now(),
  };
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(token));
    return true;
  } catch {
    return false;
  }
}

/** One-shot read. Removal happens before validation so malformed or expired
 * state can never create a relaunch loop. */
export function consumeComputerUseResumeToken(
  now: number = Date.now(),
): ComputerUseResumeToken | null {
  const target = getStorage();
  if (!target) return null;
  const raw = target.getItem(STORAGE_KEY);
  target.removeItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const token: unknown = JSON.parse(raw);
    if (!isToken(token)) return null;
    if (token.createdAt > now || now - token.createdAt > COMPUTER_USE_RESUME_TTL_MS) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function clearComputerUseResumeToken(): void {
  getStorage()?.removeItem(STORAGE_KEY);
}
