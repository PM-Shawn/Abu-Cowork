/**
 * Which connector (MCP) tool calls act on other people's behalf or cannot be
 * taken back, and so are asked about in every permission mode.
 *
 * ## Why this module exists
 *
 * A tool from a connector the user set up by hand, or one an organization
 * provides, used to run with no approval at all, in every mode: a mail
 * connector's `send_email` went out unasked. Sending to other people, deleting
 * in someone's mail or drive, and moving money are the actions the product
 * promises to stop for, whatever the mode.
 *
 * ## What it reads
 *
 * The tool's own name, split into words (the whole name is read, not its first
 * word: `check_and_send_email` and `read_then_delete` send and delete) (`send_email`, `sendMessage`,
 * `chat.postMessage`, `im.v1.message.create` all read as sending), Chinese and
 * pinyin included (`发送消息`, `fasong_xiaoxi`). When the name says nothing
 * either way, the first words of the tool's description decide ("Sends a
 * message to…", 「发送消息到群聊」). A name that starts with a read verb
 * (`get_reply`, `list_posts`, `search_emails`, 「查询发送记录」) is reading,
 * unless it also holds a verb that can only be an action (`read_then_delete`).
 * A tool whose name and description say nothing either way asks when its
 * connector has other tools that write (`connectorServerWrites`): an unknown
 * verb on a connector that can change things is not assumed harmless.
 *
 * The MCP annotations come from the server and are untrusted (the MCP spec
 * says as much), so they may only ADD an ask: `destructiveHint: true` makes a
 * tool ask on its own, every time, even one whose name reads as a send or a
 * change (which would otherwise be a reusable grant). `openWorldHint: true` (the tool reaches a service
 * outside) never makes a tool ask by itself; it only confirms a weak sign of
 * sending, a description that speaks of sending past its opening ("Creates an
 * event and sends the invitations"), which alone is not taken. A server that
 * marks `send_message` read-only is still asked about.
 *
 * The browser servers have their own gate (`browserToolPolicy.ts`) and are not
 * classified here.
 */

import { parseNamespacedToolName } from '../mcp/toolName';
import { BROWSER_SERVER_NAMES_FOR_POLICY } from './browserToolPolicy';

/**
 * - `send`: delivers something to other people (mail, chat, a post, a share,
 *   an upload to a service). Asked once per task and recipient: the approval
 *   covers that tool's sends to the same recipient for the rest of the task.
 * - `destructive`: deletes or overwrites in the connected service, or the
 *   server says it is destructive. Asked every time.
 * - `money`: pays, transfers, refunds or places an order. Asked every time.
 * - `change`: updates, creates, runs or otherwise writes in the connected
 *   service, or does something the name does not say on a connector that
 *   writes. Asked once per task for that tool and target, like a send.
 */
export type ConnectorActionKind = 'send' | 'destructive' | 'money' | 'change';

/** The MCP tool data this gate reads (`Tool.annotations`, `Tool.description`). */
export interface ConnectorToolHints {
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  description?: string;
  /** The connector has tools that write (see `connectorServerWrites`): an unclassifiable verb is then asked about. */
  serverWrites?: boolean;
}

const READ_VERBS = new Set([
  'get', 'list', 'read', 'search', 'fetch', 'query', 'find', 'view', 'show', 'describe',
  'retrieve', 'lookup', 'count', 'check', 'download', 'export', 'preview', 'summarize',
  'analyze', 'inspect', 'browse', 'load', 'peek', 'watch',
  // pinyin
  'chaxun', 'huoqu', 'duqu', 'sousuo', 'chakan', 'liechu', 'daochu', 'xiazai',
]);
/**
 * Verbs come in two strengths. A STRONG word is an action wherever it stands in
 * the name, even after a read verb (`check_and_send_email`, `read_then_delete`).
 * A WEAK word is also a noun in tool names (`get_merge_request`, `list_posts`,
 * `get_charge`, `preview_transfer`, `list_trash`) and counts when the name does
 * not start by reading, or when a connective follows the read verb
 * (`check_balance_then_transfer`, `get_or_create_user`). Pinyin is always weak:
 * the same syllables are verbs and nouns (`chaxun_fasong_jilu`).
 */
