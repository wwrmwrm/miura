import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { EmptyState } from '../components/EmptyState';
import { LocalCover } from '../components/LocalCover';
import { VirtualList } from '../components/VirtualList';
import type { Playable } from '../player/types';
import { exportM3u, parseM3u } from '../lib/localM3u';
import { SMART_PLAYLISTS, runSmartPlaylist, type SmartPlaylistId } from '../lib/localSmartPlaylists';
import {
  applyLocalTagEdit,
  findDuplicates,
  formatDuration,
  groupByAlbum,
  groupByArtist,
  groupByFolder,
  groupByGenre,
  loadLocalLibrary,
  loadWatchedFolders,
  mergeLocalTracks,
  recordLocalPlay,
  saveLocalLibrary,
  saveWatchedFolders,
  sortLocalTracks,
  type GroupBucket,
  type LocalBrowseView,
  type LocalSortKey,
  type LocalTrackMeta,
} from '../sources/localLibrary';

type Props = {
  onPlay: (item: Playable, list: Playable[]) => void;
  onAddToQueue?: (item: Playable) => void;
  currentUid?: string | null;
};

function needsTagRefresh(tr: Playable): boolean {
  if (!tr.filePath) return false;
  if (tr.meta?.enriched) return false;
  if (/_/.test(tr.title) || /^\d{1,3}[\s._\-]/.test(tr.title)) return true;
  if (!tr.artist || tr.artist === 'Unknown') return true;
  return true;
}

type CtxMenu = { x: number; y: number; track: Playable } | null;

