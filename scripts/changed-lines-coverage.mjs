#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CHANGED_LINES_THRESHOLD = 80;
export const EXEMPTION_LABEL = 'gate:changed-lines-exempt';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, '..');

export class GateInputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'GateInputError';
    this.exitCode = 2;
  }
}

function assertText(value, label) {
  if (typeof value !== 'string') {
    throw new GateInputError(`${label} must be text`);
  }
  return value;
}

function normalizeRepoPath(sourcePath, repoRoot) {
  const raw = assertText(sourcePath, 'LCOV source path');
  if (!raw || /[\0\r\n]/.test(raw)) {
    throw new GateInputError('LCOV contains an invalid source path');
  }

  const normalizedRoot = path.resolve(repoRoot).split(path.sep).join('/');
  const normalizedSource = raw.split('\\').join('/');
  const relative = path.posix.isAbsolute(normalizedSource)
    ? path.posix.relative(normalizedRoot, path.posix.normalize(normalizedSource))
    : path.posix.normalize(normalizedSource.replace(/^\.\//, ''));

  if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new GateInputError(`LCOV source path is outside the repository: ${raw}`);
  }
  return relative;
}

/** Parse LCOV DA records into repo-relative file and line maps. */
export function parseLcov(lcovText, { repoRoot = defaultRepoRoot } = {}) {
  const text = assertText(lcovText, 'LCOV input');
  if (!text.trim()) {
    throw new GateInputError('LCOV input is empty');
  }

  const coverageByFile = new Map();
  let currentFile = null;
  let sourceRecords = 0;
  let dataRecords = 0;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.startsWith('SF:')) {
      currentFile = normalizeRepoPath(line.slice(3), repoRoot);
      sourceRecords += 1;
      if (!coverageByFile.has(currentFile)) {
        coverageByFile.set(currentFile, new Map());
      }
      continue;
    }

    if (line === 'end_of_record') {
      currentFile = null;
      continue;
    }

    if (!line.startsWith('DA:')) continue;
    if (!currentFile) {
      throw new GateInputError(`LCOV line ${index + 1} has DA data without an SF record`);
    }

    const match = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(line);
    if (!match) {
      throw new GateInputError(`LCOV line ${index + 1} has an invalid DA record`);
    }
    const lineNumber = Number(match[1]);
    const executionCount = Number(match[2]);
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(executionCount)) {
      throw new GateInputError(`LCOV line ${index + 1} has an out-of-range DA record`);
    }

    const lines = coverageByFile.get(currentFile);
    const previous = lines.get(lineNumber) ?? 0;
    lines.set(lineNumber, Math.max(previous, executionCount));
    dataRecords += 1;
  }

  if (sourceRecords === 0 || dataRecords === 0) {
    throw new GateInputError('LCOV input has no source line coverage records');
  }
  return coverageByFile;
}

/** Parse the added-side ranges from a zero-context unified diff for one file. */
export function parseAddedLineRanges(diffText) {
  const text = assertText(diffText, 'Git diff input');
  const addedLines = new Set();

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.startsWith('@@')) continue;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      throw new GateInputError(`Git diff line ${index + 1} has an invalid hunk header`);
    }

    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 0 || (count > 0 && start < 1)) {
      throw new GateInputError(`Git diff line ${index + 1} has an out-of-range hunk`);
    }
    for (let offset = 0; offset < count; offset += 1) {
      addedLines.add(start + offset);
    }
  }

  return addedLines;
}

