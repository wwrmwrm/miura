import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import {
  appendItems,
  appendPlayables,
  createPlaylist,
  deletePlaylist,
  flushPlaylists,
  itemSource,
  loadPlaylists,
  patchItem,
  patchPlaylistMeta,
  playlistCover,
  playlistStats,
  removeItem,
  renamePlaylist,
  replaceItem,
  type MiuraPlaylist,
  type MiuraPlaylistItem,
} from '../lib/miuraPlaylists';
import { pathToPlayable, type LocalTrackMeta } from '../sources/localLibrary';
import {
  applyResolveToItem,
  parseTrackListText,
  resolveTrackLine,
  type ImportSource,
} from '../lib/trackListImport';
import type { Track, PlaybackState } from '../types';
import type { Playable } from '../player/types';
import { hashUid } from '../player/playableBridge';
import { SourceBadge } from '../components/SourceBadge';
import { VirtualList } from '../components/VirtualList';
import { ConfirmModal } from '../components/ConfirmModal';

type Props = {
  onPlayTrack: (track: Track, list?: Track[]) => void;
  onPlayPlayable: (item: Playable, list?: Playable[]) => void;
  currentId?: number | null;
  currentUid?: string | null;
  playerState?: PlaybackState | string;
  /** Open this playlist when set from left rail */
  focusPlaylistId?: string | null;
  onPlaylistsChange?: () => void;
  onFocusPlaylist?: (id: string | null) => void;
};

