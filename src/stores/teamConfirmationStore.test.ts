// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { confirmationKey, pendingFor, useTeamConfirmationStore, type TeamConfirmationInput } from './teamConfirmationStore';

const item: TeamConfirmationInput = { conversationId: 'c1', member: 'A', kind: 'command', detail: 'execute command', identity: { toolName: 'run_command', parametersDigest: 'cwd-a', cwd: '/a', loopId: 'l1', callId: 't1', dispatchId: 'd1', dispatchFingerprint: 'task-a', requestOrdinal: 1 } };
const retry = (overrides: Partial<TeamConfirmationInput> = {}): TeamConfirmationInput => ({ ...item, identity: { ...item.identity!, loopId: 'retry', callId: 'new-call', dispatchId: 'new-dispatch' }, ...overrides });
const store = () => useTeamConfirmationStore.getState();
function select() {
  const pending = store().add(item)!;
  const id = store().selectRetry(pending.id)!;
  store().beginRetry('c1', 'retry', id);
  return id;
}
const resetStore = () => useTeamConfirmationStore.setState({
  pending: {}, approvedOnce: {}, taskRules: {}, retrySelections: {}, currentTaskByConversation: {},
});

describe('teamConfirmationStore', () => {
  beforeEach(resetStore);

  it('does not authorize another member, cwd, conversation or script with the same display text (F1)', () => {
    expect(confirmationKey(item)).not.toBe(confirmationKey({ ...item, member: 'B' }));
    expect(confirmationKey(item)).not.toBe(confirmationKey({ ...item, conversationId: 'c2' }));
    expect(confirmationKey(item)).not.toBe(confirmationKey({ ...item, identity: { ...item.identity!, parametersDigest: 'cwd-b', cwd: '/b' } }));
    const browser = { ...item, kind: 'browser' as const };
    expect(confirmationKey(browser)).not.toBe(confirmationKey({ ...browser, identity: { ...item.identity!, parametersDigest: 'different-script' } }));
    expect(confirmationKey(item)).toBe(confirmationKey({ ...item, detail: 'translated label' } as TeamConfirmationInput));
  });

  it('confirmationKey ignores browser authorization payload fields', () => {
    const base = { conversationId: 'c1', member: 'A', kind: 'browser' as const,
      identity: { toolName: 'browser_fill', parametersDigest: 'd1', cwd: '/w', loopId: 'l', callId: 'c', dispatchId: 'x', dispatchFingerprint: 'f', requestOrdinal: 1 } };
    const withPayload = { ...base, browserOrigin: 'http://127.0.0.1:8765', browserOperationClass: 'interactive' as const, allowPersistentGrant: true, level: 'warn' as const };
    expect(confirmationKey(withPayload)).toBe(confirmationKey(base));
    // The payload must survive the store so the strip can offer a site grant.
    const stored = store().add({ ...withPayload, detail: 'fill #q' })!;
    expect(stored.browserOrigin).toBe('http://127.0.0.1:8765');
    expect(stored.browserOperationClass).toBe('interactive');
    expect(stored.allowPersistentGrant).toBe(true);
    expect(stored.level).toBe('warn');
  });

  it('deduplicates only the same originating call; parallel identical calls remain separate', () => {
    const first = store().add(item)!;
    expect(store().add(item)).toBeNull();
    expect(store().add({ ...item, identity: { ...item.identity!, callId: 'other' } })).not.toBeNull();
    expect(store().add({ ...item, member: 'B' })).not.toBeNull();
    store().remove(first.id);
    expect(pendingFor(store().pending, 'c1')).toHaveLength(2);
  });

  it('only the selected retry turn and original dispatch can consume once', () => {
    const pending = store().add(item)!;
    const id = store().selectRetry(pending.id, 'once')!;
    store().beginRetry('c2', 'retry', id);
    expect(store().consumeApproval(retry())).toBe(false);
    store().beginRetry('c1', 'retry', id);
    store().claimDispatch('c1', 'retry', 'sibling', 'another-task', 'A');
    store().claimDispatch('c1', 'retry', 'sibling', 'task-a', 'B');
    expect(store().consumeApproval(retry())).toBe(false);
    store().claimDispatch('c1', 'retry', 'new-dispatch', 'task-a', 'A');
    store().claimDispatch('c1', 'retry', 'later-sibling', 'task-a', 'A');
    for (const wrong of [retry({ member: 'B' }), retry({ conversationId: 'c2' }), retry({ identity: { ...retry().identity!, cwd: '/b' } }), retry({ identity: { ...retry().identity!, loopId: 'another-run' } }), retry({ identity: { ...retry().identity!, dispatchId: 'later-sibling' } })]) {
      expect(store().consumeApproval(wrong)).toBe(false);
    }
    expect(store().consumeApproval(retry())).toBe(true);
    expect(store().consumeApproval(retry())).toBe(false);
  });

  it('persists refused requests, never selections, grants, tasks or rules, and discards them on hydrate', async () => {
    select();
    store().beginTask('c1', false);
    store().add({ ...item, member: 'B' });
    const persisted = JSON.parse(localStorage.getItem('abu-team-confirmations')!).state;
    expect(Object.keys(persisted)).toEqual(['pending']);
    expect(Object.values(persisted.pending)).toHaveLength(1);
    localStorage.setItem('abu-team-confirmations', JSON.stringify({ state: { ...persisted,
      approvedOnce: { c1: ['command:x'] }, taskRules: { x: {} }, currentTaskByConversation: { c1: 't' } }, version: 0 }));
    await useTeamConfirmationStore.persist.rehydrate();
    expect(store().approvedOnce).toEqual({});
    expect(store().taskRules).toEqual({});
    expect(store().currentTaskByConversation).toEqual({});
    expect(store().retrySelections).toEqual({});
  });

  it('legacy pending records confer no authority; deleting a conversation removes all its state', () => {
    const legacy = store().add({ ...item, identity: undefined })!;
    expect(store().selectRetry(legacy.id)).toBeUndefined();
    expect(store().approveForTask(legacy.id)).toBe(false);
    const partial = store().add({ ...item, identity: { ...item.identity!, callId: 'legacy-call', requestOrdinal: undefined as unknown as number } })!;
    expect(store().selectRetry(partial.id)).toBeUndefined();
    select();
    store().add({ ...item, conversationId: 'c2' });
    store().clearConversation('c1');
    expect(pendingFor(store().pending, 'c1')).toEqual([]);
    expect(pendingFor(store().pending, 'c2')).toHaveLength(1);
    expect(store().approvedOnce).toEqual({});
  });
  it('does not spend approval for the second identical call on the first call of its retry', () => {
    const second = { ...item, identity: { ...item.identity!, callId: 'original-second', requestOrdinal: 2 } };
    const id = store().selectRetry(store().add(second)!.id);
    store().beginRetry('c1', 'retry', id);
    store().claimDispatch('c1', 'retry', 'new-dispatch', 'task-a', 'A');
    expect(store().consumeApproval(retry({ identity: { ...retry().identity!, requestOrdinal: 1 } }))).toBe(false);
    expect(store().consumeApproval(retry({ identity: { ...retry().identity!, callId: 'retry-second', requestOrdinal: 2 } }))).toBe(true);
  });

});

