import { describe, it, expect, beforeEach } from 'vitest';
import { useInboxStore } from './inboxStore';

describe('inboxStore', () => {
  beforeEach(() => {
    useInboxStore.setState({ items: {} });
  });

  it('addItem creates an unread, pending item', () => {
    const id = useInboxStore.getState().addItem({
      type: 'agent_proposed_todo',
      summary: '整理 3 篇草稿',
      payload: { draft: { title: '整理 3 篇草稿' } },
    });
    const item = useInboxStore.getState().items[id];
    expect(item.unread).toBe(true);
    expect(item.status).toBe('pending');
    expect(item.type).toBe('agent_proposed_todo');
    expect(item.summary).toBe('整理 3 篇草稿');
  });

  it('accept marks the item as accepted with processedAt and clears unread', () => {
    const id = useInboxStore.getState().addItem({
      type: 'agent_proposed_todo', summary: 's',
    });
    useInboxStore.getState().accept(id);
    const item = useInboxStore.getState().items[id];
    expect(item.status).toBe('accepted');
    expect(item.processedAt).toBeGreaterThan(0);
    expect(item.unread).toBe(false);
  });

  it('ignore marks the item as ignored with processedAt and clears unread', () => {
    const id = useInboxStore.getState().addItem({
      type: 'agent_proposed_todo', summary: 's',
    });
    useInboxStore.getState().ignore(id);
    const item = useInboxStore.getState().items[id];
    expect(item.status).toBe('ignored');
    expect(item.processedAt).toBeGreaterThan(0);
    expect(item.unread).toBe(false);
  });

  it('getPendingCount counts only items with status pending', () => {
    const a = useInboxStore.getState().addItem({ type: 'agent_proposed_todo', summary: 'a' });
    const b = useInboxStore.getState().addItem({ type: 'agent_proposed_todo', summary: 'b' });
    useInboxStore.getState().addItem({ type: 'agent_proposed_todo', summary: 'c' });
    useInboxStore.getState().accept(a);
    useInboxStore.getState().ignore(b);
    expect(useInboxStore.getState().getPendingCount()).toBe(1);
  });

  it('markRead flips unread to false', () => {
    const id = useInboxStore.getState().addItem({
      type: 'agent_proposed_todo', summary: 's',
    });
    useInboxStore.getState().markRead(id);
    expect(useInboxStore.getState().items[id].unread).toBe(false);
  });

  it('dismiss removes the item', () => {
    const id = useInboxStore.getState().addItem({
      type: 'agent_proposed_todo', summary: 's',
    });
    useInboxStore.getState().dismiss(id);
    expect(useInboxStore.getState().items[id]).toBeUndefined();
  });

  it('getUnreadCount returns count of unread items', () => {
    useInboxStore.getState().addItem({ type: 'agent_proposed_todo', summary: 'a' });
    const b = useInboxStore.getState().addItem({ type: 'agent_proposed_todo', summary: 'b' });
    useInboxStore.getState().markRead(b);
    expect(useInboxStore.getState().getUnreadCount()).toBe(1);
  });

  it('getAll returns items sorted by createdAt desc', () => {
    const a = useInboxStore.getState().addItem({ type: 'agent_proposed_todo', summary: 'a' });
    const b = useInboxStore.getState().addItem({ type: 'agent_proposed_todo', summary: 'b' });
    const all = useInboxStore.getState().getAll();
    expect(all[0].id).toBe(b);
    expect(all[1].id).toBe(a);
  });
});