/** Join changed line numbers to LCOV and calculate one aggregate PR percentage. */
export function calculateChangedLinesCoverage(
  changedLinesByFile,
  coverageByFile,
  threshold = CHANGED_LINES_THRESHOLD,
) {
  const files = [];
  let testable = 0;
  let covered = 0;

  for (const file of [...changedLinesByFile.keys()].sort()) {
    const lcovLines = coverageByFile.get(file);
    const changedLines = [...changedLinesByFile.get(file)].sort((a, b) => a - b);
    const testableLines = lcovLines
      ? changedLines.filter((lineNumber) => lcovLines.has(lineNumber))
      : [];
    const uncoveredLines = testableLines.filter((lineNumber) => (lcovLines.get(lineNumber) ?? 0) === 0);
    const coveredCount = testableLines.length - uncoveredLines.length;

    files.push({
      file,
      testable: testableLines.length,
      covered: coveredCount,
      uncoveredLines,
    });
    testable += testableLines.length;
    covered += coveredCount;
  }

  const percentage = testable === 0 ? null : (covered / testable) * 100;
  return {
    files,
    testable,
    covered,
    percentage,
    threshold,
    passed: percentage === null || percentage >= threshold,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function extractExemptionReason(body) {
  if (body === null || body === undefined) return null;
  if (typeof body !== 'string') {
    throw new GateInputError('Pull request body must be text or null');
  }

  // GitHub hides HTML comments, so no text inside them may satisfy a visible
  // approval requirement. Treat an unclosed comment as extending to EOF.
  const visibleBody = body.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const lines = visibleBody.split(/\r?\n/);
  const gateHeading = lines.findIndex((line) => /^##(?!#)[ \t]+门禁[ \t]*$/.test(line));
  if (gateHeading === -1) return null;

  for (let index = gateHeading + 1; index < lines.length; index += 1) {
    if (/^#{1,2}(?!#)(?:[ \t]+|$)/.test(lines[index])) break;
    const match = /^[ \t]*(?:[-*][ \t]+)?豁免理由：[ \t]*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const reason = match[1].trim();
    return reason || null;
  }
  return null;
}

/** Parse the Actions event payload without trusting its field shapes. */
export function parsePullRequestExemption(eventText) {
  const text = assertText(eventText, 'GitHub event payload');
  let event;
  try {
    event = JSON.parse(text);
  } catch (error) {
    throw new GateInputError('GitHub event payload is not valid JSON', { cause: error });
  }
  if (!isRecord(event)) {
    throw new GateInputError('GitHub event payload must be an object');
  }
  if (!isRecord(event.pull_request)) return null;

  const labels = event.pull_request.labels;
  if (!Array.isArray(labels)) {
    throw new GateInputError('Pull request labels must be an array');
  }
  const hasExemptionLabel = labels.some((label) => {
    if (!isRecord(label) || typeof label.name !== 'string') {
      throw new GateInputError('Pull request labels contain an invalid entry');
    }
    return label.name === EXEMPTION_LABEL;
  });
  if (!hasExemptionLabel) return null;

  return extractExemptionReason(event.pull_request.body);
}

function escapeMarkdown(value) {
  const flattened = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
  return flattened
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;')
    .replace(/([\\`*_{}\[\]|])/g, '\\$1');
}

export function renderCoverageSummary(report, exemptionReason = null) {
  const lines = [];
  if (exemptionReason) {
    lines.push(
      '> [!WARNING]',
      `> **Changed-lines coverage gate exempted:** ${escapeMarkdown(exemptionReason)}`,
      '',
    );
  }

  lines.push('### Changed-lines coverage', '');
  if (report.testable === 0) {
    lines.push('**Result: pass — no testable added lines.**', '');
  } else {
    const percentage = report.percentage.toFixed(2);
    const effectivePass = report.passed || Boolean(exemptionReason);
    lines.push(
      `**Result: ${effectivePass ? 'pass' : 'fail'} — ${percentage}% (${report.covered}/${report.testable}), threshold ${report.threshold}%.**`,
      '',
    );
  }

  lines.push(
    '| File | Testable added lines | Covered | Uncovered line numbers |',
    '|---|---:|---:|---|',
  );
  for (const file of report.files) {
    lines.push(
      `| ${escapeMarkdown(file.file)} | ${file.testable} | ${file.covered} | ${file.uncoveredLines.length > 0 ? file.uncoveredLines.join(', ') : '—'} |`,
    );
  }
  lines.push(
    `| **Total** | **${report.testable}** | **${report.covered}** | |`,
    '',
  );
  return lines.join('\n');
}

function compactDiagnostic(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function runGit(args, { repoRoot, spawn = spawnSync }) {
  const result = spawn('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    const detail = compactDiagnostic(result.error?.message || result.stderr);
    throw new GateInputError(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function resolveBase(base, options) {
  const resolved = runGit(
    ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
    options,
  ).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(resolved)) {
    throw new GateInputError(`Git base did not resolve to a commit: ${compactDiagnostic(base)}`);
  }
  return resolved;
}

export function collectChangedLines(base, options) {
  const resolvedBase = resolveBase(base, options);
  const range = `${resolvedBase}...HEAD`;
  const names = runGit(
    ['diff', '--name-only', '-z', '--diff-filter=AM', range, '--', '*.ts', '*.tsx'],
    options,
  );
  const files = [...new Set(names.split('\0').filter(Boolean))].sort();
  const changedLinesByFile = new Map();

  // Use NUL-delimited names plus one exact literal pathspec per file. This keeps
  // unusual PR filenames from masquerading as unified-diff file headers.
  for (const file of files) {
    const diff = runGit(
      [
        'diff',
        '--unified=0',
        '--inter-hunk-context=0',
        '--diff-filter=AM',
        '--no-ext-diff',
        '--no-color',
        range,
        '--',
        `:(literal)${file}`,
      ],
      options,
    );
    changedLinesByFile.set(file, parseAddedLineRanges(diff));
  }
  return changedLinesByFile;
}

function parseArgs(argv) {
  let base = 'origin/dev';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base') {
      const value = argv[index + 1];
      if (!value) throw new GateInputError('--base requires a Git revision');
      base = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--base=')) {
      base = argument.slice('--base='.length);
      if (!base) throw new GateInputError('--base requires a Git revision');
      continue;
    }
    throw new GateInputError(`Unknown argument: ${compactDiagnostic(argument)}`);
  }
  return { base };
}

export function readRequiredLcov(lcovPath, readFile = readFileSync) {
  try {
    return readFile(lcovPath, 'utf8');
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? ` (${error.code})` : '';
    throw new GateInputError(`Required LCOV file is unavailable: ${lcovPath}${code}`, { cause: error });
  }
}

function readExemption(env, readFile) {
  if (!env.GITHUB_EVENT_PATH) return null;
  let eventText;
  try {
    eventText = readFile(env.GITHUB_EVENT_PATH, 'utf8');
  } catch (error) {
    throw new GateInputError('GITHUB_EVENT_PATH could not be read', { cause: error });
  }
  return parsePullRequestExemption(eventText);
}

export function runCoverageGate({
  argv = process.argv.slice(2),
  env = process.env,
  repoRoot = defaultRepoRoot,
  readFile = readFileSync,
  appendFile = appendFileSync,
  spawn = spawnSync,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  try {
    const { base } = parseArgs(argv);
    const lcov = parseLcov(
      readRequiredLcov(path.join(repoRoot, 'coverage/lcov.info'), readFile),
      { repoRoot },
    );
    const changedLines = collectChangedLines(base, { repoRoot, spawn });
    const report = calculateChangedLinesCoverage(changedLines, lcov);
    const exemptionReason = readExemption(env, readFile);
    const summary = renderCoverageSummary(report, exemptionReason);

    stdout(summary);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    }
    return report.passed || Boolean(exemptionReason) ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`changed-lines-coverage: ${compactDiagnostic(message)}`);
    return error instanceof GateInputError ? error.exitCode : 2;
  }
}

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = runCoverageGate();
}
