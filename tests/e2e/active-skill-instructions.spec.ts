/**
 * Real Electron + sidecar coverage for how an activated skill's instructions
 * reach the model.
 *
 * The agent loop runs in the sidecar, and the skill index exists only in the
 * shell. So the instructions are always rendered shell-side:
 *
 *  - a skill the model activates with `use_skill` returns its instructions,
 *    with the `ARGUMENTS:` line built from the tool's `context`, in the tool
 *    result;
 *  - a skill that is already active when the run starts (a project's default
 *    skills) is rendered into the entry system prompt.
 *
 * `read_skill_file` is a core tool: it is in the tool list of every request,
 * from the first, so activating a skill never changes the tool list (a change
 * would re-bill the cached prefix).
 *
 * The provider is a loopback-only OpenAI-compatible SSE server: no real
 * credential, network endpoint, or user file is involved.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  startOpenAiMock,
  taskRequests,
  waitForApp,
  type OpenAiMock,
} from './openAiMock';
import { persistedStoreVersion } from './storeVersions';

const LOCAL_MOCK_PROVIDER_OPTIONS = {
  permissionMode: 'standard',
  supportsReasoning: null,
  supportsTools: true,
} as const;
const ACTIVE_SKILLS_HEADING = '## Active Skill Instructions';

interface OpenAiRequestMessage {
  role?: unknown;
  content?: unknown;
}

interface OpenAiRequestBody {
  messages?: OpenAiRequestMessage[];
  tools?: Array<{ function?: { name?: unknown } }>;
}

function requestMessages(body: unknown): OpenAiRequestMessage[] {
  const messages = (body as OpenAiRequestBody | null)?.messages;
  expect(Array.isArray(messages)).toBe(true);
  return messages ?? [];
}

function messageText(message: OpenAiRequestMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
    .join('\n');
}

function systemText(body: unknown): string {
  return requestMessages(body)
    .filter((message) => message.role === 'system')
    .map(messageText)
    .join('\n');
}

function toolNames(body: unknown): string[] {
  return ((body as OpenAiRequestBody | null)?.tools ?? []).map((tool) => String(tool.function?.name));
}

/** The tool definitions of a request, whole and in the order they were sent. */
function toolDefinitions(body: unknown): unknown[] {
  return (body as OpenAiRequestBody | null)?.tools ?? [];
}

/** The only tool result in the request. The adapter assigns its own tool-call ids, so it is found by role. */
function singleToolResult(body: unknown): string {
  const toolResults = requestMessages(body).filter((message) => message.role === 'tool');
  expect(toolResults).toHaveLength(1);
  return messageText(toolResults[0]);
}

