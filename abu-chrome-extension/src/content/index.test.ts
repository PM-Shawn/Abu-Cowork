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
  id?: string;
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
  target?: { ref: string; tag: string; id?: string; role?: string; text?: string };
}
interface WaitResult extends ActionResult {
  timedOut: boolean;
  elapsed: number;
  /** What the page looked like when the wait gave up — candidates included. */
  observed?: string;
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
const find = (query: Record<string, unknown>, limit?: number) =>
  handleAction('find', { query, limit }) as Promise<{
    matches: Array<{
      ref: string; tag: string; id?: string; role?: string; accessibleName?: string; text?: string;
      visible: boolean; interactive: boolean; disabled?: true;
      rect: { x: number; y: number; width: number; height: number };
    }>;
    total: number;
    truncated?: boolean;
    message?: string;
  }>;

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

// =============================================================================
// F2 — the locator understands ordinary HTML, and refuses to guess
//
// Before this: `{role,name}` compiled to `[role="X"][aria-label="Y"]`, so a
// plain `<button>保存</button>` answered "Element not found"; and `css` /
// `testId` took `querySelector`'s first match, so two `.primary` buttons meant
// one of them was clicked and reported as a success. In an office toolbar
// where 保存 and 删除 sit side by side, that second one is a wrong,
// irreversible action.
// =============================================================================

describe('implicit roles — native HTML has semantics without ARIA attributes', () => {
  it('finds a plain <button> by role and its text', async () => {
    document.body.innerHTML = '<button id="save">保存</button>';

    const result = await click({ role: 'button', name: '保存' });

    expect(result.success).toBe(true);
    expect(result.target?.id).toBe('save');
  });

  it('finds a link, a heading, a submit input and a summary by their native roles', async () => {
    document.body.innerHTML = `
      <a href="/next" id="next">下一步</a>
      <h2 id="head">设备台账</h2>
      <input type="submit" id="submit" value="提交" />
      <details><summary id="more">更多</summary>内容</details>`;

    expect((await click({ role: 'link', name: '下一步' })).target?.id).toBe('next');
    expect((await click({ role: 'heading', name: '设备台账' })).target?.id).toBe('head');
    expect((await click({ role: 'button', name: '提交' })).target?.id).toBe('submit');
    expect((await click({ role: 'button', name: '更多' })).target?.id).toBe('more');
  });

  it('gives a checkbox, a radio and a native select their roles', async () => {
    document.body.innerHTML = `
      <label for="agree">同意条款</label><input type="checkbox" id="agree" />
      <label for="male">男</label><input type="radio" id="male" name="sex" />
      <label for="city">城市</label><select id="city"><option>北京</option><option>上海</option></select>`;

    expect((await click({ role: 'checkbox', name: '同意条款' })).target?.id).toBe('agree');
    expect((await click({ role: 'radio', name: '男' })).target?.id).toBe('male');
    expect((await click({ role: 'combobox', name: '城市' })).target?.id).toBe('city');
  });

  it('does not name a <select> after its own options', async () => {
    // textContent of a <select> is every option concatenated. Naming it from
    // content would invent "北京上海" — a name no user ever sees, that then
    // matches locators nobody meant.
    document.body.innerHTML = '<select id="city"><option>北京</option><option>上海</option></select>';

    await expect(click({ role: 'combobox', name: '北京上海' })).rejects.toThrow(/Element not found/);
  });

  it('still honours an explicit role attribute over the native one', async () => {
    document.body.innerHTML = '<button role="link" id="fake">看起来像链接</button>';

    expect((await click({ role: 'link', name: '看起来像链接' })).target?.id).toBe('fake');
    await expect(click({ role: 'button', name: '看起来像链接' })).rejects.toThrow(/Element not found/);
  });

  it('matches an antd-style button whose two characters the framework spaced apart', async () => {
    // rc-button inserts a space between the two characters of a two-character
    // Chinese label, so the DOM says "提 交" while everyone says "提交".
    document.body.innerHTML = '<button id="submit">提 交</button>';

    expect((await click({ role: 'button', name: '提交' })).target?.id).toBe('submit');
  });
});

describe('accessible name — the six-source fallback', () => {
  it('names an input from a <label for>', async () => {
    document.body.innerHTML = '<label for="code">设备编号</label><input id="code" type="text" />';

    const result = await fill({ role: 'textbox', name: '设备编号' }, 'EQ-001');

    expect(result.success).toBe(true);
    expect((document.getElementById('code') as HTMLInputElement).value).toBe('EQ-001');
  });

  it('names an input from a wrapping <label>', async () => {
    document.body.innerHTML = '<label>备注 <textarea id="remark"></textarea></label>';

    const result = await fill({ role: 'textbox', name: '备注' }, '正常');

    expect(result.success).toBe(true);
    expect((document.getElementById('remark') as HTMLTextAreaElement).value).toBe('正常');
  });

  it('names an element from aria-labelledby before anything else', async () => {
    document.body.innerHTML =
      '<span id="lbl">联系人</span><input id="who" aria-labelledby="lbl" placeholder="请输入" />';

    expect((await fill({ role: 'textbox', name: '联系人' }, '张三')).success).toBe(true);
  });

  it('prefers aria-label over the native label', async () => {
    document.body.innerHTML =
      '<label for="code">旧标签</label><input id="code" aria-label="设备编号" />';

    await expect(fill({ role: 'textbox', name: '旧标签' }, 'x')).rejects.toThrow(/Element not found/);
    expect((await fill({ role: 'textbox', name: '设备编号' }, 'EQ-1')).success).toBe(true);
  });

  it('falls back to the placeholder when the field has no label at all', async () => {
    document.body.innerHTML = '<input id="code" type="text" placeholder="请输入设备编号" />';

    const result = await fill({ role: 'textbox', name: '请输入设备编号' }, 'EQ-002');

    expect(result.success).toBe(true);
    expect((document.getElementById('code') as HTMLInputElement).value).toBe('EQ-002');
  });

  it('does not treat aria-describedby as a name', async () => {
    document.body.innerHTML =
      '<span id="hint">8-20 个字符</span><input id="pwd" type="password" aria-describedby="hint" />';

    await expect(fill({ role: 'textbox', name: '8-20 个字符' }, 'x')).rejects.toThrow(/Element not found/);
  });

  it('takes an exact name over one that merely contains it', async () => {
    document.body.innerHTML = '<button id="save">保存</button><button id="both">保存并提交</button>';

    expect((await click({ role: 'button', name: '保存' })).target?.id).toBe('save');
  });

  it('falls through to a substring only when nothing matches exactly', async () => {
    document.body.innerHTML = '<button id="both">保存并提交</button>';

    expect((await click({ role: 'button', name: '保存' })).target?.id).toBe('both');
  });
});

describe('ambiguity is refused, not resolved by position', () => {
  const clickedIds: string[] = [];
  function recordClicks(): void {
    for (const el of document.querySelectorAll('button, a, input')) {
      el.addEventListener('click', () => clickedIds.push(el.id));
    }
  }
  beforeEach(() => { clickedIds.length = 0; });

  it('refuses two buttons with the same accessible name, and touches neither', async () => {
    document.body.innerHTML = '<button id="first">保存</button><button id="second">保存</button>';
    recordClicks();

    await expect(click({ role: 'button', name: '保存' }))
      .rejects.toThrow(/matches 2 elements[\s\S]*Pick one by ref/);
    expect(clickedIds).toEqual([]);
  });

  it('lists the candidates with refs, roles and names so the caller can choose', async () => {
    document.body.innerHTML = '<button id="first">保存</button><button id="second">保存</button>';

    const error = await click({ role: 'button', name: '保存' }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/\[e\d+\] <button#first> role=button name="保存"/);
    expect(message).toMatch(/\[e\d+\] <button#second>/);
    // The refs it prints must actually resolve — a candidate list the caller
    // cannot act on is just a longer way of saying "no".
    const ref = /\[(e\d+)\] <button#second>/.exec(message)![1];
    expect((await click({ ref })).target?.id).toBe('second');
  });

  it('refuses a css selector that matches two elements, and touches neither', async () => {
    document.body.innerHTML =
      '<button class="primary" id="first">保存</button><button class="primary" id="second">删除</button>';
    recordClicks();

    await expect(click({ css: '.primary' })).rejects.toThrow(/matches 2 elements/);
    expect(clickedIds).toEqual([]);
  });

  it('refuses a duplicated testId, and touches neither', async () => {
    document.body.innerHTML =
      '<button data-testid="save" id="first">保存甲</button><button data-testid="save" id="second">保存乙</button>';
    recordClicks();

    await expect(click({ testId: 'save' })).rejects.toThrow(/matches 2 elements/);
    expect(clickedIds).toEqual([]);
  });

  it('refuses an ambiguous locator on fill too, leaving both fields untouched', async () => {
    document.body.innerHTML = '<input class="f" id="a" /><input class="f" id="b" />';

    await expect(fill({ css: '.f' }, 'x')).rejects.toThrow(/matches 2 elements/);
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('b') as HTMLInputElement).value).toBe('');
  });

  it('acts when only one of two same-named buttons is actually on screen', async () => {
    // The hidden copy is the modal that is closed right now. Counting it would
    // make every page that renders a form twice permanently ambiguous.
    document.body.innerHTML =
      '<button id="live">保存</button><div style="display:none"><button id="ghost">保存</button></div>';

    expect((await click({ role: 'button', name: '保存' })).target?.id).toBe('live');
  });

  it('leaves out a copy hidden with the hidden attribute', async () => {
    document.body.innerHTML = '<button id="live">保存</button><button id="ghost" hidden>保存</button>';

    expect((await click({ role: 'button', name: '保存' })).target?.id).toBe('live');
  });

  it('never matches a type=hidden input', async () => {
    document.body.innerHTML = '<input type="hidden" data-testid="token" value="abc" />';

    await expect(click({ testId: 'token' })).rejects.toThrow(/Element not found/);
  });

  it('leaves out a copy hidden from the accessibility tree with aria-hidden', async () => {
    // The standard way to keep a duplicated render out of the a11y tree. A
    // role/name locator is an accessibility-tree query, so matching the mirror
    // is wrong on its own terms — and it made the live page permanently
    // ambiguous on the very locator this work exists to make usable.
    document.body.innerHTML =
      '<button id="live">保存</button><button id="mirror" aria-hidden="true">保存</button>';

    expect((await click({ role: 'button', name: '保存' })).target?.id).toBe('live');
  });

  it('leaves out a copy under an aria-hidden ancestor', async () => {
    // antd/element-plus hide whole subtrees, not individual controls.
    document.body.innerHTML =
      '<button id="live">保存</button><div aria-hidden="true"><span><button id="mirror">保存</button></span></div>';

    expect((await click({ role: 'button', name: '保存' })).target?.id).toBe('live');
  });

  it('leaves out a copy inside an inert subtree', async () => {
    // `inert` is the platform's "this exists but nobody can reach it" — a
    // background layer behind an open modal. It cannot receive the click we
    // would dispatch, so counting it only blocks the reachable one.
    document.body.innerHTML =
      '<div inert><button id="behind">保存</button></div><button id="live">保存</button>';

    expect((await click({ role: 'button', name: '保存' })).target?.id).toBe('live');
  });

  it('leaves out a laid-out copy the page painted fully transparent', async () => {
    document.body.innerHTML =
      '<button id="live">保存</button><div style="opacity:0"><button id="ghost">保存</button></div>';

    expect((await click({ role: 'button', name: '保存' })).target?.id).toBe('live');
  });

  it('still reaches a collapsed combobox, which is transparent on purpose', async () => {
    // The other side of the opacity rule, and the reason it is scoped to
    // elements that HAVE a layout box: antd puts `role="combobox"` on a
    // `width: 0; opacity: 0` <input> beside the span the user sees. Excluding
    // every transparent element would make every dropdown on the page
    // unaddressable — the exact failure `isSnapshotVisible` exists to avoid.
    document.body.innerHTML =
      '<div class="ant-select" style="opacity:0"><span>请选择</span>'
      + '<input data-hidden id="type" role="combobox" readonly /></div>';

    expect((await click({ role: 'combobox' })).target?.id).toBe('type');
  });

  it('never treats Abu\'s own status bubble as a candidate', async () => {
    // The bubble lives on <html> (so `snapshot` never sees it) and echoes what
    // was just done. Every locator scans the whole document, so after one
    // action our own caption joins the candidate set and the automation starts
    // tripping over its own footprint. `find` already pins this; the locator
    // used by click/fill/select/wait_for did not.
    document.body.innerHTML = '<input id="q" /><p id="hint">点击保存按钮即可提交</p>';
    await fill({ css: '#q' }, '保存');
    expect(document.getElementById('abu-status')?.textContent).toContain('保存');

    expect((await click({ text: '保存' })).target?.id).toBe('hint');
    await expect(click({ css: '#abu-status' })).rejects.toThrow(/Element not found/);
  });
});

describe('a label written both ways is still one label', () => {
  it('does not read a for= label that also wraps the field as two labels', async () => {
    // `<label for="x">文字<input id="x"></label>` is what form libraries and
    // accessibility tutorials emit. Collecting `label[for]` and then the
    // wrapping <label> pushed the SAME element twice, so the field answered to
    // the name "姓名 姓名" — which the exact and normalized tiers both miss.
    document.body.innerHTML = '<label for="n">姓名<input id="n" /></label>';

    const result = await find({ label: '姓名' });

    expect(result.matches.map((m) => m.id)).toEqual(['n']);
    expect(result.matches[0].accessibleName).toBe('姓名');
  });

  it('does not let a doubled name hand the exact tier to an unrelated field', async () => {
    // The consequence that makes this more than cosmetic: with the real field
    // named "姓名 姓名", `{name:"姓名"}` matched only the decoy at the exact
    // tier and filled it — silently, reporting success.
    document.body.innerHTML =
      '<label for="n">姓名<input id="n" /></label><input id="decoy" aria-label="姓名" />';

    await expect(fill({ role: 'textbox', name: '姓名' }, '张三'))
      .rejects.toThrow(/matches 2 elements/);
    expect((document.getElementById('n') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('decoy') as HTMLInputElement).value).toBe('');
  });
});

describe('wait_for asks what the page looks like, not whether a locator is unique', () => {
  it('sees a toast appear on a page that shows two of them', async () => {
    // `{appear, css:'.toast'}` — or `.ant-table-row`, or `.ant-spin` — matching
    // several elements IS the normal shape of the question. Refusing it left
    // the caller with no way out: `appear` waits for something that does not
    // exist yet, so "pick one by ref" has no ref to offer.
    document.body.innerHTML = '<div class="toast">已保存</div><div class="toast">已同步</div>';

    const result = await waitFor({ type: 'appear', locator: { css: '.toast' } }, 60);

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('keeps waiting while any of several spinners is still up', async () => {
    document.body.innerHTML = '<div class="spin"></div><div class="spin"></div>';
    setTimeout(() => document.querySelector('.spin')?.remove(), 10);

    const result = await waitFor({ type: 'disappear', locator: { css: '.spin' } }, 80);

    expect(result.timedOut).toBe(true);
    expect(result.message).toMatch(/Timed out/);
  });

  it('finishes as soon as the last of several spinners goes away', async () => {
    document.body.innerHTML = '<div class="spin"></div><div class="spin"></div>';
    setTimeout(() => { for (const el of document.querySelectorAll('.spin')) el.remove(); }, 10);

    const result = await waitFor({ type: 'disappear', locator: { css: '.spin' } }, 2000);

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('names the candidates when an ambiguous locator never comes true', async () => {
    document.body.innerHTML =
      '<button class="b" id="one" disabled>一</button><button class="b" id="two" disabled>二</button>';

    const result = await waitFor({ type: 'enabled', locator: { css: '.b' } }, 60);

    expect(result.timedOut).toBe(true);
    expect(result.observed).toMatch(/2 elements/);
    expect(result.observed).toMatch(/\[e\d+\] <button#one>/);
  });

  it('still fails fast when a ref went stale, instead of burning the timeout', async () => {
    document.body.innerHTML = '<div id="gone">x</div>';
    const snap = await snapshot({ selector: '#gone' });
    void snap;
    // A ref that resolves to nothing is a different answer from "no match":
    // pinned here so the multi-match rewrite cannot swallow it.
    const result = await waitFor({ type: 'appear', locator: { ref: 'e9999' } }, 5000);

    expect(result.success).toBe(false);
    expect(result.elapsed).toBeLessThan(3000);
  });
});

describe('a miss names the near misses instead of stopping at "not found"', () => {
  it('lists the buttons that ARE on the page when the named one is not', async () => {
    document.body.innerHTML = '<button id="submit">提交</button><button id="cancel">取消</button>';

    const error = await click({ role: 'button', name: '保存' }).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/Element not found/);
    expect((error as Error).message).toMatch(/closest things on the page/i);
    expect((error as Error).message).toMatch(/name="提交"/);
    expect((error as Error).message).toMatch(/name="取消"/);
  });

  it('points at find when it has nothing close to offer', async () => {
    document.body.innerHTML = '<div>empty</div>';

    await expect(click({ css: '#nope' })).rejects.toThrow(/Element not found[\s\S]*call find|Call find/i);
  });
});

describe('find — read-only search, the cheap step before acting', () => {
  it('returns candidates with ref, role, name, visibility and box — and changes nothing', async () => {
    document.body.innerHTML = '<button id="save" class="primary">保存</button>';
    let clicks = 0;
    document.getElementById('save')!.addEventListener('click', () => { clicks += 1; });

    const result = await find({ role: 'button' });

    expect(result.total).toBe(1);
    expect(result.matches[0]).toMatchObject({
      tag: 'button', id: 'save', role: 'button', accessibleName: '保存', visible: true, interactive: true,
    });
    expect(result.matches[0].rect).toMatchObject({ width: 100, height: 20 });
    expect(result.matches[0].ref).toMatch(/^e\d+$/);
    expect(clicks).toBe(0);
  });

  it('hands back a ref that click can use directly', async () => {
    document.body.innerHTML = '<button id="first">保存</button><button id="second">保存</button>';

    const result = await find({ role: 'button', name: '保存' });

    expect(result.total).toBe(2);
    const second = result.matches.find((m) => m.id === 'second')!;
    expect((await click({ ref: second.ref })).target?.id).toBe('second');
  });

  it('shares the locator\'s ref namespace, so a snapshot ref and a find ref agree', async () => {
    document.body.innerHTML = '<button id="save">保存</button>';
    const snap = await snapshot();

    const result = await find({ text: '保存' });

    expect(result.matches[0].ref).toBe(snap.elements.find((e) => e.id === 'save')!.ref);
  });

  it('finds a form field by the text of its label', async () => {
    document.body.innerHTML =
      '<label for="code">设备编号</label><input id="code" />' +
      '<label for="name">设备名称</label><input id="name" />';

    const result = await find({ label: '设备编号' });

    expect(result.matches.map((m) => m.id)).toEqual(['code']);
  });

  it('finds a form field by its placeholder', async () => {
    document.body.innerHTML =
      '<input id="code" placeholder="请输入设备编号" /><input id="remark" placeholder="请输入备注" />';

    const result = await find({ placeholder: '设备编号' });

    expect(result.matches.map((m) => m.id)).toEqual(['code']);
  });

  it('ANDs several keys together', async () => {
    document.body.innerHTML =
      '<button class="primary" id="save">保存</button>' +
      '<button class="ghost" id="save2">保存</button>' +
      '<button class="primary" id="del">删除</button>';

    const result = await find({ css: '.primary', name: '保存' });

    expect(result.matches.map((m) => m.id)).toEqual(['save']);
  });

  it('leaves hidden elements out, and says so when nothing matches', async () => {
    document.body.innerHTML = '<div style="display:none"><button id="ghost">保存</button></div>';

    const result = await find({ role: 'button', name: '保存' });

    expect(result.total).toBe(0);
    expect(result.matches).toEqual([]);
    expect(result.message).toMatch(/Hidden elements are excluded/);
  });

  it('caps the list and tells the caller to narrow rather than raise the limit', async () => {
    document.body.innerHTML = Array.from({ length: 30 }, (_, i) => `<button id="b${i}">按钮</button>`).join('');

    const result = await find({ role: 'button' });

    expect(result.total).toBe(30);
    expect(result.matches).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.message).toMatch(/Narrow the query/);
  });

  it('honours an explicit limit, clamped to the ceiling', async () => {
    document.body.innerHTML = Array.from({ length: 60 }, (_, i) => `<button id="b${i}">按钮</button>`).join('');

    expect((await find({ role: 'button' }, 3)).matches).toHaveLength(3);
    expect((await find({ role: 'button' }, 999)).matches).toHaveLength(50);
  });

  it('calls the accessible name `accessibleName`, because snapshot\'s `name` is the attribute', async () => {
    // Same field name, two meanings, in the two tools a model uses back to
    // back: snapshot's `name` is the HTML attribute (`username`), find's is
    // the accessible name (`用户名`). A caller that copied one into the other
    // got "not found" and no way to see why.
    document.body.innerHTML = '<label for="u">用户名</label><input id="u" name="username" />';

    const snap = await snapshot();
    const [match] = (await find({ role: 'textbox' })).matches;

    expect(snap.elements.find((e) => e.id === 'u')).toMatchObject({ name: 'username' });
    expect(match.accessibleName).toBe('用户名');
    expect((match as unknown as { name?: string }).name).toBeUndefined();
  });

  it('reports a disabled control as such instead of pretending it is actionable', async () => {
    document.body.innerHTML = '<button id="save" disabled>保存</button>';

    expect((await find({ role: 'button' })).matches[0].disabled).toBe(true);
  });

  it('reports a collapsed control as not visible, but still returns it', async () => {
    // antd's combobox is a zero-box <input> beside the span the user sees.
    document.body.innerHTML =
      '<div class="ant-select"><span>请选择</span><input data-hidden id="type" role="combobox" /></div>';

    const result = await find({ role: 'combobox' });

    expect(result.matches.map((m) => m.id)).toEqual(['type']);
    expect(result.matches[0].visible).toBe(false);
  });

  it('takes the innermost element for a text query, not the wrapper around it', async () => {
    document.body.innerHTML = '<div id="wrap"><span id="inner">保存</span></div>';

    const result = await find({ text: '保存' });

    expect(result.matches.map((m) => m.id)).toEqual(['inner']);
  });

  it('never matches Abu\'s own status bubble, which echoes what was just done', async () => {
    // The bubble lives on <html>, outside <body>, and reads "Abu: Click: 保存"
    // after a 保存 click. Left in scope, the very next {text:"保存"} locator
    // matched the real button AND our own caption and was refused as
    // ambiguous — the automation tripping over its own footprint.
    document.body.innerHTML = '<button id="save">保存</button>';
    await click({ role: 'button', name: '保存' });

    const result = await find({ text: '保存' });

    expect(result.matches.map((m) => m.id)).toEqual(['save']);
    expect((await click({ text: '保存' })).target?.id).toBe('save');
  });

  it('refuses a query with no usable key rather than returning the whole page', async () => {
    document.body.innerHTML = '<button>保存</button>';

    await expect(find({})).rejects.toThrow(/at least one of/);
    await expect(find({ name: '' })).rejects.toThrow(/at least one of/);
  });
});
