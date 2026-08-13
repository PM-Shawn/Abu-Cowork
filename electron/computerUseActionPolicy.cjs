'use strict';

const CONSEQUENCE_CATEGORIES = new Set([
  'none',
  'send',
  'publish',
  'delete',
  'overwrite',
  'install',
  'purchase',
  'credential-change',
  'security-change',
]);

const COMPUTER_ACTIONS = new Set([
  'get_app_state',
  'get_ui',
  'activate_app',
  'activate',
  'screenshot',
  'click',
  'ax_click',
  'type',
  'ax_type',
  'perform_action',
  'scroll',
  'move',
  'drag',
  'key',
  'wait',
]);

const CONSEQUENCE_TRIGGER_COMMANDS = new Set([
  'mouse_click',
  'mouse_drag',
  'keyboard_type',
  'keyboard_press',
  'ax_press',
  'ax_set_value',
  'ax_perform_action',
]);

const CATEGORY_PATTERNS = [
  {
    category: 'purchase',
    patterns: [
      /\b(buy|purchase|pay|checkout|place order|confirm order|subscribe)\b/i,
      /(购买|立即购买|支付|付款|结账|提交订单|确认订单|订阅)/,
    ],
  },
  {
    category: 'credential-change',
    patterns: [
      /\b(change|reset|update|replace)\b.{0,24}\b(password|passcode|pin|credential|api key|token)\b/i,
      /(修改|重置|更新|更换).{0,12}(密码|口令|凭据|密钥|令牌)/,
    ],
  },
  {
    category: 'security-change',
    patterns: [
      /\b(disable|turn off|change|reset)\b.{0,24}\b(security|protection|firewall|permission|privacy)\b/i,
      /(关闭|停用|修改|重置).{0,12}(安全|保护|防火墙|权限|隐私)/,
    ],
  },
  {
    category: 'delete',
    patterns: [
      /\b(delete|remove|trash|erase|clear all|empty trash)\b/i,
      /(删除|移除|清空|抹除|移到废纸篓|清倒废纸篓)/,
    ],
  },
  {
    category: 'install',
    patterns: [
      /\b(install|uninstall)\b/i,
      /(安装|卸载)/,
    ],
  },
  {
    category: 'publish',
    patterns: [
      /\b(publish|post|go live)\b/i,
      /(发布|发表|上线)/,
    ],
  },
  {
    category: 'send',
    patterns: [
      /\b(send|submit|reply|forward)\b/i,
      /(发送|提交|回复|转发)/,
    ],
  },
  {
    category: 'overwrite',
    patterns: [
      /\b(overwrite|replace existing|save changes)\b/i,
      /(覆盖|替换现有|保存更改)/,
    ],
  },
];

const CONSEQUENCE_LABELS = Object.freeze({
  send: { zh: '发送内容', en: 'send content' },
  publish: { zh: '发布内容', en: 'publish content' },
  delete: { zh: '删除内容', en: 'delete content' },
  overwrite: { zh: '覆盖现有内容', en: 'overwrite existing content' },
  install: { zh: '安装或卸载软件', en: 'install or uninstall software' },
  purchase: { zh: '购买、付款或订阅', en: 'make a purchase, payment, or subscription' },
  'credential-change': { zh: '修改凭据', en: 'change credentials' },
  'security-change': { zh: '修改安全设置', en: 'change security settings' },
});

