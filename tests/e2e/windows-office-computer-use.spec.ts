/**
 * Windows Office Computer Use through the real Abu product path.
 *
 * Unlike electron/spike/windowsOfficeComputerUseVerify.cjs, this suite does
 * not invoke native-helper directly. A loopback-only deterministic model asks
 * the real renderer Agent Loop to call `computer`; execution then crosses
 * toolExecutor, the Electron Host Gate, Helper Protocol v2, and Windows UIA /
 * guarded SendInput before the model observes the result in its next turn.
 *
 * The suite refuses to run over an existing Office process. It creates one
 * blank, unsaved instance, types only a random marker, never opens a user file,
 * and terminates only the exact PID + executable path that it created.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 60_000;
const CHAT_PLACEHOLDER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;
const TEST_API_KEY = 'abu-e2e-office-not-a-real-secret';
const TEST_MODEL_ID = 'abu-e2e-office-structured-model';
const PROVIDER_ID = 'abu-e2e-office-provider';
// These are worker-scoped options and must be set at file scope.
if (process.env.ABU_CU_EVAL_LIVE === '1') test.use({ trace: 'off', screenshot: 'off', video: 'off' });
const requireForEval = createRequire(import.meta.url);
interface LiveConfig { baseUrl: string; apiKey: string; model: string }
interface LiveProxy { baseUrl: string; metrics: Record<string, number>; close: () => Promise<void> }
const { readLiveEvalConfig, startOfficeLiveProxy, buildLiveEvalReport, withoutLiveEvalCredential, officeGracePeriodExpired } = requireForEval('../../scripts/computer-use-live-eval.cjs') as {
  readLiveEvalConfig: () => { status: string; config?: LiveConfig };
  startOfficeLiveProxy: (config: LiveConfig, scope: { appName: string; marker: string }, options: { assertFixtureReady: () => boolean }) => Promise<LiveProxy>;
  buildLiveEvalReport: (input: Record<string, unknown>) => { outcome: string };
  withoutLiveEvalCredential: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  officeGracePeriodExpired: (output: string) => boolean;
};
const OFFICE_ROOT = process.env.ABU_OFFICE_ROOT
  ? path.resolve(process.env.ABU_OFFICE_ROOT)
  : 'C:\\Program Files\\Microsoft Office\\root\\Office16';

interface OfficeAppDefinition {
  key: 'word' | 'excel' | 'powerpoint';
  appName: string;
  executable: string;
  args: string[];
}

const OFFICE_APPS: OfficeAppDefinition[] = [
  { key: 'word', appName: 'WINWORD', executable: 'WINWORD.EXE', args: ['/q', '/n'] },
  { key: 'excel', appName: 'EXCEL', executable: 'EXCEL.EXE', args: ['/x'] },
  { key: 'powerpoint', appName: 'POWERPNT', executable: 'POWERPNT.EXE', args: ['/n'] },
];

interface MockRequest {
  body: unknown;
  pathname: string;
  purpose: 'memory' | 'task';
}

interface OfficeModelMock {
  baseUrl: string;
  close: () => Promise<void>;
  errors: string[];
  requests: MockRequest[];
  observedMarker: boolean;
  dismissedExcelStartScreenPrompt: boolean;
  dismissedModalPrompt: boolean;
  dismissalCount: number;
  editingUnavailable: boolean;
  initialObservation: string;
  verificationReceipt: string;
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-office',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function toolCallSse(
  requestIndex: number,
  input: Record<string, unknown>,
): string {
  return sseChunk({
    tool_calls: [{
      index: 0,
      id: `call-office-${requestIndex}-${randomUUID()}`,
      type: 'function',
      function: { name: 'computer', arguments: JSON.stringify(input) },
    }],
  }, null) + sseChunk({}, 'tool_calls') + 'data: [DONE]\n\n';
}

function completeSse(text: string): string {
  return sseChunk({ content: text }, null) + sseChunk({}, 'stop') + 'data: [DONE]\n\n';
}

function latestToolText(body: unknown): string {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return '';
  const toolMessages = messages.filter((message): message is { role: string; content: unknown } => (
    !!message && typeof message === 'object' && (message as { role?: unknown }).role === 'tool'
  ));
  const content = toolMessages.at(-1)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
      return (item as { text: string }).text;
    }
    return JSON.stringify(item);
  }).join('\n');
}

function extractStateId(text: string): string | null {
  return text.match(/state_id\s*[：:]\s*([^\s（(。.]+)/i)?.[1] ?? null;
}

function extractWindowRef(text: string): string | null {
  return text.match(/window_ref\s*[：:]\s*(wr-[A-Za-z0-9_-]+)/i)?.[1] ?? null;
}

function extractScreenshotId(text: string): string | null {
  return text.match(/screenshot_id\s*[：:]\s*([^\s（(。.]+)/i)?.[1] ?? null;
}

function extractAmbiguousWindowRefs(text: string): string[] {
  if (!/多个可见窗口匹配|More than one visible window matches/i.test(text)) return [];
  return [...text.matchAll(/^- window_ref:\s*(wr-[A-Za-z0-9_-]+)/gm)]
    .map((match) => match[1]);
}

function requiresFreshObservation(text: string): boolean {
  return /interface changed after observation|界面.*观察后.*变化|调用 get_app_state 检查当前界面/i.test(text);
}

function findFocusElementId(text: string, app: OfficeAppDefinition): number | null {
  const candidates = [...text.matchAll(/^\[(\d+)]\s+([A-Za-z]+)\b([^\n]*)$/gm)].map((match) => ({
    id: Number(match[1]),
    role: match[2],
    suffix: match[3],
  }));
  const roleOrder: Record<OfficeAppDefinition['key'], string[]> = {
    word: ['Document', 'TextField'],
    excel: ['DataItem', 'TextField', 'Document'],
    powerpoint: ['Document', 'TextField'],
  };
  if (app.key === 'powerpoint') {
    const workspace = candidates.find((candidate) => (
      candidate.role === 'Pane'
      && /"(?:工作区|Workspace)"/i.test(candidate.suffix)
      && /actions=\[[^\]]*Focus/i.test(candidate.suffix)
    ));
    if (workspace) return workspace.id;
  }
  for (const role of roleOrder[app.key]) {
    const candidate = candidates.find((element) => element.role === role);
    if (candidate) return candidate.id;
  }
  return null;
}

function findExcelStartScreenDismissElementId(text: string, app: OfficeAppDefinition): number | null {
  if (app.key !== 'excel') return null;
  const isKnownRecoveryPrompt = /最后两次启动时开始屏幕意外关闭|start screen[^\n]*unexpectedly closed/i.test(text);
  if (!isKnownRecoveryPrompt) return null;
  const noButton = [...text.matchAll(/^\[(\d+)]\s+Button\s+"([^"]+)"[^\n]*$/gm)]
    .find((match) => /^(?:否(?:\(N\))?|No(?:\s*\(&?N\))?)$/i.test(match[2]));
  return noButton ? Number(noButton[1]) : null;
}

function findModalDismissElementId(text: string): number | null {
  const isModal = /检测到当前模态弹窗|A modal dialog is active/i.test(text);
  if (!isModal) return null;
  const closeButton = [...text.matchAll(/^\[(\d+)]\s+Button\s+"([^"]+)"[^\n]*$/gm)]
    .find((match) => /^(?:关闭|Close)$/i.test(match[2]));
  return closeButton ? Number(closeButton[1]) : null;
}

function officeEditingUnavailable(text: string): boolean {
  return /未经授权产品|产品已停用|Unlicensed Product|Product Deactivated|大部分功能已禁用|most features (?:have been )?disabled/i.test(text);
}

function findPowerPointTitlePoint(text: string): { x: number; y: number } | null {
  const workspace = text.match(/^\[\d+]\s+Pane\s+"(?:工作区|Workspace)"[^\n]*bounds=\((-?\d+),(-?\d+)\s+(\d+)[×x](\d+)\)/im);
  const rootWindow = text.match(/^\[\d+]\s+Window\s+"[^"]*PowerPoint[^"]*"[^\n]*bounds=\((-?\d+),(-?\d+)\s+(\d+)[×x](\d+)\)/im);
  const screenshot = text.match(/Screenshot:\s*\d+x\d+\s*\(scale:\s*([\d.]+)x\)/i);
  if (!workspace || !rootWindow || !screenshot) return null;
  const scale = Number(screenshot[1]);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const workspaceX = Number(workspace[1]);
  const workspaceY = Number(workspace[2]);
  const workspaceWidth = Number(workspace[3]);
  const workspaceHeight = Number(workspace[4]);
  const originX = Number(rootWindow[1]);
  const originY = Number(rootWindow[2]);
  return {
    x: Math.round((workspaceX + workspaceWidth * 0.5 - originX) / scale),
    y: Math.round((workspaceY + workspaceHeight * 0.3 - originY) / scale),
  };
}

function requestExposesComputerTool(body: unknown): boolean {
  const tools = (body as { tools?: unknown } | null)?.tools;
  return Array.isArray(tools) && tools.some((tool) => {
    if (!tool || typeof tool !== 'object') return false;
    const candidate = tool as { function?: { name?: unknown }; name?: unknown };
    return candidate.name === 'computer' || candidate.function?.name === 'computer';
  });
}

function isMemoryExtractionRequest(body: unknown): boolean {
  const messages = (body as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) && messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as { content?: unknown; role?: unknown };
    return candidate.role === 'system'
      && typeof candidate.content === 'string'
      && candidate.content.includes('你是一个记忆提取助手');
  });
}

function taskRequests(mock: OfficeModelMock): MockRequest[] {
  return mock.requests.filter((request) => request.purpose === 'task');
}

async function startOfficeModelMock(
  app: OfficeAppDefinition,
  marker: string,
): Promise<OfficeModelMock> {
  const requests: MockRequest[] = [];
  const errors: string[] = [];
  const activeResponses = new Set<ServerResponse>();
  const result: OfficeModelMock = {
    baseUrl: '',
    close: async () => {},
    errors,
    requests,
    observedMarker: false,
    dismissedExcelStartScreenPrompt: false,
    dismissedModalPrompt: false,
    dismissalCount: 0,
    editingUnavailable: false,
    initialObservation: '',
    verificationReceipt: '',
  };
  let phase: 'initial-observation' | 'dismiss-receipt' | 'content-observation'
    | 'focus-receipt'
    | 'type-receipt' | 'verification-observation'
    | 'verification-dismiss-receipt' | 'complete' = 'initial-observation';
  let afterDismissPhase: 'content-observation' | 'verification-observation' = 'content-observation';
  let pendingWindowRefs: string[] = [];
  const server = createServer(async (req, res) => {
    activeResponses.add(res);
    res.once('close', () => activeResponses.delete(res));
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    let rawBody = '';
    for await (const chunk of req) rawBody += String(chunk);
    let body: unknown = rawBody;
    try { body = JSON.parse(rawBody); } catch { /* assertion below reports it */ }

    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local Office E2E route' }));
      return;
    }
    const purpose = isMemoryExtractionRequest(body) ? 'memory' : 'task';
    requests.push({ body, pathname: requestUrl.pathname, purpose });
    const index = requests.filter((request) => request.purpose === 'task').length - 1;
    if (process.env.ABU_OFFICE_E2E_DEBUG === '1' && purpose === 'task') {
      console.error('[office-e2e-debug]', JSON.stringify({
        app: app.key,
        index,
        phase,
        latestToolText: latestToolText(body).slice(0, 800),
      }));
    }
    let response: string;
    if (purpose === 'memory') {
      response = completeSse('[]');
    } else if (index === 0) {
      if (!requestExposesComputerTool(body)) errors.push('Abu did not expose the computer tool');
      response = toolCallSse(index, {
        action: 'get_app_state',
        app: app.appName,
        consequence: 'none',
        show_user: false,
      });
    } else if (extractAmbiguousWindowRefs(latestToolText(body)).length > 0) {
      pendingWindowRefs = extractAmbiguousWindowRefs(latestToolText(body));
      const windowRef = pendingWindowRefs.shift();
      response = toolCallSse(index, {
        action: 'get_window_state',
        window_ref: windowRef,
        consequence: 'none',
        show_user: false,
      });
    } else if (phase === 'initial-observation' || phase === 'content-observation') {
      const observation = latestToolText(body);
      result.initialObservation = observation;
      const stateId = extractStateId(observation);
      const windowRef = extractWindowRef(observation);
      const screenshotId = extractScreenshotId(observation);
      const modalDismissElementId = findModalDismissElementId(observation);
      const excelDismissElementId = findExcelStartScreenDismissElementId(observation, app);
      const dismissElementId = modalDismissElementId ?? excelDismissElementId;
      if (stateId && windowRef && dismissElementId != null) {
        result.dismissedModalPrompt = modalDismissElementId != null;
        result.dismissedExcelStartScreenPrompt = excelDismissElementId != null;
        result.dismissalCount += 1;
        phase = 'dismiss-receipt';
        response = toolCallSse(index, {
          action: 'click',
          element_id: dismissElementId,
          window_ref: windowRef,
          expected_state_id: stateId,
          consequence: 'none',
        });
      } else {
        if (!stateId) errors.push(`initial observation did not return state_id: ${observation.slice(0, 400)}`);
        if (officeEditingUnavailable(observation)) {
          result.editingUnavailable = true;
          phase = 'complete';
          response = completeSse(`ABU_OFFICE_E2E_ABORTED_UNLICENSED_${app.key}`);
        } else if (app.key === 'powerpoint') {
          const point = findPowerPointTitlePoint(observation);
          if (!point && pendingWindowRefs.length > 0) {
            response = toolCallSse(index, {
              action: 'get_window_state', window_ref: pendingWindowRefs.shift(),
              consequence: 'none', show_user: false,
            });
          } else {
            if (!point) {
              errors.push(`PowerPoint observation did not expose a target-bound screenshot point: ${observation.slice(0, 800)}`);
            }
            phase = 'focus-receipt';
            response = stateId && windowRef && screenshotId && point
              ? toolCallSse(index, {
                  action: 'click', x: point.x, y: point.y, button: 'double',
                  window_ref: windowRef, expected_state_id: stateId,
                  screenshot_id: screenshotId, consequence: 'none',
                })
              : completeSse('ABU_OFFICE_E2E_ABORTED_NO_CONTENT_POINT');
          }
        } else {
          const focusElementId = findFocusElementId(observation, app);
          if (focusElementId == null && pendingWindowRefs.length > 0) {
            response = toolCallSse(index, {
              action: 'get_window_state', window_ref: pendingWindowRefs.shift(),
              consequence: 'none', show_user: false,
            });
          } else {
            if (focusElementId == null) {
              errors.push(`initial observation did not expose an editable content element: ${observation.slice(0, 800)}`);
            }
            phase = 'focus-receipt';
            response = stateId && windowRef && focusElementId != null
              ? toolCallSse(index, {
                  action: 'click', element_id: focusElementId,
                  window_ref: windowRef, expected_state_id: stateId, consequence: 'none',
                })
              : completeSse('ABU_OFFICE_E2E_ABORTED_NO_CONTENT_ELEMENT');
          }
        }
      }
    } else if (phase === 'dismiss-receipt') {
      const dismissReceipt = latestToolText(body);
      const dismissWindowRef = extractWindowRef(dismissReceipt);
      if (!extractStateId(dismissReceipt) || !dismissWindowRef) {
        if (requiresFreshObservation(dismissReceipt)) {
          phase = afterDismissPhase;
          afterDismissPhase = 'content-observation';
          response = toolCallSse(index, {
            action: 'get_app_state',
            app: app.appName,
            consequence: 'none',
            show_user: false,
          });
        } else {
          errors.push(`startup prompt dismissal did not return a fresh state_id: ${dismissReceipt.slice(0, 500)}`);
          phase = 'complete';
          response = completeSse('ABU_OFFICE_E2E_ABORTED_DISMISS_FAILED');
        }
      } else {
        phase = afterDismissPhase;
        afterDismissPhase = 'content-observation';
        response = toolCallSse(index, {
          action: 'get_window_state',
          window_ref: dismissWindowRef,
          consequence: 'none',
          show_user: false,
        });
      }
    } else if (phase === 'focus-receipt') {
      const focusReceipt = latestToolText(body);
      const stateId = extractStateId(focusReceipt);
      const windowRef = extractWindowRef(focusReceipt);
      const focusElementId = findFocusElementId(focusReceipt, app);
      if (!stateId && requiresFreshObservation(focusReceipt)) {
        phase = 'content-observation';
        response = toolCallSse(index, {
          action: 'get_app_state',
          app: app.appName,
          consequence: 'none',
          show_user: false,
        });
      } else {
        if (!stateId || !windowRef || focusElementId == null) {
          errors.push(`focus action did not return a fresh writable target: ${focusReceipt.slice(0, 500)}`);
        }
        phase = 'type-receipt';
        response = stateId && windowRef && focusElementId != null
          ? toolCallSse(index, {
              action: 'type',
              element_id: focusElementId,
              text: marker,
              window_ref: windowRef,
              expected_state_id: stateId,
              expected_effect: { type: 'any-state-change' },
              consequence: 'none',
            })
          : completeSse('ABU_OFFICE_E2E_ABORTED_NO_FOCUS_STATE');
      }
    } else if (phase === 'type-receipt') {
      const typeReceipt = latestToolText(body);
      const stateId = extractStateId(typeReceipt);
      const windowRef = extractWindowRef(typeReceipt);
      const modalDismissElementId = findModalDismissElementId(typeReceipt);
      if (!stateId && requiresFreshObservation(typeReceipt)) {
        phase = 'content-observation';
        response = toolCallSse(index, {
          action: 'get_app_state', app: app.appName, consequence: 'none', show_user: false,
        });
      } else if (stateId && windowRef && modalDismissElementId != null) {
        result.dismissedModalPrompt = true;
        result.dismissalCount += 1;
        // The text action may already have succeeded before Office displayed
        // its delayed licensing dialog. Dismiss and verify; never type twice.
        afterDismissPhase = 'verification-observation';
        phase = 'dismiss-receipt';
        response = toolCallSse(index, {
          action: 'click',
          element_id: modalDismissElementId,
          window_ref: windowRef,
          expected_state_id: stateId,
          consequence: 'none',
        });
      } else {
        result.verificationReceipt = typeReceipt;
        phase = 'verification-observation';
        response = toolCallSse(index, {
          action: 'get_window_state',
          window_ref: windowRef,
          consequence: 'none',
          show_user: false,
        });
      }
    } else if (phase === 'verification-observation') {
      const observation = latestToolText(body);
      const stateId = extractStateId(observation);
      const windowRef = extractWindowRef(observation);
      const modalDismissElementId = findModalDismissElementId(observation);
      if (stateId && windowRef && modalDismissElementId != null) {
        result.dismissedModalPrompt = true;
        result.dismissalCount += 1;
        phase = 'verification-dismiss-receipt';
        response = toolCallSse(index, {
          action: 'click',
          element_id: modalDismissElementId,
          window_ref: windowRef,
          expected_state_id: stateId,
          consequence: 'none',
        });
      } else {
        result.observedMarker = observation.includes(marker);
        if (!result.observedMarker && app.key !== 'powerpoint') {
          errors.push([
            `post-action observation did not contain the marker: ${observation.slice(0, 600)}`,
            `initial observation: ${result.initialObservation.slice(0, 600)}`,
            `action receipt: ${result.verificationReceipt.slice(0, 600)}`,
          ].join('\n---\n'));
        }
        phase = 'complete';
        response = completeSse(`ABU_OFFICE_E2E_COMPLETE_${app.key}`);
      }
    } else if (phase === 'verification-dismiss-receipt') {
      const dismissReceipt = latestToolText(body);
      const dismissWindowRef = extractWindowRef(dismissReceipt);
      if (!extractStateId(dismissReceipt) || !dismissWindowRef) {
        errors.push(`modal dismissal did not return a fresh state_id: ${dismissReceipt.slice(0, 500)}`);
        phase = 'complete';
        response = completeSse('ABU_OFFICE_E2E_ABORTED_DISMISS_FAILED');
      } else {
        phase = 'verification-observation';
        response = toolCallSse(index, {
          action: 'get_window_state',
          window_ref: dismissWindowRef,
          consequence: 'none',
          show_user: false,
        });
      }
    } else {
      errors.push(`unexpected extra model request ${index + 1}`);
      response = completeSse('ABU_OFFICE_E2E_UNEXPECTED_REQUEST');
    }

    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.end(response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Office mock port unavailable');
  result.baseUrl = `http://2130706433:${address.port}/v1`;
  result.close = () => closeServer(server, activeResponses);
  return result;
}

