/**
 * MCP Tool definitions for browser automation.
 * Each tool sends a request to the Chrome Extension via WebSocket.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendToExtension, isExtensionConnected } from './wsServer.js';

// --- Element Locator Schema (reusable) ---

const LocatorDescription = `How to find the element. Supports multiple strategies:
- { "text": "按钮文字" } — find by visible text content (most common)
- { "css": "#id" } or { "css": ".class" } — find by CSS selector
- { "role": "button", "name": "Submit" } — find by ARIA role
- { "testId": "submit-btn" } — find by data-testid attribute
- { "ref": "e3" } — use reference ID from a previous snapshot
- { "xpath": "//div[@class='x']" } — find by XPath (fallback)`;

// --- Helper ---

function ensureConnected(): void {
  if (!isExtensionConnected()) {
    throw new Error(
      'Chrome Extension is not connected. Please install the Abu Browser Extension and ensure it is enabled.'
    );
  }
}

function formatResult(response: { success: boolean; data?: unknown; error?: string }): string {
  if (!response.success) {
    return `Error: ${response.error ?? 'Unknown error'}`;
  }
  if (typeof response.data === 'string') {
    return response.data;
  }
  return JSON.stringify(response.data, null, 2);
}

/**
 * Parse and validate a JSON locator string from LLM input.
 * Ensures the result is a plain object with at least one known locator key.
 */
