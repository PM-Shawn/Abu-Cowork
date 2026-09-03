// @vitest-environment happy-dom
/**
 * Characterization tests for the content-script DOM runtime.
 *
 * This file is a safety net, not a spec: it pins what the runtime does *today*
 * so the upcoming locator/snapshot rework can be reviewed as an intentional
 * diff instead of a guess. Behaviours that are known to be wrong are grouped
 * under "known defects" and asserted as-is — when a fix lands, those
 * assertions must be inverted deliberately, in the same commit as the fix.
 *
 * Why `__ABU_ELECTRON_BROWSER_RUNTIME__`: the module has two transports. With
 * the marker present it exposes `handleAction` and never touches `chrome.*`,
 * which is exactly the entry point the built-in Electron browser drives
 * (`electron/browserHost.cjs` injects this same bundle into an isolated
 * world). Testing through it covers both surfaces at once.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

type HandleAction = (action: string, payload: Record<string, unknown>) => Promise<unknown>;

interface SnapshotElement {
  ref: string;
  tag: string;
  enabled: boolean;
  visible: boolean;
  text?: string;
  type?: string;
  id?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  role?: string;
  options?: Array<{ value: string; text: string }>;
}
interface PageSnapshot {
  elements: SnapshotElement[];
  truncated?: boolean;
  message?: string;
}
interface ActionResult {
  success: boolean;
  message: string;
  elementText?: string;
  previousValue?: string;
  target?: { ref: string; tag: string; id?: string; role?: string; text?: string };
}
interface WaitResult extends ActionResult {
  timedOut: boolean;
  elapsed: number;
}

let handleAction: HandleAction;

const snapshot = (payload: Record<string, unknown> = {}) =>
  handleAction('snapshot', payload) as Promise<PageSnapshot>;
const click = (locator: Record<string, unknown>) =>
  handleAction('click', { locator }) as Promise<ActionResult>;
const fill = (locator: Record<string, unknown>, value: string) =>
  handleAction('fill', { locator, value }) as Promise<ActionResult>;
const waitFor = (condition: Record<string, unknown>, timeout: number) =>
  handleAction('wait_for', { condition, timeout }) as Promise<WaitResult>;
const select = (locator: Record<string, unknown>, value: string) =>
  handleAction('select', { locator, value }) as Promise<ActionResult>;
const getHtml = (payload: Record<string, unknown> = {}) =>
  handleAction('get_html', payload) as Promise<string>;

/** Size used for every "laid out" element — see the stub below. */
const LAID_OUT = { width: 100, height: 20 };

/** Fixture rule for "this element has no box" — see the stub's comment. */
function isHiddenInFixture(el: Element): boolean {
  if (el.closest?.('[data-hidden]') !== null) return true;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if ((node as HTMLElement).style?.display === 'none') return true;
  }
  return false;
}

beforeAll(async () => {
  // happy-dom performs no layout, so getBoundingClientRect() is all zeros and
  // isVisible() would treat the entire page as invisible. Stub it: elements
  // carrying `data-hidden` report a zero box, everything else reports a real
  // one. (isVisible()'s computed-style branch is unreachable here because
  // happy-dom leaves offsetParent `undefined`, not `null`.)
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      // Two ways to have no box, and the runtime must tell them apart:
      //  - `data-hidden` = laid out at zero size but still displayed (an antd
      //    combobox input, a popup mid-animation)
      //  - `display: none` anywhere up the chain = not rendered at all
      // Marking only the element itself would let a hidden container keep
      // reporting laid-out children, which is not a state a browser can be in.
      const hidden = isHiddenInFixture(this);
      const w = hidden ? 0 : LAID_OUT.width;
      const h = hidden ? 0 : LAID_OUT.height;
      return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) };
    },
  });

  const runtime: { handleAction?: HandleAction } = {};
  (globalThis as unknown as Record<string, unknown>).__ABU_ELECTRON_BROWSER_RUNTIME__ = runtime;
  await import('./index');
  if (!runtime.handleAction) throw new Error('content runtime did not register handleAction');
  handleAction = runtime.handleAction;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

/** Minimal stand-in for the jeecg/antd form the field report came from. */
function renderAntdLikeForm(): void {
  document.body.innerHTML = `
    <form>
      <input id="form_item_equipmentCode" type="text" placeholder="请输入设备编号" />
      <textarea id="form_item_remark" placeholder="请输入备注"></textarea>
      <div class="ant-select">
        <input id="form_item_equipmentTypeId" role="combobox" readonly placeholder="请选择设备类型" />
      </div>
    </form>
    <div class="ant-select-dropdown">
      <div role="listbox">
        <div class="ant-select-item-option" role="option" data-testid="opt-dong">动设备</div>
        <div class="ant-select-item-option" role="option">静设备</div>
      </div>
    </div>`;
}

describe('locator strategies (pinned — must not change)', () => {
  it('resolves a ref handed out by the previous snapshot', async () => {
    document.body.innerHTML = '<button id="go">提交</button>';
    const snap = await snapshot();
    const ref = snap.elements.find((e) => e.tag === 'button')!.ref;

    const result = await click({ ref });

    expect(result.success).toBe(true);
    expect(result.elementText).toBe('提交');
  });

  it('resolves a css selector', async () => {
    document.body.innerHTML = '<button class="primary">保存</button>';
    const result = await click({ css: '.primary' });
    expect(result.elementText).toBe('保存');
  });

  it('resolves a testId', async () => {
    document.body.innerHTML = '<button data-testid="submit-btn">提交</button>';
    const result = await click({ testId: 'submit-btn' });
    expect(result.elementText).toBe('提交');
  });

  it('resolves role + accessible name', async () => {
    document.body.innerHTML = '<div role="button" aria-label="关闭">x</div>';
    const result = await click({ role: 'button', name: '关闭' });
    expect(result.success).toBe(true);
  });

  it('never lets a hostile locator value select a different element', async () => {
    document.body.innerHTML = '<button data-testid="ok">X</button>';
    // The value below is an attempt to break out of the attribute selector and
    // match the document root. Escaping must make that impossible; today the
    // call fails loudly, which is an acceptable outcome. What must never
    // happen is a silent match on <html>/<body>.
    await expect(click({ testId: 'a"]:root' })).rejects.toThrow();
  });

  it('reports a missing element as an error rather than a silent no-op', async () => {
    document.body.innerHTML = '<div>empty</div>';
    await expect(click({ css: '#nope' })).rejects.toThrow(/Element not found/);
  });

  // document.evaluate is not implemented by happy-dom, so the xpath branch
  // cannot run here. Left explicit so the gap is visible rather than assumed
  // covered.
  it.skip('resolves an xpath locator (needs a DOM with document.evaluate)', () => {});
});

describe('fill contract (pinned — must not change)', () => {
  it('writes through the native value setter and fires input/change/blur', async () => {
    document.body.innerHTML = '<input id="a" type="text" value="old" />';
    const el = document.getElementById('a') as HTMLInputElement;
    const seen: string[] = [];
    for (const type of ['input', 'change', 'blur']) {
      el.addEventListener(type, () => seen.push(type));
    }

    const result = await fill({ css: '#a' }, 'EQ-2026-001');

    expect(el.value).toBe('EQ-2026-001');
    expect(result.previousValue).toBe('old');
    // Order matters: frameworks that re-render on `input` must see the new
    // value before `blur` triggers validation.
    expect(seen).toEqual(['input', 'change', 'blur']);
  });

  it('fills a textarea', async () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    await fill({ css: '#t' }, '每日巡检');
    expect((document.getElementById('t') as HTMLTextAreaElement).value).toBe('每日巡检');
  });
});