const SEND_STRONG = new Set(['send', 'broadcast', 'publish', 'tweet', 'retweet', 'transmit']);
const SEND_WEAK = new Set([
  'forward', 'repost', 'dispatch', 'post', 'reply', 'share', 'invite', 'notify', 'dm', 'push',
  'deliver', 'upload', 'submit',
  // pinyin
  'fasong', 'zhuanfa', 'fabu', 'qunfa', 'tuisong', 'huifu', 'shangchuan', 'tijiao',
]);
/** `create_message`, `im.v1.message.create`: making one of these is sending it. */
const CREATE_VERBS = new Set(['create', 'new', 'add', 'compose', 'write', 'make', 'place', 'issue']);
const SENT_NOUNS = new Set([
  'message', 'messages', 'msg', 'mail', 'email', 'emails', 'post', 'posts', 'comment',
  'comments', 'reply', 'replies', 'tweet', 'tweets', 'status', 'announcement', 'notification',
  'notifications', 'sms', 'invitation', 'invite', 'xiaoxi', 'youjian', 'tongzhi',
]);
const DESTRUCTIVE_STRONG = new Set([
  'delete', 'purge', 'destroy', 'wipe', 'erase', 'drop', 'remove', 'revoke', 'truncate',
  'unlink', 'overwrite', 'replace', 'terminate', 'kill', 'cancel', 'execute', 'exec',
  'deactivate', 'unsubscribe',
]);
const DESTRUCTIVE_WEAK = new Set([
  'trash', 'archive', 'merge', 'clear', 'reset', 'disable', 'suspend', 'close',
  // pinyin
  'shanchu', 'yichu', 'qingkong', 'chexiao',
]);
const MONEY_STRONG = new Set(['pay', 'remit', 'withdraw']);
const MONEY_WEAK = new Set([
  'transfer', 'refund', 'purchase', 'payout', 'wire', 'buy', 'charge', 'checkout',
  // pinyin
  'zhifu', 'fukuan', 'zhuanzhang', 'tuikuan', 'xiadan', 'goumai',
]);
/** Writes in the connected service that neither delete nor reach anyone. */
const CHANGE_STRONG = new Set([
  'update', 'modify', 'edit', 'insert', 'upsert', 'patch', 'put', 'rename', 'move', 'assign',
  'deploy', 'restart', 'append', 'import', 'sync', 'write',
]);
const CHANGE_WEAK = new Set([
  'create', 'add', 'compose', 'set', 'approve', 'reject',
  // pinyin
  'gengxin', 'xiugai', 'chuangjian',
]);
/** What can stand between a read verb and the action that follows it. */
const CONNECTIVES = new Set(['and', 'then', 'or', 'after', 'before']);
/**
 * Things whose making moves money: `create_payment`, `place_order`,
 * `send_invoice`. Counted only with a verb that makes or sends one, so
 * `update_sort_order` or `list_orders` is no payment.
 */
const MONEY_NOUNS = new Set([
  'payment', 'payments', 'order', 'orders', 'invoice', 'invoices', 'funds', 'money',
  'transaction', 'transactions',
]);
const MONEY_MAKING_VERBS = new Set([...CREATE_VERBS, 'submit', 'send', 'initiate', 'execute', 'confirm', 'approve', 'process']);

/**
 * Chinese verbs, matched as substrings of the Chinese part of a name or a
 * description's opening. A lone 发 is not one: it is in 开发, 发票, 发现.
 */
const CJK_READ_PREFIXES = ['查询', '获取', '读取', '搜索', '查看', '列出', '导出', '下载', '统计', '检查', '查找'];
/**
 * After a Chinese read verb an action counts only behind 并 / 后 / 再 / 然后
 * (「查询并删除」, 「获取后覆盖」): 「获取删除日志」 and 「查询发送记录」 are reads.
 */
