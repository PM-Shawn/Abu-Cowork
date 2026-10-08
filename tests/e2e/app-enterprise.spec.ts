/**
 * Organization apps (product brief stories 5–7) against a real console: the
 * administrator's side runs through the console's admin API, the employee's
 * side through the real Electron shell bound to the same console.
 *
 * - Story 5: a scene with nobody handling it is refused with the scene named;
 *   a navigation entry whose page first redirects to the company login page
 *   opens both pages inside Abu when the login address is listed.
 * - Story 6: an app reaching further than its team is refused with the team
 *   named; publishing while the team is off is refused with the team named;
 *   within the team's reach it publishes.
 * - Story 7: the employee finds the app in the switcher, starts from a sample
 *   prompt (the organization expert is prepared first), loses the server and
 *   lands in the general shell with the offline notice on the app's
 *   conversation, and returns to the app once the server is back.
 *
 * The employee signs in with the console's password grant and the private
 * repo's fixture writes the binding the shell reads at startup (the shell's
 * own sign-in goes through the system browser). The client reaches the
 * console through a loopback TCP forwarder owned by this spec, so "the server
 * is unreachable" is the forwarder closing. The console's gateway forwards
 * model calls to a loopback mock registered as a provider for the run.
 *
 * Requires (spec skips itself when unset), e.g. from `npm run dev:capability-center`
 * in abu-console, whose seed provides the account, the license, the
 * `smoke-hello` skill, the local MCP server and the `capability-reviewer` expert:
 *   ABU_E2E_CONSOLE_URL       e.g. http://127.0.0.1:3000
 *   ABU_E2E_CONSOLE_EMAIL     an administrator who also signs in as the employee
 *   ABU_E2E_CONSOLE_PASSWORD
 *   ABU_E2E_CONSOLE_BINDING_FIXTURE  absolute path of the private repo's
 *                             `e2e-fixtures/console-binding.mjs`
 * plus ABU_BUILD_TARGET=enterprise so global setup builds the enterprise renderer.
 */
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
/** Preparing an organization expert downloads its skills and connects its MCP server. */
const PREPARE_TIMEOUT = 120_000;
/** The client asks the console for its session every five minutes; one miss is offline. */
const HEARTBEAT_TIMEOUT = 6 * 60_000;

const CONSOLE_URL = process.env.ABU_E2E_CONSOLE_URL ?? '';
const CONSOLE_EMAIL = process.env.ABU_E2E_CONSOLE_EMAIL ?? '';
const CONSOLE_PASSWORD = process.env.ABU_E2E_CONSOLE_PASSWORD ?? '';
/** Absolute path of the private repo's `e2e-fixtures/console-binding.mjs`. */
const BINDING_FIXTURE = process.env.ABU_E2E_CONSOLE_BINDING_FIXTURE ?? '';

/** From the console's local seed (`src/lib/dev/capability-center-local.ts`). */
const SEEDED_EXPERT_SLUG = 'capability-reviewer';
const SEEDED_SKILL = 'smoke-hello';

/** Slugs are unique per organization and apps are archived, never deleted: stamp each run. */
const RUN_STAMP = Math.floor(Date.now() / 1000).toString(36);
const APP_NAME = '合同审阅';
const TEAM_NAME = `合同审阅组 ${RUN_STAMP}`;
const APP_REPLY = 'Abu E2E organization reply.';

// Public (localized) UI.
const WELCOME = /交给阿布就行啦|Leave it to Abu/;
const CHAT_PLACEHOLDER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;
const NEW_TASK = /^(新任务|New task)$/;
const GENERAL_SHELL = /发现应用|Discover apps/;
const OFFLINE_NOTICE = /连不上公司服务器，恢复连接后可以继续|Can't reach the company server/;

const templates = (prefix: string, subject: string) => [
  { id: `${prefix}-a`, title: `${subject}一`, prompt: `请${subject}：第一份合同` },
  { id: `${prefix}-b`, title: `${subject}二`, prompt: `请${subject}：第二份合同` },
  { id: `${prefix}-c`, title: `${subject}三`, prompt: `请${subject}：第三份合同` },
];

