import { format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';

/**
 * One line saying what a "this task" allowance covers, in the user's words.
 * `category` is teamApprovalScope.ts's `teamTaskRuleCategory` output.
 */
export function describeTaskRuleScope(category: string, member: string, t: TranslationDict['team']): string {
  const [kind, ...rest] = category.split(':');
  const value = rest.join(':');
  if (kind === 'command') {
    return value.startsWith('prefix:')
      ? format(t.confirmationScopeCommand, { member, prefix: value.slice('prefix:'.length) })
      : format(t.confirmationScopeExactCommand, { member });
  }
  if (kind === 'file') {
    const [caps, ...folder] = value.split(':');
    return format(caps.includes('write') ? t.confirmationScopeFileWrite : t.confirmationScopeFileRead,
      { member, folder: folder.join(':') });
  }
  const [resource, ...site] = value.split(':');
  const siteText = site.join(':');
  if (resource === 'script') return format(t.confirmationScopeScript, { member, site: siteText });
  if (resource === 'upload') return format(t.confirmationScopeUpload, { member, site: siteText });
  return format(t.confirmationScopeBrowse, { member, site: siteText });
}
