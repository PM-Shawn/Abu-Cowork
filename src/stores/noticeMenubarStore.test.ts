import { describe, it, expect, beforeEach } from 'vitest';
import { useNoticeMenubarStore } from './noticeMenubarStore';
import type { Notice } from '@/core/notice/types';
import { getI18n } from '@/i18n';

function makeNotice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: 'ntc_test',
    type: 'task_complete',
    tier: 'L1',
    source: 'agent',
    payload: {},
    dedupKey: 'k',
    createdAt: 1_000_000,
    ...overrides,
  };
}

describe('noticeMenubarStore', () => {
  beforeEach(() => {
    useNoticeMenubarStore.setState({ notices: [] });
  });

  it('starts with empty notices', () => {
    expect(useNoticeMenubarStore.getState().notices).toEqual([]);
  });

  it('addNotice inserts at front', () => {
    const { addNotice } = useNoticeMenubarStore.getState();
    addNotice(makeNotice({ id: 'ntc_1' }));
    addNotice(makeNotice({ id: 'ntc_2' }));
    const ids = useNoticeMenubarStore.getState().notices.map((n) => n.id);
    expect(ids).toEqual(['ntc_2', 'ntc_1']);
  });

  it('addNotice maps type to localized summary', () => {
    useNoticeMenubarStore.getState().addNotice(makeNotice({ type: 'task_complete' }));
    expect(useNoticeMenubarStore.getState().notices[0].summary).toBe(getI18n().noticeMenubar.taskComplete);
  });

  it('caps at 50 entries', () => {
    const { addNotice } = useNoticeMenubarStore.getState();
    for (let i = 0; i < 60; i++) {
      addNotice(makeNotice({ id: `ntc_${i}` }));
    }
    expect(useNoticeMenubarStore.getState().notices.length).toBe(50);
  });

  it('dismiss removes one notice', () => {
    const { addNotice, dismiss } = useNoticeMenubarStore.getState();
    addNotice(makeNotice({ id: 'ntc_1' }));
    addNotice(makeNotice({ id: 'ntc_2' }));
    dismiss('ntc_1');
    const ids = useNoticeMenubarStore.getState().notices.map((n) => n.id);
    expect(ids).toEqual(['ntc_2']);
  });

  it('dismissAll clears everything', () => {
    const { addNotice, dismissAll } = useNoticeMenubarStore.getState();
    addNotice(makeNotice({ id: 'ntc_1' }));
    addNotice(makeNotice({ id: 'ntc_2' }));
    dismissAll();
    expect(useNoticeMenubarStore.getState().notices).toEqual([]);
  });
});