function parseLocator(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Locator must be a JSON object');
  }
  const validKeys = ['css', 'text', 'tag', 'role', 'name', 'xpath', 'testId', 'ref'];
  const hasValidKey = Object.keys(parsed).some(k => validKeys.includes(k));
  if (!hasValidKey) {
    throw new Error(`Locator must contain at least one of: ${validKeys.join(', ')}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parse and validate a JSON wait condition string from LLM input.
 */
function parseCondition(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Condition must be a JSON object');
  }
  const validTypes = ['appear', 'disappear', 'enabled', 'textContains', 'urlContains'];
  if (!validTypes.includes(parsed.type as string)) {
    throw new Error(`Condition type must be one of: ${validTypes.join(', ')}`);
  }
  return parsed as Record<string, unknown>;
}

// --- Register all tools ---

export function registerTools(server: McpServer): void {

  // 1. browser_get_tabs
  server.tool(
    'get_tabs',
    'Get all open Chrome browser tabs grouped by window. Returns a summary with the current window/tab info, plus a list of windows each containing their tabs. Use this first to find the target tab ID for other browser actions.',
    async () => {
      ensureConnected();
      const res = await sendToExtension('get_tabs');
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 2. browser_snapshot
  server.tool(
    'snapshot',
    `Get a structured snapshot of all interactive elements on the page (buttons, inputs, links, selects, etc.). Returns each element with a short reference ID (e.g., "e1") that can be used in subsequent actions. This is the primary way to understand what's on a page before taking action.`,
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      selector: z.string().optional().describe('Optional CSS selector to scope the snapshot to a specific area of the page'),
    },
    async ({ tabId, selector }) => {
      ensureConnected();
      const res = await sendToExtension('snapshot', { tabId, selector });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 3. browser_click
  server.tool(
    'click',
    'Click an element on the page. Returns the result of the click action.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      locator: z.string().describe(`JSON string of element locator. ${LocatorDescription}`),
    },
    async ({ tabId, locator }) => {
      ensureConnected();
      const parsed = parseLocator(locator);
      const res = await sendToExtension('click', { tabId, locator: parsed });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 4. browser_fill
  server.tool(
    'fill',
    'Fill in a text input, textarea, or other editable field. Clears existing content and types the new value, triggering proper input/change events for framework compatibility (React, Vue, etc.).',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      locator: z.string().describe(`JSON string of element locator. ${LocatorDescription}`),
      value: z.string().describe('The text value to fill into the field'),
    },
    async ({ tabId, locator, value }) => {
      ensureConnected();
      const parsed = parseLocator(locator);
      const res = await sendToExtension('fill', { tabId, locator: parsed, value });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 5. browser_select
  server.tool(
    'select',
    'Select an option from a <select> dropdown element.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      locator: z.string().describe(`JSON string of element locator. ${LocatorDescription}`),
      value: z.string().describe('The option value or visible text to select'),
    },
    async ({ tabId, locator, value }) => {
      ensureConnected();
      const parsed = parseLocator(locator);
      const res = await sendToExtension('select', { tabId, locator: parsed, value });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 6. browser_wait_for
  server.tool(
    'wait_for',
    `Wait for a condition to be met on the page. Useful for waiting for elements to appear after a click, waiting for loading to complete, or waiting for page navigation. Returns when the condition is met or times out.`,
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      condition: z.string().describe(
        `JSON string of wait condition. Options:
- { "type": "appear", "locator": { "text": "成功" } } — wait for element to appear
- { "type": "disappear", "locator": { "css": ".loading" } } — wait for element to disappear
- { "type": "enabled", "locator": { "text": "提交" } } — wait for element to become clickable
- { "type": "textContains", "locator": { "css": "#status" }, "text": "完成" } — wait for text content
- { "type": "urlContains", "pattern": "/success" } — wait for URL change`
      ),
      timeout: z.number().optional().default(30000).describe('Maximum wait time in ms (default: 30000)'),
    },
    async ({ tabId, condition, timeout }) => {
      ensureConnected();
      const parsed = parseCondition(condition);
      const res = await sendToExtension('wait_for', { tabId, condition: parsed, timeout }, timeout + 5000);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 7. browser_extract_text
  server.tool(
    'extract_text',
    'Extract text content from the page or a specific element. Useful for reading content, checking values, or verifying results.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      selector: z.string().optional().describe('CSS selector to extract text from. If omitted, extracts the full page text (may be large).'),
    },
    async ({ tabId, selector }) => {
      ensureConnected();
      const res = await sendToExtension('extract_text', { tabId, selector });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 8. browser_extract_table
  server.tool(
    'extract_table',
    'Extract structured data from an HTML table on the page. Returns headers and rows as arrays.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      selector: z.string().optional().describe('CSS selector for the target table. If omitted, extracts the largest table on the page.'),
    },
    async ({ tabId, selector }) => {
      ensureConnected();
      const res = await sendToExtension('extract_table', { tabId, selector });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 9. browser_scroll
  server.tool(
    'scroll',
    'Scroll the page or a specific element.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
      amount: z.number().optional().default(500).describe('Scroll amount in pixels (default: 500)'),
      selector: z.string().optional().describe('CSS selector for the scrollable element. If omitted, scrolls the whole page.'),
    },
    async ({ tabId, direction, amount, selector }) => {
      ensureConnected();
      const res = await sendToExtension('scroll', { tabId, direction, amount, selector });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 10. browser_navigate
  server.tool(
    'navigate',
    'Navigate a tab to a specific URL, or go back/forward in history.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      url: z.string().optional().describe('URL to navigate to. Omit for back/forward.'),
      action: z.enum(['goto', 'back', 'forward', 'reload']).optional().default('goto').describe('Navigation action (default: goto)'),
    },
    async ({ tabId, url, action }) => {
      ensureConnected();
      const res = await sendToExtension('navigate', { tabId, url, action });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 11. browser_keyboard
  server.tool(
    'keyboard',
    'Send keyboard events to the page. Supports key combinations.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "a", "ArrowDown")'),
      modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'meta'])).optional().describe('Modifier keys to hold'),
    },
    async ({ tabId, key, modifiers }) => {
      ensureConnected();
      const res = await sendToExtension('keyboard', { tabId, key, modifiers });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 12. browser_execute_js
  server.tool(
    'execute_js',
    'Execute arbitrary JavaScript code in the context of the page. Use this as a fallback when other tools cannot achieve the desired result. Returns the result of the expression.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
      code: z.string().describe('JavaScript code to execute. The last expression value is returned.'),
    },
    async ({ tabId, code }) => {
      ensureConnected();
      const res = await sendToExtension('execute_js', { tabId, code }, 60_000);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 13. browser_screenshot
  server.tool(
    'screenshot',
    'Take a screenshot of the visible area of a tab. Returns a base64-encoded PNG image. Useful for visual confirmation of actions.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
    },
    async ({ tabId }) => {
      ensureConnected();
      const res = await sendToExtension('screenshot', { tabId });
      if (res.success && typeof res.data === 'string') {
        return {
          content: [{
            type: 'image' as const,
            data: res.data.replace(/^data:image\/png;base64,/, ''),
            mimeType: 'image/png' as const,
          }]
        };
      }
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 14. browser_screenshot_full_page
  server.tool(
    'screenshot_full_page',
    'Take a full-page screenshot by scrolling and stitching the entire page content. Returns a base64-encoded PNG image of the complete page. Use this when the user asks for a "long screenshot" or wants to capture content beyond the visible viewport. This is slower than a regular screenshot.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
    },
    async ({ tabId }) => {
      ensureConnected();
      // Full-page capture needs more time: scroll + multiple captures + stitch
      const res = await sendToExtension('screenshot_full_page', { tabId }, 120_000);
      if (res.success && typeof res.data === 'string') {
        return {
          content: [{
            type: 'image' as const,
            data: res.data.replace(/^data:image\/png;base64,/, ''),
            mimeType: 'image/png' as const,
          }]
        };
      }
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 15. browser_connection_status
  server.tool(
    'connection_status',
    'Check whether the Chrome Extension is connected to this bridge. Use this to verify the extension is ready before performing browser actions.',
    async () => {
      const connected = isExtensionConnected();
      return {
        content: [{
          type: 'text' as const,
          text: connected
            ? 'Chrome Extension is connected and ready.'
            : 'Chrome Extension is NOT connected. Please ensure the Abu Browser Extension is installed and enabled in Chrome.'
        }]
      };
    }
  );

  // 15. get_downloads — recent download activity
  server.tool(
    'get_downloads',
    'Get recent file downloads from the browser. Useful for confirming that a file was downloaded after clicking a download button.',
    async () => {
      ensureConnected();
      const res = await sendToExtension('get_downloads');
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 16. start_recording — record user interactions
  server.tool(
    'start_recording',
    'Start recording user interactions on a page (clicks, inputs, selects). The user performs actions manually, then call stop_recording to get a list of recorded steps that can be used as an automation template.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
    },
    async ({ tabId }) => {
      ensureConnected();
      const res = await sendToExtension('start_recording', { tabId });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 17. stop_recording — stop recording and return captured steps
  server.tool(
    'stop_recording',
    'Stop recording user interactions and return the captured steps. Each step includes the action type, element locator, and value. Use these steps as a template to replay the automation.',
    {
      tabId: z.number().describe('Tab ID from get_tabs'),
    },
    async ({ tabId }) => {
      ensureConnected();
      const res = await sendToExtension('stop_recording', { tabId });
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );
}