describe('snapshot contract (pinned — must not change)', () => {
  it('describes inputs, selects and links with a stable field set', async () => {
    document.body.innerHTML = `
      <a href="https://example.com/x">链接</a>
      <input id="i" type="text" placeholder="请输入设备编号" />
      <select id="s"><option value="1">动设备</option></select>`;

    const snap = await snapshot();
    const byTag = (tag: string) => snap.elements.find((e) => e.tag === tag)!;

    expect(byTag('a')).toMatchObject({ tag: 'a', href: 'https://example.com/x', enabled: true, visible: true });
    expect(byTag('input')).toMatchObject({ type: 'text', placeholder: '请输入设备编号' });
    expect(byTag('select')).toMatchObject({ options: [{ value: '1', text: '动设备' }] });
    expect(byTag('a').ref).toMatch(/^e\d+$/);
  });

  it('scopes to a css selector when asked', async () => {
    document.body.innerHTML = '<div id="in"><button>内</button></div><button>外</button>';
    const snap = await snapshot({ selector: '#in' });
    expect(snap.elements.map((e) => e.text)).toEqual(['内']);
  });

  it('skips elements the page has actually hidden', async () => {
    document.body.innerHTML =
      '<button>可见</button><div style="display:none"><button>隐藏</button></div>';
    const snap = await snapshot();
    expect(snap.elements.map((e) => e.text)).toEqual(['可见']);
  });

  it('keeps a control that collapsed its own box but is still on the page', async () => {
    // antd's combobox is a width:0 / opacity:0 <input> next to the span the
    // user sees. Requiring a layout box dropped every dropdown on the page out
    // of the snapshot, so an agent concluded the form had no selects at all.
    document.body.innerHTML =
      '<div class="ant-select"><span class="shown">请选择设备类型</span>' +
      '<input data-hidden id="form_item_typeId" role="combobox" /></div>';

    const snap = await snapshot();

    expect(snap.elements.some((e) => e.id === 'form_item_typeId')).toBe(true);
  });

  it('still leaves out a collapsed control inside a closed menu', async () => {
    document.body.innerHTML =
      '<div class="menu" style="display:none"><input data-hidden id="inMenu" role="combobox" /></div>';
    const snap = await snapshot();
    expect(snap.elements.some((e) => e.id === 'inMenu')).toBe(false);
  });

  it('caps the element list and says how to narrow the scope', async () => {
    document.body.innerHTML = Array.from({ length: 205 }, (_, i) => `<button>b${i}</button>`).join('');
    const snap = await snapshot();
    expect(snap.elements).toHaveLength(200);
    expect(snap.truncated).toBe(true);
    // The in-page cap already carries a recovery hint. The main-process
    // truncation that sits above it does not — that asymmetry is the thing
    // the rework has to remove.
    expect(snap.message).toMatch(/selector/);
  });

  it('exposes ARIA combobox/option nodes, so custom dropdowns are reachable by ref', async () => {
    renderAntdLikeForm();
    const snap = await snapshot();
    const texts = snap.elements.map((e) => e.text);
    expect(texts).toContain('动设备');
    expect(snap.elements.some((e) => e.role === 'combobox')).toBe(true);
  });
});

/**
 * ── U5: sensitive-value redaction ─────────────────────────────────────────
 *
 * A snapshot used to serialize `input.value` verbatim for every field,
 * password boxes and card numbers included, and `fill` handed back the value
 * that was already in the field as `previousValue`. Both land in the model's
 * context (and from there in logs, IM approval messages, diagnostic bundles).
 * The value is replaced by a marker; everything ELSE about the field — its
 * ref, type, placeholder, name, id — stays, because the agent still has to be
 * able to FIND and FILL these fields.
 *
 * One bundle serves both transports (the Chrome extension and the built-in
 * Electron browser inject the same `content.js`), so these cases cover both.
 */