function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>): Promise<void> {
  for (const response of activeResponses) response.destroy();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      reject(new Error('Timed out closing Office E2E mock'));
    }, 5_000);
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

function officeExecutable(app: OfficeAppDefinition): string {
  return path.join(OFFICE_ROOT, app.executable);
}

function assertOfficeFixtureLicense(): void {
  const script = path.join(OFFICE_ROOT, 'OSPP.VBS');
  if (!fs.existsSync(script)) return; // A missing legacy probe cannot classify modern licensing.
  const status = spawnSync('cscript.exe', ['//nologo', script, '/dstatus'], {
    encoding: 'utf8', timeout: 10_000, env: withoutLiveEvalCredential(process.env),
  });
  if (officeGracePeriodExpired(status.stdout)) {
    throw new Error('Office fixture unavailable: license grace period expired (0xC004F009). Editing acceptance requires a valid activated license; no bypass is attempted.');
  }
}

function officeProcessExists(app: OfficeAppDefinition): boolean {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `if (Get-Process -Name '${path.parse(app.executable).name}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
  ], { stdio: 'ignore', timeout: 5_000, env: withoutLiveEvalCredential(process.env) });
  return result.status === 0;
}

function powerPointContainsMarker(
  child: ChildProcess | undefined,
  executablePath: string,
  marker: string,
): boolean {
  if (!child?.pid) return false;
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$owned = Get-Process -Id ([int]$env:ABU_OFFICE_E2E_PID) -ErrorAction SilentlyContinue; ' +
      'if ($null -eq $owned -or $owned.Path -ne $env:ABU_OFFICE_E2E_PATH) { exit 2 }; ' +
      "$ppt = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application'); " +
      '$found = $false; foreach ($slide in $ppt.ActivePresentation.Slides) { ' +
      'foreach ($shape in $slide.Shapes) { if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1 ' +
      '-and $shape.TextFrame.TextRange.Text.Contains($env:ABU_OFFICE_E2E_MARKER)) { $found = $true } } }; ' +
      'if ($found) { exit 0 } else { exit 1 }',
  ], {
    env: {
      ...withoutLiveEvalCredential(process.env),
      ABU_OFFICE_E2E_MARKER: marker,
      ABU_OFFICE_E2E_PATH: executablePath,
      ABU_OFFICE_E2E_PID: String(child.pid),
    },
    stdio: 'ignore',
    timeout: 10_000,
  });
  return result.status === 0;
}

async function waitForOfficeWindow(child: ChildProcess, executablePath: string): Promise<void> {
  if (!child.pid) throw new Error('Office launch returned no PID');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$p = Get-Process -Id ([int]$env:ABU_OFFICE_E2E_PID) -ErrorAction SilentlyContinue; ' +
        'if ($null -ne $p -and $p.Path -eq $env:ABU_OFFICE_E2E_PATH -and $p.MainWindowHandle -ne 0) { exit 0 } else { exit 1 }',
    ], {
      env: {
        ...withoutLiveEvalCredential(process.env),
        ABU_OFFICE_E2E_PID: String(child.pid),
        ABU_OFFICE_E2E_PATH: executablePath,
      },
      stdio: 'ignore',
      timeout: 5_000,
    });
    if (result.status === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Office PID ${child.pid} did not expose a main window`);
}

