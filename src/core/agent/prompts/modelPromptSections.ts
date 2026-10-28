import type { PromptSection } from '@/core/llm/promptSections';
import type { ComputerUseModelTier } from '@/core/llm/modelCapabilities';
import { getCapabilityPrompt } from './capabilityPrompt';
import { resolvePromptVariant, type PromptVariantSource } from './variants';
import { SYSTEM_SETTINGS_TOOL_LINE } from './variants/default';
import { fullComputerUseGuidance, structuredComputerUseGuidance } from './computerUseGuidance';

export const DEFAULT_PERSONA = 'You are Abu (阿布), a professional and reliable desktop assistant. Reply in a friendly and concise manner.';

const PLANNING_EXAMPLES = `
### Execution Examples

Example 1 (skill match):
User says "help me convert this report to a Word document"
→ Check the available skills list, find that the docx skill's TRIGGER matches
→ use_skill({"skill_name": "docx", "context": "convert the report to a Word document"})

Example 2 (deterministic task):
User says "help me organize the invoices on my desktop"
→ report_plan({"steps": ["scan desktop files", "identify invoices", "create invoice folder", "move invoices"]})
→ Then execute

Example 3 (task requiring search):
User says "help me learn about use cases for OpenClaw"
→ First web_search("OpenClaw") to understand what it is
→ Then report_plan({"steps": ["search for more use cases", "categorize findings", "generate report"]})
→ Then continue executing
`;

export function modelPlanningPrompt(profile: PromptVariantSource | undefined, includeExamples: boolean, windows: boolean): string {
  return (resolvePromptVariant(profile).planning + (includeExamples ? PLANNING_EXAMPLES : '')).replace(
    SYSTEM_SETTINGS_TOOL_LINE,
    windows ? '- System settings → run_command (PowerShell)' : SYSTEM_SETTINGS_TOOL_LINE,
  );
}

/** Rebuild only model-dependent sections; rendered skill content remains intact. */
export function refreshModelPromptSections(
  sections: readonly PromptSection[],
  profile: PromptVariantSource,
  options: { supportsTools: boolean; computerUseTier: ComputerUseModelTier; windows: boolean; customIdentity: boolean },
): PromptSection[] {
  const variant = resolvePromptVariant(profile);
  const refreshed = sections.filter((section) => section.name !== 'family-notes').map((section) => {
    switch (section.name) {
      case 'persona': return { ...section, text: variant.persona ?? getCapabilityPrompt({ supportsTools: options.supportsTools }) };
      case 'identity': return options.customIdentity ? section : { ...section, text: '\n## Identity\n' + (variant.persona ?? DEFAULT_PERSONA) };
      case 'planning': return { ...section, text: modelPlanningPrompt(profile, true, options.windows) };
      case 'computer-use': return { ...section, text: options.computerUseTier === 'structured'
        ? structuredComputerUseGuidance(options.windows) : fullComputerUseGuidance(options.windows) };
      default: return section;
    }
  });
  if (variant.familyNotes) {
    const position = refreshed.reduce((last, section, index) => ['planning', 'identity', 'skill-content', 'persona'].includes(section.name) ? index : last, -1);
    refreshed.splice(position + 1, 0, { name: 'family-notes', text: '\n' + variant.familyNotes, cacheable: true });
  }
  return refreshed;
}