describe('sensitive values are redacted, but the fields stay fillable (U5)', () => {
  const REDACTED = '[value redacted]';

  const valueOf = (snap: PageSnapshot, id: string) =>
    snap.elements.find((e) => e.id === id)?.value;

  it('redacts a password field value', async () => {
    document.body.innerHTML = '<input id="pw" type="password" value="hunter2" />';
    expect(valueOf(await snapshot(), 'pw')).toBe(REDACTED);
  });

  it('redacts every autocomplete=cc-* field', async () => {
    document.body.innerHTML = `
      <input id="num" autocomplete="cc-number" value="4111111111111111" />
      <input id="csc" autocomplete="cc-csc" value="123" />
      <input id="exp" autocomplete="CC-EXP" value="12/30" />`;
    const snap = await snapshot();
    expect(valueOf(snap, 'num')).toBe(REDACTED);
    expect(valueOf(snap, 'csc')).toBe(REDACTED);
    // Case-insensitive: the attribute is author-written and often shouted.
    expect(valueOf(snap, 'exp')).toBe(REDACTED);
  });

  it('redacts autocomplete=one-time-code', async () => {
    document.body.innerHTML = '<input id="otp" autocomplete="one-time-code" value="483920" />';
    expect(valueOf(await snapshot(), 'otp')).toBe(REDACTED);
  });

  it('reads the autocomplete token out of a multi-token attribute', async () => {
    // The spec allows `section-* shipping cc-number`; a whole-string compare
    // would miss every field written that way.
    document.body.innerHTML =
      '<input id="num" autocomplete="section-blue billing cc-number" value="4111111111111111" />';
    expect(valueOf(await snapshot(), 'num')).toBe(REDACTED);
  });

  it('leaves an ordinary field value alone', async () => {
    document.body.innerHTML = '<input id="code" type="text" value="EQ-001" />';
    expect(valueOf(await snapshot(), 'code')).toBe('EQ-001');
  });

  it('keeps everything the agent needs to fill the redacted field', async () => {
    document.body.innerHTML =
      '<input id="pw" name="password" type="password" placeholder="请输入密码" value="hunter2" />';
    const el = (await snapshot()).elements.find((e) => e.id === 'pw')!;
    expect(el).toMatchObject({
      id: 'pw',
      name: 'password',
      type: 'password',
      placeholder: '请输入密码',
      enabled: true,
    });
    expect(el.ref).toMatch(/^e\d+$/);
  });

  it('redacting does not stop the agent from filling the field', async () => {
    document.body.innerHTML = '<input id="pw" type="password" value="old" />';
    const result = await fill({ css: '#pw' }, 'new-secret');
    expect(result.success).toBe(true);
    expect((document.getElementById('pw') as HTMLInputElement).value).toBe('new-secret');
  });

  it('fill does not hand back the previous value of a sensitive field', async () => {
    document.body.innerHTML = '<input id="pw" type="password" value="hunter2" />';
    const result = await fill({ css: '#pw' }, 'new-secret');
    expect(result.previousValue).toBe(REDACTED);
  });

  it('fill still reports the previous value of an ordinary field', async () => {
    document.body.innerHTML = '<input id="code" type="text" value="EQ-001" />';
    const result = await fill({ css: '#code' }, 'EQ-002');
    expect(result.previousValue).toBe('EQ-001');
  });

  it('an empty sensitive field reports nothing rather than a redaction marker', async () => {
    document.body.innerHTML = '<input id="pw" type="password" />';
    expect(valueOf(await snapshot(), 'pw')).toBeUndefined();
    const result = await fill({ css: '#pw' }, 'x');
    expect(result.previousValue).toBeUndefined();
  });

  it('a textarea carrying a one-time-code autocomplete is redacted too', async () => {
    document.body.innerHTML = '<textarea id="ta" autocomplete="one-time-code">483920</textarea>';
    expect(valueOf(await snapshot(), 'ta')).toBe(REDACTED);
  });

  /**
   * C1 (review round 1). `info.value` was redacted while `info.text` — set from
   * `getVisibleText`, which returns `input.value` for an INPUT — carried the
   * same secret verbatim on the SAME object. Four model-facing paths all route
   * through that one function, so each is asserted here rather than trusting
   * the shared helper: a future caller that reaches for the raw value again
   * has to break one of these.
   */
  describe('every reporting path, not just .value (C1)', () => {
    const textOf = (snap: PageSnapshot, id: string) =>
      snap.elements.find((e) => e.id === id)?.text;

    it('snapshot .text does not carry what .value redacted', async () => {
      document.body.innerHTML = '<input id="pw" type="password" value="hunter2" />';
      const snap = await snapshot();
      expect(valueOf(snap, 'pw')).toBe(REDACTED);
      expect(textOf(snap, 'pw')).not.toBe('hunter2');
      expect(JSON.stringify(snap)).not.toContain('hunter2');
    });

    it('snapshot .text falls back to the placeholder, so the field stays identifiable', async () => {
      document.body.innerHTML =
        '<input id="pw" type="password" placeholder="请输入密码" value="hunter2" />';
      expect(textOf(await snapshot(), 'pw')).toBe('请输入密码');
    });

    it('snapshot .text falls back to aria-label when there is no placeholder', async () => {
      document.body.innerHTML =
        '<input id="pw" type="password" aria-label="Password" value="hunter2" />';
      expect(textOf(await snapshot(), 'pw')).toBe('Password');
    });

    it('click does not echo the secret in elementText, target.text or the message', async () => {
      document.body.innerHTML = '<input id="pw" type="password" value="hunter2" />';
      const result = await click({ css: '#pw' });
      expect(result.elementText).not.toContain('hunter2');
      expect(result.target?.text).not.toContain('hunter2');
      // `message` is built from describeElement — the string that gets quoted
      // into an IM approval prompt.
      expect(result.message).not.toContain('hunter2');
      expect(JSON.stringify(result)).not.toContain('hunter2');
    });

    it('wait_for does not quote the secret when it explains what it saw', async () => {
      document.body.innerHTML = '<input id="pw" type="password" value="hunter2" />';
      const result = await waitFor(
        { type: 'textContains', locator: { css: '#pw' }, text: 'nope' },
        20,
      );
      expect(result.timedOut).toBe(true);
      expect(JSON.stringify(result)).not.toContain('hunter2');
    });

    it('a not-found error message does not carry a sibling field\'s secret', async () => {
      // describeElement is also used in "did you mean" style diagnostics; the
      // click above covers its main caller, this covers the shape of the text.
      document.body.innerHTML = '<input id="cc" autocomplete="cc-number" value="4111111111111111" />';
      const result = await click({ css: '#cc' });
      expect(result.message).not.toContain('4111111111111111');
    });
  });

  /**
   * M5 — a `<select autocomplete="cc-exp-month">` is the common real case; its
   * `value` is the user's actual expiry, and it bypassed `reportableValue`
   * entirely.
   */
  describe('sensitive <select> (M5)', () => {
    it('redacts the selected value of a sensitive select', async () => {
      document.body.innerHTML =
        '<select id="exp" autocomplete="cc-exp-month">' +
        '<option value="01">01</option><option value="07" selected>07</option></select>';
      const el = (await snapshot()).elements.find((e) => e.id === 'exp')!;
      expect(el.value).toBe(REDACTED);
    });

    it('keeps the option list, so the agent can still pick a value', async () => {
      document.body.innerHTML =
        '<select id="exp" autocomplete="cc-exp-month">' +
        '<option value="01">01</option><option value="07" selected>07</option></select>';
      const el = (await snapshot()).elements.find((e) => e.id === 'exp')!;
      expect(el.options).toEqual([
        { value: '01', text: '01' },
        { value: '07', text: '07' },
      ]);
    });

    it('leaves an ordinary select alone', async () => {
      document.body.innerHTML =
        '<select id="kind"><option value="a" selected>动设备</option></select>';
      const el = (await snapshot()).elements.find((e) => e.id === 'kind')!;
      expect(el.value).toBe('a');
    });
  });

  /**
   * M6 — get_html feeds query_js, and a server-rendered
   * `<input type="password" value="...">` carries the secret in the ATTRIBUTE,
   * which the detached clone copied verbatim.
   */
  describe('get_html / query_js source (M6)', () => {
    it('does not serialize a password input\'s value attribute', async () => {
      document.body.innerHTML = '<input id="pw" type="password" value="hunter2" />';
      const html = await getHtml();
      expect(html).not.toContain('hunter2');
      expect(html).toContain(REDACTED);
    });

    it('does not serialize a cc-* input\'s value attribute', async () => {
      document.body.innerHTML =
        '<form><input id="cc" autocomplete="cc-number" value="4111111111111111" /></form>';
      expect(await getHtml({ selector: 'form' })).not.toContain('4111111111111111');
    });

    it('redacts a sensitive input that IS the serialization root', async () => {
      document.body.innerHTML = '<input id="pw" type="password" value="hunter2" />';
      expect(await getHtml({ selector: '#pw' })).not.toContain('hunter2');
    });

    it('leaves an ordinary input\'s value attribute alone', async () => {
      document.body.innerHTML = '<input id="code" type="text" value="EQ-001" />';
      expect(await getHtml()).toContain('EQ-001');
    });

    /**
     * M6 residual (re-review). A `<textarea>` has NO value attribute — its
     * default value is the child text node — so rewriting attributes left it
     * verbatim. Same "redacted on one surface, plaintext on the next" shape as
     * C1: the field reads `[value redacted]` in a snapshot and `TASERVER999`
     * to anything reading the page source.
     */
    it('redacts a sensitive textarea\'s CONTENT, not just attributes', async () => {
      document.body.innerHTML =
        '<textarea id="t" autocomplete="cc-csc">TASERVER999</textarea>';
      const html = await getHtml();
      expect(html).not.toContain('TASERVER999');
      expect(html).toContain(REDACTED);
    });

    it('what query_js parses out of that html sees the marker, not the secret', async () => {
      document.body.innerHTML =
        '<textarea id="t" autocomplete="cc-csc">TASERVER999</textarea>';
      // Stand-in for queryJsWorker.mjs: it parses the get_html output and the
      // script reads `.value`, which for a textarea comes from its content.
      const parsed = new DOMParser().parseFromString(await getHtml(), 'text/html');
      const ta = parsed.querySelector('#t') as HTMLTextAreaElement;
      expect(ta.value).not.toContain('TASERVER999');
    });

    it('redacts a password textarea that IS the serialization root', async () => {
      document.body.innerHTML =
        '<textarea id="t" autocomplete="one-time-code">483920</textarea>';
      expect(await getHtml({ selector: '#t' })).not.toContain('483920');
    });

    it('leaves an ordinary textarea\'s content alone', async () => {
      document.body.innerHTML = '<textarea id="t">ordinary note</textarea>';
      expect(await getHtml()).toContain('ordinary note');
    });

    // N2 (round-2 regression): the TEXTAREA branch returned early, so a
    // textarea carrying a `value` ATTRIBUTE with empty content stopped being
    // redacted — the attribute rewrite that used to catch it never ran. The
    // markup is invalid and inert in the DOM (hand-written SSR templates), but
    // it is raw plaintext in `get_html` either way.
    it('redacts a sensitive textarea\'s value ATTRIBUTE as well as its content', async () => {
      document.body.innerHTML =
        '<textarea id="t" autocomplete="cc-csc" value="4111111111111111"></textarea>';
      expect(await getHtml()).not.toContain('4111111111111111');
    });

    it('redacts BOTH when a sensitive textarea carries content and an attribute', async () => {
      document.body.innerHTML =
        '<textarea id="t" autocomplete="cc-csc" value="ATTRSECRET111">CONTENTSECRET222</textarea>';
      const html = await getHtml();
      expect(html).not.toContain('ATTRSECRET111');
      expect(html).not.toContain('CONTENTSECRET222');
    });

    it('extract_table gets the same scrub as extract_text', async () => {
      document.body.innerHTML =
        '<table><tbody><tr><td><textarea autocomplete="cc-csc">TBLSECRET999</textarea></td></tr></tbody></table>';
      const table = await handleAction('extract_table', {}) as { rows: string[][] };
      expect(JSON.stringify(table)).not.toContain('TBLSECRET999');
    });

    it('extract_table still returns ordinary cell text', async () => {
      document.body.innerHTML =
        '<table><tbody><tr><td>Q3 revenue</td></tr></tbody></table>';
      const table = await handleAction('extract_table', {}) as { rows: string[][] };
      expect(JSON.stringify(table)).toContain('Q3 revenue');
    });

    it('extract_text does not return a sensitive textarea\'s content', async () => {
      document.body.innerHTML =
        '<div id="scope"><textarea id="t" autocomplete="cc-csc">TASERVER999</textarea></div>';
      expect(await handleAction('extract_text', {})).not.toContain('TASERVER999');
      expect(await handleAction('extract_text', { selector: '#scope' })).not.toContain('TASERVER999');
    });

    it('extract_text still returns ordinary page text', async () => {
      document.body.innerHTML = '<div id="scope"><p>Report for Q3</p></div>';
      expect(await handleAction('extract_text', { selector: '#scope' })).toContain('Report for Q3');
    });
  });

  /**
   * Pre-existing hole (predates U5, ruled in scope for this round because it is
   * the last plaintext channel on the surface U5 hardens).
   *
   * `fillElement` wrote the value being typed into the `#abu-status` bubble,
   * which lives in `document.documentElement`. Any script on the page can read
   * it, it outlives the tool call, and it comes back through `get_html` — so a
   * value everything else redacts sat in the page in plaintext.
   */
  describe('the on-page status bubble never carries a typed value', () => {
    it('does not put a filled password into the page DOM', async () => {
      document.body.innerHTML = '<input id="pw" type="password" />';
      await fill({ css: '#pw' }, 'FILLEDSECRET777');

      expect(document.documentElement.outerHTML).not.toContain('FILLEDSECRET777');
      expect(await getHtml()).not.toContain('FILLEDSECRET777');
    });

    it('does not put an ORDINARY filled value into the page DOM either', async () => {
      // The bubble cannot tell a password from an order number, and the page
      // is the wrong place for either.
      document.body.innerHTML = '<input id="code" type="text" />';
      await fill({ css: '#code' }, 'ORDINARY-VALUE-42');

      expect(document.documentElement.outerHTML).not.toContain('ORDINARY-VALUE-42');
    });

    it('still shows a status naming the field, so the user can see what happened', async () => {
      document.body.innerHTML = '<input id="pw" type="password" placeholder="请输入密码" />';
      await fill({ css: '#pw' }, 'FILLEDSECRET777');

      const bubble = document.getElementById('abu-status');
      expect(bubble?.textContent).toContain('Fill');
      expect(bubble?.textContent).toContain('请输入密码');
    });

    it('does not echo a selected value into the status bubble', async () => {
      // The custom-dropdown branch is the one that shows a status (the native
      // <select> branch returns before it). The option text is the page's own
      // markup, so the bubble — not the whole DOM — is what must stay clean.
      renderAntdLikeForm();
      await select({ css: '#form_item_equipmentTypeId' }, '动设备');

      const bubble = document.getElementById('abu-status');
      expect(bubble?.textContent).toContain('Select');
      expect(bubble?.textContent).not.toContain('动设备');
      // It names the field instead, which the page already knows about itself.
      expect(bubble?.textContent).toContain('请选择设备类型');
    });
  });
});

