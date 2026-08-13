'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  inferCategoryFromText,
  buildActionApprovalDialogOptions,
  normalizeActionIntent,
  resolveConsequence,
  sanitizeAxElements,
} = require('./computerUseActionPolicy.cjs');

test('action intent requires a valid category and exact summary for consequences', () => {
  assert.deepEqual(
    normalizeActionIntent({ action: 'click', category: 'none' }, 'ui-control'),
    { action: 'click', category: 'none', summary: '' },
  );
  assert.deepEqual(
    normalizeActionIntent({
      action: 'CLICK',
      category: 'send',
      summary: '  Send the prepared reply  ',
    }, 'ui-control'),
    { action: 'click', category: 'send', summary: 'Send the prepared reply' },
  );
  assert.throws(
    () => normalizeActionIntent(null, 'ui-control'),
    /action intent is required/,
  );
  assert.throws(
    () => normalizeActionIntent({ action: 'click', category: 'later' }, 'ui-control'),
    /category is invalid/,
  );
  assert.throws(
    () => normalizeActionIntent({ action: 'run_shell', category: 'none' }, 'ui-control'),
    /action name is invalid/,
  );
  assert.throws(
    () => normalizeActionIntent({ action: 'click', category: 'delete' }, 'ui-control'),
    /consequence summary/,
  );
});

test('screen reading always normalizes to a non-consequential intent', () => {
  assert.deepEqual(
    normalizeActionIntent(null, 'screen-read'),
    { action: 'screenshot', category: 'none', summary: '' },
  );
});

test('native accessibility labels classify reviewed consequential controls', () => {
  const examples = new Map([
    ['发送', 'send'],
    ['Publish now', 'publish'],
    ['Delete conversation', 'delete'],
    ['Overwrite existing file', 'overwrite'],
    ['Install update', 'install'],
    ['Place order', 'purchase'],
    ['修改登录密码', 'credential-change'],
    ['关闭安全保护', 'security-change'],
  ]);
  for (const [label, expected] of examples) {
    assert.equal(inferCategoryFromText(label), expected, label);
  }
  assert.equal(inferCategoryFromText('Open details'), null);
});

test('native label inference overrides a renderer declaration of none', () => {
  const elements = sanitizeAxElements({
    elements: [
      { id: 7, role: 'AXButton', label: 'Delete message', value: 'secret value' },
    ],
  });
  const session = {
    target: { app_name: 'Slack', bundle_id: 'com.tinyspeck.slackmacgap' },
    actionIntent: { action: 'click', category: 'none', summary: '' },
  };
  assert.deepEqual(
    resolveConsequence(
      session,
      'ax_press',
      { elementId: 7 },
      { elements },
    ),
    {
      category: 'delete',
      summary: 'Activate the "Delete message" control',
      source: 'accessibility-label',
    },
  );
  assert.equal(elements.get(7).value, undefined);
});

test('declared consequences bind to the next native side effect', () => {
  const session = {
    target: { app_name: 'Notes', bundle_id: 'com.apple.Notes' },
    actionIntent: {
      action: 'key',
      category: 'publish',
      summary: 'Publish the prepared release note',
    },
  };
  assert.deepEqual(
    resolveConsequence(session, 'keyboard_press', { key: 'Return' }, null),
    {
      category: 'publish',
      summary: 'Publish the prepared release note',
      source: 'declared-intent',
    },
  );
  assert.equal(resolveConsequence(session, 'capture_screen', {}, null), null);
});

test('Windows Explorer Delete and Shift+Delete are host-inferred consequences', () => {
  const session = {
    target: { app_name: 'Explorer', bundle_id: 'explorer.exe' },
    actionIntent: { action: 'key', category: 'none', summary: '' },
  };
  assert.deepEqual(
    resolveConsequence(session, 'keyboard_press', { key: 'Delete' }, null),
    {
      category: 'delete',
      summary: 'Delete the selected item in Explorer',
      source: 'keyboard-shortcut',
    },
  );
  assert.deepEqual(
    resolveConsequence(
      session,
      'keyboard_press',
      { key: 'Delete', modifiers: ['Shift'] },
      null,
    ),
    {
      category: 'delete',
      summary: 'Permanently delete the selected item in Explorer',
      source: 'keyboard-shortcut',
    },
  );
});

test('native action confirmation defaults to cancel and explains one-time scope', () => {
  const options = buildActionApprovalDialogOptions({
    isZh: true,
    target: { app_name: '备忘录' },
    consequence: {
      category: 'delete',
      summary: '删除一次性测试笔记',
    },
  });
  assert.deepEqual(options.buttons, ['允许这一次', '取消']);
  assert.equal(options.defaultId, 1);
  assert.equal(options.cancelId, 1);
  assert.match(options.message, /备忘录/);
  assert.match(options.detail, /删除一次性测试笔记/);
  assert.match(options.detail, /一次操作有效/);
});
