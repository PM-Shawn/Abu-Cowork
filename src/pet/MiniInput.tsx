/**
 * Mini input box (Phase C).
 *
 * Expands the pet window to 420×180, shows a text input + file chips +
 * send/expand-to-main/close buttons. Draft text is kept in localStorage
 * so Esc-close preserves it.
 *
 * Enter sends (calls emitMiniSend → main creates conversation + dispatches).
 * Shift+Enter inserts newline.
 * Esc or ✕ collapses back to 80×80 pet.
 * ↗ sends nothing but focuses main window.
 *
 * File chips: populated by TauriEvent.DRAG_DROP listener in PetApp — when
 * the user drops files while the mini input is open they land here
 * instead of immediately creating a conversation (matches PRD: "弱意图
 * → 统一承载文本/粘贴/打字").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, X } from 'lucide-react';
import { emitMiniSend, emitFocusMain } from './petBridge';

const DRAFT_KEY = 'abu-pet-mini-draft';

export interface MiniInputProps {
  files: string[];
  onRemoveFile: (path: string) => void;
  onClose: () => void;
  onAfterSend: () => void;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

export default function MiniInput({ files, onRemoveFile, onClose, onAfterSend }: MiniInputProps) {
  const [text, setText] = useState<string>(() => {
    try {
      return localStorage.getItem(DRAFT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Persist draft as user types.
  useEffect(() => {
    try {
      if (text) localStorage.setItem(DRAFT_KEY, text);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Non-critical.
    }
  }, [text]);

  // Autofocus on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = useCallback(async () => {
    await emitMiniSend(text, files);
    setText('');
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Non-critical.
    }
    onAfterSend();
  }, [text, files, onAfterSend]);

  const expandToMain = useCallback(async () => {
    await emitFocusMain();
    onClose();
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 80,
        width: 340,
        height: 180,
        background: 'rgba(28, 26, 24, 0.92)',
        borderRadius: 12,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        display: 'flex',
        flexDirection: 'column',
        padding: '10px 12px',
        gap: 8,
        color: '#f5f3ef',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: 13,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 48, overflowY: 'auto' }}>
          {files.map((p) => (
            <span
              key={p}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                background: 'rgba(255,255,255,0.12)',
                borderRadius: 6,
                fontSize: 11,
                maxWidth: 160,
              }}
              title={p}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {baseName(p)}
              </span>
              <button
                type="button"
                onClick={() => onRemoveFile(p)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'rgba(255,255,255,0.7)',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                }}
                aria-label="remove"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="跟阿布说..."
        style={{
          flex: 1,
          resize: 'none',
          background: 'transparent',
          color: 'inherit',
          border: 'none',
          outline: 'none',
          fontFamily: 'inherit',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      />

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onClose}
          title="关闭 (Esc)"
          style={miniBtnStyle}
        >
          <X size={14} />
        </button>
        <button
          type="button"
          onClick={() => void expandToMain()}
          title="在主窗口打开"
          style={miniBtnStyle}
        >
          <ArrowUpRight size={14} />
        </button>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!text.trim() && files.length === 0}
          title="发送 (Enter)"
          style={{
            ...miniBtnStyle,
            background: text.trim() || files.length ? 'rgba(255, 140, 80, 0.85)' : 'rgba(255,255,255,0.1)',
            opacity: text.trim() || files.length ? 1 : 0.4,
          }}
        >
          <ArrowUp size={14} />
        </button>
      </div>
    </div>
  );
}

const miniBtnStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(255,255,255,0.1)',
  border: 'none',
  borderRadius: 6,
  color: '#f5f3ef',
  cursor: 'pointer',
};