function builtinSkillLines(name: string): string[] {
  return fs.readFileSync(path.join(process.cwd(), 'builtin-skills', name, 'SKILL.md'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The last non-empty line of a built-in skill's SKILL.md. */
function lastLineOfBuiltinSkill(name: string): string {
  const lines = builtinSkillLines(name);
  return lines[lines.length - 1];
}

/**
 * A line from the middle of a built-in skill's SKILL.md. Result truncation
 * keeps the head and the tail, so the middle is what a cut removes. Lines
 * with `$` are skipped: variable substitution may rewrite them.
 */
function middleLineOfBuiltinSkill(name: string): string {
  const lines = builtinSkillLines(name);
  const candidates = lines
    .slice(Math.floor(lines.length / 2))
    .filter((line) => line.length > 20 && !line.includes('$'));
  expect(candidates.length).toBeGreaterThan(0);
  return candidates[0];
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

async function launchWithMock(): Promise<Page> {
  dataRoot = createElectronDataRoot();
  const launched = await launchAbuElectron(dataRoot);
  app = launched.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  return page;
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder(CHAT_PLACEHOLDER).fill(text);
  await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');
}

test.describe('Electron active skill instructions E2E', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (mock) {
      await mock.close();
      mock = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('use_skill returns the skill instructions and its arguments, and read_skill_file is there from the first request, with the tool list unchanged', async () => {
    const response = `abu-e2e-use-skill-complete-${randomUUID()}`;
    const skillContext = `abu-e2e-skill-context-${randomUUID()}`;
    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: { skill_name: 'mermaid-diagram', context: skillContext },
        toolCallId: `call-use-skill-${randomUUID()}`,
        toolName: 'use_skill',
      },
      { kind: 'complete', responseText: response },
    ]);
    const page = await launchWithMock();
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);

    await sendMessage(page, `abu-e2e-use-skill-${randomUUID()}`);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    const [firstRequest, secondRequest] = taskRequests(mock);

    // read_skill_file is offered from the first request, before any skill is active ...
    expect(toolNames(firstRequest.body)).toContain('read_skill_file');
    // ... and activating the skill leaves the tool definitions, and their order, as they were.
    expect(toolDefinitions(secondRequest.body)).toEqual(toolDefinitions(firstRequest.body));

    const toolResult = singleToolResult(secondRequest.body);
    expect(toolResult).toContain('已加载技能 "mermaid-diagram"');
    expect(toolResult).toContain('### mermaid-diagram');
    expect(toolResult).toContain(lastLineOfBuiltinSkill('mermaid-diagram'));
    expect(toolResult).toContain(`ARGUMENTS: ${skillContext}`);

    // The instructions travel in the tool result, with no copy in the system prompt.
    expect(systemText(secondRequest.body)).not.toContain(ACTIVE_SKILLS_HEADING);
    expect(systemText(secondRequest.body)).not.toContain('### mermaid-diagram');

    expect(toolNames(secondRequest.body)).toContain('read_skill_file');

    await expect(page.getByText(response, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  });

  test('use_skill returns a long skill body without cutting it', async () => {
    const response = `abu-e2e-use-long-skill-complete-${randomUUID()}`;
    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: { skill_name: 'docx' },
        toolCallId: `call-use-long-skill-${randomUUID()}`,
        toolName: 'use_skill',
      },
      { kind: 'complete', responseText: response },
    ]);
    const page = await launchWithMock();
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);

    await sendMessage(page, `abu-e2e-use-long-skill-${randomUUID()}`);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    const toolResult = singleToolResult(taskRequests(mock)[1].body);
    expect(toolResult).toContain('### docx');
    expect(toolResult).toContain(middleLineOfBuiltinSkill('docx'));
    expect(toolResult).toContain(lastLineOfBuiltinSkill('docx'));
    expect(toolResult).not.toContain('characters omitted');
    expect(toolResult).not.toContain('characters truncated');

    await expect(page.getByText(response, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  });

  test('a project default skill is in the system prompt of the first request, with its arguments', async () => {
    const response = `abu-e2e-default-skill-complete-${randomUUID()}`;
    const skillArguments = `abu-e2e-default-skill-arguments-${randomUUID()}`;
    mock = await startOpenAiMock([{ kind: 'complete', responseText: response }]);
    const page = await launchWithMock();
    const workspace = path.join(dataRoot!.rootDir, 'workspace-default-skill');
    fs.mkdirSync(workspace, { recursive: true });
    await page.evaluate(({ workspacePath, version, args }) => {
      window.localStorage.setItem('abu-projects', JSON.stringify({
        state: {
          projects: {
            'project-default-skill': {
              id: 'project-default-skill',
              name: 'E2E Default Skill Project',
              workspacePath,
              pinned: false,
              archived: false,
              createdAt: 1_800_000_000_000,
              updatedAt: 1_800_000_000_000,
              lastActiveAt: 1_800_000_000_000,
              defaultSkills: ['mermaid-diagram'],
              defaultSkillArgs: { 'mermaid-diagram': args },
            },
          },
        },
        version,
      }));
    }, { workspacePath: workspace, version: persistedStoreVersion('abu-projects'), args: skillArguments });
    // Reloads the window, which also loads the seeded project.
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);

    await page.getByRole('button', { name: 'E2E Default Skill Project', exact: true })
      .locator('xpath=..')
      .getByRole('button', { name: '新任务', exact: true })
      .click();
    await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible();
    await sendMessage(page, `abu-e2e-default-skill-${randomUUID()}`);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(1);
    const [request] = taskRequests(mock);
    const system = systemText(request.body);
    expect(system).toContain(ACTIVE_SKILLS_HEADING);
    expect(system).toContain('### mermaid-diagram');
    expect(system).toContain(lastLineOfBuiltinSkill('mermaid-diagram'));
    expect(system).toContain(`ARGUMENTS: ${skillArguments}`);
    expect(toolNames(request.body)).toContain('read_skill_file');

    await expect(page.getByText(response, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  });
});