/**
 * ── I2: the origin pin on the EXTENSION channel ───────────────────────────
 *
 * Round 1 pinned only the built-in Electron browser. This channel drives the
 * user's real logged-in Chrome — the more dangerous of the two — and dropped
 * `expectedOrigin` on the floor. `location.origin` inside the content script
 * is the true execution point here: whatever the background worker believed
 * about the tab, this is the document the click is about to land in.
 *
 * happy-dom's location is settable, which is what lets these drive a "the page
 * moved between approval and execution" state directly.
 */
describe('execution-time origin pin, content-script half (I2)', () => {
  const APPROVED = 'https://shop.example.com';

  function pageAt(href: string): void {
    // happy-dom allows assigning href without a navigation.
    (globalThis as unknown as { location: { href: string } }).location.href = href;
  }

  beforeEach(() => {
    pageAt(`${APPROVED}/cart`);
    document.body.innerHTML = '<button id="buy">Buy</button><input id="f" />';
  });

  it('runs a pinned action that is still on the approved origin', async () => {
    const result = await handleAction('click', {
      locator: { css: '#buy' },
      unattended: true,
      expectedOrigin: APPROVED,
    }) as ActionResult;
    expect(result.success).toBe(true);
  });

  it('refuses after the page drifted cross-origin, naming both ends and a next step', async () => {
    pageAt('https://evil.example.com/cart');
    await expect(handleAction('click', {
      locator: { css: '#buy' },
      unattended: true,
      expectedOrigin: APPROVED,
    })).rejects.toThrow(/no longer on the page this action was approved for/);
    await expect(handleAction('click', {
      locator: { css: '#buy' },
      unattended: true,
      expectedOrigin: APPROVED,
    })).rejects.toThrow(/https:\/\/evil\.example\.com/);
  });

  it('a same-origin path change is not a drift', async () => {
    pageAt(`${APPROVED}/cart/step-2?x=1`);
    const result = await handleAction('click', {
      locator: { css: '#buy' },
      unattended: true,
      expectedOrigin: APPROVED,
    }) as ActionResult;
    expect(result.success).toBe(true);
  });

  it('covers every state-changing action the content script owns', async () => {
    pageAt('https://evil.example.com/');
    for (const [action, payload] of [
      ['click', { locator: { css: '#buy' } }],
      ['fill', { locator: { css: '#f' }, value: 'x' }],
      ['select', { locator: { css: '#f' }, value: 'x' }],
      ['keyboard', { key: 'Enter' }],
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(
        handleAction(action, { ...payload, unattended: true, expectedOrigin: APPROVED }),
      ).rejects.toThrow(/no longer on the page/);
    }
  });

  it('leaves read-only actions alone — they change nothing', async () => {
    pageAt('https://evil.example.com/');
    const snap = await handleAction('snapshot', {
      unattended: true,
      expectedOrigin: APPROVED,
    }) as PageSnapshot;
    expect(snap.elements.length).toBeGreaterThan(0);
  });

  it('fail-closed: an unattended pinned action with no approved origin is refused', async () => {
    await expect(handleAction('click', {
      locator: { css: '#buy' },
      unattended: true,
    })).rejects.toThrow(/sent no approved origin/);
  });

  it('an ATTENDED call is compared too (I3)', async () => {
    pageAt('https://evil.example.com/');
    await expect(handleAction('click', {
      locator: { css: '#buy' },
      expectedOrigin: APPROVED,
    })).rejects.toThrow(/no longer on the page/);
  });

  it('an attended call carrying NO pin keeps its exact pre-U5 path', async () => {
    pageAt('https://evil.example.com/');
    const result = await handleAction('click', { locator: { css: '#buy' } }) as ActionResult;
    expect(result.success).toBe(true);
  });

  it('a non-http document is a mismatch, not a pass', async () => {
    pageAt('about:blank');
    await expect(handleAction('click', {
      locator: { css: '#buy' },
      unattended: true,
      expectedOrigin: APPROVED,
    })).rejects.toThrow(/an unknown page/);
  });

  it('a trailing-dot FQDN is the same origin, not a way past the pin', async () => {
    pageAt('https://shop.example.com./cart');
    const result = await handleAction('click', {
      locator: { css: '#buy' },
      unattended: true,
      expectedOrigin: APPROVED,
    }) as ActionResult;
    expect(result.success).toBe(true);
  });

  /**
   * ── The all-frames race (re-review ruling) ────────────────────────────────
   *
   * `ensureContentScript` injects with `allFrames: true` and
   * `chrome.tabs.sendMessage` broadcasts WITHOUT a frameId, so every frame
   * answers and the FIRST response wins. A benign `about:blank` / `srcdoc` /
   * cross-origin subframe would therefore answer "the page moved — take a
   * fresh snapshot" for a top frame that never moved: a false, unactionable
   * refusal that loops the model straight back into the same race.
   *
   * A frame that cannot resolve the target is modelled here the only way that
   * matters to the code — a locator this document does not match. That is
   * exactly the state a non-owning subframe is in.
   *
   * The invariant has two halves and both are asserted:
   *   1. a frame that does NOT own the target never emits a pin refusal;
   *   2. a frame that DOES own the target still enforces the pin.
   */
  describe('a frame that does not own the target never preempts with a pin refusal', () => {
    it('answers its ordinary not-found error instead of the pin refusal', async () => {
      pageAt('https://evil.example.com/');
      await expect(handleAction('click', {
        locator: { css: '#not-in-this-frame' },
        unattended: true,
        expectedOrigin: APPROVED,
      })).rejects.toThrow(/Element not found/);
    });

    it('does not emit the pin refusal even with no pin carried at all', async () => {
      pageAt('https://evil.example.com/');
      await expect(handleAction('fill', {
        locator: { css: '#not-in-this-frame' },
        value: 'x',
        unattended: true,
      })).rejects.toThrow(/Element not found/);
    });

    it('but the frame that OWNS the target still enforces (invariant half two)', async () => {
      pageAt('https://evil.example.com/');
      await expect(handleAction('click', {
        locator: { css: '#buy' },
        unattended: true,
        expectedOrigin: APPROVED,
      })).rejects.toThrow(/no longer on the page/);
    });

    it('keyboard, which has no locator, is still pinned in the acting frame', async () => {
      pageAt('https://evil.example.com/');
      (document.getElementById('f') as HTMLInputElement).focus();
      await expect(handleAction('keyboard', {
        key: 'Enter',
        unattended: true,
        expectedOrigin: APPROVED,
      })).rejects.toThrow(/no longer on the page/);
    });

    it('the TOP frame still checks keyboard even with nothing focused', async () => {
      // Not a false refusal: the top frame refuses only when its OWN origin
      // drifted, which is the true answer. Keeping it silent here would let a
      // keyboard event run unpinned on a drifted top document.
      pageAt('https://evil.example.com/');
      (document.activeElement as HTMLElement | null)?.blur?.();
      await expect(handleAction('keyboard', {
        key: 'Enter',
        unattended: true,
        expectedOrigin: APPROVED,
      })).rejects.toThrow(/no longer on the page/);
    });

    /**
     * N1 (round-2 invariant hole). `frameServicesAction` gated only the PIN,
     * not the action, and `keyboard` has no second guard the way locator
     * actions have `findElementOrThrow` — so a subframe with nothing focused
     * skipped the check AND dispatched the key anyway. "Skips the check and
     * acts" is precisely what the pin exists to prevent, so a frame that does
     * not service the action must now abstain from it too.
     */
    it('a SUBFRAME with nothing focused abstains from keyboard instead of acting', async () => {
      pageAt('https://evil.example.com/');
      (document.activeElement as HTMLElement | null)?.blur?.();
      let keydowns = 0;
      const count = () => { keydowns += 1; };
      document.addEventListener('keydown', count);
      // Model a subframe: `window.top !== window`. This is the benign
      // about:blank/srcdoc frame the ruling is about.
      const realTop = window.top;
      Object.defineProperty(window, 'top', { value: {}, configurable: true });
      try {
        await expect(handleAction('keyboard', {
          key: 'Enter',
          unattended: true,
          expectedOrigin: APPROVED,
        })).rejects.toThrow(/nothing is focused in this frame/i);
        expect(keydowns).toBe(0);
      } finally {
        Object.defineProperty(window, 'top', { value: realTop, configurable: true });
        document.removeEventListener('keydown', count);
      }
    });

    /**
     * N3 — a cross-origin subframe that genuinely holds focus is refused (fail
     * closed is right), but "the page moved, take a fresh snapshot" is advice
     * that can never work there: that frame is permanently a different site
     * from the approved one, and no snapshot changes that.
     */
    it('a subframe on a different site is told SO, not told to re-snapshot', async () => {
      pageAt('https://evil.example.com/');
      (document.getElementById('f') as HTMLInputElement).focus();
      const realTop = window.top;
      Object.defineProperty(window, 'top', { value: {}, configurable: true });
      try {
        await expect(handleAction('keyboard', {
          key: 'Enter',
          unattended: true,
          expectedOrigin: APPROVED,
        })).rejects.toThrow(/frame from a different site/i);
        await expect(handleAction('click', {
          locator: { css: '#buy' },
          unattended: true,
          expectedOrigin: APPROVED,
        })).rejects.toThrow(/will not change/i);
      } finally {
        Object.defineProperty(window, 'top', { value: realTop, configurable: true });
      }
    });
  });
});

describe('get_html contract for query_js', () => {
  it('serializes the whole document by default', async () => {
    document.body.innerHTML = '<main><h1>Report</h1><p data-id="a">Alpha</p></main>';

    const html = await getHtml();

    expect(html).toContain('<html');
    expect(html).toContain('<h1>Report</h1>');
    expect(html).toContain('data-id="a"');
  });

  it('serializes only the selected subtree when selector is provided', async () => {
    document.body.innerHTML = '<section id="skip">No</section><main id="keep"><p>Yes</p></main>';

    const html = await getHtml({ selector: '#keep' });

    expect(html).toContain('<main id="keep">');
    expect(html).toContain('<p>Yes</p>');
    expect(html).not.toContain('id="skip"');
  });

  it('fails missing selectors with narrowing guidance', async () => {
    await expect(getHtml({ selector: '#missing' })).rejects.toThrow(/snapshot/);
  });

  it('inlines same-origin iframe HTML and marks inaccessible frames', async () => {
    document.body.innerHTML = `
      <main>
        <iframe id="same" title="same"></iframe>
        <iframe id="cross" title="cross"></iframe>
      </main>
    `;
    const same = document.querySelector('#same') as HTMLIFrameElement;
    Object.defineProperty(same, 'contentDocument', {
      configurable: true,
      value: document.implementation.createHTMLDocument('inner'),
    });
    same.contentDocument!.body.innerHTML = '<section class="inside">Frame text</section>';
    const cross = document.querySelector('#cross') as HTMLIFrameElement;
    Object.defineProperty(cross, 'contentDocument', {
      configurable: true,
      get() {
        throw new DOMException('cross origin', 'SecurityError');
      },
    });

    const html = await getHtml({ selector: 'main' });

    expect(html).toContain('<abu-inline-frame');
    expect(html).toContain('data-title="same"');
    expect(html).toContain('class="inside"');
    expect(html).toContain('Frame text');
    expect(html).toContain('data-reason="cross-origin"');
  });

  it('inlines a same-origin iframe when the selector targets the frame itself', async () => {
    document.body.innerHTML = '<iframe id="target" title="selected frame"></iframe>';
    const frame = document.querySelector('#target') as HTMLIFrameElement;
    Object.defineProperty(frame, 'contentDocument', {
      configurable: true,
      value: document.implementation.createHTMLDocument('selected'),
    });
    frame.contentDocument!.body.innerHTML = '<p data-node="inside">Selected frame text</p>';

    const html = await getHtml({ selector: '#target' });

    expect(html).toContain('<abu-inline-frame');
    expect(html).toContain('data-title="selected frame"');
    expect(html).toContain('data-node="inside"');
    expect(html).not.toContain('<iframe');
  });
});

describe('snapshot stays usable when it cannot show everything', () => {
  it('cuts at an element boundary and says how to see the rest', async () => {
    document.body.innerHTML = Array.from(
      { length: 60 },
      (_, i) => `<input id="field_${i}" placeholder="请输入第${i}项内容用于撑大这个快照" />`,
    ).join('');

    const snap = await snapshot({ maxChars: 2000 });

    // Whatever survives is complete and parseable — never a sliced object.
    expect(snap.elements.length).toBeGreaterThan(0);
    expect(snap.elements.length).toBeLessThan(60);
    expect(() => JSON.parse(JSON.stringify(snap.elements))).not.toThrow();
    expect(snap.truncated).toBe(true);
    expect(snap.message).toMatch(/selector/);
    expect(snap.message).toMatch(/maxChars/);
    expect(snap.message).toMatch(/refs are valid/);
  });

  it('reports ids and names so a caller can build a durable css locator', async () => {
    document.body.innerHTML = '<input id="form_item_equipmentCode" name="equipmentCode" />';
    const snap = await snapshot();
    expect(snap.elements[0]).toMatchObject({ id: 'form_item_equipmentCode', name: 'equipmentCode' });
  });

  it('tells the caller what to do when the scope selector matches nothing', async () => {
    document.body.innerHTML = '<button>提交</button>';
    await expect(handleAction('snapshot', { selector: '#nope' })).rejects.toThrow(/without a selector/);
  });
});

describe('wait_for reports what it actually saw', () => {
  it('names the reason on timeout instead of only the elapsed time', async () => {
    document.body.innerHTML = '<button data-hidden id="go">提交</button>';

    const result = await waitFor({ type: 'appear', locator: { css: '#go' } }, 60);

    expect(result.timedOut).toBe(true);
    expect(result.observed).toMatch(/no layout box/);
    expect(result.message).toMatch(/button/);
  });

  it('says so when nothing matches at all', async () => {
    document.body.innerHTML = '<div>空页面</div>';
    const result = await waitFor({ type: 'appear', locator: { css: '#missing' } }, 60);
    expect(result.observed).toMatch(/no element matches/);
  });

  it('fails a wait on a dead ref immediately instead of burning the whole timeout', async () => {
    document.body.innerHTML = '<button>提交</button>';
    const ref = (await snapshot()).elements[0].ref;
    document.body.innerHTML = '<div>页面换了</div>';

    // Waiting 30s for an element that can never come back is pure waste, and
    // the caller needs to know it should re-snapshot, not wait longer.
    // (Was a rejection; now the same guidance arrives as a structured
    // failure, matching how a mid-poll stale ref reports.)
    const result = await waitFor({ type: 'appear', locator: { ref } }, 30_000);
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.message).toMatch(/no longer exists/);
    expect(result.elapsed).toBeLessThan(4000);
  });

  it('reports the current url for a urlContains timeout', async () => {
    const result = await waitFor({ type: 'urlContains', pattern: '/success' }, 60);
    expect(result.observed).toMatch(/current url is/);
  });
});

