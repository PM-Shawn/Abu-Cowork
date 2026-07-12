/**
 * Tests for showWidgetTool / readMeTool execute() and shared helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  showWidgetTool,
  readMeTool,
  detectWidgetRenderMode,
  validateWidgetCode,
  sanitizeWidgetTitle,
  MAX_WIDGET_CODE_LENGTH,
  SHOW_WIDGET_OK_MARKER,
} from './widgetTools';
import { toolRegistry } from '../registry';
import { registerBuiltinTools } from '../builtins';
import { TOOL_NAMES } from '../toolNames';
import { CORE_TOOL_NAMES } from '../toolPrefetch';

const VALID_INPUT = {
  title: 'Sales chart',
  widget_code: '<div>hi</div>',
  loading_messages: ['Rendering chart…'],
};

describe('showWidgetTool', () => {
  describe('input validation (in spec order)', () => {
    it('rejects an empty title', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, title: '' }),
      ).rejects.toThrow('Parameter error: title cannot be empty.');
    });

    it('rejects a missing title', async () => {
      const { title: _title, ...rest } = VALID_INPUT;
      await expect(showWidgetTool.execute(rest)).rejects.toThrow(
        'Parameter error: title cannot be empty.',
      );
    });

    it('rejects an empty widget_code', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, widget_code: '' }),
      ).rejects.toThrow('Parameter error: widget_code cannot be empty.');
    });

    it('rejects whitespace-only widget_code', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, widget_code: '   \n  ' }),
      ).rejects.toThrow('Parameter error: widget_code cannot be empty.');
    });

    it('rejects an empty loading_messages array', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, loading_messages: [] }),
      ).rejects.toThrow(/loading_messages must have between 1 and 4 entries; received 0/);
    });

    it('rejects loading_messages with more than 4 entries', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, loading_messages: ['a', 'b', 'c', 'd', 'e'] }),
      ).rejects.toThrow(/loading_messages must have between 1 and 4 entries; received 5/);
    });

    it('accepts loading_messages with 1 entry', async () => {
      await expect(showWidgetTool.execute(VALID_INPUT)).resolves.toContain('Sales chart');
    });

    it('accepts loading_messages with 4 entries', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, loading_messages: ['a', 'b', 'c', 'd'] }),
      ).resolves.toContain('Sales chart');
    });

    it.each(['<!DOCTYPE html><div>x</div>', '<html><div>x</div></html>', '<head><style>x</style></head><div>x</div>', '<body><div>x</div></body>'])(
      'rejects a full-document wrapper tag: %s',
      async (widget_code) => {
        await expect(
          showWidgetTool.execute({ ...VALID_INPUT, widget_code }),
        ).rejects.toThrow('widget_code must be a raw SVG or HTML fragment without document wrapper tags.');
      },
    );

    it('rejects widget_code referencing localStorage', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, widget_code: '<script>localStorage.setItem("a","b")</script>' }),
      ).rejects.toThrow(/localStorage\/sessionStorage/);
    });

    it('rejects widget_code referencing sessionStorage', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, widget_code: '<script>sessionStorage.getItem("a")</script>' }),
      ).rejects.toThrow(/localStorage\/sessionStorage/);
    });

    it('rejects widget_code using position:fixed', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, widget_code: '<div style="position: fixed; top:0">x</div>' }),
      ).rejects.toThrow(/position:fixed/);
    });

    it('rejects widget_code assigning fixed via el.style.position (JS bypass)', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, widget_code: '<script>el.style.position = "fixed"</script><div>x</div>' }),
      ).rejects.toThrow(/position:fixed/);
    });

    it('rejects widget_code assigning fixed via setProperty (JS bypass)', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, widget_code: "<script>el.style.setProperty('position', 'fixed')</script><div>x</div>" }),
      ).rejects.toThrow(/position:fixed/);
    });

    it('rejects widget_code exceeding the ~1MB size budget', async () => {
      const huge = '<div>' + 'x'.repeat(MAX_WIDGET_CODE_LENGTH) + '</div>';
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, widget_code: huge }),
      ).rejects.toThrow(/1MB size budget/);
    });

    it.each([[[null]], [[42]], [['']], [['ok', '  ']]])(
      'rejects loading_messages with a non-string or blank entry: %j',
      async (loading_messages) => {
        await expect(
          showWidgetTool.execute({ ...VALID_INPUT, loading_messages }),
        ).rejects.toThrow(/loading_messages\[\d\] must be a non-empty string/);
      },
    );

    it('rejects widget_code containing a <form> element', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, widget_code: '<form><input/></form>' }),
      ).rejects.toThrow(/<form> element/);
    });

    it('does not false-positive on the word "formation" (word-boundary form check)', async () => {
      await expect(
        showWidgetTool.execute({ ...VALID_INPUT, widget_code: '<div>Formation chart</div>' }),
      ).resolves.toContain('Sales chart');
    });
  });

  describe('success result', () => {
    it('starts with the machine-readable OK marker followed by the short confirmation', async () => {
      const result = await showWidgetTool.execute(VALID_INPUT);
      expect(result).toBe(`${SHOW_WIDGET_OK_MARKER}Widget rendered: Sales chart`);
      expect(String(result).startsWith(SHOW_WIDGET_OK_MARKER)).toBe(true);
      expect(String(result)).not.toContain('<div>hi</div>');
    });
  });

  it('is concurrency-safe (read-only, no disk mutation)', () => {
    expect(showWidgetTool.isConcurrencySafe).toBe(true);
  });
});

describe('validateWidgetCode (pure gate shared with the chat UI)', () => {
  it('returns null for a valid fragment', () => {
    expect(validateWidgetCode('<div>ok</div>')).toBeNull();
  });

  it('classifies each violation', () => {
    expect(validateWidgetCode('')).toBe('empty');
    expect(validateWidgetCode(undefined)).toBe('empty');
    expect(validateWidgetCode('x'.repeat(MAX_WIDGET_CODE_LENGTH + 1))).toBe('too-large');
    expect(validateWidgetCode('<html><div>x</div></html>')).toBe('document');
    expect(validateWidgetCode('<script>localStorage.x</script>')).toBe('storage');
    expect(validateWidgetCode('<div style="position:fixed">x</div>')).toBe('position-fixed');
    expect(validateWidgetCode('<script>a.style.position="fixed"</script>')).toBe('position-fixed');
    expect(validateWidgetCode("<script>s.setProperty('position', 'fixed')</script>")).toBe('position-fixed');
    expect(validateWidgetCode('<form>x</form>')).toBe('form');
  });
});

describe('sanitizeWidgetTitle', () => {
  it('keeps Unicode letters/digits and converts spaces/hyphens to underscore', () => {
    expect(sanitizeWidgetTitle('2024/Q1 营收')).toBe('2024Q1_营收');
    expect(sanitizeWidgetTitle('Progress: 50%')).toBe('Progress_50');
    expect(sanitizeWidgetTitle('sales-by-region chart')).toBe('sales_by_region_chart');
  });

  it('collapses runs and trims leading/trailing underscores', () => {
    expect(sanitizeWidgetTitle('  --hello--  ')).toBe('hello');
    expect(sanitizeWidgetTitle('a  -  b')).toBe('a_b');
  });

  it('falls back to "widget" when nothing survives', () => {
    expect(sanitizeWidgetTitle(undefined)).toBe('widget');
    expect(sanitizeWidgetTitle('')).toBe('widget');
    expect(sanitizeWidgetTitle('!!!///:::')).toBe('widget');
  });
});

describe('detectWidgetRenderMode', () => {
  it('detects svg for a raw <svg> fragment', () => {
    expect(detectWidgetRenderMode('<svg viewBox="0 0 10 10"></svg>')).toBe('svg');
  });

  it('detects svg case-insensitively and ignoring leading whitespace', () => {
    expect(detectWidgetRenderMode('  \n<SVG width="10"></SVG>')).toBe('svg');
  });

  it('detects html for anything else', () => {
    expect(detectWidgetRenderMode('<div>chart</div>')).toBe('html');
    expect(detectWidgetRenderMode('<canvas></canvas>')).toBe('html');
  });
});

describe('readMeTool', () => {
  it('returns guidelines text containing the hard rules', async () => {
    const result = await readMeTool.execute({});
    expect(String(result)).toContain('Hard rules');
    expect(String(result)).toContain('position: fixed');
  });

  it('filters to only the requested modules', async () => {
    const result = String(await readMeTool.execute({ modules: ['chart'] }));
    expect(result).toContain('## Charts');
    expect(result).not.toContain('## Diagrams');
    expect(result).not.toContain('## Interactive widgets');
    expect(result).not.toContain('## UI mockups');
  });

  it('unknown-only module names (e.g. the typo "charts") return hard rules only — NOT all modules', async () => {
    const result = String(await readMeTool.execute({ modules: ['charts'] }));
    expect(result).toContain('Hard rules');
    expect(result).not.toContain('## Charts');
    expect(result).not.toContain('## Diagrams');
    expect(result).not.toContain('## Interactive widgets');
    expect(result).not.toContain('## UI mockups');
  });

  it('mixed known + unknown names keep the known module', async () => {
    const result = String(await readMeTool.execute({ modules: ['charts', 'diagram'] }));
    expect(result).toContain('## Diagrams');
    expect(result).not.toContain('## Charts');
  });

  it('is concurrency-safe', () => {
    expect(readMeTool.isConcurrencySafe).toBe(true);
  });
});

describe('builtins registration', () => {
  it('registers show_widget and read_me in the builtin tool registry', () => {
    registerBuiltinTools();
    expect(toolRegistry.has(TOOL_NAMES.SHOW_WIDGET)).toBe(true);
    expect(toolRegistry.has(TOOL_NAMES.READ_ME)).toBe(true);
  });

  it('wires TOOL_NAMES.SHOW_WIDGET / READ_ME to the expected literal names', () => {
    expect(TOOL_NAMES.SHOW_WIDGET).toBe('show_widget');
    expect(TOOL_NAMES.READ_ME).toBe('read_me');
  });

  it('keeps show_widget and read_me in the always-loaded core tool set', () => {
    expect(CORE_TOOL_NAMES.has(TOOL_NAMES.SHOW_WIDGET)).toBe(true);
    expect(CORE_TOOL_NAMES.has(TOOL_NAMES.READ_ME)).toBe(true);
  });
});