function stopOwnedOffice(child: ChildProcess | undefined, executablePath: string): void {
  if (!child?.pid) return;
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$p = Get-Process -Id ([int]$env:ABU_OFFICE_E2E_PID) -ErrorAction SilentlyContinue; ' +
      'if ($null -ne $p -and $p.Path -eq $env:ABU_OFFICE_E2E_PATH) { Stop-Process -Id $p.Id -Force }',
  ], {
    env: {
      ...withoutLiveEvalCredential(process.env),
      ABU_OFFICE_E2E_PID: String(child.pid),
      ABU_OFFICE_E2E_PATH: executablePath,
    },
    stdio: 'ignore',
    timeout: 5_000,
  });
}

interface RecordedApproval {
  buttons: string[];
  cancelId: number;
  defaultId: number;
  kind: 'task' | 'action';
  noLink: boolean;
  title: string;
}

async function installExactOfficeApprovalRecorder(
  electronApp: ElectronApplication,
  appName: string,
  safeFixtureOnly = false,
): Promise<void> {
  await electronApp.evaluate(({ dialog }, { expectedAppName, safeFixtureOnly }) => {
    const state = globalThis as typeof globalThis & {
      __abuOfficeE2eApprovals?: RecordedApproval[];
    };
    state.__abuOfficeE2eApprovals = [];
    const mutableDialog = dialog as unknown as {
      showMessageBox: (...args: unknown[]) => Promise<unknown>;
    };
    const original = mutableDialog.showMessageBox.bind(mutableDialog);
    mutableDialog.showMessageBox = async (...args: unknown[]) => {
      const options = args.at(-1) as {
        buttons?: unknown;
        cancelId?: unknown;
        defaultId?: unknown;
        noLink?: unknown;
        title?: unknown;
      } | undefined;
      const expectedTitles = new Set([
        `允许 Abu 操作「${expectedAppName}」？`,
        `Allow Abu to control "${expectedAppName}"?`,
      ]);
      const actionTitles = new Set([
        '确认这次关键操作？',
        'Confirm this consequential action?',
      ]);
      if (
        options
        && typeof options.title === 'string'
        && (expectedTitles.has(options.title) || actionTitles.has(options.title))
      ) {
        state.__abuOfficeE2eApprovals?.push({
          buttons: Array.isArray(options.buttons)
            ? options.buttons.filter((button): button is string => typeof button === 'string')
            : [],
          cancelId: typeof options.cancelId === 'number' ? options.cancelId : -1,
          defaultId: typeof options.defaultId === 'number' ? options.defaultId : -1,
          kind: expectedTitles.has(options.title) ? 'task' : 'action',
          noLink: options.noLink === true,
          title: options.title,
        });
        return { response: safeFixtureOnly && actionTitles.has(options.title) ? 1 : 0, checkboxChecked: false };
      }
      if (safeFixtureOnly) return { response: typeof options?.cancelId === 'number' ? options.cancelId : 1, checkboxChecked: false };
      return original(...args);
    };
  }, { expectedAppName: appName, safeFixtureOnly });
}