import {buildTeamConfirmationIdentity as auditIdentity} from '@/core/agent/teamConfirmationIdentity';
describe('audit-review team browser approval scope',()=>{
 beforeEach(resetStore);
 const input={tabId:1,frameId:'f2',locator:'#q',value:'x'};
 const target={origin:'https://frame.example',pageOrigin:'https://host-a.example',embeddedOrigins:['https://frame.example']};
 const browserItem=async(kind:'browser'|'browser-upload',allowPersistentGrant:boolean)=>({...item,kind,level:'warn' as const,
  identity:await auditIdentity('abu-browser__fill',input,{conversationId:'c1',loopId:'old',toolCallId:'initial'},target),
  browserOrigin:target.origin,browserOperationClass:kind==='browser'?'interactive':'upload',
  browserPermissionResource:kind==='browser'?'browse':'upload',allowPersistentGrant,
  browserPermissionTargets:[{origin:target.origin,embeddedIn:target.pageOrigin}]} as TeamConfirmationInput);

 it.each(['browser','browser-upload'] as const)('audit-team: %s allow-once cannot be reused by a new call',async(kind)=>{
  const browser=await browserItem(kind,true);
  const selected=store().selectRetry(store().add(browser)!.id);
  store().beginRetry('c1','retry',selected);
  const first=await auditIdentity('abu-browser__fill',input,{conversationId:'c1',loopId:'retry',toolCallId:'first'},target);
  expect(store().consumeApproval({...browser,identity:first})).toBe(true);
  const second=await auditIdentity('abu-browser__fill',input,{conversationId:'c1',loopId:'retry',toolCallId:'second'},target);
  expect(store().consumeApproval({...browser,identity:second})).toBe(false);
 });

 it.each(['browser','browser-upload'] as const)('audit-team: %s task rule stays inside the embedding page',async(kind)=>{
  store().beginTask('c1',false);
  const browser=await browserItem(kind,true);
  expect(store().approveForTask(store().add(browser)!.id)).toBe(true);
  const sameHost=await auditIdentity('abu-browser__fill',{...input,value:'y'},{conversationId:'c1',loopId:'retry',toolCallId:'a'},target);
  expect(store().consumeApproval({...browser,identity:sameHost})).toBe(true);
  const otherHost=await auditIdentity('abu-browser__fill',input,{conversationId:'c1',loopId:'retry',toolCallId:'b'},{...target,pageOrigin:'https://host-b.example'});
  expect(store().consumeApproval({...browser,identity:otherHost})).toBe(false);
 });

 it('audit-team: a browser request the gate would not offer a standing grant for gets no task rule',async()=>{
  store().beginTask('c1',false);
  const pending=store().add(await browserItem('browser',false))!;
  expect(store().approveForTask(pending.id)).toBe(false);
 });
});