describe('known defects — pinned so the fix shows up as a deliberate diff', () => {
  it('a text locator hits the option, not the ancestor that contains it', async () => {
    renderAntdLikeForm();

    const result = await click({ text: '动设备' });

    // Was a defect: the first element in document order whose subtree text
    // contained the string won — in the field report that was <body>, the
    // whole page shell, clicked and reported as a success.
    expect(result.elementText).toBe('动设备');
    expect(result.target).toMatchObject({ tag: 'div', role: 'option' });
  });

  it('refuses an ambiguous text match instead of picking one', async () => {
    document.body.innerHTML = `
      <div><button>删除</button></div>
      <div><button>删除</button></div>`;

    await expect(click({ text: '删除' })).rejects.toThrow(/matches 2 different elements[\s\S]*Pick one by ref/);
  });

  it('narrows an ambiguous text match with an exact match', async () => {
    document.body.innerHTML = `
      <div role="option">动设备</div>
      <div role="option">动设备（备用）</div>`;

    const result = await click({ text: '动设备' });
    expect(result.elementText).toBe('动设备');
  });

  it('prefers a real control over the wrapper holding the same text', async () => {
    document.body.innerHTML = '<label>提交<button>提交</button></label>';
    const result = await click({ text: '提交' });
    expect(result.target!.tag).toBe('button');
  });

  it('matches a label whose spacing the framework changed', async () => {
    // antd puts a space between the two characters of a two-character Chinese
    // button, so the DOM says "提 交" while every human says "提交".
    document.body.innerHTML = '<button class="ant-btn"><span>提 交</span></button>';
    const result = await click({ text: '提交' });
    expect(result.success).toBe(true);
  });

  it('still honours a tag filter alongside the text', async () => {
    document.body.innerHTML = '<div><span>提交</span></div><button><span>提交</span></button>';
    const result = await click({ tag: 'button', text: '提交' });
    expect(result.target!.tag).toBe('button');
  });

  it('wait_for no longer resolves through an ancestor match', async () => {
    renderAntdLikeForm();

    const missing = await waitFor({ type: 'appear', locator: { text: '还没有出现的文字' } }, 50);
    expect(missing.success).toBe(false);

    // Was a defect: any string present anywhere on the page resolved instantly
    // via <body>, including while the real target was hidden — which made the
    // wait primitive a no-op.
    document.querySelector('.ant-select-dropdown')!.setAttribute('data-hidden', '');
    const hidden = await waitFor({ type: 'appear', locator: { text: '动设备' } }, 50);
    expect(hidden.success).toBe(false);
    expect(hidden.observed).toMatch(/no element matches|no layout box/);
  });

  it('a ref keeps pointing at the same element when the page changes', async () => {
    // Was a defect: snapshots restarted the numbering, so a held ref became an
    // index into the latest walk and silently retargeted.
    document.body.innerHTML = '<button>提交</button>';
    const first = await snapshot();
    const submitRef = first.elements[0].ref;

    // The page changes the way an SPA does — a control appears above the form.
    document.body.insertAdjacentHTML('afterbegin', '<button>取消</button>');
    const second = await snapshot();

    const result = await click({ ref: submitRef });
    expect(result.elementText).toBe('提交');
    // The pre-existing element keeps its identity; only the new one is new.
    expect(second.elements.find((e) => e.text === '提交')!.ref).toBe(submitRef);
  });

  it('says a ref is gone instead of quietly acting on something else', async () => {
    document.body.innerHTML = '<button>提交</button>';
    const ref = (await snapshot()).elements[0].ref;

    document.body.innerHTML = '<button>取消</button>';

    await expect(click({ ref })).rejects.toThrow(/no longer exists.*fresh snapshot/s);
  });

  it('does not fall back to another strategy when a named ref is dead', async () => {
    document.body.innerHTML = '<button id="a">提交</button>';
    const ref = (await snapshot()).elements[0].ref;
    document.body.innerHTML = '<button id="a">别的按钮</button>';

    // A stale ref plus a css selector must not quietly click the css match:
    // the caller named a specific element.
    await expect(click({ ref, css: '#a' })).rejects.toThrow(/no longer exists/);
  });

  it('selects from an ARIA combobox whose options live in a portal', async () => {
    // Was a defect: `select` required an HTMLSelectElement, so every antd /
    // Element Plus dropdown — i.e. most Chinese enterprise back-office forms —
    // was unreachable, which is what pushed the model to scripting.
    renderAntdLikeForm();
    const dropdown = document.querySelector('.ant-select-dropdown') as HTMLElement;
    dropdown.setAttribute('data-hidden', '');
    dropdown.style.display = 'none';
    const option = document.querySelector('[data-testid="opt-dong"]')!;
    let clicked = '';
    document.addEventListener('click', (e) => {
      const t = e.target as Element;
      if (t.getAttribute?.('role') === 'option') clicked = t.textContent ?? '';
    });
    // The trigger opens the portal, the way rc-select does on mousedown.
    document
      .querySelector('#form_item_equipmentTypeId')!
      .addEventListener('mousedown', () => {
        dropdown.removeAttribute('data-hidden');
        dropdown.style.display = '';
      });

    const result = await select({ css: '#form_item_equipmentTypeId' }, '动设备');

    expect(result.success).toBe(true);
    expect(clicked).toBe('动设备');
    expect(result.target).toMatchObject({ role: 'option', text: '动设备' });
    expect(option.isConnected).toBe(true);
  });

  it('lists the real options when the requested one is not there', async () => {
    renderAntdLikeForm();

    await expect(select({ css: '#form_item_equipmentTypeId' }, '飞行设备')).rejects.toThrow(
      /Options available: "动设备", "静设备"/,
    );
  });

  it('lists the options of a native select too', async () => {
    document.body.innerHTML = '<select id="s"><option value="1">动设备</option><option value="2">静设备</option></select>';
    await expect(select({ css: '#s' }, '飞行设备')).rejects.toThrow(/Available options: "动设备", "静设备"/);
  });

  it('still drives a native select, firing input and change', async () => {
    document.body.innerHTML = '<select id="s"><option value="1">动设备</option><option value="2">静设备</option></select>';
    const el = document.getElementById('s') as HTMLSelectElement;
    const seen: string[] = [];
    for (const type of ['input', 'change']) el.addEventListener(type, () => seen.push(type));

    const result = await select({ css: '#s' }, '静设备');

    expect(el.value).toBe('2');
    expect(seen).toEqual(['input', 'change']);
    expect(result.success).toBe(true);
  });

  it('explains what to do when the target is not a dropdown at all', async () => {
    document.body.innerHTML = '<input id="t" type="text" />';
    await expect(select({ css: '#t' }, '动设备')).rejects.toThrow(/is not a dropdown[\s\S]*use fill/);
  });

  it('says so when the dropdown opens but renders nothing', async () => {
    document.body.innerHTML = '<div id="c" role="combobox">请选择</div>';
    await expect(select({ css: '#c' }, '动设备')).rejects.toThrow(/no options appeared within/);
  }, 10_000);
});