// ─── loopback servers owned by the spec ──────────────────────────────────────

function closeServer(server: Server | net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    (server as Server).closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sse(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'chatcmpl-abu-e2e-org-app', object: 'chat.completion.chunk', created: 0, model: 'abu-e2e-org-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return chunk({ content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
}

/** What the console's gateway forwards to: every task gets one line, prompts are recorded. */
async function startLlmMock(): Promise<{ baseUrl: string; users: string[]; close: () => Promise<void> }> {
  const users: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    if (!(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'abu-e2e-org-model', object: 'model' }] }));
      return;
    }
    const body = JSON.parse(raw) as { stream?: boolean; messages?: Array<{ role: string; content: unknown }> };
    const messages = body.messages ?? [];
    const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    const user = messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const background = system.includes('记忆提取助手') || user.includes('请将以下对话内容压缩为一段简洁的摘要');
    if (!background) users.push(user);
    const content = background ? '[]' : APP_REPLY;
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-abu-e2e-org-app', object: 'chat.completion', created: 0, model: 'abu-e2e-org-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.end(sse(content));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, users, close: () => closeServer(server) };
}

/**
 * The company's contract system: `/contracts` on 127.0.0.1 redirects to the
 * login page on `localhost` (another origin), which is only reachable when the
 * administrator listed it as an address the page passes through.
 */
