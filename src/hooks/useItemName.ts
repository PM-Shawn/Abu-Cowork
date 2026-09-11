import { useState } from 'react';
import { ITEM_NAME_RE, AGENT_NAME_RE, isItemNameTaken } from '@/utils/validation';

// Re-exported: the editors import it from here alongside the hook.
export { isItemNameTaken };

/**
 * Shared name validation logic for AgentEditor and SkillEditor.
 * Handles the "new vs rename vs unchanged" validation rules:
 * - New item or renamed: strict ITEM_NAME_RE check, and the name must not be
 *   one another item already uses (`takenNames`, see {@link isItemNameTaken})
 * - Unchanged name on existing item: always valid
 */
export function useItemName(
  existingName: string | null,
  options: { mode?: 'default' | 'agent'; takenNames?: Iterable<string> } = {},
) {
  const { mode = 'default', takenNames = [] } = options;
  const [name, setRawName] = useState(existingName ?? '');

  const setName = (value: string) => {
    // Agent names keep case and unicode (中文/QA); spaces still fold to '-'
    // because the composer mention parser cannot span whitespace.
    const collapsed = value.replace(/\s+/g, '-');
    setRawName(mode === 'agent' ? collapsed : collapsed.toLowerCase());
  };

  const trimmed = name.trim();
  const isNew = existingName === null;
  const nameChanged = !isNew && trimmed !== existingName;
  const re = mode === 'agent' ? AGENT_NAME_RE : ITEM_NAME_RE;
  const nameValid = trimmed.length > 0 && (
    (isNew || nameChanged) ? re.test(trimmed) : true
  );
  const nameTaken = (isNew || nameChanged) && isItemNameTaken(trimmed, existingName, takenNames);

  return { name, setName, nameValid, nameTaken, nameChanged } as const;
}
