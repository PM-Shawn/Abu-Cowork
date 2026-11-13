import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The scripts that ship inside the office skills (xlsx, docx, pptx, pdf, gongwen).
 * - The copy of office_env.py in each skill folder must stay identical: a skill is a self-contained folder
 *   (the loader lists its scripts by path, and a user who edits a built-in skill gets a copy of that folder only),
 *   so the helper is repeated rather than shared.
 * - The checks cover the skills that carry the new scripts (the ones with a scripts/office_env.py), so each
 *   skill's tests start to run in the change that brings that skill, and the four together once all are in.
 * - The Python tests run with the bundled runtime: OFFICE_SKILLS_PYTHON when set, else the runtime that
 *   `npm run setup:electron-dev` prepares (electron/.runtime/python-runtime, the folder the app itself uses
 *   in development). A checkout that has not prepared it has no such Python and the Python tests are
 *   skipped (see TESTING.md, "Office skill scripts"); the .github workflows do not install the runtime today,
 *   so run them locally with `npm run setup:electron-dev` first.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skills = path.join(repoRoot, 'builtin-skills');
const pythonTests = path.join(repoRoot, 'scripts', 'office-skills');
const read = (skill: string, file: string) => readFileSync(path.join(skills, skill, 'scripts', file));

const OFFICE_SKILLS = ['docx', 'xlsx', 'pptx', 'pdf', 'gongwen'];
const present = OFFICE_SKILLS.filter((skill) => existsSync(path.join(skills, skill, 'scripts', 'office_env.py')));

/** The Python test files that exist for the runtime and for the skills that are present. */
const pythonTestFiles = [
  'test_runtime_libs.py',
  ...present.flatMap((skill) => [`test_${skill}.py`, ...(skill === 'pdf' ? ['test_pdf_forms.py'] : [])]),
].filter((file) => existsSync(path.join(pythonTests, file)));

/** A Python that has every library the scripts import: the env variable, else the app's dev runtime. */
function findOfficeSkillsPython(): string | null {
  const candidates = [
    process.env.OFFICE_SKILLS_PYTHON,
    path.join(repoRoot, 'electron', '.runtime', 'python-runtime', 'bin', 'python3'),
    path.join(repoRoot, 'electron', '.runtime', 'python-runtime', 'python.exe'),
  ].filter((candidate): candidate is string => !!candidate && existsSync(candidate));
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-I', '-c', 'import pandas, matplotlib, openpyxl, docx, pptx, pypdfium2, xlrd, fontTools, lxml'], { encoding: 'utf8', timeout: 60_000 });
    if (probe.status === 0) return candidate;
  }
  return null;
}

describe('office skill scripts', () => {
  it('keeps office_env.py identical in every skill that carries it', () => {
    if (present.length === 0) return;
    const reference = read(present[0], 'office_env.py');
    for (const skill of present) {
      expect(read(skill, 'office_env.py').equals(reference), `${skill}/scripts/office_env.py`).toBe(true);
    }
  });

  it('shows no command for a tool the bundled runtime does not have', () => {
    for (const skill of present) {
      const text = readFileSync(path.join(skills, skill, 'SKILL.md'), 'utf8');
      expect(text, skill).not.toMatch(/^\s*(pip3? install|npm install|pandoc |pdftoppm |qpdf |tesseract |markitdown |soffice )/m);
      expect(text, skill).not.toMatch(/\bfrom pdf2image\b|require\('pptxgenjs'\)|from docx import \{|import fitz/);
    }
  });

  it('never tells the model to start soffice or look for an office engine, and quotes every script path', () => {
    for (const skill of present) {
      const text = readFileSync(path.join(skills, skill, 'SKILL.md'), 'utf8');
      expect(text, skill).not.toMatch(/soffice|--convert-to|Office Engine|install_office_engine/);
      expect(text, skill).not.toMatch(/python \$\{ABU_SKILL_DIR\}/);   // a folder with a space or a Chinese user name needs the quotes
    }
  });

  const python = findOfficeSkillsPython();
  const runnable = !!python;
  it.skipIf(!runnable).each(pythonTestFiles)('passes %s with the bundled libraries', (file) => {
    const result = spawnSync(python as string, [path.join(pythonTests, file)], {
      encoding: 'utf8',
      timeout: 240_000,
    });
    expect(`${result.stdout}${result.stderr}`).toMatch(/OK/);
    expect(result.status).toBe(0);
  }, 300_000);
});