export function MiuraPlaylistsPage({
  onPlayTrack,
  onPlayPlayable,
  currentId = null,
  currentUid = null,
  playerState = 'idle',
  focusPlaylistId = null,
  onPlaylistsChange,
  onFocusPlaylist,
}: Props) {
  const t = useT();
  const [playlists, setPlaylists] = useState<MiuraPlaylist[]>(() => loadPlaylists());
  const [activeId, setActiveId] = useState<string | null>(focusPlaylistId || null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importTitle, setImportTitle] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [editingField, setEditingField] = useState<null | 'title' | 'description'>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [sources, setSources] = useState<Record<ImportSource, boolean>>({
    local: true,
    soundcloud: true,
  });
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const cancelRef = useRef(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const descInputRef = useRef<HTMLTextAreaElement | null>(null);

  const active = useMemo(
    () => playlists.find((p) => p.id === activeId) || null,
    [playlists, activeId]
  );

  const refresh = useCallback(() => {
    setPlaylists(loadPlaylists());
    onPlaylistsChange?.();
  }, [onPlaylistsChange]);

  const selectPlaylist = useCallback(
    (id: string | null) => {
      setActiveId(id);
      onFocusPlaylist?.(id);
    },
    [onFocusPlaylist]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (focusPlaylistId) {
      setActiveId(focusPlaylistId);
      setPlaylists(loadPlaylists());
    }
  }, [focusPlaylistId]);

  useEffect(
    () => () => {
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    },
    []
  );

  /** Show a one-shot status toast, then clear (never sticks on the page). */
  const flashMsg = useCallback((text: string | null, ms = 4500) => {
    if (msgTimerRef.current) {
      clearTimeout(msgTimerRef.current);
      msgTimerRef.current = null;
    }
    setMsg(text);
    if (!text) return;
    msgTimerRef.current = setTimeout(() => {
      setMsg(null);
      msgTimerRef.current = null;
    }, ms);
  }, []);

  const sourceList = useMemo(() => {
    const s: ImportSource[] = [];
    if (sources.local) s.push('local');
    if (sources.soundcloud) s.push('soundcloud');
    return s.length ? s : (['local', 'soundcloud'] as ImportSource[]);
  }, [sources]);

  const openCreate = () => {
    setCreateTitle(t.playlists.defaultName);
    setCreateOpen(true);
    setMsg(null);
  };

  const addOwnTracks = async () => {
    if (!active || importing) return;
    if (!window.electronAPI?.localPickFiles) {
      flashMsg(t.playlists.addOwnTracksEmpty);
      return;
    }
    try {
      const list = await window.electronAPI.localPickFiles();
      if (list && !Array.isArray(list) && 'error' in list) {
        flashMsg(String((list as { error?: string }).error || t.common.error));
        return;
      }
      const files = Array.isArray(list) ? (list as LocalTrackMeta[]) : [];
      if (!files.length) {
        flashMsg(t.playlists.addOwnTracksEmpty);
        return;
      }
      let metas = files;
      if (window.electronAPI.localEnrichMeta) {
        try {
          const paths = files.map((f) => f.path).filter(Boolean);
          const res = await window.electronAPI.localEnrichMeta(paths);
          if (Array.isArray(res) && res.length) {
            const byPath = new Map(
              (res as LocalTrackMeta[]).map((m) => [String(m.path || '').replace(/\\/g, '/'), m])
            );
            metas = files.map((f) => {
              const key = String(f.path || '').replace(/\\/g, '/');
              return byPath.get(key) || f;
            });
          }
        } catch {
          /* keep basic meta */
        }
      }
      const playables = metas.map((m) => pathToPlayable(m));
      const before = active.items.length;
      appendPlayables(active.id, playables);
      refresh();
      const after = loadPlaylists().find((p) => p.id === active.id);
      const added = Math.max(0, (after?.items.length || before) - before);
      flashMsg(t.playlists.addOwnTracksDone.replace('{n}', String(added || playables.length)));
    } catch (e) {
      flashMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const submitCreate = () => {
    const pl = createPlaylist(createTitle.trim() || t.playlists.defaultName);
    refresh();
    setCreateOpen(false);
    setCreateTitle('');
    selectPlaylist(pl.id);
    setMsg(null);
  };

  const isItemActive = useCallback(
    (it: MiuraPlaylistItem) => {
      if (currentId == null && !currentUid) return false;
      if (it.track?.id != null && currentId != null && it.track.id === currentId) return true;
      if (it.playable) {
        if (currentUid && it.playable.uid === currentUid) return true;
        if (currentId != null && hashUid(it.playable.uid) === currentId) return true;
      }
      return false;
    },
    [currentId, currentUid]
  );

  const startEditTitle = () => {
    if (!active || importing) return;
    setTitleDraft(active.title);
    setEditingField('title');
    setTimeout(() => titleInputRef.current?.focus(), 0);
  };

  const startEditDesc = () => {
    if (!active || importing) return;
    setDescDraft(active.description || '');
    setEditingField('description');
    setTimeout(() => descInputRef.current?.focus(), 0);
  };

  const commitTitle = () => {
    if (!active) return;
    const next = titleDraft.trim() || t.playlists.defaultName;
    if (next !== active.title) {
      patchPlaylistMeta(active.id, { title: next });
      refresh();
    }
    setEditingField(null);
  };

  const commitDesc = () => {
    if (!active) return;
    const next = descDraft.trim();
    if (next !== (active.description || '')) {
      patchPlaylistMeta(active.id, { description: next || null });
      refresh();
    }
    setEditingField(null);
  };

  const pickCover = async () => {
    if (!active || importing) return;
    let url: string | null = null;
    try {
      if (window.electronAPI?.profilePickBanner) {
        const r = await window.electronAPI.profilePickBanner();
        if (r && !r.canceled && r.dataUrl) url = r.dataUrl;
      }
    } catch {
      /* fall through */
    }
    if (!url) {
      url = await new Promise<string | null>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => {
          const f = input.files?.[0];
          if (!f) {
            resolve(null);
            return;
          }
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(f);
        };
        input.click();
      });
    }
    if (url) {
      patchPlaylistMeta(active.id, { artworkUrl: url });
      refresh();
    }
  };

  const onPickTextFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setImportText(text);
      if (!importTitle.trim()) {
        const base = file.name.replace(/\.[^.]+$/, '').trim();
        if (base) setImportTitle(base);
      }
      setImportOpen(true);
    };
    reader.readAsText(file, 'UTF-8');
  };

  const runImport = async () => {
    const lines = parseTrackListText(importText);
    if (!lines.length) {
      setMsg(t.playlists.importEmpty);
      return;
    }
    if (!sourceList.length) {
      setMsg(t.playlists.pickSource);
      return;
    }

    let plId = activeId;
    if (!plId) {
      const title =
        importTitle.trim() ||
        t.playlists.importDefaultTitle.replace('{n}', String(lines.length));
      const pl = createPlaylist(title);
      plId = pl.id;
      selectPlaylist(pl.id);
    } else if (importTitle.trim()) {
      renamePlaylist(plId, importTitle.trim());
    }

    const before = loadPlaylists().find((p) => p.id === plId);
    const existingIds = new Set((before?.items || []).map((i) => i.id));
    appendItems(
      plId,
      lines.map((l) => l.raw)
    );
    refresh();
    setImportOpen(false);
    setImportText('');
    setImportTitle('');

    const pl = loadPlaylists().find((p) => p.id === plId);
    if (!pl) return;
    const newItems = pl.items.filter((i) => !existingIds.has(i.id) && i.status === 'pending');

    cancelRef.current = false;
    setImporting(true);
    setProgress({ done: 0, total: newItems.length });
    setMsg(t.playlists.importStarted.replace('{n}', String(newItems.length)));

    // Debounced storage + sparse UI refresh — critical for 1000+ lines
    const DEBOUNCE = 800;
    const UI_EVERY = 12;

    for (let i = 0; i < newItems.length; i++) {
      if (cancelRef.current) break;
      const it = newItems[i];
      // Skip intermediate "searching" write — jump straight to resolved state
      const line =
        lines[i] ||
        parseTrackListText(it.query)[0] || {
          raw: it.query,
          title: it.query,
          query: it.query,
        };

      try {
        const result = await resolveTrackLine(line, sourceList);
        const next = applyResolveToItem(it, result);
        replaceItem(plId, it.id, next, { debounceMs: DEBOUNCE });
      } catch (e) {
        patchItem(
          plId,
          it.id,
          {
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
            resolvedAt: Date.now(),
          },
          { debounceMs: DEBOUNCE }
        );
      }

      setProgress({ done: i + 1, total: newItems.length });
      if (i % UI_EVERY === 0 || i === newItems.length - 1) {
        refresh();
        // Yield to UI thread
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    flushPlaylists();
    setImporting(false);
    const final = loadPlaylists().find((p) => p.id === plId);
    if (final) {
      const st = playlistStats(final);
      flashMsg(
        t.playlists.importDone
          .replace('{found}', String(st.found))
          .replace('{total}', String(st.total))
          .replace('{missing}', String(st.missing)),
        4000
      );
    } else {
      flashMsg(null);
    }
    refresh();
  };

  const reresolveAll = async () => {
    if (!active || importing) return;
    const plId = active.id;
    const items = [...active.items];
    if (!items.length) return;
    if (!sourceList.length) {
      setMsg(t.playlists.pickSource);
      return;
    }

    cancelRef.current = false;
    setImporting(true);
    setProgress({ done: 0, total: items.length });
    setMsg(t.playlists.reresolveStarted.replace('{n}', String(items.length)));

    const DEBOUNCE = 800;
    const UI_EVERY = 12;

    for (let i = 0; i < items.length; i++) {
      if (cancelRef.current) break;
      const it = items[i];
      const line = parseTrackListText(it.query)[0] || {
        raw: it.query,
        title: it.query,
        query: it.query,
      };

      try {
        const result = await resolveTrackLine(line, sourceList);
        const next = applyResolveToItem({ ...it, track: undefined, playable: undefined }, result);
        replaceItem(plId, it.id, next, { debounceMs: DEBOUNCE });
      } catch (e) {
        patchItem(
          plId,
          it.id,
          {
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
            resolvedAt: Date.now(),
          },
          { debounceMs: DEBOUNCE }
        );
      }

      setProgress({ done: i + 1, total: items.length });
      if (i % UI_EVERY === 0 || i === items.length - 1) {
        refresh();
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    flushPlaylists();
    setImporting(false);
    const final = loadPlaylists().find((p) => p.id === plId);
    if (final) {
      const st = playlistStats(final);
      flashMsg(
        t.playlists.importDone
          .replace('{found}', String(st.found))
          .replace('{total}', String(st.total))
          .replace('{missing}', String(st.missing)),
        4000
      );
    } else {
      flashMsg(null);
    }
    refresh();
  };

  const playItem = (it: MiuraPlaylistItem, fromList: MiuraPlaylistItem[]) => {
    if (it.status !== 'found') return;
    const src = itemSource(it);
    if (src === 'local' && it.playable) {
      const list = fromList
        .filter((x) => {
          const s = itemSource(x);
          return s === 'local' && x.playable;
        })
        .map((x) => x.playable!) as Playable[];
      onPlayPlayable(it.playable, list);
      return;
    }
    if (src === 'soundcloud' && it.track) {
      const tracks = fromList
        .filter((x) => itemSource(x) === 'soundcloud' && x.track)
        .map((x) => x.track!) as Track[];
      onPlayTrack(it.track, tracks);
      return;
    }
    if (it.playable) {
      const list = fromList.filter((x) => x.playable).map((x) => x.playable!) as Playable[];
      onPlayPlayable(it.playable, list);
      return;
    }
    if (it.track) {
      const tracks = fromList.filter((x) => x.track).map((x) => x.track!) as Track[];
      onPlayTrack(it.track, tracks);
    }
  };

  const playAllFound = (pl: MiuraPlaylist) => {
    const found = pl.items.filter((i) => i.status === 'found');
    if (!found.length) return;
    playItem(found[0], found);
  };

  // ── list ──
  if (!active) {
    return (
      <div className="chapter miura-pl-page">
        <div className="sc-home-hero">
          <div className="sc-home-hero-text">
            <h1 className="sc-home-greeting">{t.playlists.title}</h1>
            <p className="sc-home-lead">{t.playlists.lead}</p>
          </div>
        </div>

        <div className="row-btns miura-pl-toolbar">
          <button type="button" className="btn solid" onClick={openCreate} disabled={importing}>
            {t.playlists.create}
          </button>
          <button
            type="button"
            className="btn solid"
            disabled={importing}
            onClick={() => {
              selectPlaylist(null);
              setImportTitle('');
              setImportText('');
              setImportOpen(true);
            }}
          >
            {t.playlists.importFromText}
          </button>
          <button
            type="button"
            className="btn"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            {t.playlists.importFromFile}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.m3u,.m3u8,.tsv,text/plain"
            hidden
            onChange={(e) => {
              onPickTextFile(e.target.files?.[0] || null);
              e.target.value = '';
            }}
          />
        </div>

        {msg && <p className="note miura-pl-msg">{msg}</p>}

        {playlists.length === 0 ? (
          <div className="miura-pl-empty">
            <div className="miura-pl-empty-icon">☰</div>
            <p>{t.playlists.empty}</p>
          </div>
        ) : (
          <div className="miura-pl-grid">
            {playlists.map((pl) => {
              const cover = playlistCover(pl);
              return (
                <button
                  key={pl.id}
                  type="button"
                  className="miura-pl-card"
                  onClick={() => {
                    selectPlaylist(pl.id);
                    setMsg(null);
                  }}
                >
                  <div className="miura-pl-card-art">
                    {cover ? (
                      <img src={cover} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="miura-pl-card-ph">♪</div>
                    )}
                  </div>
                  <div className="miura-pl-card-body">
                    <span className="miura-pl-card-title">{pl.title}</span>
                    {pl.description ? (
                      <span className="miura-pl-card-desc">{pl.description}</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {createOpen && (
          <SimpleModal
            title={t.playlists.create}
            onClose={() => setCreateOpen(false)}
            footer={
              <>
                <button type="button" className="btn" onClick={() => setCreateOpen(false)}>
                  {t.common.cancel}
                </button>
                <button type="button" className="btn solid" onClick={submitCreate}>
                  {t.common.save}
                </button>
              </>
            }
          >
            <label className="settings-field-label">{t.playlists.name}</label>
            <input
              autoFocus
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder={t.playlists.defaultName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate();
              }}
            />
          </SimpleModal>
        )}

        {importOpen && (
          <ImportModal
            t={t}
            text={importText}
            setText={setImportText}
            title={importTitle}
            setTitle={setImportTitle}
            sources={sources}
            setSources={setSources}
            busy={importing}
            onClose={() => !importing && setImportOpen(false)}
            onStart={() => void runImport()}
            onPickFile={() => fileRef.current?.click()}
          />
        )}
      </div>
    );
  }

  // ── detail ──
  const st = playlistStats(active);
  const cover = playlistCover(active);
  const isPlayingNow = playerState === 'playing';

  return (
    <div className="chapter miura-pl-page">
      <div className="miura-pl-iconbar">
        <button
          type="button"
          className="miura-pl-ico"
          title={t.playlists.back}
          disabled={importing}
          onClick={() => selectPlaylist(null)}
        >
          <IconBack />
        </button>
        <button
          type="button"
          className="miura-pl-ico solid"
          title={t.common.play}
          disabled={importing || !st.found}
          onClick={() => playAllFound(active)}
        >
          <IconPlay />
        </button>
        <button
          type="button"
          className="miura-pl-ico solid"
          title={t.playlists.addOwnTracks}
          disabled={importing}
          onClick={() => void addOwnTracks()}
        >
          <IconPlus />
        </button>
        <button
          type="button"
          className="miura-pl-ico"
          title={t.playlists.addFromText}
          disabled={importing}
          onClick={() => setImportOpen(true)}
        >
          <IconFile />
        </button>
        <button
          type="button"
          className="miura-pl-ico"
          title={t.playlists.importFromFile}
          disabled={importing}
          onClick={() => fileRef.current?.click()}
        >
          <IconFile />
        </button>
        <button
          type="button"
          className="miura-pl-ico"
          title={t.playlists.reresolveHint}
          disabled={importing || !active.items.length}
          onClick={() => void reresolveAll()}
        >
          <IconRefresh />
        </button>
        <span className="miura-pl-iconbar-spacer" />
        <button
          type="button"
          className="miura-pl-ico danger"
          title={t.common.remove}
          disabled={importing}
          onClick={() => setDeleteOpen(true)}
        >
          <IconTrash />
        </button>
        {importing && (
          <button
            type="button"
            className="miura-pl-ico"
            title={t.common.cancel}
            onClick={() => {
              cancelRef.current = true;
            }}
          >
            <IconStop />
          </button>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".txt,.csv,.m3u,.m3u8,.tsv,text/plain"
        hidden
        onChange={(e) => {
          onPickTextFile(e.target.files?.[0] || null);
          e.target.value = '';
        }}
      />

      <header className="miura-pl-hero">
        <button
          type="button"
          className="miura-pl-hero-art miura-pl-hero-art-btn"
          title={t.playlists.pickCover}
          disabled={importing}
          onClick={() => void pickCover()}
        >
          {cover ? (
            <img src={cover} alt="" referrerPolicy="no-referrer" />
          ) : (
            <div className="miura-pl-hero-ph">
              <span>♪</span>
              <span className="miura-pl-hero-art-hint">{t.playlists.pickCover}</span>
            </div>
          )}
          <span className="miura-pl-hero-art-overlay" aria-hidden>
            <IconCamera />
          </span>
        </button>
        <div className="miura-pl-hero-text">
          <p className="miura-pl-hero-kicker">{t.nav.playlists}</p>
          {editingField === 'title' ? (
            <input
              ref={titleInputRef}
              className="miura-pl-inline-title"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTitle();
                }
                if (e.key === 'Escape') setEditingField(null);
              }}
            />
          ) : (
            <h1
              className="miura-pl-hero-title miura-pl-editable"
              title={t.playlists.editTitle}
              onClick={startEditTitle}
            >
              {active.title}
            </h1>
          )}
          {editingField === 'description' ? (
            <textarea
              ref={descInputRef}
              className="miura-pl-inline-desc"
              rows={3}
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              onBlur={commitDesc}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingField(null);
              }}
              placeholder={t.playlists.descriptionPlaceholder}
            />
          ) : (
            <p
              className={`miura-pl-hero-desc miura-pl-editable ${active.description ? '' : 'is-empty'}`}
              title={t.playlists.editDescription}
              onClick={startEditDesc}
            >
              {active.description || t.playlists.descriptionPlaceholder}
            </p>
          )}
          {importing ? (
            <p className="miura-pl-hero-meta">
              {progress.done}/{progress.total}…
            </p>
          ) : null}
        </div>
      </header>

      {msg && <p className="note miura-pl-msg">{msg}</p>}

      <div className="miura-pl-tracks-wrap">
        {active.items.length === 0 ? (
          <div className="miura-pl-empty" style={{ marginTop: 24 }}>
            <p className="note">{t.playlists.noTracksYet}</p>
            <button
              type="button"
              className="btn solid"
              style={{ marginTop: 12 }}
              disabled={importing}
              onClick={() => void addOwnTracks()}
            >
              {t.playlists.addOwnTracks}
            </button>
          </div>
        ) : (
          <VirtualList
            className="miura-pl-tracks miura-pl-virtual miura-pl-vlist"
            items={active.items}
            rowHeight={60}
            maxHeight={640}
            overscan={10}
            getKey={(it) => it.id}
            renderRow={(it, i) => (
              <PlaylistTrackRow
                it={it}
                index={i}
                activeRow={isItemActive(it)}
                isPlayingNow={isPlayingNow}
                importing={importing}
                searchingLabel={t.playlists.searching}
                pendingLabel={t.playlists.pending}
                notFoundLabel={t.playlists.notFound}
                errorLabel={t.playlists.error}
                removeTitle={t.common.remove}
                onPlay={() => playItem(it, active.items)}
                onRemove={() => {
                  removeItem(active.id, it.id);
                  refresh();
                }}
              />
            )}
          />
        )}
      </div>

      {importOpen && (
        <ImportModal
          t={t}
          text={importText}
          setText={setImportText}
          title={importTitle}
          setTitle={setImportTitle}
          sources={sources}
          setSources={setSources}
          busy={importing}
          onClose={() => !importing && setImportOpen(false)}
          onStart={() => void runImport()}
          onPickFile={() => fileRef.current?.click()}
          addMode
        />
      )}

      {deleteOpen && active && (
        <ConfirmModal
          title={t.common.remove}
          message={
            <>
              {t.playlists.deleteConfirm.includes('{title}') ? (
                <>
                  {t.playlists.deleteConfirm.split('{title}')[0].replace(/[«“]\s*$/, '')}
                  <strong>«{active.title}»</strong>
                  {(t.playlists.deleteConfirm.split('{title}')[1] || '').replace(/^\s*[»”]/, '')}
                </>
              ) : (
                t.playlists.deleteConfirm
              )}
            </>
          }
          confirmLabel={t.common.remove}
          cancelLabel={t.common.cancel}
          onClose={() => setDeleteOpen(false)}
          onConfirm={() => {
            deletePlaylist(active.id);
            setDeleteOpen(false);
            selectPlaylist(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

const PlaylistTrackRow = React.memo(function PlaylistTrackRow({
  it,
  index,
  activeRow,
  isPlayingNow,
  importing,
  searchingLabel,
  pendingLabel,
  notFoundLabel,
  errorLabel,
  removeTitle,
  onPlay,
  onRemove,
}: {
  it: MiuraPlaylistItem;
  index: number;
  activeRow: boolean;
  isPlayingNow: boolean;
  importing: boolean;
  searchingLabel: string;
  pendingLabel: string;
  notFoundLabel: string;
  errorLabel: string;
  removeTitle: string;
  onPlay: () => void;
  onRemove: () => void;
}) {
  const src = itemSource(it);
  const title = it.title || it.query;
  const art =
    it.artworkUrl ||
    (it.playable?.artworkUrl && /^https?:\/\//i.test(it.playable.artworkUrl)
      ? it.playable.artworkUrl
      : '') ||
    '';

  return (
    <div
      className={`cat-row track-row-compact miura-pl-row${activeRow ? ' playing' : ''}${activeRow && isPlayingNow ? ' is-now' : ''}`}
      style={{ opacity: it.status === 'found' || activeRow ? 1 : 0.65, height: '100%' }}
    >
      <button type="button" className="idx" disabled={it.status !== 'found'} onClick={onPlay}>
        {it.status === 'searching' || it.status === 'pending' ? (
          <span className="idx-load" />
        ) : activeRow && isPlayingNow ? (
          <span className="idx-eq" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        ) : (
          <>
            <span className="idx-num">{index + 1}</span>
            <span className="idx-play hover-only" aria-hidden>
              ▶
            </span>
          </>
        )}
      </button>
      <div className="miura-pl-art">
        {art ? (
          <img
            className="cat-art"
            src={art}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : (
          <div className="cat-art ph">♪</div>
        )}
      </div>
      <button
        type="button"
        className="cat-main"
        disabled={it.status !== 'found'}
        onClick={onPlay}
        title={title}
      >
        <span className="miura-pl-title-row">
          <span className="cat-title miura-pl-title">{title}</span>
          {src ? <SourceBadge source={src} /> : null}
        </span>
        <span className="cat-sub">
          {it.status === 'found'
            ? `${it.artist || '—'} · ${
                src === 'local'
                  ? 'Local'
                  : src === 'soundcloud'
                    ? 'SoundCloud'
                    : src || ''
              }${activeRow ? (isPlayingNow ? ' · ▶' : ' · ⏸') : ''}`
            : it.status === 'searching'
              ? searchingLabel
              : it.status === 'pending'
                ? pendingLabel
                : it.status === 'not_found'
                  ? notFoundLabel
                  : it.error || errorLabel}
        </span>
      </button>
      <button
        type="button"
        className="op ico-btn"
        title={removeTitle}
        disabled={importing}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
});

const ico = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function IconBack() {
  return (
    <svg {...ico} aria-hidden>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function IconPlay() {
  return (
    <svg {...ico} aria-hidden>
      <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg {...ico} aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function IconFile() {
  return (
    <svg {...ico} aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg {...ico} aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.6-6.3" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg {...ico} aria-hidden>
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </svg>
  );
}
function IconStop() {
  return (
    <svg {...ico} aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconCamera() {
  return (
    <svg {...ico} width={20} height={20} aria-hidden>
      <path d="M4 8h3l2-2h6l2 2h3v10H4z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

function SimpleModal({
  title,
  children,
  footer,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="banner-editor-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="banner-editor-card miura-pl-modal"
        style={{ width: 'min(480px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        <div className="miura-pl-modal-body">{children}</div>
        <div className="banner-editor-actions">{footer}</div>
      </div>
    </div>
  );
}

function ImportModal({
  t,
  text,
  setText,
  title,
  setTitle,
  sources,
  setSources,
  busy,
  onClose,
  onStart,
  onPickFile,
  addMode,
}: {
  t: ReturnType<typeof useT>;
  text: string;
  setText: (v: string) => void;
  title: string;
  setTitle: (v: string) => void;
  sources: Record<ImportSource, boolean>;
  setSources: React.Dispatch<React.SetStateAction<Record<ImportSource, boolean>>>;
  busy: boolean;
  onClose: () => void;
  onStart: () => void;
  onPickFile: () => void;
  addMode?: boolean;
}) {
  const preview = parseTrackListText(text).length;
  return (
    <div className="banner-editor-overlay" role="dialog" aria-modal="true">
      <div className="banner-editor-card miura-pl-modal" style={{ width: 'min(640px, 100%)' }}>
        <h2>{addMode ? t.playlists.addFromText : t.playlists.importFromText}</h2>
        <p className="banner-editor-hint">{t.playlists.importHint}</p>

        {!addMode && (
          <>
            <label className="settings-field-label">{t.playlists.name}</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t.playlists.defaultName}
              disabled={busy}
            />
          </>
        )}

        <div className="row-btns" style={{ marginTop: 10, marginBottom: 8 }}>
          <button type="button" className="btn" disabled={busy} onClick={onPickFile}>
            {t.playlists.loadFromFile}
          </button>
        </div>

        <label className="settings-field-label" style={{ marginTop: 8 }}>
          {t.playlists.listLabel}
        </label>
        <textarea
          className="miura-profile-textarea"
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Artist - Title\nArtist - Title\n...'}
          disabled={busy}
          style={{ fontFamily: 'var(--mono)', fontSize: '0.85rem' }}
        />
        <p className="note">
          {preview
            ? t.playlists.linesDetected.replace('{n}', String(preview))
            : t.playlists.importEmpty}
        </p>

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '10px 0 14px' }}>
          {(['local', 'soundcloud'] as ImportSource[]).map((s) => (
            <label key={s} className="settings-check">
              <input
                type="checkbox"
                checked={sources[s]}
                disabled={busy}
                onChange={(e) => setSources((prev) => ({ ...prev, [s]: e.target.checked }))}
              />
              <span>{s === 'local' ? t.sources.local : t.sources.soundcloud}</span>
            </label>
          ))}
        </div>

        <div className="banner-editor-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="btn solid"
            disabled={busy || preview === 0}
            onClick={onStart}
          >
            {busy ? t.common.loading : t.playlists.startImport}
          </button>
        </div>
      </div>
    </div>
  );
}
