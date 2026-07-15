import React, { useMemo, useState } from 'react';
import {
  artworkUrl,
  copyToClipboard,
  formatCount,
  formatDuration,
  formatRelativeTime,
  isGoPlusOnlyTrack,
} from '../api/soundcloud';
import {
  IconCheck,
  IconExternal,
  IconHeart,
  IconLink,
  IconPlay,
  IconRepost,
  IconStation,
  Ico,
} from '../components/icons';
import type { SoundCloudUser, Track, TrackComment } from '../types';

type Props = {
  track: Track;
  related: Track[];
  comments: TrackComment[];
  loading?: boolean;
  currentId?: number;
  liked: boolean;
  reposted?: boolean;
  /** Current player time in seconds (for timed comments) */
  playerProgressSec?: number;
  meId?: number | null;
  isLoggedIn?: boolean;
  onPlay: () => void;
  onPlayRelated: (t: Track, list: Track[]) => void;
  onLike: () => void;
  onRepost?: () => void;
  onStation: () => void;
  onOpenUser: (u: SoundCloudUser) => void;
  onOpenTrack: (t: Track) => void;
  onSeekComment?: (ms: number) => void;
  onPostComment?: (body: string, timestampMs: number | null) => Promise<void>;
  onDeleteComment?: (commentId: number) => Promise<void>;
  onAddToPlaylist?: () => void;
  onLogin?: () => void;
};