function normalizeShortText(value, label, maxLength) {
  if (typeof value !== 'string') {
    throw new Error(`Computer Use ${label} must be a string`);
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Computer Use ${label} must be between 1 and ${maxLength} characters`);
  }
  return normalized;
}

function normalizeActionIntent(raw, scope) {
  if (scope === 'screen-read') {
    return Object.freeze({
      action: 'screenshot',
      category: 'none',
      summary: '',
    });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Computer Use action intent is required');
  }
  const action = normalizeShortText(raw.action, 'action name', 64).toLowerCase();
  if (!COMPUTER_ACTIONS.has(action)) {
    throw new Error('Computer Use action name is invalid');
  }
  const category = typeof raw.category === 'string' ? raw.category.trim() : '';
  if (!CONSEQUENCE_CATEGORIES.has(category)) {
    throw new Error('Computer Use consequence category is invalid');
  }
  const summary = category === 'none'
    ? ''
    : normalizeShortText(raw.summary, 'consequence summary', 400);
  return Object.freeze({ action, category, summary });
}

function findElement(axSession, elementId) {
  if (!axSession?.elements || !Number.isInteger(elementId)) return null;
  return axSession.elements.get(elementId) ?? null;
}

function inferCategoryFromText(text) {
  for (const entry of CATEGORY_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      return entry.category;
    }
  }
  return null;
}

function inferAxConsequence(cmd, args, axSession) {
  if (cmd !== 'ax_press' && cmd !== 'ax_perform_action') return null;
  const element = findElement(axSession, args?.elementId);
  const label = typeof element?.label === 'string' ? element.label.trim() : '';
  if (!label) return null;
  const category = inferCategoryFromText(label);
  if (!category) return null;
  return {
    category,
    summary: `Activate the "${label.slice(0, 160)}" control`,
    source: 'accessibility-label',
  };
}

function normalizedModifiers(args) {
  return new Set(
    Array.isArray(args?.modifiers)
      ? args.modifiers.map((value) => String(value).toLowerCase())
      : [],
  );
}

function inferKeyboardConsequence(session, cmd, args) {
  if (cmd !== 'keyboard_press') return null;
  const key = typeof args?.key === 'string' ? args.key.toLowerCase() : '';
  const modifiers = normalizedModifiers(args);
  const targetId = session.target.bundle_id.toLowerCase();
  const finderLike = targetId === 'com.apple.finder';
  const windowsExplorer = targetId === 'explorer' || targetId === 'explorer.exe';
  if (
    windowsExplorer
    && (key === 'delete' || key === 'backspace')
  ) {
    const permanent = modifiers.has('shift');
    return {
      category: 'delete',
      summary: permanent
        ? `Permanently delete the selected item in ${session.target.app_name}`
        : `Delete the selected item in ${session.target.app_name}`,
      source: 'keyboard-shortcut',
    };
  }
  if (
    finderLike
    && (key === 'delete' || key === 'backspace')
    && (modifiers.has('meta') || modifiers.has('ctrl'))
  ) {
    return {
      category: 'delete',
      summary: `Delete the selected item in ${session.target.app_name}`,
      source: 'keyboard-shortcut',
    };
  }
  return null;
}

/**
 * A model-supplied `category: none` is not positive evidence that an input is
 * harmless. In browsers, communication apps, and unknown applications the
 * same Return key or unlabelled pointer action can submit a form, send a
 * message, or confirm a purchase. App classification alone cannot prove the
 * focused control is harmless, so fail closed for commit-like input that has
 * no trustworthy AX semantics.
 */
function inferAmbiguousConsequence(session, cmd, args, axSession) {
  if (cmd === 'keyboard_press') {
    const key = typeof args?.key === 'string' ? args.key.trim().toLowerCase() : '';
    if (key === 'enter' || key === 'return') {
      return {
        category: 'ambiguous',
        summary: `Press ${args.key} in ${session.target.app_name}; this may submit or send content`,
        source: 'host-ambiguous-input',
      };
    }
  }

  if (cmd === 'mouse_click' || cmd === 'mouse_drag') {
    return {
      category: 'ambiguous',
      summary: `${cmd === 'mouse_click' ? 'Click' : 'Drag'} in ${session.target.app_name} without accessibility semantics`,
      source: 'host-ambiguous-input',
    };
  }

  if (cmd === 'ax_press' || cmd === 'ax_perform_action') {
    const element = findElement(axSession, args?.elementId);
    const label = typeof element?.label === 'string' ? element.label.trim() : '';
    if (!label) {
      return {
        category: 'ambiguous',
        summary: `Activate an unlabelled control in ${session.target.app_name}`,
        source: 'host-ambiguous-input',
      };
    }
  }

  return null;
}

function resolveConsequence(session, cmd, args, axSession) {
  if (!CONSEQUENCE_TRIGGER_COMMANDS.has(cmd)) return null;
  const inferred = inferAxConsequence(cmd, args, axSession)
    ?? inferKeyboardConsequence(session, cmd, args);
  if (inferred) return inferred;
  if (session.actionIntent.category !== 'none') {
    return {
      category: session.actionIntent.category,
      summary: session.actionIntent.summary,
      source: 'declared-intent',
    };
  }
  return inferAmbiguousConsequence(session, cmd, args, axSession);
}

function sanitizeAxElements(result) {
  const elements = new Map();
  if (!Array.isArray(result?.elements)) return elements;
  for (const raw of result.elements) {
    if (!Number.isInteger(raw?.id)) continue;
    elements.set(raw.id, {
      id: raw.id,
      role: typeof raw.role === 'string' ? raw.role.slice(0, 80) : '',
      label: typeof raw.label === 'string' ? raw.label.slice(0, 240) : '',
    });
  }
  return elements;
}

function buildActionApprovalDialogOptions({ isZh, target, consequence }) {
  const labels = CONSEQUENCE_LABELS[consequence.category]
    ?? { zh: '执行关键操作', en: 'perform a consequential action' };
  return {
    type: 'warning',
    title: isZh ? '确认这次关键操作？' : 'Confirm this consequential action?',
    message: isZh
      ? `Abu 即将在「${target.app_name}」中${labels.zh}`
      : `Abu is about to ${labels.en} in "${target.app_name}"`,
    detail: isZh
      ? [
          `具体操作：${consequence.summary}`,
          '允许仅对上述这一次操作有效。查看或操作应用的权限，不代表已允许发送、删除、购买或修改安全设置。',
        ].join('\n')
      : [
          `Exact action: ${consequence.summary}`,
          'Approval applies only to this action. Permission to view or control an app does not approve sending, deleting, purchasing, or security changes.',
        ].join('\n'),
    buttons: isZh ? ['允许这一次', '取消'] : ['Allow once', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

module.exports = {
  CONSEQUENCE_CATEGORIES,
  COMPUTER_ACTIONS,
  CONSEQUENCE_TRIGGER_COMMANDS,
  normalizeActionIntent,
  inferCategoryFromText,
  resolveConsequence,
  sanitizeAxElements,
  buildActionApprovalDialogOptions,
};
