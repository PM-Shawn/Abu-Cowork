import { format, getI18n } from '@/i18n';
import { takeDeliveredInstructions, takeUnconfirmedInstructions } from './dispatchInput';

/** Called after dispatch cleanup, when no more user sends can join the hand-off. */
export function takeDispatchInstructionReport(dispatchKey: string | undefined, agentName: string): string {
  if (!dispatchKey) return '';
  const delivered = takeDeliveredInstructions(dispatchKey);
  const unconfirmed = takeUnconfirmedInstructions(dispatchKey);
  const t = getI18n().toolResult.agent;
  return [
    delivered.length ? format(t.delegateUserInstructionsNote, {
      agentName, n: delivered.length, list: delivered.map((text) => `- ${text}`).join('\n'),
    }) : '',
    unconfirmed.length ? format(t.delegateUnconfirmedInstructionsNote, {
      agentName, n: unconfirmed.length, list: unconfirmed.map((text) => `- ${text}`).join('\n'),
    }) : '',
  ].filter(Boolean).join('\n\n');
}