const CJK_MONEY = ['支付', '付款', '转账', '退款', '下单', '购买', '缴费', '打款', '汇款'];
const CJK_DESTRUCTIVE = ['删除', '移除', '清空', '撤销', '撤回', '销毁', '注销', '覆盖', '执行', '合并', '终止', '取消', '归档'];
const CJK_SEND = ['发送', '推送', '回复', '转发', '发布', '群发', '发消息', '发邮件', '发短信', '发通知', '发给', '上传', '提交', '分享'];
const CJK_CHANGE = ['更新', '修改', '编辑', '创建', '新增', '新建', '写入', '添加', '重命名', '移动'];

/** `outlook_send_mail` → outlook, send, mail; `chat.postMessage` → chat, post, message. */
export function toolNameWords(toolName: string): string[] {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** The Chinese characters of a text, in order, with everything else dropped. */
function cjkText(text: string): string {
  return Array.from(text).filter((char) => /\p{Script=Han}/u.test(char)).join('');
}

/**
 * A lone 发 starts a send (「发群公告」, 「发起审批」), except in the two nouns a
 * tool name begins with: 发票 (invoice) and 发现 (discover).
 */
function startsWithLoneSendVerb(cjk: string): boolean {
  return cjk.startsWith('发') && !/^发[票现]/u.test(cjk);
}

/**
 * The verdict of one piece of text (a tool name, or a description's opening):
 * `'read'` when it starts by reading and holds no action verb, a kind when it
 * acts, null when it says nothing either way.
 *
 * The whole text is read: a STRONG verb (see the verb lists) acts wherever it
 * stands, so `check_and_send_email` and `read_then_delete` are not reads. A
 * WEAK word, which is also a noun in tool names, counts only when the text does
 * not start by reading. Kinds rank money, deleting, sending, changing.
 */
function classifyText(text: string): ConnectorActionKind | 'read' | null {
  const words = toolNameWords(text);
  const cjk = cjkText(text);
  // The verb comes first in both languages: `get_sent_messages`, 「查询发送记录」.
  const startsByReading = (words.length > 0 && READ_VERBS.has(words[0]))
    || CJK_READ_PREFIXES.some((verb) => cjk.startsWith(verb));
  /** A weak word counts unless a read verb leads and no connective brings the action in. */
  const weakWord = (set: Set<string>) => words.some((word, index) => set.has(word)
    && (!startsByReading || words.slice(1, index).some((earlier) => CONNECTIVES.has(earlier))));
  const strongWord = (set: Set<string>) => words.some((word) => set.has(word));
  const cjkVerb = (verbs: string[]) => verbs.some((verb) => {
    const at = cjk.indexOf(verb);
    return at >= 0 && (!startsByReading || /[并后再然]$/u.test(cjk.slice(0, at)));
  });
  const makesMoneyThing = words.some((word) => MONEY_NOUNS.has(word)) && words.some((word) => MONEY_MAKING_VERBS.has(word))
    && !startsByReading;
  // A draft waits in the user's own mailbox; `send_draft` is what sends it.
  const onlyDrafts = (words.some((word) => word === 'draft' || word === 'drafts') || cjk.includes('草稿'))
    && !words.includes('send') && !cjk.includes('发送');

  if (strongWord(MONEY_STRONG) || makesMoneyThing || cjkVerb(CJK_MONEY) || weakWord(MONEY_WEAK)) return 'money';
  if (strongWord(DESTRUCTIVE_STRONG) || cjkVerb(CJK_DESTRUCTIVE) || weakWord(DESTRUCTIVE_WEAK)) return 'destructive';
  if (strongWord(SEND_STRONG)) return 'send';
  if (onlyDrafts) return startsByReading ? 'read' : null;
  const sendsByCreate = words.some((word) => CREATE_VERBS.has(word)) && words.some((word) => SENT_NOUNS.has(word))
    && !startsByReading;
  if (weakWord(SEND_WEAK) || cjkVerb(CJK_SEND) || (!startsByReading && startsWithLoneSendVerb(cjk)) || sendsByCreate) {
    return 'send';
  }
  if (strongWord(CHANGE_STRONG) || weakWord(CHANGE_WEAK) || cjkVerb(CJK_CHANGE)) return 'change';
  return startsByReading ? 'read' : null;
}

/** The words of a description, third-person verbs in their base form. */
function descriptionWords(text: string): string[] {
  return toolNameWords(text.split(/\s+/).map(baseVerb).join(' '));
}

/**
 * Whether a description speaks of sending anywhere in it. Weak on its own:
 * descriptions name every verb their parameters and results touch ("a post",
 * "the shared drive"), so this counts only with the server's `openWorldHint`.
 */
function descriptionMentionsSending(description: string): boolean {
  return descriptionWords(description).some((word) => SEND_STRONG.has(word) || SEND_WEAK.has(word))
    || CJK_SEND.some((verb) => cjkText(description).includes(verb));
}

/**
 * The opening of a description: its first sentence, cut short. The action a
 * tool performs is stated first ("Sends a message…", 「删除指定的文件…」); later
 * clauses describe parameters and results, which mention every verb there is.
 */
function descriptionOpening(description: string): string {
  const first = description.trim().split(/[.。！？!?\n]/u)[0] ?? '';
  // English verbs in the third person ("Sends", "Deletes", "Replies") read as
  // the verb; six words reach the verb of "Use this tool to send…".
  const words = first.split(/\s+/).slice(0, 6).map(baseVerb);
  return `${words.join(' ')} ${Array.from(cjkText(first)).slice(0, 12).join('')}`;
}

/** `sends` → `send`, `pushes` → `push`, `replies` → `reply`; anything else as written. */
function baseVerb(word: string): string {
  if (/[a-z]{2,}ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:sh|ch|ss|x)es$/i.test(word)) return word.slice(0, -2);
  if (/[a-z]{2,}[^s]s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Classify one call. Returns null for a tool that is not a connector tool (a
 * built-in, a browser tool, an unparseable name) and for one that only reads.
 */
export function classifyConnectorAction(
  namespacedName: string,
  hints?: ConnectorToolHints,
): ConnectorActionKind | null {
  const parsed = parseNamespacedToolName(namespacedName);
  if (!parsed || BROWSER_SERVER_NAMES_FOR_POLICY.has(parsed.serverName)) return null;
  const description = typeof hints?.description === 'string' ? hints.description.trim() : '';
  let verdict = classifyText(parsed.toolName);
  // The name says nothing: the description's opening speaks for the tool.
  if (verdict === null && description !== '') verdict = classifyText(descriptionOpening(description));
  // A tool that reaches the outside world and whose description speaks of
  // sending is taken as a send; the hint never asks on its own.
  if ((verdict === null || verdict === 'change') && hints?.openWorldHint === true && descriptionMentionsSending(description)) {
    verdict = 'send';
  }
  // Money and deletions already ask every time.
  if (verdict === 'money' || verdict === 'destructive') return verdict;
  // Tighten-only: the server's own word that a tool destroys something is
  // taken, whatever the name says (a send or a change would otherwise be a
  // reusable grant); its word that a tool is harmless never is.
  if (hints?.destructiveHint === true) return 'destructive';
  if (verdict !== null && verdict !== 'read') return verdict;
  // Nothing said what the tool does, and the connector has tools that write:
  // an unknown verb is not assumed to read.
  if (verdict === null && hints?.serverWrites === true) return 'change';
  return null;
}

/**
 * Whether a connector writes: any of its tools is classified as an action.
 * `classifyConnectorAction` asks about an unclassifiable tool of such a
 * connector, and lets one of a connector that only reads run.
 */
export function connectorServerWrites(tools: Array<{ name: string; description?: string; destructiveHint?: boolean }>): boolean {
  return tools.some((tool) => classifyConnectorAction(tool.name, {
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.destructiveHint === true ? { destructiveHint: true } : {}),
  }) !== null);
}
