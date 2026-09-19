// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileDragDrop } from './useFileDragDrop';
import type { DragEvent as ReactDragEvent } from 'react';

type TestRuntime = typeof globalThis & {
  __ABU_SHELL__?: {
    mainSupervisesSidecar?: boolean;
    getPathForFile?: (file: File) => string;
    authorizeUserAttachment?: (file: File, request: { mediaType: 'application/pdf'; maxBytes?: number }) => Promise<{
      token: string;
      name: string;
      mediaType: 'application/pdf';
      expiresAt: number;
    }>;
    readUserAttachment?: (request: { token: string }) => Promise<Uint8Array>;
  };
};

function dragEvent(files: File[] = [], types: string[] = ['Files']) {
  const currentTarget = document.createElement('div');
  return {
    currentTarget,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { files, types, dropEffect: 'none' },
  } as unknown as ReactDragEvent<HTMLElement>;
}

describe('useFileDragDrop', () => {
  const runtime = globalThis as TestRuntime;

  beforeEach(() => {
    runtime.__ABU_SHELL__ = {
      mainSupervisesSidecar: true,
      getPathForFile: (file) => `/native/${file.name}`,
    };
  });

  afterEach(() => {
    delete runtime.__ABU_SHELL__;
  });

  it('uses Electron DOM drag events and resolves native file paths', () => {
    const onDrop = vi.fn();
    const { result } = renderHook(() => useFileDragDrop(onDrop));
    const first = new File(['one'], 'one.txt');
    const second = new File(['two'], 'two.md');

    const enter = dragEvent([first, second]);
    act(() => result.current.dropTargetProps.onDragEnter?.(enter));
    expect(result.current.isDragging).toBe(true);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(enter.stopPropagation).toHaveBeenCalled();

    const over = dragEvent([first, second]);
    act(() => result.current.dropTargetProps.onDragOver?.(over));
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe('copy');

    const drop = dragEvent([first, second]);
    act(() => result.current.dropTargetProps.onDrop?.(drop));

    expect(drop.preventDefault).toHaveBeenCalled();
    expect(drop.stopPropagation).toHaveBeenCalled();
    expect(result.current.isDragging).toBe(false);
    expect(onDrop).toHaveBeenCalledWith(['/native/one.txt', '/native/two.md']);
  });

  it('ignores non-file drags and files without a native path', () => {
    const onDrop = vi.fn();
    runtime.__ABU_SHELL__!.getPathForFile = () => '';
    const { result } = renderHook(() => useFileDragDrop(onDrop));

    act(() => result.current.dropTargetProps.onDragEnter?.(dragEvent([], ['text/plain'])));
    expect(result.current.isDragging).toBe(false);

    act(() => result.current.dropTargetProps.onDrop?.(dragEvent([new File(['x'], 'virtual.txt')])));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('keeps the drag state while nested drag-enter events remain active', () => {
    const onDrop = vi.fn();
    const { result } = renderHook(() => useFileDragDrop(onDrop));
    const enter = dragEvent([new File(['x'], 'one.txt')]);

    act(() => result.current.dropTargetProps.onDragEnter?.(enter));
    act(() => result.current.dropTargetProps.onDragEnter?.(enter));
    act(() => result.current.dropTargetProps.onDragLeave?.(dragEvent()));

    expect(result.current.isDragging).toBe(true);

    act(() => result.current.dropTargetProps.onDragLeave?.(dragEvent()));
    expect(result.current.isDragging).toBe(false);
  });



  it.each(['brief.pdf', 'brief.PDF'])('delivers native PDF %s as a file reference', async (name) => {
    const onDrop = vi.fn();
    const finishAdmission = vi.fn();
    const onAdmissionError = vi.fn();
    const { result } = renderHook(() => useFileDragDrop(onDrop, {
      onAdmissionStart: () => finishAdmission, onAdmissionError,
    }));
    await act(async () => {
      result.current.dropTargetProps.onDrop?.(dragEvent([new File(['pdf'], name, { type: 'application/pdf' })]));
    });
    expect(onDrop).toHaveBeenCalledWith([`/native/${name}`]);
    expect(onAdmissionError).not.toHaveBeenCalled();
    expect(finishAdmission).toHaveBeenCalledTimes(1);
  });

  it('rejects a PDF with no native path and closes admission', async () => {
    runtime.__ABU_SHELL__!.getPathForFile = () => '';
    const onDrop = vi.fn();
    const onAdmissionError = vi.fn();
    const finishAdmission = vi.fn();
    const { result } = renderHook(() => useFileDragDrop(onDrop, {
      onAdmissionStart: () => finishAdmission, onAdmissionError,
    }));
    await act(async () => {
      result.current.dropTargetProps.onDrop?.(dragEvent([new File(['pdf'], 'missing.pdf')]));
    });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onAdmissionError).toHaveBeenCalledTimes(1);
    expect(finishAdmission).toHaveBeenCalledTimes(1);
  });
});
