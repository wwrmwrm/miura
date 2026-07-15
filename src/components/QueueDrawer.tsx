import React from 'react';
import { createPortal } from 'react-dom';
import { artworkUrl } from '../api/soundcloud';
import type { Track } from '../types';
import { SourceBadge } from './SourceBadge';
import { useT } from '../i18n';

type Props = {
  open: boolean;
  onClose: () => void;
  queue: Track[];
  currentId?: number | null;
  onPlay: (index: number) => void;
  onRemove: (id: number) => void;
  onClear: () => void;
};

export function QueueDrawer({ open, onClose, queue, currentId, onPlay, onRemove, onClear }: Props) {
  const t = useT();
  if (!open) return null;

  const node = (
    <div className="queue-drawer-root">
      <button type="button" className="queue-drawer-backdrop" aria-label="close" onClick={onClose} />
      <aside className="queue-drawer" role="dialog" aria-label={t.nav.queue}>
        <header className="queue-drawer-head">
          <h2>
            {t.nav.queue}
            <span className="queue-drawer-count">{queue.length}</span>
          </h2>
          <div className="queue-drawer-actions">
            {queue.length > 0 && (
              <button type="button" className="btn" onClick={onClear}>
                {t.common.remove}
              </button>
            )}
            <button type="button" className="btn solid" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>
        {queue.length === 0 ? (
          <p className="note" style={{ padding: '16px 4px' }}>
            {t.common.empty}
          </p>
        ) : (
          <ul className="queue-drawer-list">
            {queue.map((tr, i) => {
              const live = tr.id === currentId;
              return (
                <li key={`${tr.id}-${i}`} className={live ? 'live' : ''}>
                  <button type="button" className="queue-drawer-row" onClick={() => onPlay(i)}>
                    <span className="queue-drawer-idx">{i + 1}</span>
                    {tr.artwork_url ? (
                      <img src={artworkUrl(tr.artwork_url, 't67x67')} alt="" />
                    ) : (
                      <span className="queue-drawer-ph">♪</span>
                    )}
                    <span className="queue-drawer-meta">
                      <span className="queue-drawer-title">
                        {tr.title} <SourceBadge track={tr} />
                      </span>
                      <span className="queue-drawer-artist">
                        {tr.user?.username || tr.user?.full_name || '—'}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="queue-drawer-x"
                    title={t.common.remove}
                    onClick={() => onRemove(tr.id)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </div>
  );

  // Portal to body — never a CSS-grid sibling of the player bar
  return createPortal(node, document.body);
}
