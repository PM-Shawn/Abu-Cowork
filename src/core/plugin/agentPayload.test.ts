import { describe, it, expect, vi, beforeEach } from 'vitest';
import { remove, lstat } from '@tauri-apps/plugin-fs';

// plugin-fs is mocked globally (src/test/setup.ts) exactly as
// `src/core/agent/installer.test.ts` drives it: the fs surface is a fake and
// each test states what `lstat` reports about the agent directory.
import {
  AGENT_FRONTMATTER_ALLOWLIST,
  convertSingleFileAgent,
  renderAgentMd,
  removeContributedAgent,
} from './agentPayload';
import { parseAgentFile } from '@/core/agent/registry';

const mockRemove = vi.mocked(remove);
const mockLstat = vi.mocked(lstat);

/** homeDir() is globally mocked to '/Users/testuser' (src/test/setup.ts). */
const AGENTS_ROOT = '/Users/testuser/.abu/agents';

beforeEach(() => {
  vi.clearAllMocks();
  mockRemove.mockResolvedValue(undefined as never);
  mockLstat.mockResolvedValue({ isSymlink: false, isFile: false, isDirectory: true } as never);
});

describe('AGENT_FRONTMATTER_ALLOWLIST', () => {
  it('is exactly the key set parseAgentFile reads', () => {
    expect([...AGENT_FRONTMATTER_ALLOWLIST].sort()).toEqual(
      [
        'avatar',
        'background',
        'category',
        'description',
        'disallowed-tools',
        'expertise',
        'intro',
        'max-turns',
        'memory',
        'model',
        'name',
        'sample-prompts',
        'skills',
        'source',
        'tags',
        'tools',
      ].sort(),
    );
  });
});

