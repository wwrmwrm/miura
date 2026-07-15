import React, { useState } from 'react';
import { useT } from '../i18n';
import { EmptyState } from '../components/EmptyState';
import type { Playable } from '../player/types';
import { searchYouTube, ytHitToPlayable, type YtSearchHit } from '../sources/youtube';

type Props = {
  onPlay: (item: Playable, list: Playable[]) => void;
  currentUid?: string | null;
};

export function YouTubePage({ onPlay, currentUid }: Props) {
  const t = useT();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<YtSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const runSearch = async () => {
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    setErr(null);
    setSearched(true);
    try {
      const res = await searchYouTube(query, 30);
      setHits(res);
    } catch (e) {
      setHits([]);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const playables = hits.map(ytHitToPlayable);

  return (
    <div className="chapter">
      <div className="sc-home-hero">
        <div className="sc-home-hero-text">
          <h1 className="sc-home-greeting">{t.youtube.title}</h1>
          <p className="sc-home-lead">{t.youtube.lead}</p>
        </div>
      </div>

      <form
        className="find"
        style={{ maxWidth: 560, margin: '0 0 20px' }}
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.youtube.placeholder}
          spellCheck={false}
        />
        <button type="submit" disabled={busy || !q.trim()}>
          {busy ? '…' : t.common.search}
        </button>
      </form>

      <p className="note">{t.youtube.note}</p>
      {err && <p className="note err">{err}</p>}

      {!searched && !busy && (
        <EmptyState title={t.youtube.empty} hint={t.common.emptyHint} />
      )}

      {searched && !busy && hits.length === 0 && !err && (
        <EmptyState title={t.youtube.noResults} hint={t.common.emptyHint} />
      )}

      {hits.length > 0 && (
        <div className="ledger">
          {playables.map((p) => (
            <button
              key={p.uid}
              type="button"
              className="cell"
              onClick={() => onPlay(p, playables)}
            >
              <div className="cell-top">
                {p.artworkUrl ? (
                  <img className="cell-mark" src={p.artworkUrl} alt="" />
                ) : (
                  <div className="cell-mark" style={{ display: 'grid', placeItems: 'center' }}>
                    ▶
                  </div>
                )}
              </div>
              <div className="cell-body">
                <div className="cell-title" style={{ color: currentUid === p.uid ? 'var(--accent)' : undefined }}>
                  {p.title}
                </div>
                <div className="cell-meta">{p.artist}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
