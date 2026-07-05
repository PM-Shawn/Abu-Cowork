/// <reference types="@testing-library/jest-dom" />

import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ShareExportDialog from './ShareExportDialog';
import { useChatStore } from '../../stores/chatStore';

afterEach(() => cleanup());

describe('ShareExportDialog progress + cancel (#7)', () => {
  it('renders live progress N/total while the bundle builds', async () => {
    useChatStore.setState({
      // Report progress synchronously, then never resolve → stays in loading.
      exportConversationForShare: (async (
        _id: string,
        opts?: { onProgress?: (done: number, total: number) => void },
      ) => {
        opts?.onProgress?.(3, 10);
        return new Promise(() => {});
      }) as never,
    });

    render(<ShareExportDialog convId="c1" defaultFilename="x.json" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/3\/10/)).toBeInTheDocument());
  });

  it('aborts the build when the dialog unmounts (cancel)', async () => {
    let receivedSignal: AbortSignal | undefined;
    useChatStore.setState({
      exportConversationForShare: (async (
        _id: string,
        opts?: { signal?: AbortSignal },
      ) => {
        receivedSignal = opts?.signal;
        return new Promise(() => {});
      }) as never,
    });

    const { unmount } = render(
      <ShareExportDialog convId="c1" defaultFilename="x.json" onClose={() => {}} />,
    );
    await waitFor(() => expect(receivedSignal).toBeDefined());
    expect(receivedSignal!.aborted).toBe(false);
    unmount();
    expect(receivedSignal!.aborted).toBe(true); // cleanup aborted the build
  });
});
