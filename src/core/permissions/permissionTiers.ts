/**
 * Labels for the unattended autonomy tiers.
 *
 * Abu grew four separate vocabularies for the same idea: chat says
 * standard/smart/autonomous, triggers said "read-only / safe / full",
 * IM channels said "Read Only (can view files) / Standard / Full Control",
 * and scheduled tasks had no words at all. Same three steps, four names —
 * so a user who learned one screen learned nothing about the next.
 *
 * This module is the single place those words come from for the *unattended*
 * scenarios (permission plan §4.2). It is wording only: `TriggerCapability`,
 * `IMCapabilityLevel` and `ScheduledTaskPermissionMode` keep their existing
 * values and their existing judgement code untouched — the plan explicitly
 * does not consolidate the decision layers (§8).
 *
 * Chat is not included on purpose: its three modes stay worded as they are
 * (§8, "do not touch the chat window's existing wording").
 */

import { getI18n } from '../../i18n';
import type { TriggerCapability } from '../../types/trigger';
import type { IMCapabilityLevel } from '../../types/imChannel';

/**
 * Every tier value used by an unattended scenario. This is a union of the
 * existing types, not a new enum — `read_tools`/`safe_tools`/`full` are the
 * shared three, `chat_only` is IM-only and `custom` is trigger-only.
 */
export type UnattendedCapability = TriggerCapability | IMCapabilityLevel;

export function getCapabilityTierLabel(capability: UnattendedCapability): string {
  const t = getI18n().permissionTiers;
  switch (capability) {
    case 'chat_only': return t.chatOnly;
    case 'read_tools': return t.readTools;
    case 'safe_tools': return t.safeTools;
    case 'full': return t.full;
    case 'custom': return t.custom;
  }
}

export function getCapabilityTierDescription(capability: UnattendedCapability): string {
  const t = getI18n().permissionTiers;
  switch (capability) {
    case 'chat_only': return t.chatOnlyDesc;
    case 'read_tools': return t.readToolsDesc;
    case 'safe_tools': return t.safeToolsDesc;
    case 'full': return t.fullDesc;
    case 'custom': return t.customDesc;
  }
}