async function readOfficeApprovals(
  electronApp: ElectronApplication,
): Promise<RecordedApproval[]> {
  return electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __abuOfficeE2eApprovals?: RecordedApproval[];
    };
    return state.__abuOfficeE2eApprovals ?? [];
  });
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function configureOfficeProvider(page: Page, baseUrl: string, supportsImages = true): Promise<void> {
  await page.evaluate(({ baseUrl, apiKey, modelId, providerId, supportsImages }) => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    const declaredCapabilities = { supportsTools: true, supportsImages };
    persisted.state.providers = [{
      id: providerId,
      source: 'custom',
      name: 'Abu Office E2E loopback provider',
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl,
      apiKey,
      models: [{
        id: modelId,
        label: 'Abu Office E2E structured model',
        isCustom: true,
        declaredCapabilities,
      }],
      defaultModelId: modelId,
      status: 'verified',
      sortOrder: 0,
      userAdded: true,
      declaredCapabilities,
    }];
    persisted.state.activeModel = { providerId, modelId };
    persisted.state.recentModels = [];
    persisted.state.favoriteModels = [];
    persisted.state.permissionMode = 'standard';
    persisted.state.computerUseEnabled = true;
    persisted.state.guideShown = true;
    persisted.state.guideOpen = false;
    persisted.state.hasAcknowledgedDisclaimer = true;
    persisted.state.hasRunSensitiveAudit_v015 = true;
    window.localStorage.setItem('abu-settings', JSON.stringify({
      ...persisted,
      state: persisted.state,
      version: 42,
    }));
  }, { baseUrl, apiKey: TEST_API_KEY, modelId: TEST_MODEL_ID, providerId: PROVIDER_ID, supportsImages });
  await page.reload();
  await waitForApp(page);
}

