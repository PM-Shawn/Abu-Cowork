import { describe, expect, it } from 'vitest';
import { createClaimLifecycle } from './claimLifecycle';
import { classifyInbound, createTabClaimStore, makeOwner } from './tabClaims';

describe('extension claim lifetime', () => {
  it('recognizes deletion separately from run release and rejects an empty deletion owner', () => {
    expect(classifyInbound({ type: 'conversation-deleted', ownerId: 'conversation' }))
      .toEqual({ kind: 'conversation-deleted', ownerId: 'conversation' });
    for (const ownerId of ['', ' ', null, 1]) {
      expect(classifyInbound({ type: 'conversation-deleted', ownerId }).kind).toBe('unknown');
    }
  });
  it('seals a deleted conversation and releases a claim acquired by an already admitted request', () => {
    const claims = createTabClaimStore();
    const lifecycle = createClaimLifecycle(claims);
    const owner = makeOwner('deleted', 'child');
    const finish = lifecycle.beginRequest(owner);
    lifecycle.deleteConversation('deleted');
    expect(() => lifecycle.beginRequest(owner)).toThrow('deleted');
    claims.claim(1, owner, 0);
    expect(claims.holderOf(1)).toEqual(owner);
    finish();
    expect(claims.holderOf(1)).toBeNull();
  });

  it('keeps claims until content completion even after the request waiter has ended', () => {
    const claims = createTabClaimStore();
    const lifecycle = createClaimLifecycle(claims);
    const owner = makeOwner('deleted');
    claims.claim(1, owner, 0);
    const finish = lifecycle.beginRequest(owner);
    const contentFinished = lifecycle.beginTabOperation(1);
    lifecycle.deleteConversation('deleted');
    finish();
    lifecycle.releaseOwner('deleted', 'main');
    expect(claims.holderOf(1)).toEqual(owner);
    contentFinished();
    expect(claims.holderOf(1)).toBeNull();
  });

  it('waits for sibling requests but releases only the settled run', () => {
    const claims = createTabClaimStore();
    const lifecycle = createClaimLifecycle(claims);
    const main = makeOwner('conversation');
    const child = makeOwner('conversation', 'child');
    claims.claim(1, main, 0);
    claims.claim(2, child, 0);
    const finish = lifecycle.beginRequest(child);
    lifecycle.releaseOwner('conversation', 'main');
    expect(claims.holderOf(1)).toEqual(main);
    finish();
    expect(claims.holderOf(1)).toBeNull();
    expect(claims.holderOf(2)).toEqual(child);
  });

  it('disconnect waits for requests that have not acquired their tab yet', () => {
    const claims = createTabClaimStore();
    const lifecycle = createClaimLifecycle(claims);
    const owner = makeOwner('old');
    const other = makeOwner('new');
    const finish = lifecycle.beginRequest(owner);
    lifecycle.releaseAll();
    claims.claim(1, owner, 0);
    expect(() => lifecycle.beginRequest(other)).toThrow('Previous browser connection');
    finish();
    expect(claims.holderOf(1)).toBeNull();
    lifecycle.beginRequest(other)();
    claims.claim(2, other, 0);
    expect(claims.holderOf(2)).toEqual(other);
    expect(() => lifecycle.beginRequest(owner)()).not.toThrow();
  });

  it('disconnect clears sibling current-tab pointers after real content work completes', () => {
    const claims = createTabClaimStore();
    const lifecycle = createClaimLifecycle(claims);
    const main = makeOwner('conversation');
    const child = makeOwner('conversation', 'child');
    claims.claim(1, main, 0);
    claims.touch(1, child);
    const finish = lifecycle.beginTabOperation(1);
    lifecycle.releaseAll();
    expect(claims.currentTabOf(child)).toBe(1);
    finish();
    expect(claims.currentTabOf(child)).toBeNull();
    expect(claims.holderOf(1)).toBeNull();
  });

  it('a new turn cancels the old main-run release while old page work finishes', () => {
    const claims = createTabClaimStore();
    const lifecycle = createClaimLifecycle(claims);
    const owner = makeOwner('conversation');
    claims.claim(1, owner, 0);
    const oldFinished = lifecycle.beginTabOperation(1);
    lifecycle.releaseOwner('conversation', 'main');
    const newFinished = lifecycle.beginRequest(owner);
    oldFinished();
    newFinished();
    expect(claims.holderOf(1)).toEqual(owner);
    lifecycle.releaseOwner('conversation', 'main');
    expect(claims.holderOf(1)).toBeNull();
  });

  it('waits for every run on deletion and leaves other conversations intact', () => {
    const claims = createTabClaimStore();
    const lifecycle = createClaimLifecycle(claims);
    const main = makeOwner('deleted');
    const child = makeOwner('deleted', 'child');
    const other = makeOwner('other');
    claims.claim(1, main, 0);
    claims.claim(2, child, 0);
    claims.claim(3, other, 0);
    const finishMain = lifecycle.beginRequest(main);
    const finishChild = lifecycle.beginRequest(child);
    lifecycle.deleteConversation('deleted');
    finishMain();
    expect(claims.entries()).toHaveLength(3);
    finishChild();
    expect(claims.entries().map(entry => entry.tabId)).toEqual([3]);
  });

  it('completion is idempotent and an idle release is immediate', () => {
    const claims = createTabClaimStore();
    const lifecycle = createClaimLifecycle(claims);
    const owner = makeOwner('conversation');
    claims.claim(1, owner, 0);
    const finish = lifecycle.beginRequest(owner);
    finish();
    finish();
    const complete = lifecycle.beginTabOperation(1);
    complete();
    complete();
    lifecycle.releaseOwner('conversation', 'main');
    expect(claims.entries()).toEqual([]);
  });
});
