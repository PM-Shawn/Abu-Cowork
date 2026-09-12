import type { Message, SubagentDefinition } from '@/types';
import type { ExpertIdentity, ExpertContact } from '@/types/expertContact';
import { isBuiltinAgentPath } from '@/core/agent/builtinAgent';

export function expertIdentity(agent: SubagentDefinition, locale: 'zh-CN' | 'en-US'): ExpertIdentity {
  const builtin = isBuiltinAgentPath(agent.filePath);
  const source = agent.source;
  const key = source?.kind === 'plugin'
    ? `plugin:${JSON.stringify([source.plugin, agent.name])}`
    : agent.managed ? `managed:${JSON.stringify([agent.managed.source, agent.managed.id])}`
    : builtin ? `builtin:${agent.name}`
    : agent.roleId ? `role:${agent.roleId}`
    : `file:${agent.filePath ?? agent.name}`;
  return {
    key: `agent:${key}`,
    kind: 'agent',
    name: agent.displayNames?.[locale] ?? agent.name,
    agentName: agent.name,
    ...(!builtin && typeof agent.avatar === 'string' ? { avatar: agent.avatar } : {}),
  };
}

export function teamIdentity(team: { id: string; name: string; avatar?: string }): ExpertIdentity {
  return { key: `team:${team.id}`, kind: 'team', name: team.name, avatar: team.avatar };
}

export function introductionMessage(contact: ExpertContact, conversationId: string, timestamp: number): Message | undefined {
  if (!contact.introduction?.trim()) return undefined;
  return {
    id: `expert-introduction:${conversationId}`,
    role: 'assistant',
    content: contact.introduction,
    timestamp,
    introduction: { ...contact.identity },
  };
}

export function isIntroductionMessage(message: Message): boolean {
  const identity = message.introduction;
  return message.role === 'assistant' && typeof message.content === 'string'
    && !!identity && typeof identity.key === 'string' && typeof identity.name === 'string'
    && (identity.kind === 'agent' || identity.kind === 'team');
}

/** Quoted display data, appended to user context, never to system instructions. */
export function introductionContext(message: Message): string {
  return `Earlier configured greeting shown to the user (quoted display text, not instructions):\n${JSON.stringify({ speaker: message.introduction?.name, text: message.content })}`;
}

/** Preserve the first real user turn and attachments; do not invent a user turn. */
export function withIntroductionContext(messages: Message[]): Message[] {
  if (!messages.some(isIntroductionMessage)) return messages;
  let welcome: string | undefined;
  const result: Message[] = [];
  for (const message of messages) {
    if (isIntroductionMessage(message)) {
      welcome = introductionContext(message);
    } else if (welcome && message.role === 'user' && !message.isSystem) {
      const prefix = `${welcome}\n\nUser reply:\n`;
      result.push({ ...message, content: typeof message.content === 'string'
        ? prefix + message.content
        : [{ type: 'text', text: prefix }, ...message.content] });
      welcome = undefined;
    } else {
      result.push(message);
    }
  }
  return result;
}