test.describe.serial('Windows Office through real Abu Computer Use', () => {
  test.skip(process.platform !== 'win32', 'Windows Office is required');

  for (const officeApp of OFFICE_APPS) {
    test(`${officeApp.key}: observes, types, verifies, and returns through the real agent loop`, async () => {
      const executablePath = officeExecutable(officeApp);
      test.skip(!fs.existsSync(executablePath), `${officeApp.executable} is not installed`);
      expect(officeProcessExists(officeApp), `Refusing to touch an existing ${officeApp.key} process`).toBe(false);

      const marker = `ABU_E2E_${officeApp.key.toUpperCase()}_${randomUUID().replaceAll('-', '')}`;
      const modelMock = await startOfficeModelMock(officeApp, marker);
      let electronApp: ElectronApplication | undefined;
      let dataRoot: ElectronDataRoot | undefined;
      let officeChild: ChildProcess | undefined;
      try {
        officeChild = spawn(executablePath, officeApp.args, { stdio: 'ignore', env: withoutLiveEvalCredential(process.env) });
        await waitForOfficeWindow(officeChild, executablePath);
        // Excel and PowerPoint can replace their first visible bootstrap HWND
        // while creating the blank workbook/deck. The product must reject that
        // identity change; the fixture waits for the test-owned app to settle
        // before asking Abu to pin its exact WindowRef.
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));

        dataRoot = createElectronDataRoot();
        const launched = await launchAbuElectron(dataRoot);
        electronApp = launched.app;
        const page = await electronApp.firstWindow({ timeout: READY_TIMEOUT });
        await waitForApp(page);
        await configureOfficeProvider(page, modelMock.baseUrl);
        await installExactOfficeApprovalRecorder(electronApp, officeApp.appName);

        const prompt = `Use Computer Use to type the isolated test marker into the blank ${officeApp.key} instance.`;
        await page.getByPlaceholder(CHAT_PLACEHOLDER).fill(prompt);
        await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');

        await expect(page.getByText(/ABU_OFFICE_E2E_(?:COMPLETE|ABORTED)_/).last())
          .toBeVisible({ timeout: READY_TIMEOUT });
        expect(modelMock.errors).toEqual([]);
        expect(
          await page.getByText(/ABU_OFFICE_E2E_(?:COMPLETE|ABORTED)_/).last().textContent(),
        ).toBe(modelMock.editingUnavailable
          ? `ABU_OFFICE_E2E_ABORTED_UNLICENSED_${officeApp.key}`
          : `ABU_OFFICE_E2E_COMPLETE_${officeApp.key}`);
        const approvals = await readOfficeApprovals(electronApp);
        const taskApprovals = approvals.filter((approval) => approval.kind === 'task');
        const actionApprovals = approvals.filter((approval) => approval.kind === 'action');
        expect(taskApprovals).toHaveLength(1);
        expect(taskApprovals[0].buttons).toEqual(expect.arrayContaining([
          expect.stringMatching(/允许本任务|Allow for this task/),
          expect.stringMatching(/取消|Cancel/),
        ]));
        expect(taskApprovals[0]).toMatchObject({ defaultId: 0, cancelId: 1, noLink: true });
        expect(actionApprovals).toHaveLength(0);
        expect(taskRequests(modelMock).length).toBeGreaterThanOrEqual(
          modelMock.editingUnavailable ? 2 : 5,
        );
        expect(taskRequests(modelMock).length).toBeLessThanOrEqual(30);
        if (modelMock.editingUnavailable) {
          expect(modelMock.initialObservation).toMatch(/不要继续点击|Do not keep clicking/);
        } else {
          expect(officeContainsMarker(officeApp, officeChild, executablePath, marker), 'Independent test-owned unsaved-document oracle').toBe(true);
          if (officeApp.key === 'powerpoint') {
            expect(powerPointContainsMarker(officeChild, executablePath, marker)).toBe(true);
          } else {
            expect(modelMock.observedMarker).toBe(true);
          }
          expect(modelMock.verificationReceipt).toMatch(/Automatic verification|自动验证/);
          if (officeApp.key !== 'powerpoint') {
            expect(modelMock.verificationReceipt).toMatch(/verified change|已确认界面发生预期变化/);
          }
        }
        const mainLog = await electronApp.evaluate(({ app }) => app.getPath('logs'));
        const { replayFile } = requireForEval('../../scripts/replay-computer-use.cjs') as { replayFile: (file: string) => { complete: boolean; runs: Array<{ phase: string }> } };
        await expect.poll(() => replayFile(path.join(mainLog, 'runtime-observability.jsonl')).runs.some((run) => run.phase === 'ended'), { timeout: 10_000 }).toBe(true);
        const trajectory = replayFile(path.join(mainLog, 'runtime-observability.jsonl'));
        expect(trajectory.complete, 'Real Host trajectory must reconstruct without missing/invalid events').toBe(true);
        await test.info().attach('computer-use-deterministic-evaluation', { contentType: 'application/json', body: JSON.stringify({
          evaluationKind: 'deterministic-model', fixture: officeApp.key,
          outcome: modelMock.editingUnavailable ? 'editing-unavailable' : 'passed', trajectory,
        }, null, 2) });
      } finally {
        if (electronApp) await closeAbuElectron(electronApp);
        await modelMock.close();
        stopOwnedOffice(officeChild, executablePath);
        if (dataRoot) removeElectronDataRoot(dataRoot);
      }
    });
  }
});