async function startCompanyPages(): Promise<{ port: number; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    hits.push(`${host}${req.url ?? '/'}`);
    if ((req.url ?? '').startsWith('/contracts')) {
      res.writeHead(302, { location: `http://localhost:${port}/login?next=contracts` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Company login</title><h1 id="login">Company login</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, hits, close: () => closeServer(server) };
}

/**
 * The client's way to the console. `cut()` closes the port and drops every open
 * connection, which is what an unreachable server looks like to the client;
 * `restore()` listens on the same port again.
 */
async function startConsoleForwarder(target: URL): Promise<{ url: string; cut: () => Promise<void>; restore: () => Promise<void>; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const handle = (client: net.Socket) => {
    const upstream = net.connect(Number(target.port || 80), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
    }
    client.pipe(upstream);
    upstream.pipe(client);
  };
  let server = net.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const cut = async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  };
  const restore = async () => {
    server = net.createServer(handle);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  };
  return { url: `http://127.0.0.1:${port}`, cut, restore, close: async () => { if (server.listening) await cut(); } };
}

// ─── console admin API (node side) ───────────────────────────────────────────

let adminCookie = '';

async function adminLogin(): Promise<void> {
  const res = await fetch(`${CONSOLE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: CONSOLE_EMAIL, password: CONSOLE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`console admin login failed: HTTP ${res.status}`);
  const cookies = res.headers.getSetCookie();
  if (cookies.length === 0) throw new Error('console admin login returned no cookie');
  adminCookie = cookies.map((c) => c.split(';')[0]).join('; ');
}

async function admin(pathname: string, method = 'GET', body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${CONSOLE_URL}${pathname}`, {
    method,
    headers: { cookie: adminCookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function adminOk(pathname: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const result = await admin(pathname, method, body);
  if (result.status >= 400) throw new Error(`${method} ${pathname} failed: HTTP ${result.status} ${JSON.stringify(result.json)}`);
  return result.json;
}

function appDraft(input: { teamId: string; expertId: string; pagesPort: number; ownerless?: boolean }) {
  return {
    slug: `e2e-contract-review-${RUN_STAMP}`,
    name: APP_NAME,
    description: '从审阅到结论的合同工作',
    icon: 'icon:file-text/blue',
    manifest: {
      home: {
        modes: {
          items: [{
            modeId: 'review',
            title: '审阅',
            scenes: [
              {
                id: 'team-review',
                title: '交给审阅组',
                ...(input.ownerless ? {} : { run: { team: `enterprise-team:${input.teamId}` } }),
                templates: templates('team', '审阅'),
              },
              {
                id: 'expert-review',
                title: '交给审阅助手',
                run: { expert: `enterprise-agent:${input.expertId}`, skill: `enterprise:${SEEDED_SKILL}` },
                templates: templates('expert', '检查'),
              },
            ],
          }],
        },
      },
      nav: {
        items: [
          ...['chat', 'todos', 'inbox', 'team', 'extensions', 'automation'].map((id, index) => ({ id, order: index + 1, target: `builtin:${id}` })),
          { id: 'contracts', title: '合同系统', order: 7, target: `url:http://127.0.0.1:${input.pagesPort}/contracts` },
        ],
      },
    },
    pageRedirects: { contracts: [`http://localhost:${input.pagesPort}/login`] },
  };
}

// ─── the employee's shell ────────────────────────────────────────────────────

interface BindingFixture {
  bindToConsole: (options: { appDataDir: string; consoleUrl: string; serverUrl: string; email: string; password: string }) => Promise<{ userName: string; orgName: string }>;
}

async function showSidebar(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^(显示侧栏|Show sidebar)$/ });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.getByTestId('app-switcher-trigger')).toBeVisible();
}

async function openSwitcher(page: Page): Promise<void> {
  await showSidebar(page);
  await page.getByTestId('app-switcher-trigger').click();
  await expect(page.getByTestId('app-switcher-menu')).toBeVisible();
}

function composerText(page: Page): Promise<string> {
  return page.locator('[data-chat-composer]').evaluate((element) => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '');
}

// ─── the walkthrough ─────────────────────────────────────────────────────────

test.describe.serial('organization apps (real console + real shell)', () => {
  test.skip(
    CONSOLE_URL === '' || CONSOLE_EMAIL === '' || CONSOLE_PASSWORD === '' || BINDING_FIXTURE === '',
    'set ABU_E2E_CONSOLE_URL / _EMAIL / _PASSWORD / _BINDING_FIXTURE to run the organization app walkthrough',
  );

  let llm: Awaited<ReturnType<typeof startLlmMock>>;
  let pages: Awaited<ReturnType<typeof startCompanyPages>>;
  let forwarder: Awaited<ReturnType<typeof startConsoleForwarder>>;
  let providerId = '';
  let expertId = '';
  let adminRoleId = '';
  let orgId = '';
  let teamId = '';
  let appId = '';
  let dataRoot: ElectronDataRoot;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    await adminLogin();
    llm = await startLlmMock();
    pages = await startCompanyPages();
    forwarder = await startConsoleForwarder(new URL(CONSOLE_URL));

    const provider = await adminOk('/api/admin/llm/providers', 'POST', {
      type: 'vllm', label: `E2E loopback ${RUN_STAMP}`, models: ['abu-e2e-org-model'],
      config: { baseUrl: llm.baseUrl, apiKey: 'abu-e2e-provider-key-not-a-secret' },
    });
    providerId = String((provider.provider as { id: string }).id);

    const agents = (await adminOk('/api/admin/agents')).items as Array<{ id: string; slug: string }>;
    const expert = agents.find((item) => item.slug === SEEDED_EXPERT_SLUG);
    if (!expert) throw new Error(`console has no expert @${SEEDED_EXPERT_SLUG}; run the console's local seed`);
    expertId = expert.id;
    const roles = (await adminOk('/api/admin/roles')).items as Array<{ id: string; name: string; orgId: string }>;
    const adminRole = roles.find((item) => item.name === 'admin');
    if (!adminRole) throw new Error('console has no admin role');
    adminRoleId = adminRole.id;
    orgId = adminRole.orgId;

    // The team reaches the administrator role only; the expert reaches the whole organization.
    const team = await adminOk('/api/admin/agent-teams', 'POST', {
      slug: `e2e-review-team-${RUN_STAMP}`, name: TEAM_NAME, description: '', avatar: '👥',
      leaderAgentId: expertId, members: [{ agentId: expertId }], manifest: {},
    });
    teamId = String((team.template as { id: string }).id);
    await adminOk(`/api/admin/agent-teams/versions/${(team.version as { id: string }).id}/publish`, 'POST');
    await adminOk(`/api/admin/agent-teams/${teamId}/assignments`, 'PUT', {
      assignments: [{ principalType: 'role', principalId: adminRoleId, canUse: true }],
    });
  });

  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
    if (appId) await admin(`/api/admin/apps/${appId}`, 'DELETE');
    if (teamId) await admin(`/api/admin/agent-teams/${teamId}`, 'DELETE');
    if (providerId) await admin(`/api/admin/llm/providers/${providerId}`, 'DELETE');
    await forwarder?.close();
    await llm?.close();
    await pages?.close();
  });

  test('story 5: a scene with nobody handling it is refused, naming the scene', async () => {
    const refused = await admin('/api/admin/apps', 'POST', appDraft({ teamId, expertId, pagesPort: pages.port, ownerless: true }));
    expect(refused.status).toBe(400);
    expect(refused.json).toEqual({ error: 'app_scene_owner_required', modeId: 'review', sceneId: 'team-review' });

    const created = await adminOk('/api/admin/apps', 'POST', appDraft({ teamId, expertId, pagesPort: pages.port }));
    appId = String((created.template as { id: string }).id);
    const listed = (await adminOk('/api/admin/apps')).items as Array<{ id: string; latestVersionId: string | null; versions: Array<{ status: string }> }>;
    const draft = listed.find((item) => item.id === appId);
    expect(draft?.latestVersionId).toBeNull();
    expect(draft?.versions.map((version) => version.status)).toEqual(['draft']);
  });

  test('story 6: the app can reach no further than its team, and publishes only while the team is on', async () => {
    const orgWide = await admin(`/api/admin/apps/${appId}/assignments`, 'PUT', {
      assignments: [{ principalType: 'org', principalId: orgId, canUse: true }],
    });
    expect(orgWide.status).toBe(409);
    expect(orgWide.json).toMatchObject({ error: 'app_assignment_exceeds_refs', refs: [{ kind: 'team', refId: teamId, name: TEAM_NAME }] });
    await adminOk(`/api/admin/apps/${appId}/assignments`, 'PUT', {
      assignments: [{ principalType: 'role', principalId: adminRoleId, canUse: true }],
    });

    const versions = ((await adminOk('/api/admin/apps')).items as Array<{ id: string; versions: Array<{ id: string }> }>)
      .find((item) => item.id === appId)!.versions;
    await adminOk(`/api/admin/agent-teams/${teamId}`, 'PATCH', { enabled: false });
    const whileOff = await admin(`/api/admin/apps/versions/${versions[0].id}/publish`, 'POST');
    expect(whileOff.status).toBe(409);
    expect(whileOff.json).toMatchObject({ error: 'app_ref_unavailable', refs: [{ kind: 'team', name: TEAM_NAME }] });

    await adminOk(`/api/admin/agent-teams/${teamId}`, 'PATCH', { enabled: true });
    await adminOk(`/api/admin/apps/versions/${versions[0].id}/publish`, 'POST');

    // Once published, the team the app uses cannot be turned off.
    const required = await admin(`/api/admin/agent-teams/${teamId}`, 'PATCH', { enabled: false });
    expect(required.status).toBe(409);
    expect(required.json).toEqual({ error: 'required_by_app', apps: [APP_NAME] });
  });

  test('story 7: the employee finds the app in the switcher and sees its home', async () => {
    dataRoot = createElectronDataRoot();
    const fixture = await import(pathToFileURL(BINDING_FIXTURE).href) as BindingFixture;
    await fixture.bindToConsole({
      appDataDir: dataRoot.appDataDir, consoleUrl: CONSOLE_URL, serverUrl: forwarder.url, email: CONSOLE_EMAIL, password: CONSOLE_PASSWORD,
    });
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(WELCOME).or(page.getByPlaceholder(CHAT_PLACEHOLDER)).first()).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page);

    const itemId = `app-switcher-item-enterprise-app:${appId}`;
    await expect.poll(async () => {
      await openSwitcher(page);
      const found = await page.getByTestId(itemId).count();
      await page.keyboard.press('Escape');
      return found;
    }, { timeout: READY_TIMEOUT }).toBe(1);
    await openSwitcher(page);
    await page.getByTestId(itemId).click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('app-home-title')).toHaveText(APP_NAME);
    await expect(page.getByTestId('app-home-scene-team-review')).toContainText('交给审阅组');
    await expect(page.getByTestId('app-home-scene-team-review')).toContainText(TEAM_NAME);
    await expect(page.getByTestId('app-home-scene-expert-review')).toContainText('交给审阅助手');
    await expect(page.getByTestId('sidebar-app-page-contracts')).toBeVisible();
  });

  test('story 7: a sample prompt of the expert scene prepares the organization expert first, then starts', async () => {
    await page.getByTestId('app-home-scene-expert-review').click();
    await expect(page.getByTestId('app-home-templates')).toBeVisible();
    // The seeded expert needs the organization's skill and MCP server, which a
    // fresh profile does not have yet: the scene sets it up before anything starts.
    await expect(page.getByTestId('app-home-scene-expert-review')).toBeVisible();
    await page.getByTestId('app-home-template-expert-a').click();
    await expect(page.getByTestId('app-home-preparing')).toHaveAttribute('data-state', 'busy');
    await expect(page.getByTestId('app-home-preparing')).toContainText('联调审阅助手');
    await expect.poll(() => composerText(page), { timeout: PREPARE_TIMEOUT }).toMatch(/请检查：第一份合同/);
    await expect(page.getByTestId('app-home-preparing')).toHaveCount(0);
    // The scene's organization skill joins the draft.
    await expect(page.getByRole('button', { name: `/${SEEDED_SKILL}`, exact: true })).toBeVisible();

    const before = llm.users.length;
    const composer = page.locator('[data-chat-composer]');
    await composer.click();
    await composer.press('Enter');
    await expect.poll(() => llm.users.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(before);
    expect(llm.users.at(-1)).toContain('请检查：第一份合同');
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByText(APP_REPLY)).toBeVisible({ timeout: READY_TIMEOUT });
  });

  test('story 5: the contract system opens inside Abu through the company login page', async () => {
    await showSidebar(page);
    await page.getByTestId('sidebar-app-page-contracts').click();
    await expect(page.getByTestId('app-page-view')).toHaveAttribute('data-nav-item', 'contracts');
    await expect.poll(() => pages.hits, { timeout: READY_TIMEOUT }).toEqual(expect.arrayContaining([
      '127.0.0.1/contracts',
      'localhost/login?next=contracts',
    ]));
    await page.getByLabel('Main navigation').getByRole('button', { name: NEW_TASK }).click();
    await expect(page.getByTestId('app-home-title')).toBeVisible();
  });

  test('story 7: without the server the employee is in the general shell; the app\'s conversation says why', async () => {
    test.setTimeout(HEARTBEAT_TIMEOUT + 2 * READY_TIMEOUT);
    await forwarder.cut();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(GENERAL_SHELL, { timeout: HEARTBEAT_TIMEOUT });
    await openSwitcher(page);
    await expect(page.getByTestId(`app-switcher-item-enterprise-app:${appId}`)).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByTestId('conversation-app-icon').first().click();
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByText(OFFLINE_NOTICE)).toBeVisible({ timeout: READY_TIMEOUT });
  });

  test('story 7: once the server is back the employee returns to the app', async () => {
    test.setTimeout(2 * HEARTBEAT_TIMEOUT + READY_TIMEOUT);
    await forwarder.restore();
    await showSidebar(page);
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: 2 * HEARTBEAT_TIMEOUT });
    await expect(page.getByText(OFFLINE_NOTICE)).toHaveCount(0);
  });
});