export function TrackPage({
  track,
  related,
  comments,
  loading,
  currentId,
  liked,
  reposted,
  playerProgressSec = 0,
  meId,
  isLoggedIn,
  onPlay,
  onPlayRelated,
  onLike,
  onRepost,
  onStation,
  onOpenUser,
  onOpenTrack,
  onSeekComment,
  onPostComment,
  onDeleteComment,
  onAddToPlaylist,
  onLogin,
}: Props) {
  const [descOpen, setDescOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState('');
  const [atPlayhead, setAtPlayhead] = useState(true);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const art = artworkUrl(track.artwork_url || track.user?.avatar_url, 't500x500');
  const desc = (track.description || '').trim();
  const longDesc = desc.length > 280;
  const shownDesc = !longDesc || descOpen ? desc : `${desc.slice(0, 280)}…`;

  const stats = useMemo(
    () => [
      { label: 'прослушиваний', value: formatCount(track.playback_count || 0) },
      { label: 'лайков', value: formatCount(track.likes_count || track.favoritings_count || 0) },
      { label: 'репостов', value: formatCount(track.reposts_count || 0) },
      { label: 'комментов', value: formatCount(track.comment_count || comments.length || 0) },
    ],
    [track, comments.length]
  );

  const handleCopy = async () => {
    const url = track.permalink_url || `https://soundcloud.com/${track.id}`;
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <div className="track-page">
      <div className="track-hero">
        {art ? (
          <img className="track-hero-art" src={art} alt="" draggable={false} />
        ) : (
          <div className="track-hero-art ph">♪</div>
        )}
        <div className="track-hero-body">
          <div className="dossier-k">Трек</div>
          <h1 className="track-title">
            {track.title}
            {isGoPlusOnlyTrack(track) ? (
              <span className="badge-go badge-go-lg" title="Доступно с SoundCloud Go+">
                GO+
              </span>
            ) : null}
          </h1>
          {track.user && (
            <button type="button" className="track-artist" onClick={() => onOpenUser(track.user)}>
              {track.user.username}
            </button>
          )}
          <div className="track-meta-line">
            {isGoPlusOnlyTrack(track) ? (
              <span className="track-chip track-chip-go" title="Полный трек с подпиской Go+">
                SoundCloud Go+
              </span>
            ) : null}
            {track.genre ? <span className="track-chip">{track.genre}</span> : null}
            <span>{formatDuration(track.duration)}</span>
            {track.created_at ? <span>· {formatRelativeTime(track.created_at)}</span> : null}
          </div>
          <div className="track-stats">
            {stats.map((s) => (
              <div key={s.label} className="track-stat">
                <strong>{s.value}</strong>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
          <div className="acts acts-icons">
            <button type="button" className="btn solid btn-ico-text" onClick={onPlay}>
              <IconPlay size={16} />
              <span>{currentId === track.id ? 'Играет' : 'Слушать'}</span>
            </button>
            <button
              type="button"
              className={`btn-icon ${liked ? 'on' : ''}`}
              onClick={onLike}
              title={liked ? 'Убрать лайк' : 'Лайк'}
              aria-label="like"
            >
              <IconHeart filled={liked} size={20} />
            </button>
            {onRepost && (
              <button
                type="button"
                className={`btn-icon ${reposted ? 'on' : ''}`}
                onClick={onRepost}
                title={reposted ? 'Убрать репост' : 'Репост'}
                aria-label="repost"
              >
                <IconRepost size={20} />
              </button>
            )}
            <button type="button" className="btn-icon" onClick={onStation} title="Станция" aria-label="station">
              <IconStation size={20} />
            </button>
            {onAddToPlaylist && (
              <button
                type="button"
                className="btn-icon"
                onClick={onAddToPlaylist}
                title="В плейлист"
                aria-label="add to playlist"
              >
                <Ico size={20}>
                  <path d="M12 5v14M5 12h14" />
                  <path d="M4 19h8" />
                </Ico>
              </button>
            )}
            <button
              type="button"
              className={`btn-icon ${copied ? 'on' : ''}`}
              onClick={() => void handleCopy()}
              title={copied ? 'Скопировано' : 'Копировать ссылку'}
              aria-label="copy link"
            >
              {copied ? <IconCheck size={20} /> : <IconLink size={20} />}
            </button>
            {track.permalink_url ? (
              <a
                className="btn-icon"
                href={track.permalink_url}
                target="_blank"
                rel="noreferrer"
                title="Открыть на сайте"
                aria-label="open web"
              >
                <IconExternal size={20} />
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {desc ? (
        <section className="chapter track-desc">
          <div className="chapter-h">
            <h2>Описание</h2>
          </div>
          <p className="track-desc-text">{shownDesc}</p>
          {longDesc && (
            <button type="button" className="linkish" onClick={() => setDescOpen((v) => !v)}>
              {descOpen ? 'Свернуть' : 'Показать полностью'}
            </button>
          )}
        </section>
      ) : null}

      <section className="chapter">
        <div className="chapter-h">
          <h2>Комментарии</h2>
          <span className="linkish" style={{ cursor: 'default' }}>
            {comments.length}
            {loading ? ' · …' : ''}
          </span>
        </div>

        {isLoggedIn && onPostComment ? (
          <form
            className="comment-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim() || sending) return;
              setSending(true);
              setFormError(null);
              const ts =
                atPlayhead && currentId === track.id
                  ? Math.floor(playerProgressSec * 1000)
                  : atPlayhead
                    ? 0
                    : null;
              void onPostComment(draft.trim(), ts)
                .then(() => setDraft(''))
                .catch((err: unknown) =>
                  setFormError(err instanceof Error ? err.message : 'Не удалось отправить')
                )
                .finally(() => setSending(false));
            }}
          >
            <textarea
              className="comment-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Написать комментарий…"
              rows={3}
              maxLength={5000}
              disabled={sending}
            />
            <div className="comment-form-bar">
              <label className="comment-check">
                <input
                  type="checkbox"
                  checked={atPlayhead}
                  onChange={(e) => setAtPlayhead(e.target.checked)}
                />
                <span>
                  В момент трека
                  {atPlayhead && currentId === track.id
                    ? ` (${formatDuration(playerProgressSec * 1000)})`
                    : atPlayhead
                      ? ' (0:00)'
                      : ''}
                </span>
              </label>
              <button
                type="submit"
                className="btn solid"
                disabled={sending || !draft.trim()}
              >
                {sending ? 'Отправка…' : 'Отправить'}
              </button>
            </div>
            {formError && <p className="note err">{formError}</p>}
          </form>
        ) : (
          <p className="note">
            Чтобы комментировать,{' '}
            <button type="button" className="linkish" onClick={() => onLogin?.()}>
              войди
            </button>
          </p>
        )}

        {!comments.length && !loading ? (
          <div className="void" style={{ padding: '24px 0' }}>
            <h3>Пока тихо</h3>
            <p>Напиши первый комментарий</p>
          </div>
        ) : (
          <ul className="comment-list">
            {comments.map((c) => {
              const mine = meId != null && (c.user_id === meId || c.user?.id === meId);
              return (
                <li key={c.id} className="comment-row">
                  {c.user?.avatar_url ? (
                    <img
                      className="comment-av"
                      src={artworkUrl(c.user.avatar_url, 't67x67')}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <div className="comment-av ph">@</div>
                  )}
                  <div className="comment-body">
                    <div className="comment-head">
                      {c.user ? (
                        <button type="button" className="comment-user" onClick={() => onOpenUser(c.user)}>
                          {c.user.username}
                        </button>
                      ) : (
                        <span className="comment-user">user</span>
                      )}
                      <span className="comment-time">{formatRelativeTime(c.created_at)}</span>
                      {typeof c.timestamp === 'number' && c.timestamp >= 0 && (
                        <button
                          type="button"
                          className="comment-ts"
                          title="Перейти к моменту"
                          onClick={() => onSeekComment?.(c.timestamp!)}
                        >
                          {formatDuration(c.timestamp)}
                        </button>
                      )}
                      {mine && onDeleteComment && (
                        <button
                          type="button"
                          className="comment-del"
                          title="Удалить"
                          onClick={() => void onDeleteComment(c.id)}
                        >
                          Удалить
                        </button>
                      )}
                    </div>
                    <p className="comment-text">{c.body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {related.length > 0 && (
        <section className="chapter">
          <div className="chapter-h">
            <h2>Похожие</h2>
            <button type="button" className="linkish" onClick={() => onPlayRelated(related[0]!, related)}>
              Слушать всё
            </button>
          </div>
          <div className="sc-rail">
            {related.map((t) => {
              const rArt = artworkUrl(t.artwork_url || t.user?.avatar_url, 't300x300');
              const active = currentId === t.id;
              return (
                <article key={t.id} className={`sc-card ${active ? 'live' : ''}`}>
                  <div className="sc-cover">
                    {rArt ? (
                      <img src={rArt} alt="" loading="lazy" draggable={false} />
                    ) : (
                      <div className="sc-cover-ph">♪</div>
                    )}
                    <div className="sc-cover-fade" />
                    <button
                      type="button"
                      className="sc-play"
                      onClick={() => onPlayRelated(t, related)}
                      title="Play"
                    >
                      <IconPlay size={18} />
                    </button>
                    <span className="sc-dur">{formatDuration(t.duration)}</span>
                    {isGoPlusOnlyTrack(t) && (
                      <span className="badge-go badge-go-cover" title="SoundCloud Go+">
                        GO+
                      </span>
                    )}
                  </div>
                  <button type="button" className="sc-meta" onClick={() => onOpenTrack(t)}>
                    <div className="sc-t" title={t.title}>
                      {t.title}
                      {isGoPlusOnlyTrack(t) ? (
                        <span className="badge-go" title="SoundCloud Go+">
                          GO+
                        </span>
                      ) : null}
                    </div>
                    <div className="sc-a">{t.user?.username}</div>
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