export function LocalPage({ onPlay, onAddToQueue, currentUid }: Props) {
  const t = useT();
  const [tracks, setTracks] = useState<Playable[]>(() => loadLocalLibrary());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [metaStatus, setMetaStatus] = useState<string | null>(null);
  const [view, setView] = useState<LocalBrowseView>('tracks');
  const [sortKey, setSortKey] = useState<LocalSortKey>('artist');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [smartId, setSmartId] = useState<SmartPlaylistId>('most_played');
  const [watched, setWatched] = useState<string[]>(() => loadWatchedFolders());
  const [ctx, setCtx] = useState<CtxMenu>(null);
  const [editTrack, setEditTrack] = useState<Playable | null>(null);
  const [lyricsTrack, setLyricsTrack] = useState<Playable | null>(null);
  const [dupes, setDupes] = useState<Playable[][] | null>(null);
  const enrichedOnce = useRef(false);
  const lastClickUid = useRef<string | null>(null);

  // Persist library
  useEffect(() => {
    saveLocalLibrary(tracks);
  }, [tracks]);

  // Record plays from player
  useEffect(() => {
    const onPlayEvt = (e: Event) => {
      const path = (e as CustomEvent).detail?.filePath as string | undefined;
      if (!path) return;
      setTracks((prev) => recordLocalPlay(prev, path));
    };
    window.addEventListener('miura-local-play', onPlayEvt);
    return () => window.removeEventListener('miura-local-play', onPlayEvt);
  }, []);

  // Watch folders
  useEffect(() => {
    saveWatchedFolders(watched);
    if (!window.electronAPI?.localWatchFolders) return;
    void window.electronAPI.localWatchFolders(watched);
  }, [watched]);

  useEffect(() => {
    if (!window.electronAPI?.onLocalLibraryEvent) return;
    return window.electronAPI.onLocalLibraryEvent((evt: { type: string; folder?: string }) => {
      if (evt?.type === 'folder-changed' && evt.folder) {
        void rescanFolder(String(evt.folder));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initial enrich
  useEffect(() => {
    if (enrichedOnce.current) return;
    if (!window.electronAPI) return;
    enrichedOnce.current = true;
    let cancelled = false;

    (async () => {
      if (window.electronAPI?.localCoverForPath) {
        const missingArt = tracks.filter((tr) => tr.filePath && !tr.artworkUrl);
        if (missingArt.length) {
          const updates: LocalTrackMeta[] = [];
          for (const tr of missingArt.slice(0, 80)) {
            try {
              const r = await window.electronAPI.localCoverForPath!(tr.filePath!);
              if (r?.ok && r.dataUrl) {
                updates.push({
                  path: tr.filePath!,
                  name: String(tr.meta?.fileName || tr.title),
                  title: tr.title,
                  artist: tr.artist,
                  album: (tr.meta?.album as string) ?? null,
                  durationMs: tr.durationMs ?? null,
                  artworkUrl: r.dataUrl,
                  size: typeof tr.meta?.size === 'number' ? tr.meta.size : undefined,
                  url: tr.streamUrl,
                });
              }
            } catch {
              /* ignore */
            }
          }
          if (!cancelled && updates.length) {
            setTracks((prev) => mergeLocalTracks(prev, updates));
          }
        }
      }

      const need = tracks.filter(needsTagRefresh);
      if (!need.length || !window.electronAPI?.localEnrichMeta) return;
      if (cancelled) return;
      setMetaStatus('…');
      try {
        const res = await window.electronAPI.localEnrichMeta(need.map((tr) => tr.filePath!));
        if (cancelled) return;
        if (res && !Array.isArray(res) && 'error' in res) {
          setErr(String(res.error));
          return;
        }
        const list = Array.isArray(res) ? res : [];
        if (list.length) setTracks((prev) => mergeLocalTracks(prev, list as LocalTrackMeta[]));
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setMetaStatus(null);
      }

      // Mark missing
      void checkMissing();
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rescanFolder = useCallback(async (folder: string) => {
    if (!window.electronAPI?.localScanFolder) return;
    try {
      const list = await window.electronAPI.localScanFolder(folder);
      if (list && !Array.isArray(list) && 'error' in list) return;
      const files = Array.isArray(list) ? list : [];
      if (files.length) {
        setTracks((prev) => mergeLocalTracks(prev, files as LocalTrackMeta[], { rootFolder: folder }));
      }
    } catch {
      /* ignore */
    }
  }, []);

  const checkMissing = useCallback(async () => {
    if (!window.electronAPI?.localCheckMissing) return;
    const paths = tracks.map((t) => t.filePath).filter(Boolean) as string[];
    if (!paths.length) return;
    try {
      const r = await window.electronAPI.localCheckMissing(paths);
      if (!r?.ok) return;
      const miss = new Set((r.missing || []).map((p) => p.replace(/\\/g, '/')));
      setTracks((prev) =>
        prev.map((t) => {
          if (!t.filePath) return t;
          const missing = miss.has(t.filePath.replace(/\\/g, '/'));
          if (Boolean(t.meta?.missing) === missing) return t;
          return { ...t, meta: { ...t.meta, missing } };
        })
      );
    } catch {
      /* ignore */
    }
  }, [tracks]);

  const addFromPicker = useCallback(async (mode: 'files' | 'folder') => {
    if (!window.electronAPI) {
      setErr('Electron only');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const list =
        mode === 'files'
          ? await window.electronAPI.localPickFiles()
          : await window.electronAPI.localPickFolder();
      if (list && !Array.isArray(list) && 'error' in list) {
        setErr(String(list.error));
        return;
      }
      const files = Array.isArray(list) ? (list as LocalTrackMeta[]) : [];
      if (!files.length) return;
      const root = mode === 'folder' ? files[0]?.rootFolder || null : null;
      setTracks((prev) => mergeLocalTracks(prev, files, { rootFolder: root }));
      if (root) {
        setWatched((w) => (w.includes(root) ? w : [...w, root]));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const addWatchFolder = useCallback(async () => {
    if (!window.electronAPI?.localPickFolderWatch) {
      await addFromPicker('folder');
      return;
    }
    setBusy(true);
    try {
      const r = await window.electronAPI.localPickFolderWatch();
      if (!r?.ok || !r.path) return;
      const folder = r.path;
      setWatched((w) => (w.includes(folder) ? w : [...w, folder]));
      await rescanFolder(folder);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [addFromPicker, rescanFolder]);

  const refreshMeta = useCallback(async () => {
    if (!window.electronAPI?.localEnrichMeta || !tracks.length) return;
    setBusy(true);
    setErr(null);
    setMetaStatus('…');
    try {
      const paths = tracks.map((tr) => tr.filePath).filter(Boolean) as string[];
      // batch in chunks of 100
      for (let i = 0; i < paths.length; i += 100) {
        const chunk = paths.slice(i, i + 100);
        const res = await window.electronAPI.localEnrichMeta(chunk);
        if (res && !Array.isArray(res) && 'error' in res) {
          setErr(String(res.error));
          break;
        }
        const list = Array.isArray(res) ? res : [];
        if (list.length) setTracks((prev) => mergeLocalTracks(prev, list as LocalTrackMeta[]));
      }
      await checkMissing();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setMetaStatus(null);
    }
  }, [tracks, checkMissing]);

  const removeMissing = useCallback(() => {
    setTracks((prev) => prev.filter((t) => !t.meta?.missing));
  }, []);

  const removeSelected = useCallback(() => {
    if (!selected.size) return;
    setTracks((prev) => prev.filter((t) => !selected.has(t.uid)));
    setSelected(new Set());
  }, [selected]);

  const importM3u = useCallback(async () => {
    if (!window.electronAPI?.localImportM3u) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await window.electronAPI.localImportM3u();
      if (!r?.ok || !r.text) return;
      const entries = parseM3u(r.text, r.baseDir);
      const paths = entries.map((e) => e.path);
      if (!paths.length) {
        setErr(t.local.m3uEmpty);
        return;
      }
      // enrich known paths
      const basic: LocalTrackMeta[] = entries.map((e) => ({
        path: e.path,
        name: e.path.split(/[/\\]/).pop() || e.path,
        title: e.title,
      }));
      if (window.electronAPI.localEnrichMeta) {
        const res = await window.electronAPI.localEnrichMeta(paths);
        if (Array.isArray(res)) {
          setTracks((prev) => mergeLocalTracks(prev, res as LocalTrackMeta[]));
        } else {
          setTracks((prev) => mergeLocalTracks(prev, basic));
        }
      } else {
        setTracks((prev) => mergeLocalTracks(prev, basic));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [t.local.m3uEmpty]);

  const filteredBase = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = tracks;
    if (q) {
      list = tracks.filter(
        (tr) =>
          tr.title.toLowerCase().includes(q) ||
          tr.artist.toLowerCase().includes(q) ||
          String(tr.meta?.album || '')
            .toLowerCase()
            .includes(q) ||
          String(tr.meta?.genre || '')
            .toLowerCase()
            .includes(q) ||
          String(tr.filePath || '')
            .toLowerCase()
            .includes(q)
      );
    }
    return list;
  }, [tracks, filter]);

  const groups: GroupBucket[] = useMemo(() => {
    if (view === 'artists') return groupByArtist(filteredBase);
    if (view === 'albums') return groupByAlbum(filteredBase);
    if (view === 'genres') return groupByGenre(filteredBase);
    if (view === 'folders') return groupByFolder(filteredBase);
    return [];
  }, [view, filteredBase]);

  const activeGroup = useMemo(
    () => (groupKey ? groups.find((g) => g.key === groupKey) : null),
    [groups, groupKey]
  );

  const displayedTracks = useMemo(() => {
    let list: Playable[];
    if (view === 'smart') {
      list = runSmartPlaylist(filteredBase, smartId);
    } else if (activeGroup) {
      list = activeGroup.tracks;
    } else if (view === 'tracks') {
      list = filteredBase;
    } else {
      list = [];
    }
    return sortLocalTracks(list, sortKey, sortDir);
  }, [view, smartId, activeGroup, filteredBase, sortKey, sortDir]);

  // fix exportM3u dependency
  const exportM3uFileFixed = useCallback(async () => {
    if (!window.electronAPI?.localExportM3u) return;
    const list = selected.size ? tracks.filter((tr) => selected.has(tr.uid)) : displayedTracks;
    await window.electronAPI.localExportM3u(exportM3u(list));
  }, [selected, tracks, displayedTracks]);

  const toggleSelect = (uid: string, e: React.MouseEvent) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && lastClickUid.current) {
        const ids = displayedTracks.map((x) => x.uid);
        const a = ids.indexOf(lastClickUid.current);
        const b = ids.indexOf(uid);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(ids[i]!);
          return next;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        if (next.has(uid)) next.delete(uid);
        else next.add(uid);
      } else {
        if (next.size === 1 && next.has(uid)) next.clear();
        else {
          next.clear();
          next.add(uid);
        }
      }
      lastClickUid.current = uid;
      return next;
    });
  };

  const playList = (list: Playable[], start: Playable) => {
    onPlay(start, list);
  };

  const selectAllVisible = () => {
    setSelected(new Set(displayedTracks.map((x) => x.uid)));
  };

  const views: { id: LocalBrowseView; label: string }[] = [
    { id: 'tracks', label: t.local.viewTracks },
    { id: 'artists', label: t.local.viewArtists },
    { id: 'albums', label: t.local.viewAlbums },
    { id: 'genres', label: t.local.viewGenres },
    { id: 'folders', label: t.local.viewFolders },
    { id: 'smart', label: t.local.viewSmart },
  ];

  const missingCount = tracks.filter((x) => x.meta?.missing).length;

  return (
    <div className="chapter local-page" onClick={() => setCtx(null)}>
      <div className="sc-home-hero">
        <div className="sc-home-hero-text">
          <h1 className="sc-home-greeting">{t.local.title}</h1>
          <p className="sc-home-lead">{t.local.lead}</p>
        </div>
      </div>

      <div className="acts local-acts" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn solid" disabled={busy} onClick={() => void addFromPicker('files')}>
          {t.local.addFiles}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void addFromPicker('folder')}>
          {t.local.addFolder}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void addWatchFolder()}>
          {t.local.watchFolder}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void importM3u()}>
          {t.local.importM3u}
        </button>
        {tracks.length > 0 && (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => void exportM3uFileFixed()}>
              {t.local.exportM3u}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void refreshMeta()}>
              {metaStatus ? '…' : t.local.refreshMeta}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void checkMissing()}>
              {t.local.checkMissing}
            </button>
            {missingCount > 0 && (
              <button type="button" className="btn" onClick={removeMissing}>
                {t.local.removeMissing.replace('{n}', String(missingCount))}
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => setDupes(findDuplicates(tracks))}
            >
              {t.local.findDupes}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setTracks([])}>
              {t.local.clear}
            </button>
          </>
        )}
      </div>

      {watched.length > 0 && (
        <p className="note" style={{ marginBottom: 10 }}>
          {t.local.watching}: {watched.map((w) => w.split(/[/\\]/).pop()).join(', ')}
          <button
            type="button"
            className="btn"
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}
            onClick={() => setWatched([])}
          >
            {t.local.stopWatch}
          </button>
        </p>
      )}

      {err && <p className="note err">{err}</p>}
      {metaStatus && !err && <p className="note">{t.local.readingMeta}</p>}

      {tracks.length === 0 ? (
        <EmptyState title={t.local.empty} hint={t.local.emptyHint} />
      ) : (
        <>
          <div className="local-toolbar">
            <div className="local-views">
              {views.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={`chip ${view === v.id ? 'on' : ''}`}
                  onClick={() => {
                    setView(v.id);
                    setGroupKey(null);
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <div className="find local-find">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`${t.common.search}…`}
                spellCheck={false}
              />
            </div>
            <label className="local-sort">
              <span>{t.local.sort}</span>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as LocalSortKey)}
              >
                <option value="title">{t.local.sortTitle}</option>
                <option value="artist">{t.local.sortArtist}</option>
                <option value="album">{t.local.sortAlbum}</option>
                <option value="genre">{t.local.sortGenre}</option>
                <option value="year">{t.local.sortYear}</option>
                <option value="duration">{t.local.sortDuration}</option>
                <option value="added">{t.local.sortAdded}</option>
                <option value="played">{t.local.sortPlayed}</option>
                <option value="path">{t.local.sortPath}</option>
              </select>
              <button
                type="button"
                className="btn"
                title={sortDir === 'asc' ? 'A→Z' : 'Z→A'}
                onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
              >
                {sortDir === 'asc' ? '↑' : '↓'}
              </button>
            </label>
          </div>

          {view === 'smart' && (
            <div className="local-smart-list">
              {SMART_PLAYLISTS.map((sp) => (
                <button
                  key={sp.id}
                  type="button"
                  className={`chip ${smartId === sp.id ? 'on' : ''}`}
                  onClick={() => setSmartId(sp.id)}
                >
                  {(t.local as unknown as Record<string, string>)[sp.labelKey] || sp.id}
                </button>
              ))}
            </div>
          )}

          {view !== 'tracks' && view !== 'smart' && !groupKey && (
            <div className="local-groups">
              {groups.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  className="local-group-card"
                  onClick={() => setGroupKey(g.key)}
                  onDoubleClick={() => {
                    if (g.tracks[0]) playList(g.tracks, g.tracks[0]);
                  }}
                >
                  <LocalCover
                    artworkUrl={g.artworkUrl}
                    filePath={g.tracks[0]?.filePath}
                    className="local-group-art"
                  />
                  <div className="local-group-meta">
                    <div className="local-group-title">{g.label}</div>
                    <div className="local-group-sub">
                      {g.count} {t.local.tracks}
                    </div>
                  </div>
                </button>
              ))}
              {!groups.length && <p className="note">{t.common.empty}</p>}
            </div>
          )}

          {(view === 'tracks' || view === 'smart' || groupKey) && (
            <>
              {groupKey && (
                <div className="local-group-header">
                  <button type="button" className="btn" onClick={() => setGroupKey(null)}>
                    ← {t.local.back}
                  </button>
                  <strong>{activeGroup?.label}</strong>
                  <span className="note">
                    {displayedTracks.length} {t.local.tracks}
                  </span>
                  {displayedTracks[0] && (
                    <button
                      type="button"
                      className="btn solid"
                      onClick={() => playList(displayedTracks, displayedTracks[0]!)}
                    >
                      {t.common.play}
                    </button>
                  )}
                </div>
              )}

              <div className="local-sel-bar">
                <span className="note">
                  {displayedTracks.length}/{tracks.length} {t.local.tracks}
                  {selected.size ? ` · ${selected.size} ${t.local.selected}` : ''}
                </span>
                <button type="button" className="btn" onClick={selectAllVisible}>
                  {t.local.selectAll}
                </button>
                {selected.size > 0 && (
                  <>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        const list = tracks.filter((x) => selected.has(x.uid));
                        if (list[0]) playList(list, list[0]);
                      }}
                    >
                      {t.common.play}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        if (!onAddToQueue) return;
                        tracks.filter((x) => selected.has(x.uid)).forEach((x) => onAddToQueue(x));
                      }}
                    >
                      {t.local.addToQueue}
                    </button>
                    <button type="button" className="btn" onClick={removeSelected}>
                      {t.common.remove}
                    </button>
                    <button type="button" className="btn" onClick={() => setSelected(new Set())}>
                      {t.local.clearSel}
                    </button>
                  </>
                )}
              </div>

              <div className="local-list-wrap">
                <VirtualList
                  items={displayedTracks}
                  rowHeight={72}
                  maxHeight={640}
                  getKey={(tr) => tr.uid}
                  className="local-vlist"
                  renderRow={(tr, i) => {
                    const live = currentUid === tr.uid;
                    const album = tr.meta?.album ? String(tr.meta.album) : '';
                    const isSel = selected.has(tr.uid);
                    const missing = Boolean(tr.meta?.missing);
                    return (
                      <div
                        className={`cat-row local-row ${live ? 'live' : ''} ${isSel ? 'sel' : ''} ${missing ? 'missing' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect(tr.uid, e);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          playList(displayedTracks, tr);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCtx({ x: e.clientX, y: e.clientY, track: tr });
                        }}
                      >
                        <button
                          type="button"
                          className="idx"
                          onClick={(e) => {
                            e.stopPropagation();
                            playList(displayedTracks, tr);
                          }}
                          title={t.common.play}
                        >
                          <span className="idx-num">{i + 1}</span>
                        </button>
                        <LocalCover
                          artworkUrl={tr.artworkUrl}
                          filePath={tr.filePath}
                          className="cat-art local-row-art"
                        />
                        <button
                          type="button"
                          className="cat-main"
                          onClick={(e) => {
                            e.stopPropagation();
                            playList(displayedTracks, tr);
                          }}
                        >
                          <div className="cat-title local-row-title">
                            {tr.title}
                            {missing ? ' ⚠' : ''}
                          </div>
                          <div className="cat-sub local-row-sub">
                            {tr.artist}
                            {album ? ` · ${album}` : ''}
                            {tr.meta?.genre ? ` · ${tr.meta.genre}` : ''}
                            {Number(tr.meta?.playCount) > 0
                              ? ` · ▶${tr.meta?.playCount}`
                              : ''}
                          </div>
                        </button>
                        <span className="local-dur">{formatDuration(tr.durationMs)}</span>
                      </div>
                    );
                  }}
                />
              </div>
            </>
          )}
        </>
      )}

      {ctx && (
        <div
          className="local-ctx"
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              playList(displayedTracks.length ? displayedTracks : tracks, ctx.track);
              setCtx(null);
            }}
          >
            {t.common.play}
          </button>
          {onAddToQueue && (
            <button
              type="button"
              onClick={() => {
                onAddToQueue(ctx.track);
                setCtx(null);
              }}
            >
              {t.local.addToQueue}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (ctx.track.filePath) void window.electronAPI?.localRevealInFolder?.(ctx.track.filePath);
              setCtx(null);
            }}
          >
            {t.local.reveal}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditTrack(ctx.track);
              setCtx(null);
            }}
          >
            {t.local.editTags}
          </button>
          <button
            type="button"
            onClick={() => {
              setLyricsTrack(ctx.track);
              setCtx(null);
            }}
          >
            {t.local.lyrics}
          </button>
          <button
            type="button"
            onClick={() => {
              setTracks((prev) => prev.filter((x) => x.uid !== ctx.track.uid));
              setCtx(null);
            }}
          >
            {t.common.remove}
          </button>
        </div>
      )}

      {editTrack && (
        <TagEditorModal
          track={editTrack}
          onClose={() => setEditTrack(null)}
          onSave={(edit) => {
            if (!editTrack.filePath) return;
            setTracks((prev) => applyLocalTagEdit(prev, editTrack.filePath!, edit));
            void window.electronAPI?.localWriteTags?.({ path: editTrack.filePath, ...edit });
            setEditTrack(null);
          }}
          labels={{
            title: t.local.tagTitle,
            artist: t.local.tagArtist,
            album: t.local.tagAlbum,
            genre: t.local.tagGenre,
            year: t.local.tagYear,
            save: t.common.save,
            cancel: t.common.cancel,
            heading: t.local.editTags,
            note: t.local.tagsLibraryOnly,
          }}
        />
      )}

      {lyricsTrack && (
        <LyricsModal
          track={lyricsTrack}
          onClose={() => setLyricsTrack(null)}
          title={t.local.lyrics}
        />
      )}

      {dupes && (
        <div className="local-modal-backdrop" onClick={() => setDupes(null)}>
          <div className="local-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t.local.findDupes}</h3>
            {!dupes.length ? (
              <p className="note">{t.local.noDupes}</p>
            ) : (
              <div className="local-dupe-list">
                {dupes.slice(0, 40).map((group, gi) => (
                  <div key={gi} className="local-dupe-group">
                    <strong>
                      {group[0]?.artist} — {group[0]?.title}
                    </strong>
                    {group.map((tr) => (
                      <div key={tr.uid} className="note">
                        {tr.filePath}
                        <button
                          type="button"
                          className="btn"
                          style={{ marginLeft: 8 }}
                          onClick={() =>
                            setTracks((prev) => prev.filter((x) => x.uid !== tr.uid))
                          }
                        >
                          {t.common.remove}
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="btn" onClick={() => setDupes(null)}>
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TagEditorModal({
  track,
  onClose,
  onSave,
  labels,
}: {
  track: Playable;
  onClose: () => void;
  onSave: (edit: {
    title: string;
    artist: string;
    album: string | null;
    genre: string | null;
    year: number | null;
  }) => void;
  labels: Record<string, string>;
}) {
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const [album, setAlbum] = useState(String(track.meta?.album || ''));
  const [genre, setGenre] = useState(String(track.meta?.genre || ''));
  const [year, setYear] = useState(String(track.meta?.year || ''));

  return (
    <div className="local-modal-backdrop" onClick={onClose}>
      <div className="local-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{labels.heading}</h3>
        {labels.note ? <p className="note" style={{ marginBottom: 10 }}>{labels.note}</p> : null}
        <label>
          {labels.title}
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          {labels.artist}
          <input value={artist} onChange={(e) => setArtist(e.target.value)} />
        </label>
        <label>
          {labels.album}
          <input value={album} onChange={(e) => setAlbum(e.target.value)} />
        </label>
        <label>
          {labels.genre}
          <input value={genre} onChange={(e) => setGenre(e.target.value)} />
        </label>
        <label>
          {labels.year}
          <input value={year} onChange={(e) => setYear(e.target.value)} />
        </label>
        <div className="acts">
          <button
            type="button"
            className="btn solid"
            onClick={() =>
              onSave({
                title: title.trim() || track.title,
                artist: artist.trim() || track.artist,
                album: album.trim() || null,
                genre: genre.trim() || null,
                year: year ? parseInt(year, 10) || null : null,
              })
            }
          >
            {labels.save}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {labels.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

function LyricsModal({
  track,
  onClose,
  title,
}: {
  track: Playable;
  onClose: () => void;
  title: string;
}) {
  const [text, setText] = useState(String(track.meta?.lyrics || ''));
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (text || !track.filePath || !window.electronAPI?.localReadLyricsFile) return;
      try {
        const r = await window.electronAPI.localReadLyricsFile(track.filePath);
        if (!cancelled && r?.ok && r.text) setText(r.text);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [track.filePath, text]);

  return (
    <div className="local-modal-backdrop" onClick={onClose}>
      <div className="local-modal local-lyrics-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {title}: {track.title}
        </h3>
        <pre className="local-lyrics-body">{text || '—'}</pre>
        <button type="button" className="btn" onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}