it.each(['browser','browser-upload'] as const)('audit-legacy: %s ignores old run rules and clamps old selections to once',(kind)=>{
 resetStore();
 const oldItem={...item,id:'legacy',createdAt:1,kind,identity:{...item.identity!,dispatchId:'leader'}};
 const newItem={...oldItem,identity:{...oldItem.identity,loopId:'retry',callId:'retry-first'}};
 useTeamConfirmationStore.setState({runRules:{legacy:{item:oldItem,mode:'run',loopId:'retry',dispatchId:'leader'}}} as never);
 expect(store().consumeApproval(newItem)).toBe(false);
 useTeamConfirmationStore.setState({retrySelections:{selection:{item:oldItem,mode:'run'}}} as never);
 store().beginRetry('c1','retry','selection');
 expect(store().consumeApproval(newItem)).toBe(true);
 expect(store().consumeApproval(newItem)).toBe(false);
});

describe('task scope', () => {
  beforeEach(resetStore);
  const scoped = (callId: string, digest: string, overrides: Partial<TeamConfirmationInput> = {}): TeamConfirmationInput => ({
    conversationId: 'c1', member: 'A', kind: 'command', level: 'warn', detail: 'npm run build',
    identity: { toolName: 'run_command', parametersDigest: digest, cwd: '/w', loopId: 'l1', callId,
      dispatchId: 'd1', dispatchFingerprint: 'f1', requestOrdinal: 1, scope: 'prefix:npm run' },
    ...overrides,
  });
  const withScope = (base: TeamConfirmationInput, scope: string): TeamConfirmationInput =>
    ({ ...base, identity: { ...base.identity!, scope } });

  it('starts a task for a fresh request and keeps it for a continuation', () => {
    const first = store().beginTask('c1', false);
    expect(store().beginTask('c1', true)).toEqual({ taskId: first.taskId });
    const next = store().beginTask('c1', false);
    expect(next.taskId).not.toBe(first.taskId);
    expect(next.retiredTaskId).toBe(first.taskId);
  });

  it('a continuation without a current task starts one', () => {
    const { taskId, retiredTaskId } = store().beginTask('c1', true);
    expect(taskId).toBeTruthy();
    expect(retiredTaskId).toBeUndefined();
  });

  it('a task rule admits the same kind of request with other parameters, in any run of the task', () => {
    store().beginTask('c1', false);
    expect(store().approveForTask(store().add(scoped('call-1', 'digest-1'))!.id)).toBe(true);
    const later = scoped('call-9', 'digest-9', { detail: 'npm run test' });
    expect(store().consumeApproval({ ...later, identity: { ...later.identity!, loopId: 'another-run' } })).toBe(true);
    expect(store().consumeApproval(later)).toBe(true);
  });

  it('a task rule does not reach another member, conversation, category or a chained command', () => {
    store().beginTask('c1', false);
    store().approveForTask(store().add(scoped('call-1', 'digest-1'))!.id);
    expect(store().consumeApproval(scoped('c2', 'd2', { member: 'B' }))).toBe(false);
    expect(store().consumeApproval(scoped('c3', 'd3', { conversationId: 'c2' }))).toBe(false);
    expect(store().consumeApproval(withScope(scoped('c4', 'd4'), 'prefix:git push'))).toBe(false);
    expect(store().consumeApproval(withScope(scoped('c5', 'd5'), 'exact:npm run build && rm -rf ~'))).toBe(false);
  });

  it('a task rule does not admit a request that must be asked every time', () => {
    store().beginTask('c1', false);
    store().approveForTask(store().add(scoped('call-1', 'digest-1'))!.id);
    expect(store().consumeApproval(scoped('c2', 'd2', { level: 'danger' }))).toBe(false);
  });

  it('a new task retires the previous task rules', () => {
    store().beginTask('c1', false);
    store().approveForTask(store().add(scoped('call-1', 'digest-1'))!.id);
    store().beginTask('c1', false);
    expect(store().consumeApproval(scoped('call-2', 'digest-2'))).toBe(false);
    expect(Object.keys(store().taskRules)).toHaveLength(0);
  });

  it('refuses a task rule for a request that must be asked every time, and keeps it pending', () => {
    store().beginTask('c1', false);
    const pending = store().add(scoped('call-1', 'digest-1', { level: 'danger' }))!;
    expect(store().approveForTask(pending.id)).toBe(false);
    expect(store().pending[pending.id]).toBeDefined();
  });

  it('approving for the task clears other pending requests it now covers', () => {
    store().beginTask('c1', false);
    const a = store().add(scoped('call-1', 'digest-1'))!;
    const b = store().add(scoped('call-2', 'digest-2', { detail: 'npm run lint' }))!;
    const other = store().add(scoped('call-3', 'digest-3', { member: 'B' }))!;
    store().approveForTask(a.id);
    expect(store().pending[b.id]).toBeUndefined();
    expect(store().pending[other.id]).toBeDefined();
  });

  it('allow all turns every categorised request into a task rule and leaves the rest', () => {
    store().beginTask('c1', false);
    store().add(scoped('call-1', 'digest-1'));
    store().add(scoped('call-2', 'digest-2', { member: 'B' }));
    const danger = store().add(scoped('call-3', 'digest-3', { member: 'C', level: 'danger' }))!;
    expect(store().approveAllForTask('c1')).toBe(2);
    expect(Object.keys(store().pending)).toEqual([danger.id]);
  });

  it('a run ending leaves task rules in place', () => {
    const { taskId } = store().beginTask('c1', false);
    store().approveForTask(store().add(scoped('call-1', 'digest-1'))!.id);
    store().clearRun('c1', 'l1');
    expect(Object.values(store().taskRules).map((rule) => rule.taskId)).toEqual([taskId]);
  });

  it('revoking a task rule makes the same kind of request ask again', () => {
    store().beginTask('c1', false);
    store().approveForTask(store().add(scoped('call-1', 'digest-1'))!.id);
    const [ruleId] = Object.keys(store().taskRules);
    store().revoke(ruleId);
    expect(store().consumeApproval(scoped('call-2', 'digest-2'))).toBe(false);
  });

  it('deleting the conversation forgets its task and rules', () => {
    store().beginTask('c1', false);
    store().approveForTask(store().add(scoped('call-1', 'digest-1'))!.id);
    store().clearConversation('c1');
    expect(store().currentTaskByConversation).toEqual({});
    expect(store().taskRules).toEqual({});
  });
});
