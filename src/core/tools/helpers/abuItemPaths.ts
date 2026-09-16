import { exists } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath } from '../../../utils/pathUtils';
import { AGENT_NAME_RE } from '../../../utils/validation';

/**
 * Where `save_agent` (and the unregistered `save_skill`) write an item:
 * `~/.abu/<folder>/<name>/<manifest>`. One definition, shared by the tool that
 * writes there and the approval that describes the write, so the two can never
 * talk about different files. Rooted at `homeDir()`, like the agent registry's
 * own scan of `~/.abu/agents`.
 */
export async function abuItemPaths(
  folder: 'agents' | 'skills',
  name: string,
  manifest: 'AGENT.md' | 'SKILL.md',
): Promise<{ itemsDir: string; itemDir: string; filePath: string }> {
  const itemsDir = joinPath(await homeDir(), '.abu', folder);
  const itemDir = joinPath(itemsDir, name);
  return { itemsDir, itemDir, filePath: joinPath(itemDir, manifest) };
}

/**
 * Would a `save_agent` call with this `name` replace an AGENT.md that is
 * already on disk? Read from the disk, never from the model's `overwrite`
 * flag — the approval showing this is the one check on the model's claim that
 * the user asked to change that expert.
 *
 * A name the tool refuses before writing anything answers false. When the disk
 * cannot be asked, the answer is true: warning about a replace that does not
 * happen costs a second look, calling a replace "new" costs the user's expert.
 */
export async function saveAgentWouldReplace(rawName: unknown): Promise<boolean> {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!AGENT_NAME_RE.test(name)) return false;
  try {
    return await exists((await abuItemPaths('agents', name, 'AGENT.md')).filePath);
  } catch {
    return true;
  }
}