describe('snapshot budget accounting', () => {
  it('keeps the serialized payload inside the requested budget', async () => {
    document.body.innerHTML = Array.from(
      { length: 80 },
      (_, i) => `<input id="field_${i}" name="f${i}" placeholder="第${i}项，需要一些长度来撑大序列化后的体积" />`,
    ).join('');

    for (const maxChars of [1500, 4000, 12000]) {
      const snap = await snapshot({ maxChars });
      const wireSize = JSON.stringify(snap.elements, null, 2).length;
      expect(wireSize).toBeLessThanOrEqual(maxChars);
      expect(snap.elements.length).toBeGreaterThan(0);
    }
  });

  it('returns everything, and no truncation note, when it all fits', async () => {
    document.body.innerHTML = '<button>提交</button><button>取消</button>';
    const snap = await snapshot();
    expect(snap.elements).toHaveLength(2);
    expect(snap.truncated).toBeUndefined();
    expect(snap.message).toBeUndefined();
  });
});

/**
 * End-to-end shape of the failure this work came from: the "新增设备" form in
 * the field diagnostic (jeecg + antd), where the agent burned 10 script
 * executions — one approval prompt each — and still did not finish the form.
 *
 * The assertion that matters is the last one: the whole form is completable
 * through the ordinary tools, so the scripting fallback is never reached.
 */
