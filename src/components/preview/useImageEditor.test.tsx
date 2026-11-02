// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, getLanguageSetting, initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useImageEditStore } from '@/stores/imageEditStore';
import { getComposerDraftKey, getComposerDraftScopeForEnterpriseMode, readComposerDraft, writeComposerDraft } from '@/stores/composerDraftStore';
import { useImageEditor } from './useImageEditor';
import { ImageEditReference } from '@/components/chat/ImageEditReference';

function Editor() {
  return useImageEditor('conversation', '/source.png').controls;
}

const service = { id: 'images', name: 'Images', vendor: 'volcengine' as const, model: 'doubao-seedream-5.0-pro', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations', apiKey: 'test-boundary-credential' };
const originalServices = useSettingsStore.getState().imageGeneration;
const originalLanguage = getLanguageSetting();

beforeEach(() => {
  initLanguage('en-US');
  useImageEditStore.setState({ entries: {}, active: {}, pending: {} });
  useSettingsStore.setState({ imageGeneration: { backends: [] } });
});

afterEach(() => {
  cleanup();
  useImageEditStore.setState({ entries: {}, active: {}, pending: {} });
  useSettingsStore.setState({ imageGeneration: originalServices });
  initLanguage(originalLanguage);
});

it('explains unavailable region editing before drawing while other draft tools stay available', () => {
  render(<Editor />, { wrapper: DesignSystemProvider });
  const t = getI18n().media;
  expect((screen.getByRole('button', { name: t.region }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(t.regionUnavailable)).toBeTruthy();
  expect((screen.getByRole('button', { name: t.comments }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: t.markup }) as HTMLButtonElement).disabled).toBe(false);
});

it('preserves the selection, prompt and undo history across Pro, Lite, Flash and OpenAI', async () => {
  const scope = getComposerDraftScopeForEnterpriseMode(useEnterpriseStore.getState().mode);
  const composerKey = getComposerDraftKey('conversation', scope);
  const key = `${composerKey}\0/source.png`;
  const entry = { key, composerKey, originalPath: '/source.png', history: { past: [], future: [] }, draft: {
    scope, conversationId: 'conversation', sourceArtifactId: 'source', sourceCaptureId: 'capture', sourceDigest: 'a'.repeat(64),
    source: { kind: 'source' as const, fileRef: { originalPath: '/source.png', captureId: 'capture', contentDigest: 'a'.repeat(64) }, mimeType: 'image/png' as const, width: 80, height: 60, byteLength: 100 },
    activeTool: 'region' as const, prompt: 'Keep the package', comments: [], markup: [], region: [],
  } };
  useImageEditStore.getState().activate(entry);
  useImageEditStore.getState().changeLayer(key, 'region', [{ id: 'area', erase: false, width: 0.1, points: [{ x: 0.5, y: 0.5 }] }]);
  useImageEditStore.getState().changeLayer(key, 'region', [...useImageEditStore.getState().entries[key].draft.region,
    { id: 'erased', erase: true, width: 0.3, points: [{ x: 0.5, y: 0.5 }] }]);
  const saved = useImageEditStore.getState().entries[key];
  useSettingsStore.setState({ imageGeneration: { defaultId: service.id, backends: [service] } });
  render(<><Editor /><ImageEditReference entry={saved} /></>, { wrapper: DesignSystemProvider });
  const t = getI18n().media;
  expect(screen.getByTestId('image-edit-reference').textContent).not.toContain(t.region);
  expect(screen.getByTestId('image-edit-reference').textContent).toContain(t.regionEdited);
  const button = screen.getByRole('button', { name: t.region }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('aria-pressed')).toBe('true');
  act(() => useSettingsStore.setState({ imageGeneration: { backends: [{ ...service, model: 'doubao-seedream-5.0-lite' }] } }));
  expect(button.disabled).toBe(true);
  expect(button.getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByText(t.regionDraftUnavailable)).toBeTruthy();
  expect(useImageEditStore.getState().entries[key]).toBe(saved);
  for (const backend of [{ ...service, model: 'doubao-seedream-5.0-flash' }, { ...service, vendor: 'openai' as const, model: 'gpt-image-2.5-sunburst', baseUrl: 'https://api.openai.com/v1' }, service]) {
    act(() => useSettingsStore.setState({ imageGeneration: { backends: [backend] } }));
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText(t.regionDraftUnavailable)).toBeNull();
    expect(useImageEditStore.getState().entries[key]).toBe(saved);
  }
  act(() => useSettingsStore.setState({ imageGeneration: { backends: [{ ...service, model: 'doubao-seedream-5.0-lite' }] } }));
  writeComposerDraft(composerKey, { ...readComposerDraft(composerKey), text: saved.draft.prompt });
  fireEvent.click(screen.getByRole('button', { name: t.ratio }));
  fireEvent.click(screen.getByRole('menuitem', { name: '16:9' }));
  await waitFor(() => expect(readComposerDraft(composerKey).text).toBe(`${saved.draft.prompt}\n${t.ratioPrompt.replace('{ratio}', '16:9')}`));
  expect(useImageEditStore.getState().entries[key].draft.region).toBe(saved.draft.region);
  expect(useImageEditStore.getState().entries[key].history).toBe(saved.history);
});
