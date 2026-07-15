import React, { useEffect, useState } from 'react';
import { applyAppTheme, getStoredTheme } from '../theme';

export type MiniPlayerState = {
  title: string;
  artist: string;
  playing: boolean;
  artworkUrl?: string | null;
};

const empty: MiniPlayerState = {
  title: 'miura',
  artist: '—',
  playing: false,
  artworkUrl: null,
};

/**
 * Control-only mini window — NO usePlayer / no second <audio>.
 * Commands go to the main window via Electron media-command IPC.
 */
export function MiniPlayerApp() {
  const [st, setSt] = useState<MiniPlayerState>(empty);

  useEffect(() => {
    applyAppTheme(getStoredTheme());
    document.documentElement.classList.add('mini-root-html');
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onPlayerState) return;
    void api.playerGetState?.().then((s) => {
      if (s) setSt({ ...empty, ...s });
    });
    return api.onPlayerState((s) => {
      if (s) setSt({ ...empty, ...s });
    });
  }, []);

  const cmd = (c: 'toggle' | 'next' | 'prev') => {
    void window.electronAPI?.mediaCommand?.(c);
  };

  return (
    <div className="mini-player-shell">
      {st.artworkUrl ? (
        <img className="mini-player-art" src={st.artworkUrl} alt="" draggable={false} />
      ) : (
        <div className="mini-player-art ph">♪</div>
      )}
      <div className="mini-player-meta">
        <strong className="mini-player-title" title={st.title}>
          {st.title || 'miura'}
        </strong>
        <span className="mini-player-artist" title={st.artist}>
          {st.artist || '—'}
        </span>
      </div>
      <div className="mini-player-acts">
        <button type="button" className="btn" onClick={() => cmd('prev')} title="Previous">
          ⏮
        </button>
        <button
          type="button"
          className="btn solid"
          onClick={() => cmd('toggle')}
          title={st.playing ? 'Pause' : 'Play'}
        >
          {st.playing ? '⏸' : '▶'}
        </button>
        <button type="button" className="btn" onClick={() => cmd('next')} title="Next">
          ⏭
        </button>
      </div>
    </div>
  );
}