// Independent read-only oracle: the model does not get this COM interface.
// Verify the COM application's HWND belongs to the exact test-owned PID before
// inspecting an unsaved document. Existing Office processes are refused above.
function officeContainsMarker(app: OfficeAppDefinition, child: ChildProcess, executablePath: string, marker: string,
  mode: 'verify' | 'prepare' | 'guard' = 'verify'): boolean {
  if (!child.pid) return false;
  const progId = { word: 'Word.Application', excel: 'Excel.Application', powerpoint: 'PowerPoint.Application' }[app.key];
  const verify = {
    word: "$doc=$office.ActiveDocument; $found=($doc.Path -eq '' -and $doc.Content.Text.Contains($env:ABU_OFFICE_E2E_MARKER));",
    excel: "$doc=$office.ActiveWorkbook; $found=($doc.Path -eq '' -and [string]$doc.Worksheets.Item(1).Range('A1').Value2 -eq $env:ABU_OFFICE_E2E_MARKER);",
    powerpoint: "$doc=$office.ActivePresentation; $found=$false; if ($doc.Path -eq '') { foreach ($slide in $doc.Slides) { foreach ($shape in $slide.Shapes) { if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1 -and $shape.TextFrame.TextRange.Text.Contains($env:ABU_OFFICE_E2E_MARKER)) { $found=$true } } } };",
  }[app.key];
  const prepare = {
    word: "if ($office.Documents.Count -eq 0) { [void]$office.Documents.Add() }; $doc=$office.ActiveDocument; if ($office.Documents.Count -ne 1 -or $doc.Path -ne '' -or $doc.Content.Text.Trim() -ne '') { exit 2 }; $doc.Activate(); $found=$true;",
    excel: "if ($office.Workbooks.Count -eq 0) { [void]$office.Workbooks.Add() }; $doc=$office.ActiveWorkbook; if ($office.Workbooks.Count -ne 1 -or $doc.Path -ne '' -or $null -ne $doc.Worksheets.Item(1).UsedRange.Value2) { exit 2 }; $doc.Activate(); $doc.Worksheets.Item(1).Range('A1').Select(); $found=$true;",
    powerpoint: "if ($office.Presentations.Count -eq 0) { [void]$office.Presentations.Add() }; $doc=$office.ActivePresentation; if ($office.Presentations.Count -ne 1 -or $doc.Path -ne '' -or $doc.Slides.Count -ne 0) { exit 2 }; [void]$doc.Slides.Add(1,1); $office.ActiveWindow.View.GotoSlide(1); $doc.Slides.Item(1).Shapes.Title.Select(); $found=$true;",
  }[app.key];
  const guard = {
    word: "$doc=$office.ActiveDocument; $value=$doc.Content.Text.Trim(); $found=($office.Documents.Count -eq 1 -and $doc.Path -eq '' -and ($value -eq '' -or $value -eq $env:ABU_OFFICE_E2E_MARKER));",
    excel: "$doc=$office.ActiveWorkbook; $values=@($doc.Worksheets.Item(1).UsedRange.Value2); $found=($office.Workbooks.Count -eq 1 -and $doc.Path -eq ''); foreach ($value in $values) { if ($null -ne $value -and [string]$value -ne '' -and [string]$value -ne $env:ABU_OFFICE_E2E_MARKER) { $found=$false } };",
    powerpoint: "$doc=$office.ActivePresentation; $found=($office.Presentations.Count -eq 1 -and $doc.Path -eq '' -and $doc.Slides.Count -eq 1); foreach ($slide in $doc.Slides) { foreach ($shape in $slide.Shapes) { if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) { $value=$shape.TextFrame.TextRange.Text.Trim(); if ($value -ne '' -and $value -ne $env:ABU_OFFICE_E2E_MARKER) { $found=$false } } } };",
  }[app.key];
  const readDocument = mode === 'prepare' ? prepare : mode === 'guard' ? guard : verify;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "try { $ErrorActionPreference='Stop'; " +
    '$owned=Get-Process -Id ([int]$env:ABU_OFFICE_E2E_PID); if ($owned.Path -ne $env:ABU_OFFICE_E2E_PATH) { exit 2 }; ' +
    'Add-Type \'using System; using System.Runtime.InteropServices; public static class AbuOfficeOracle { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }\'; ' +
    `$office=[Runtime.InteropServices.Marshal]::GetActiveObject('${progId}'); try { ` +
    '[uint32]$ownerPid=0; [void][AbuOfficeOracle]::GetWindowThreadProcessId([IntPtr]([long]$office.Hwnd),[ref]$ownerPid); ' +
    'if ($ownerPid -ne [uint32]$env:ABU_OFFICE_E2E_PID) { exit 2 }; ' + readDocument +
    'if ($found) { exit 0 } else { exit 1 } } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($office) } ' +
    '} catch { [Console]::Error.WriteLine("OFFICE_ORACLE_ERROR:" + $_.Exception.GetType().Name + ":" + $_.Exception.HResult); exit 3 }',
  ], { env: { ...withoutLiveEvalCredential(process.env), ABU_OFFICE_E2E_PID: String(child.pid), ABU_OFFICE_E2E_PATH: executablePath,
    ABU_OFFICE_E2E_MARKER: marker }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0 && mode === 'prepare') {
    const category = result.stderr?.match(/OFFICE_ORACLE_ERROR:[A-Za-z]+:-?\d+/)?.[0];
    console.warn(`[office-fixture:${app.key}] ${category ?? `not-ready-${result.status ?? 'timeout'}`}`);
  }
  return result.status === 0;
}