describe('convertSingleFileAgent', () => {
  it('drops keys outside the allowlist (CC-only color / permissionMode)', () => {
    const raw = [
      '---',
      'name: reviewer',
      'description: reviews code',
      'color: purple',
      'permissionMode: acceptEdits',
      'model: sonnet',
      '---',
      '',
      'You review code.',
    ].join('\n');

    const converted = convertSingleFileAgent(raw, 'fallback');

    expect(converted.frontmatter.color).toBeUndefined();
    expect(converted.frontmatter.permissionMode).toBeUndefined();
    expect(converted.frontmatter.model).toBe('sonnet');
    expect(converted.name).toBe('reviewer');
    expect(converted.description).toBe('reviews code');
  });

  it('turns a comma-separated tools string into a trimmed, de-duplicated array', () => {
    const raw = '---\nname: a\ntools: Read, Grep , Read, ,Bash\n---\n\nbody';
    expect(convertSingleFileAgent(raw, 'fallback').frontmatter.tools).toEqual(['Read', 'Grep', 'Bash']);
  });

  it('keeps an array-shaped tools list, trimmed and de-duplicated', () => {
    const raw = '---\nname: a\ntools:\n  - Read\n  - " Grep "\n  - Read\n  - ""\n---\n\nbody';
    expect(convertSingleFileAgent(raw, 'fallback').frontmatter.tools).toEqual(['Read', 'Grep']);
  });

  it('normalises disallowed-tools, skills and tags the same way', () => {
    const raw = [
      '---',
      'name: a',
      'disallowed-tools: Bash , Bash',
      'skills: pdf, docx',
      'tags:',
      '  - one',
      '  - one',
      '---',
      '',
      'body',
    ].join('\n');

    const fm = convertSingleFileAgent(raw, 'fallback').frontmatter;
    expect(fm['disallowed-tools']).toEqual(['Bash']);
    expect(fm.skills).toEqual(['pdf', 'docx']);
    expect(fm.tags).toEqual(['one']);
  });

  it('drops memory whether or not the package declared one', () => {
    const declared = convertSingleFileAgent('---\nname: a\nmemory: user\n---\n\nbody', 'fallback');
    expect(declared.frontmatter.memory).toBeUndefined();
    expect('memory' in declared.frontmatter).toBe(false);

    const absent = convertSingleFileAgent('---\nname: a\n---\n\nbody', 'fallback');
    expect(absent.frontmatter.memory).toBeUndefined();
  });

  it('emits no memory key for a package that declared memory: user', () => {
    const converted = convertSingleFileAgent('---\nname: a\nmemory: user\n---\n\nbody', 'fallback');
    const rendered = renderAgentMd(converted);
    expect(rendered).not.toContain('memory:');
    // The written file reads exactly like an agent whose author never declared
    // one, so the parser applies its own default rather than a plugin's claim.
    expect(parseAgentFile(rendered, '/Users/testuser/.abu/agents/a/AGENT.md')?.memory).toBe('session');
  });

  it('falls back to the file name when name is missing, blank or not a string', () => {
    expect(convertSingleFileAgent('---\ndescription: d\n---\n\nbody', 'from-file').name).toBe('from-file');
    expect(convertSingleFileAgent('---\nname: "   "\n---\n\nbody', 'from-file').name).toBe('from-file');
    expect(convertSingleFileAgent('---\nname: 42\n---\n\nbody', 'from-file').name).toBe('from-file');
  });

  it('falls back to an empty description', () => {
    expect(convertSingleFileAgent('---\nname: a\n---\n\nbody', 'fallback').description).toBe('');
    expect(convertSingleFileAgent('---\nname: a\ndescription: 42\n---\n\nbody', 'fallback').description).toBe('');
  });

  it('keeps the body verbatim, including a standalone --- rule inside it', () => {
    // Shape taken from the Vercel plugin's agents/deployment-expert.md, whose
    // prose uses --- as a horizontal rule several times.
    const body = [
      'You are a Vercel deployment specialist.',
      '',
      '---',
      '',
      '## Deployment Failure Diagnostic Tree',
      '',
      'text after the rule',
    ].join('\n');
    const raw = `---\nname: deployment-expert\ndescription: deploys\n---\n\n${body}\n`;

    const converted = convertSingleFileAgent(raw, 'fallback');

    expect(converted.body).toBe(`\n${body}\n`);
    expect(converted.body).toContain('\n---\n');
    expect(converted.body).toContain('text after the rule');
  });

  it('accepts a file with no frontmatter at all', () => {
    const raw = 'Just a system prompt.\n\nNo frontmatter here.';
    const converted = convertSingleFileAgent(raw, 'from-file');
    expect(converted.name).toBe('from-file');
    expect(converted.description).toBe('');
    expect(converted.body).toBe(raw);
    expect(converted.frontmatter.memory).toBeUndefined();
  });

  it('treats unparseable frontmatter as none, keeping the body after the fence', () => {
    const raw = '---\nname: [unclosed\n---\n\nbody text';
    const converted = convertSingleFileAgent(raw, 'from-file');
    expect(converted.name).toBe('from-file');
    expect(converted.body).toBe('\nbody text');
  });
});

