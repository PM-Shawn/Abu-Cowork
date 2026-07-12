import { describe, it, expect } from 'vitest';
import { reconcileEditorContent } from './editorReconcile';

describe('reconcileEditorContent', () => {
  describe('no-op cases', () => {
    it('keeps draft when disk content already matches the buffer', () => {
      const result = reconcileEditorContent({
        diskContent: 'same',
        draft: 'same',
        lastSaved: 'same',
        isSelfEcho: false,
      });
      expect(result).toEqual({ nextDraft: 'same', conflict: false });
    });

    it('keeps draft when disk matches buffer even if lastSaved is stale', () => {
      // e.g. lastSaved hasn't been updated yet but disk and draft happen to agree
      const result = reconcileEditorContent({
        diskContent: 'v2',
        draft: 'v2',
        lastSaved: 'v1',
        isSelfEcho: false,
      });
      expect(result).toEqual({ nextDraft: 'v2', conflict: false });
    });
  });

  describe('self-echo (our own autosave reflecting back through fs watch)', () => {
    it('keeps draft unchanged when disk content is our own just-written content', () => {
      const result = reconcileEditorContent({
        diskContent: 'v1-saved',
        draft: 'v1-saved',
        lastSaved: 'v1-saved',
        isSelfEcho: true,
      });
      expect(result).toEqual({ nextDraft: 'v1-saved', conflict: false });
    });

    it('keeps the newer draft when the user kept typing after the autosave fired', () => {
      // Autosave wrote 'v1-saved'; user has since typed further to 'v2-typing'
      // before the watch event for the v1 write was even processed.
      const result = reconcileEditorContent({
        diskContent: 'v1-saved',
        draft: 'v2-typing',
        lastSaved: 'v1-saved',
        isSelfEcho: true,
      });
      expect(result).toEqual({ nextDraft: 'v2-typing', conflict: false });
    });
  });

  describe('external change, no unsaved edits (adopt disk content)', () => {
    it('adopts disk content when draft has no unsaved edits', () => {
      const result = reconcileEditorContent({
        diskContent: 'external-edit',
        draft: 'original',
        lastSaved: 'original',
        isSelfEcho: false,
      });
      expect(result).toEqual({ nextDraft: 'external-edit', conflict: false });
    });
  });

  describe('external change with unsaved edits (conflict)', () => {
    it('keeps the user draft and flags a conflict instead of clobbering it', () => {
      const result = reconcileEditorContent({
        diskContent: 'external-edit',
        draft: 'user-typing',
        lastSaved: 'original',
        isSelfEcho: false,
      });
      expect(result).toEqual({ nextDraft: 'user-typing', conflict: true });
    });
  });

  describe('disk unchanged from baseline (mid-edit, nothing external happened)', () => {
    it('does not flag a conflict when disk still matches lastSaved but draft is dirty', () => {
      // A reload cycle fired (e.g. an unrelated watch event) but the file on
      // disk never actually changed from our last known baseline — the user
      // is simply mid-edit. This must not be treated as an external change.
      const result = reconcileEditorContent({
        diskContent: 'original',
        draft: 'user-typing',
        lastSaved: 'original',
        isSelfEcho: false,
      });
      expect(result).toEqual({ nextDraft: 'user-typing', conflict: false });
    });
  });

  describe('empty-string edge cases', () => {
    it('treats an emptied file as a valid external change when draft is clean', () => {
      const result = reconcileEditorContent({
        diskContent: '',
        draft: 'original',
        lastSaved: 'original',
        isSelfEcho: false,
      });
      expect(result).toEqual({ nextDraft: '', conflict: false });
    });

    it('flags conflict when the file is externally emptied while user has unsaved edits', () => {
      const result = reconcileEditorContent({
        diskContent: '',
        draft: 'user-typing',
        lastSaved: 'original',
        isSelfEcho: false,
      });
      expect(result).toEqual({ nextDraft: 'user-typing', conflict: true });
    });
  });
});