test.describe.serial('Windows Office natural-language live model @live', () => {
  test.skip(process.platform !== 'win32' || process.env.ABU_CU_EVAL_LIVE !== '1', 'Explicit Windows live-model opt-in required');
  for (const officeApp of OFFICE_APPS) {
    test(`${officeApp.key}: independent document oracle @live`, async () => {
      const testInfo = test.info();
      test.setTimeout(360_000);
      const configuration = readLiveEvalConfig();
      expect(configuration.status, 'Live-model configuration unavailable; no simulated fallback').toBe('ready');
      assertOfficeFixtureLicense();
      const executablePath = officeExecutable(officeApp);
      expect(fs.existsSync(executablePath), 'Required Office executable unavailable').toBe(true);
      expect(officeProcessExists(officeApp), 'Refusing an existing Office process').toBe(false);
      const marker = `ABU_LIVE_${officeApp.key.toUpperCase()}_${randomUUID().replaceAll('-', '')}`;
      let proxy: LiveProxy | undefined;
      let electronApp: ElectronApplication | undefined;
      let dataRoot: ElectronDataRoot | undefined;
      let officeChild: ChildProcess | undefined;
      let oraclePassed = false;
      let taskFinished = false;
      let trajectory: unknown;
      const startedAt = Date.now();
      try {
        officeChild = spawn(executablePath, officeApp.args, { stdio: 'ignore', env: withoutLiveEvalCredential(process.env) });
        await waitForOfficeWindow(officeChild, executablePath);
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
        expect(officeContainsMarker(officeApp, officeChild, executablePath, marker, 'prepare'), 'Cannot prepare a single blank unsaved test document').toBe(true);
        proxy = await startOfficeLiveProxy(configuration.config!, { appName: officeApp.appName, marker }, {
          assertFixtureReady: () => Boolean(officeChild && officeContainsMarker(officeApp, officeChild, executablePath, marker, 'guard')),
        });
        dataRoot = createElectronDataRoot();
        electronApp = (await launchAbuElectron(dataRoot)).app;
        const page = await electronApp.firstWindow({ timeout: READY_TIMEOUT });
        await waitForApp(page);
        await configureOfficeProvider(page, proxy.baseUrl, false);
        await installExactOfficeApprovalRecorder(electronApp, officeApp.appName, true);
        const prompt = `Only operate the test-owned ${officeApp.appName} window using computer. Use app="${officeApp.appName}" on every call. ` +
          `A blank unsaved ${officeApp.key} document has been prepared. Do not navigate or dismiss dialogs; stop if the document body cannot be reached by typing. ` +
          `Type exactly "${marker}" ${officeApp.key === 'excel' ? 'into cell A1' : officeApp.key === 'powerpoint' ? 'into the title of one blank slide' : 'into the document body'}, then read the interface again to confirm it exists. ` +
          'Do not save, open files, sign in, activate a license, change settings, or operate another application. ' +
          'Only get_app_state, get_ui, type, ax_type and wait are allowed; never click, press a key, scroll or use coordinates/screenshots. If editing is unavailable, stop and report that. ' +
          'Only after successful verification, finish with exactly ABU_LIVE_TASK_DONE.';
        await page.getByPlaceholder(CHAT_PLACEHOLDER).fill(prompt);
        await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');
        await expect(page.getByText('ABU_LIVE_TASK_DONE', { exact: true }).last()).toBeVisible({ timeout: 300_000 });
        // The final model string is not the terminal signal: wait for Host task
        // cleanup and independently inspect document content as well.
        await expect.poll(async () => {
          const diagnostics = await page.evaluate(async () => {
            const shell = (globalThis as typeof globalThis & { __ABU_SHELL__?: {
              getRuntimeDiagnostics: () => Promise<{ computerUseReplay?: { runs: Array<{ phase: string }> } }>;
            } }).__ABU_SHELL__;
            return shell?.getRuntimeDiagnostics();
          });
          trajectory = diagnostics?.computerUseReplay;
          return diagnostics?.computerUseReplay?.runs.some((run) => run.phase === 'ended') ?? false;
        }, { timeout: 10_000 }).toBe(true);
        oraclePassed = officeContainsMarker(officeApp, officeChild, executablePath, marker);
        taskFinished = true;
      } finally {
        if (electronApp) {
          try {
            const mainLog = await electronApp.evaluate(({ app }) => app.getPath('logs'));
            const { replayFile } = requireForEval('../../scripts/replay-computer-use.cjs') as { replayFile: (file: string) => unknown };
            trajectory = replayFile(path.join(mainLog, 'runtime-observability.jsonl'));
          } catch { /* report remains incomplete if runtime evidence is absent */ }
          await closeAbuElectron(electronApp);
        }
        await proxy?.close();
        stopOwnedOffice(officeChild, executablePath);
        if (dataRoot) removeElectronDataRoot(dataRoot);
        const report = buildLiveEvalReport({ oraclePassed, taskFinished, trajectory,
          elapsedMs: Date.now() - startedAt, fixture: officeApp.key, proxyMetrics: proxy?.metrics });
        await testInfo.attach('computer-use-live-evaluation', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
        expect(report.outcome, 'Live-model result requires independent unsaved-document proof and a clean Host trajectory').toBe('passed');
      }
    });
  }
});

test.describe('Owned blank Office fixture preflight @fixture', () => {
  test.skip(process.platform !== 'win32', 'Windows Office is required');
  for (const officeApp of OFFICE_APPS) {
    test(`${officeApp.key}: prepares one unsaved document and independently checks isolation @fixture`, async () => {
      assertOfficeFixtureLicense();
      const executablePath = officeExecutable(officeApp);
      expect(fs.existsSync(executablePath), 'Required Office executable unavailable').toBe(true);
      expect(officeProcessExists(officeApp), 'Refusing an existing Office process').toBe(false);
      const child = spawn(executablePath, officeApp.args, { stdio: 'ignore', env: withoutLiveEvalCredential(process.env) });
      try {
        await waitForOfficeWindow(child, executablePath);
        await expect.poll(() => officeContainsMarker(officeApp, child, executablePath, 'ABU_FIXTURE_MARKER', 'prepare'), { timeout: 20_000 }).toBe(true);
        expect(officeContainsMarker(officeApp, child, executablePath, 'ABU_FIXTURE_MARKER', 'guard')).toBe(true);
        expect(officeContainsMarker(officeApp, child, executablePath, 'ABU_FIXTURE_MARKER')).toBe(false);
      } finally {
        stopOwnedOffice(child, executablePath);
      }
    });
  }
});
