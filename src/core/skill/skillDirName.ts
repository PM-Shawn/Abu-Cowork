/**
 * The one rule every skill installer applies to the name it read out of a
 * SKILL.md before turning that name into a directory.
 *
 * The rule itself, and why each part of it is there, lives in
 * `electron/shared/skillDirName.mjs`: the Node-side package scan behind the
 * marketplace check reads a package by the same rule the renderer installs it
 * by, so a package the check accepts is one that installs.
 */
export { isSafeSkillDirName } from '../../../electron/shared/skillDirName.mjs';