describe('field case: an antd enterprise form can be completed with ordinary tools', () => {
  const TEXT_FIELDS: Array<[string, string]> = [
    ['equipmentCode', 'EQ-2026-001'],
    ['equipmentName', '卧式离心泵'],
    ['equipmentPosition', 'P-101'],
    ['specModel', 'IS65-50-160'],
    ['manufacturer', '上海凯泉泵业（集团）有限公司'],
    ['totalRunHour', '3560'],
    ['material', '铸铁'],
  ];
  const DROPDOWNS: Array<[string, string[], string]> = [
    ['equipmentTypeId', ['动设备', '静设备', '电气设备', '仪表', '特种设备', '其他'], '动设备'],
    ['importantLevelId', ['关键', '重要', '一般'], '关键'],
    ['statusId', ['在用', '备用', '闲置', '维修', '停机', '报废'], '在用'],
  ];

  /** A stand-in for rc-select: options live in a body portal, opened on mousedown. */
  function renderForm(): void {
    const inputs = TEXT_FIELDS.map(
      ([id]) => `<input id="form_item_${id}" name="${id}" type="text" placeholder="请输入${id}" />`,
    ).join('');
    const triggers = DROPDOWNS.map(
      ([id]) =>
        `<div class="ant-select"><input id="form_item_${id}" role="combobox" aria-controls="list_${id}"
           aria-expanded="false" readonly placeholder="请选择" /></div>`,
    ).join('');
    const portals = DROPDOWNS.map(
      ([id, options]) =>
        `<div class="ant-select-dropdown" data-hidden style="display:none"><div id="list_${id}" role="listbox">${options
          .map((o) => `<div class="ant-select-item-option" role="option">${o}</div>`)
          .join('')}</div></div>`,
    ).join('');
    document.body.innerHTML = `
      <nav>${Array.from({ length: 18 }, (_, i) => `<a href="/m${i}">菜单${i}</a>`).join('')}</nav>
      <form>${inputs}${triggers}<button id="submit">提交</button></form>
      ${portals}`;

    for (const [id] of DROPDOWNS) {
      const trigger = document.getElementById(`form_item_${id}`)!;
      const portal = document.getElementById(`list_${id}`)!.parentElement!;
      trigger.addEventListener('mousedown', () => {
        portal.removeAttribute('data-hidden');
        (portal as HTMLElement).style.display = '';
        trigger.setAttribute('aria-expanded', 'true');
      });
      portal.addEventListener('click', (e) => {
        const option = (e.target as Element).closest('[role="option"]');
        if (!option) return;
        (trigger as HTMLInputElement).value = option.textContent ?? '';
        portal.setAttribute('data-hidden', '');
        (portal as HTMLElement).style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
      });
    }
  }

  it('reads the whole form in one snapshot and fills every field', async () => {
    renderForm();

    // 1. One read. Not truncated, and every field carries the id a caller needs.
    const snap = await snapshot();
    expect(snap.truncated).toBeUndefined();
    for (const [id] of [...TEXT_FIELDS, ...DROPDOWNS]) {
      expect(snap.elements.some((e) => e.id === `form_item_${id}`)).toBe(true);
    }

    // 2. Text fields.
    for (const [id, value] of TEXT_FIELDS) {
      const result = await fill({ css: `#form_item_${id}` }, value);
      expect(result.success).toBe(true);
      expect((document.getElementById(`form_item_${id}`) as HTMLInputElement).value).toBe(value);
    }

    // 3. Dropdowns — one call each, no click-then-hunt, no script.
    for (const [id, , choice] of DROPDOWNS) {
      const result = await select({ css: `#form_item_${id}` }, choice);
      expect(result.success).toBe(true);
      expect((document.getElementById(`form_item_${id}`) as HTMLInputElement).value).toBe(choice);
    }

    // 4. Refs taken before all that mutation still address the same elements.
    const submitRef = snap.elements.find((e) => e.id === 'submit')!.ref;
    expect((await click({ ref: submitRef })).target).toMatchObject({ id: 'submit' });
  });
});

/**
 * Shapes taken from a real antd 5.21.6 page, not invented.
 *
 * rc-select renders the dropdown twice: a `role="listbox"` sized
 * `height:0; width:0; overflow:hidden` for screen readers, and a separate,
 * completely un-roled list that takes the mouse. An ARIA-only implementation
 * finds the mirror, clicks a 0×0 node, and closes the dropdown having selected
 * nothing — which is what the first version of this code did.
 */
describe('real rc-select shape', () => {
  function renderRealShape(options: string[], mirrored: number): void {
    document.body.innerHTML = `
      <div class="ant-select">
        <div class="ant-select-selector">
          <span class="ant-select-selection-placeholder">请选择</span>
          <span class="ant-select-selection-search">
            <input data-hidden id="trigger" role="combobox" aria-controls="trigger_list"
                   aria-expanded="false" readonly />
          </span>
        </div>
      </div>
      <div class="ant-select-dropdown" style="display:none">
        <div role="listbox" id="trigger_list" data-hidden>
          ${options.slice(0, mirrored).map((o, i) =>
            `<div aria-label="${o}" role="option" id="trigger_list_${i}" aria-selected="false">${o}</div>`).join('')}
        </div>
        <div class="rc-virtual-list"><div class="rc-virtual-list-holder-inner">
          ${options.map((o) =>
            `<div class="ant-select-item ant-select-item-option" title="${o}">
               <div class="ant-select-item-option-content">${o}</div></div>`).join('')}
        </div></div>
      </div>`;

    const trigger = document.getElementById('trigger')!;
    const popup = document.querySelector('.ant-select-dropdown') as HTMLElement;
    const placeholder = document.querySelector('.ant-select-selection-placeholder')!;
    trigger.addEventListener('mousedown', () => {
      popup.style.display = '';
      trigger.setAttribute('aria-expanded', 'true');
    });
    // Only the real row reacts — clicking the a11y mirror does nothing, as on
    // the real page.
    for (const row of document.querySelectorAll('.ant-select-item-option')) {
      row.addEventListener('click', () => {
        placeholder.className = 'ant-select-selection-item';
        placeholder.textContent = row.getAttribute('title');
        popup.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
      });
    }
  }

  const selected = () => document.querySelector('.ant-select-selection-item')?.textContent ?? '(空)';

  it('clicks the rendered row, not the zero-sized accessibility mirror', async () => {
    renderRealShape(['动设备', '静设备', '电气设备'], 3);

    const result = await select({ css: '#trigger' }, '静设备');

    expect(result.success).toBe(true);
    expect(selected()).toBe('静设备');
  });

  it('finds an option the accessibility mirror never advertised', async () => {
    // The mirror is virtualized: six options, two announced. The requested one
    // is only present in the list the mouse sees.
    renderRealShape(['在用', '备用', '闲置', '维修', '停机', '报废'], 2);

    const result = await select({ css: '#trigger' }, '报废');

    expect(result.success).toBe(true);
    expect(selected()).toBe('报废');
  });

  it('lists what it saw, across both lists, when the option is absent', async () => {
    renderRealShape(['在用', '备用', '闲置'], 1);
    await expect(select({ css: '#trigger' }, '飞行中')).rejects.toThrow(/"在用"[\s\S]*"闲置"/);
  });

  it('reaches the collapsed combobox from a snapshot', async () => {
    renderRealShape(['动设备', '静设备'], 2);
    const snap = await snapshot();
    const ref = snap.elements.find((e) => e.id === 'trigger')?.ref;
    expect(ref).toBeDefined();

    const result = await select({ ref: ref! }, '静设备');
    expect(result.success).toBe(true);
    expect(selected()).toBe('静设备');
  });
});