describe('renderAgentMd', () => {
  it('round-trips through parseAgentFile with the same fields', () => {
    const raw = [
      '---',
      'name: reviewer',
      'description: reviews code',
      'tools: Read, Grep',
      'memory: user',
      'color: purple',
      '---',
      '',
      'You review code.',
      '',
      '---',
      '',
      'Rules follow.',
    ].join('\n');

    const converted = convertSingleFileAgent(raw, 'fallback');
    const rendered = renderAgentMd(converted);
    const parsed = parseAgentFile(rendered, '/Users/testuser/.abu/agents/reviewer/AGENT.md');

    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('reviewer');
    expect(parsed?.description).toBe('reviews code');
    expect(parsed?.tools).toEqual(['Read', 'Grep']);
    // Dropped on conversion, so the parser's own default for an absent key.
    expect(parsed?.memory).toBe('session');
    expect(rendered).not.toContain('memory:');
    expect(parsed?.systemPrompt).toContain('You review code.');
    expect(parsed?.systemPrompt).toContain('Rules follow.');
  });

  it('emits no key for a field the package did not declare', () => {
    const converted = convertSingleFileAgent('---\nname: a\n---\n\nbody', 'fallback');
    const rendered = renderAgentMd(converted);
    expect(rendered).not.toContain('description:');
    expect(rendered).not.toContain('tools:');
    expect(rendered).not.toContain('memory:');
    expect(rendered.startsWith('---\n')).toBe(true);
  });

  it('renders an agent that had no frontmatter at all', () => {
    const converted = convertSingleFileAgent('body only', 'from-file');
    const parsed = parseAgentFile(renderAgentMd(converted), '/p/AGENT.md');
    expect(parsed?.name).toBe('from-file');
    expect(parsed?.systemPrompt).toBe('body only');
  });

  /**
   * Provenance is the host's statement, not the package's. A package that
   * declares its own `source:` is claiming to come from somewhere — the exact
   * claim the label exists to make trustworthy — so the declared value is
   * dropped on conversion and only the installer's key is ever written.
   */
  describe('source: provenance', () => {
    const claiming = '---\nname: reviewer\nsource: plugin:trusted-vendor@official\n---\n\nYou review.';

    it('stamps the caller\'s plugin key, overriding what the package claimed', () => {
      const converted = convertSingleFileAgent(claiming, 'reviewer');
      // Dropped at conversion — the claim never even reaches the renderer.
      expect(converted.frontmatter.source).toBeUndefined();

      const rendered = renderAgentMd(converted, { pluginKey: 'weather@official' });
      expect(rendered).toContain('source: plugin:weather@official');
      expect(rendered).not.toContain('trusted-vendor@official');
      expect(parseAgentFile(rendered, '/p/AGENT.md')?.source).toEqual({
        kind: 'plugin',
        plugin: 'weather@official',
      });
    });

    it('writes no source at all without a plugin key (the user-authored path)', () => {
      const rendered = renderAgentMd(convertSingleFileAgent(claiming, 'reviewer'));
      expect(rendered).not.toContain('source:');
      expect(parseAgentFile(rendered, '/p/AGENT.md')?.source).toBeUndefined();
    });

    it('treats a blank plugin key as no key rather than emitting an empty claim', () => {
      const converted = convertSingleFileAgent(claiming, 'reviewer');
      expect(renderAgentMd(converted, { pluginKey: '   ' })).not.toContain('source:');
    });
  });
});

describe('removeContributedAgent', () => {
  it('removes the agent directory under the agents root', async () => {
    const result = await removeContributedAgent('reviewer');
    expect(result).toEqual({ removed: true });
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(String(mockRemove.mock.calls[0][0])).toBe(`${AGENTS_ROOT}/reviewer`);
    expect(mockRemove.mock.calls[0][1]).toEqual({ recursive: true });
  });

  it('refuses a name that is not a single safe directory segment, touching nothing', async () => {
    for (const bad of ['../../Documents', 'a/b', '..', '', ' spaced ']) {
      expect(await removeContributedAgent(bad)).toEqual({ removed: false, reason: 'unsafe-name' });
    }
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockLstat).not.toHaveBeenCalled();
  });

  it('reports not-found when the directory is absent', async () => {
    mockLstat.mockRejectedValue(new Error('ENOENT'));
    expect(await removeContributedAgent('reviewer')).toEqual({ removed: false, reason: 'not-found' });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('never follows a link: a symlinked agent directory is refused, not removed', async () => {
    mockLstat.mockResolvedValue({ isSymlink: true, isFile: false, isDirectory: false } as never);
    expect(await removeContributedAgent('reviewer')).toEqual({ removed: false, reason: 'symlink' });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('reports not-found when the path is not a directory', async () => {
    mockLstat.mockResolvedValue({ isSymlink: false, isFile: true, isDirectory: false } as never);
    expect(await removeContributedAgent('reviewer')).toEqual({ removed: false, reason: 'not-found' });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('reports error when the removal itself fails', async () => {
    mockRemove.mockRejectedValue(new Error('EPERM'));
    expect(await removeContributedAgent('reviewer')).toEqual({ removed: false, reason: 'error' });
  });
});
