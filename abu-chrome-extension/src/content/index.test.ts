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

/** Size used for every "laid out" element — see the stub below. */
const LAID_OUT = { width: 100, height: 20 };

beforeAll(async () => {
  // happy-dom performs no layout, so getBoundingClientRect() is all zeros and
  // isVisible() would treat the entire page as invisible. Stub it: elements
  // carrying `data-hidden` report a zero box, everything else reports a real
  // one. (isVisible()'s computed-style branch is unreachable here because
  // happy-dom leaves offsetParent `undefined`, not `null`.)
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      const hidden = this.hasAttribute?.('data-hidden');
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

  it('skips elements with no layout box', async () => {
    document.body.innerHTML = '<button>可见</button><button data-hidden>隐藏</button>';
    const snap = await snapshot();
    expect(snap.elements.map((e) => e.text)).toEqual(['可见']);
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

describe('known defects — pinned so the fix shows up as a deliberate diff', () => {
  it('DEFECT: a text locator matches the outermost ancestor, not the option', async () => {
    renderAntdLikeForm();

    const result = await click({ text: '动设备' });

    // What the caller wanted was the `.ant-select-item-option`. What it gets
    // is an ancestor whose text merely *contains* the string — in the field
    // report this was <body>, i.e. the whole page shell, reported as success.
    expect(result.success).toBe(true);
    expect(result.elementText).toContain('静设备');
  });

  it('DEFECT: wait_for inherits the same match, so "appear" is true immediately', async () => {
    renderAntdLikeForm();

    const result = await waitFor({ type: 'appear', locator: { text: '还没有出现的文字' } }, 50);
    expect(result.success).toBe(false);

    // But any string already present anywhere on the page resolves instantly
    // through an ancestor match — including while the real target is hidden.
    document.querySelector('.ant-select-dropdown')!.setAttribute('data-hidden', '');
    const stillTrue = await waitFor({ type: 'appear', locator: { text: '动设备' } }, 50);
    expect(stillTrue.success).toBe(true);
    expect(stillTrue.elapsed).toBe(0);
  });

  it('DEFECT: a ref silently retargets when the page changes between snapshots', async () => {
    // Every snapshot clears the map and restarts numbering from e1, so a ref
    // is only an index into "whatever the last snapshot walked". This is worse
    // than a dangling ref: it does not fail, it points somewhere else.
    document.body.innerHTML = '<button>提交</button>';
    const first = await snapshot();
    const submitRef = first.elements[0].ref;

    // The page changes the way an SPA does — a dropdown opens above the form.
    document.body.insertAdjacentHTML('afterbegin', '<button>取消</button>');
    await snapshot();

    const result = await click({ ref: submitRef });

    expect(result.success).toBe(true);
    expect(result.elementText).toBe('取消'); // caller asked for 提交
  });

  it('DEFECT: select refuses an ARIA combobox, with no pointer to what would work', async () => {
    renderAntdLikeForm();

    await expect(
      handleAction('select', { locator: { css: '#form_item_equipmentTypeId' }, value: '动设备' }),
    ).rejects.toThrow(/not a <select>/);
  });
});