describe('an open popup is legible in a snapshot', () => {
  it('lists the rows the user can click, not the zero-sized mirror', async () => {
    // Straight from a field trace: a snapshot of an open antd dropdown listed
    // the two rows of the screen-reader mirror (of six real options), so the
    // model reasoned about an incomplete, un-clickable list and went back to
    // scripting the page to find `.ant-select-item-option`.
    document.body.innerHTML = `
      <div class="ant-select-dropdown">
        <div role="listbox" id="t_list" data-hidden>
          <div role="option" aria-label="动设备" id="t_list_0">动设备</div>
          <div role="option" aria-label="静设备" id="t_list_1">静设备</div>
        </div>
        <div class="rc-virtual-list-holder-inner">
          ${['动设备', '静设备', '电气设备', '仪表', '特种设备', '其他']
            .map((o) => `<div class="ant-select-item-option" title="${o}">
                           <div class="ant-select-item-option-content">${o}</div></div>`).join('')}
        </div>
      </div>`;

    const snap = await snapshot();
    const texts = snap.elements.map((e) => e.text);

    // All six real rows, and none of the mirror's ids.
    expect(texts).toEqual(expect.arrayContaining(['动设备', '静设备', '电气设备', '仪表', '特种设备', '其他']));
    expect(snap.elements.some((e) => e.id?.startsWith('t_list'))).toBe(false);
  });

  it('does not turn ordinary page text into rows when nothing is open', async () => {
    document.body.innerHTML = '<div><p>一段说明文字</p><span>另一段</span></div><button>提交</button>';
    const snap = await snapshot();
    expect(snap.elements.map((e) => e.text)).toEqual(['提交']);
  });
});

describe('a dropdown that is slow to lay out', () => {
  it('waits for a clickable row instead of reporting the option missing', async () => {
    // Straight from a field trace: `select` said `Option "在用" not found` and
    // then listed "在用" among the options it had seen. The accessibility
    // mirror mounts the instant the dropdown opens; the list the mouse can
    // reach is laid out a frame or two later. Resolving on the first pass
    // found labels and no click target.
    document.body.innerHTML = `
      <input id="trigger" role="combobox" aria-controls="trigger_list" aria-expanded="false" readonly />
      <div class="popup" style="display:none">
        <div role="listbox" id="trigger_list" data-hidden>
          <div role="option" aria-label="在用">在用</div>
        </div>
        <div class="rows" data-hidden><div class="row">在用</div></div>
      </div>`;
    const popup = document.querySelector('.popup') as HTMLElement;
    const rows = document.querySelector('.rows') as HTMLElement;
    const row = document.querySelector('.row')!;
    let clicked = false;
    row.addEventListener('click', () => { clicked = true; });

    document.getElementById('trigger')!.addEventListener('mousedown', () => {
      // The popup mounts immediately — mirror included — but the rows only
      // acquire a box on a later frame.
      popup.style.display = '';
      setTimeout(() => rows.removeAttribute('data-hidden'), 250);
    });

    const result = await select({ css: '#trigger' }, '在用');

    expect(result.success).toBe(true);
    expect(clicked).toBe(true);
  });

  it('says the row never became clickable rather than claiming it is absent', async () => {
    document.body.innerHTML = `
      <input id="trigger" role="combobox" aria-controls="trigger_list" aria-expanded="true" readonly />
      <div class="popup">
        <div role="listbox" id="trigger_list" data-hidden>
          <div role="option" aria-label="在用">在用</div>
        </div>
      </div>`;

    await expect(select({ css: '#trigger' }, '在用')).rejects.toThrow(
      /never finished opening[\s\S]*Take a snapshot/,
    );
  }, 10_000);
});

describe('a scope selector that matches more than one element', () => {
  /** Three dropdown popups on the page, only the middle one open — the field shape. */
  function renderThreePopups(openIndex: number): void {
    document.body.innerHTML = [0, 1, 2]
      .map((i) => `
        <div class="ant-select-dropdown"${i === openIndex ? '' : ' style="display:none"'}>
          <div role="listbox" id="list_${i}" data-hidden>
            <div role="option" aria-label="选项${i}">选项${i}</div>
          </div>
          <div class="rows"><div class="row">选项${i}</div></div>
        </div>`)
      .join('');
  }

  it('scopes to every match, not just the first one', async () => {
    // Was a defect: `querySelector` took the first `.ant-select-dropdown`,
    // which was closed, so the snapshot came back empty and the caller went
    // off to script the page.
    renderThreePopups(1);

    const snap = await snapshot({ selector: '.ant-select-dropdown' });

    expect(snap.elements.map((e) => e.text)).toEqual(['选项1']);
    expect(snap.message).toBeUndefined();
  });

  it('lists an element once even when the scopes overlap', async () => {
    document.body.innerHTML = '<div class="a b"><button>提交</button></div>';
    const snap = await snapshot({ selector: '.a, .b' });
    expect(snap.elements).toHaveLength(1);
  });

  it('explains an empty scope instead of looking like an empty page', async () => {
    renderThreePopups(-1); // nothing open

    const snap = await snapshot({ selector: '.ant-select-dropdown' });

    expect(snap.elements).toHaveLength(0);
    expect(snap.message).toMatch(/matched 3 elements/);
    expect(snap.message).toMatch(/popup that is closed/);
    expect(snap.message).toMatch(/without a selector/);
  });

  it('still throws when the selector matches nothing at all', async () => {
    document.body.innerHTML = '<button>提交</button>';
    await expect(handleAction('snapshot', { selector: '#nope' })).rejects.toThrow(/without a selector/);
  });
});

describe('visibility:hidden elements are not visible (fixed defect)', () => {
  // visibility:hidden keeps the layout box, so the old offsetParent-gated
  // check never saw it: a dropdown a library closes this way was treated as
  // the live popup, and select() could pick an option the user cannot see.

  it('appear does not fire for a visibility:hidden element', async () => {
    document.body.innerHTML =
      '<div id="pop" role="listbox" style="visibility: hidden"><div role="option">旧选项</div></div>';

    const result = await waitFor({ type: 'appear', locator: { css: '#pop' } }, 120);

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('snapshot omits options inside a visibility:hidden dropdown but keeps the open one', async () => {
    document.body.innerHTML = `
      <div class="ant-select-dropdown" style="visibility: hidden">
        <div role="listbox"><div role="option">旧选项</div></div>
      </div>
      <div class="ant-select-dropdown">
        <div role="listbox"><div role="option">动设备</div></div>
      </div>`;

    const snap = await snapshot();

    const texts = snap.elements.map((e) => e.text);
    expect(texts).toContain('动设备');
    expect(texts).not.toContain('旧选项');
  });
});

describe('wait_for with refs that go stale (fixed defect)', () => {
  // findElement throws on a stale ref, and tryCheck used to swallow every
  // throw as "condition not yet met" — so a disappear wait whose element was
  // ALREADY gone ran the full timeout, and appear/enabled/textContains on a
  // replaced node hung the same way. Stale refs now satisfy `disappear` and
  // fail every other condition fast, with the re-snapshot guidance.

  it('disappear by ref succeeds immediately once the element is removed', async () => {
    document.body.innerHTML = '<div id="modal"><button>关闭</button></div>';
    const snap = await snapshot();
    const ref = snap.elements.find((e) => e.text === '关闭')!.ref;
    document.getElementById('modal')!.remove();

    const result = await waitFor({ type: 'disappear', locator: { ref } }, 5000);

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.elapsed).toBeLessThan(4000);
  });

  it('disappear by ref resolves when the removal happens mid-wait', async () => {
    document.body.innerHTML = '<div id="modal"><button>关闭</button></div>';
    const snap = await snapshot();
    const ref = snap.elements.find((e) => e.text === '关闭')!.ref;
    setTimeout(() => document.getElementById('modal')!.remove(), 30);

    const result = await waitFor({ type: 'disappear', locator: { ref } }, 5000);

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.elapsed).toBeLessThan(4000);
  });

  it('enabled by ref fails fast with re-snapshot guidance when the node was replaced', async () => {
    document.body.innerHTML = '<button id="go">提交</button>';
    const snap = await snapshot();
    const ref = snap.elements.find((e) => e.text === '提交')!.ref;
    // Framework-style re-render: same-looking node, different identity.
    document.body.innerHTML = '<button id="go">提交</button>';

    const result = await waitFor({ type: 'enabled', locator: { ref } }, 5000);

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.message).toMatch(/fresh snapshot/);
    expect(result.elapsed).toBeLessThan(4000);
  });

  it('textContains by ref fails fast when the node is replaced mid-wait', async () => {
    document.body.innerHTML = '<button id="status">加载中</button>';
    const snap = await snapshot();
    const ref = snap.elements.find((e) => e.text === '加载中')!.ref;
    setTimeout(() => {
      document.body.innerHTML = '<button id="status">完成</button>';
    }, 30);

    const result = await waitFor({ type: 'textContains', locator: { ref }, text: '完成' }, 5000);

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.message).toMatch(/fresh snapshot/);
    expect(result.elapsed).toBeLessThan(4000);
  });
});
