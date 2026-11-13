/**
 * The one-line, plain-language purpose a model gives a `run_command` call
 * ("把合同第 18 页转成图片"), and the checks that decide whether it may be shown.
 *
 * The purpose is what a person who knows nothing about code reads in the step
 * list and in the approval window, so it is shown only when it reads like a
 * sentence: single line, bounded length, and not the command or a file path
 * pasted back. Anything else counts as missing and the caller falls back to a
 * generic label. The raw command always stays available behind the details.
 */

import { sanitizeUntrustedPromptField } from '@/utils/untrustedText';

/** Longest purpose shown, in characters (not UTF-16 units). */
export const MAX_PURPOSE_CHARS = 60;

/**
 * A file path or code fragment inside the text. Chinese prose has no spaces, so a path is often
 * glued to the verb ("保存到/tmp/out.pdf"): the tests look for the shape of a path, not for a
 * word boundary before it.
 */
const PATH_OR_CODE: RegExp[] = [
  /(^|[^A-Za-z])[A-Za-z]:[\\/]/, // C:\ or C:/ (a single drive letter, not the end of "https:")
  /\\/, // any backslash: Windows path, escape or UNC
  /%[A-Za-z_]+%/, // %TEMP%
  /(^|[^\w])~[\\/]/, // ~/Desktop
  /(^|[^\w.])\.{1,2}\/[^\s/]/, // ./out, ../a
  // an absolute path starts at a root: the "/" opens the text or follows a space, quote, bracket or colon.
  // A "/" inside a word list (合同/发票/收据) is prose and does not start a path.
  /(^|[\s"'`(（「：:,，])\/[^\s/<>]+(\/|\.\w{1,5}(\s|$|[^\w]))/,
  // glued to Chinese text ("保存到/tmp/a/b.pdf"): a Latin-letter folder followed by a deeper segment or an extension
  /[\u4e00-\u9fff]\/[A-Za-z][\w.-]*\/[^\s/]+(\/|\.\w{1,5}(\s|$|[^\w]))/,
  /\*\.\w+/, // *.py
  /[\w-]+\.(py|sh|js|ts|ps1|bat|cmd|rb|pl)\b/i, // a script file name
  /(^|\s)--?[A-Za-z][\w-]*(\s|$)/, // a command-line flag
  /(^|[\s'"])s\/[^/\s]*\/[^/\s]*\//, // sed substitution
];

/**
 * Shell syntax that has no place in a sentence for a person: operators, and a command word at the
 * start. Words that are only commands (rm, mkdir, sudo…) count on their own; words that are also
 * ordinary English or product names (find, zip, python…) count only when an argument that looks
 * like one follows (a flag, a path, a file name, a quote or a variable).
 */
const COMMAND_ONLY = '(?:sudo|cd|pip3?|npm|bash|sh|zsh|cat|ls|rm|rmdir|mv|cp|mkdir|chmod|sed|awk|grep|xargs|curl|wget|powershell|cmd)';
const COMMAND_OR_WORD = '(?:python3?|node|git|dir|del|find|tar|zip|unzip|echo)';
const ARGUMENT_LIKE = '(?:-|\\.{0,2}\\/|~|\\/|[A-Za-z]:|[\'"$*]|[\\w.-]+\\.\\w{1,5}(?:\\s|$))';
const SHELL_SYNTAX = new RegExp(
  `\`|\\$\\(|&&|\\|\\||<<|>>|\\s\\|\\s|^\\s*${COMMAND_ONLY}\\s|^\\s*${COMMAND_OR_WORD}\\s+${ARGUMENT_LIKE}`,
  'i',
);

/**
 * The purpose to show for a model-written value, or undefined when there is
 * none worth showing. `command` is the call's own command, to catch a model
 * that copied it into the field.
 */
export function cleanPurpose(raw: unknown, command?: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // Invisible and direction-changing characters become spaces, so a purpose made only of them is empty.
  const oneLine = sanitizeUntrustedPromptField(raw, Number.MAX_SAFE_INTEGER);
  if (oneLine === '') return undefined;
  if (command !== undefined && oneLine === command.replace(/\s+/g, ' ').trim()) return undefined;
  if (PATH_OR_CODE.some((re) => re.test(oneLine)) || SHELL_SYNTAX.test(oneLine)) return undefined;
  const chars = Array.from(oneLine);
  return chars.length > MAX_PURPOSE_CHARS ? chars.slice(0, MAX_PURPOSE_CHARS - 1).join('') + '…' : oneLine;
}

/** The purpose of a `run_command` input, ready to show, or undefined. */
export function commandPurpose(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : undefined;
  return cleanPurpose(input.purpose, command);
}
