import React, { useEffect, useState } from 'react';
import { useI18n, useT } from '../i18n';
import { BannerPositionEditor } from '../components/BannerPositionEditor';
import {
  deleteProfile,
  formatProfileDate,
  logoutProfile,
  pickProfileAvatar,
  pickProfileBanner,
  profileInitials,
  switchProfile,
  updateProfile,
  type MiuraProfile,
  type MiuraProfileState,
} from '../lib/miuraProfile';
import { loadLocalLibrary } from '../sources/localLibrary';
import type { FavItem } from '../lib/miuraFavorites';
import type { RecentItem } from '../lib/recent';

type ProfileTab = 'about' | 'favorites' | 'profiles';

type Props = {
  profile: MiuraProfile;
  profiles: MiuraProfile[];
  favorites: FavItem[];
  recent: RecentItem[];
  scConnected: boolean;
  scUsername?: string | null;
  onProfileState: (s: MiuraProfileState) => void;
  onOpenSettings: () => void;
  onOpenLocal: () => void;
  onOpenFavorites: () => void;
  onPlayFavorite?: (f: FavItem) => void;
  onToggleFavorite?: (f: FavItem) => void;
  onAccentChange?: (hex: string | null) => void;
};

export function ProfilePage({
  profile,
  profiles,
  favorites,
  recent,
  scConnected,
  scUsername,
  onProfileState,
  onOpenSettings,
  onOpenLocal,
  onOpenFavorites,
  onPlayFavorite,
  onToggleFavorite,
  onAccentChange,
}: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [tab, setTab] = useState<ProfileTab>('about');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio || '');
  const [accent, setAccent] = useState(profile.accent || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [localCount, setLocalCount] = useState(0);
  /** Pending new banner image before position is confirmed */
  const [bannerDraft, setBannerDraft] = useState<{
    path?: string | null;
    url: string;
    posX: number;
    posY: number;
  } | null>(null);

  const bannerPosX = profile.bannerPosX ?? 50;
  const bannerPosY = profile.bannerPosY ?? 50;

  useEffect(() => {
    setName(profile.displayName);
    setBio(profile.bio || '');
    setAccent(profile.accent || '');
    setEditing(false);
    setMsg(null);
  }, [profile.id, profile.displayName, profile.bio, profile.accent]);

  useEffect(() => {
    setLocalCount(loadLocalLibrary().length);
  }, [profile.id]);

  const localeTag =
    locale === 'en'
      ? 'en-US'
      : locale === 'de'
        ? 'de-DE'
        : locale === 'es'
          ? 'es-ES'
          : locale === 'fr'
            ? 'fr-FR'
            : locale === 'it'
              ? 'it-IT'
              : locale === 'nl'
                ? 'nl-NL'
                : locale === 'pl'
                  ? 'pl-PL'
                  : locale === 'pt'
                    ? 'pt-PT'
                    : locale === 'sv'
                      ? 'sv-SE'
                      : 'ru-RU';

  const save = async () => {
    const displayName = name.trim();
    if (!displayName) {
      setMsg(t.profile.nameRequired);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const state = await updateProfile({
        id: profile.id,
        displayName,
        bio: bio.trim().slice(0, 160),
        accent: accent.trim() || null,
      });
      onProfileState(state);
      onAccentChange?.(accent.trim() || null);
      setEditing(false);
      setMsg(t.profile.saved);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changeAvatar = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const picked = await pickProfileAvatar();
      if (picked.canceled || !picked.path) return;
      const state = await updateProfile({ id: profile.id, avatarPath: picked.path });
      onProfileState(state);
      setMsg(t.profile.saved);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changeBanner = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const picked = await pickProfileBanner();
      if (picked.canceled || !picked.path) return;
      const url = picked.dataUrl || '';
      if (!url && !picked.path) return;
      // Open reposition UI first (path saved on confirm)
      setBannerDraft({
        path: picked.path,
        url: url || `file:///${picked.path.replace(/\\/g, '/')}`,
        posX: 50,
        posY: 50,
      });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openReposition = () => {
    if (!profile.bannerUrl) return;
    setBannerDraft({
      path: null,
      url: profile.bannerUrl,
      posX: bannerPosX,
      posY: bannerPosY,
    });
  };

  const saveBannerDraft = async (pos: { x: number; y: number }) => {
    if (!bannerDraft) return;
    setBusy(true);
    setMsg(null);
    try {
      const state = await updateProfile({
        id: profile.id,
        bannerPath: bannerDraft.path || undefined,
        bannerPosX: pos.x,
        bannerPosY: pos.y,
      });
      onProfileState(state);
      setBannerDraft(null);
      setMsg(t.profile.saved);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearBanner = async () => {
    setBusy(true);
    try {
      const state = await updateProfile({ id: profile.id, clearBanner: true });
      onProfileState(state);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sc-profile">
      {bannerDraft && (
        <BannerPositionEditor
          imageUrl={bannerDraft.url}
          posX={bannerDraft.posX}
          posY={bannerDraft.posY}
          onCancel={() => setBannerDraft(null)}
          onSave={(pos) => void saveBannerDraft(pos)}
        />
      )}

      {/* SoundCloud-style banner header */}
      <div
        className={`sc-profile-banner ${profile.bannerUrl ? 'has-img' : ''}`}
        style={
          profile.bannerUrl
            ? {
                backgroundImage: `url(${profile.bannerUrl})`,
                backgroundPosition: `${bannerPosX}% ${bannerPosY}%`,
              }
            : profile.accent
              ? {
                  background: `linear-gradient(120deg, ${profile.accent} 0%, color-mix(in srgb, ${profile.accent} 40%, #1a1a1a) 100%)`,
                }
              : undefined
        }
      >
        <div className="sc-profile-banner-shade" />
        <div className="sc-profile-banner-actions">
          <button type="button" className="btn sc-profile-banner-btn" disabled={busy} onClick={() => void changeBanner()}>
            {t.profile.pickBanner}
          </button>
          {profile.bannerUrl && (
            <button type="button" className="btn sc-profile-banner-btn" disabled={busy} onClick={openReposition}>
              {t.profile.repositionBanner}
            </button>
          )}
          {profile.bannerUrl && (
            <button type="button" className="btn sc-profile-banner-btn" disabled={busy} onClick={() => void clearBanner()}>
              {t.profile.clearBanner}
            </button>
          )}
        </div>

        <div className="sc-profile-banner-body">
          <button
            type="button"
            className="sc-profile-av-btn"
            onClick={() => void changeAvatar()}
            disabled={busy}
            title={t.profile.pickAvatar}
          >
            {profile.avatarUrl ? (
              <img className="sc-profile-av" src={profile.avatarUrl} alt="" />
            ) : (
              <div className="sc-profile-av ph">{profileInitials(profile.displayName)}</div>
            )}
          </button>
          <div className="sc-profile-identity">
            <p className="sc-profile-badge">{t.profile.localOnly}</p>
            <h1>{profile.displayName}</h1>
            {profile.bio ? <p className="sc-profile-bio">{profile.bio}</p> : null}
            <p className="sc-profile-meta">
              {t.profile.memberSince} {formatProfileDate(profile.createdAt, localeTag)}
            </p>
          </div>
        </div>
      </div>

      {/* Stats strip like SC */}
      <div className="sc-profile-stats-bar">
        <button type="button" className="sc-profile-stat" onClick={() => setTab('favorites')}>
          <strong>{favorites.length}</strong>
          <span>{t.profile.statFavs}</span>
        </button>
        <button type="button" className="sc-profile-stat" onClick={onOpenLocal}>
          <strong>{localCount}</strong>
          <span>{t.profile.statLocal}</span>
        </button>
        <div className="sc-profile-stat static">
          <strong>{recent.length}</strong>
          <span>{t.profile.statRecent}</span>
        </div>
        <div className="sc-profile-stat-actions">
          <button type="button" className="btn solid" onClick={() => setEditing((v) => !v)} disabled={busy}>
            {editing ? t.common.cancel : t.profile.edit}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              void (async () => {
                setBusy(true);
                try {
                  onProfileState(await logoutProfile());
                } catch (e) {
                  setMsg(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {t.profile.switch}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <nav className="sc-profile-tabs" aria-label={t.profile.pageTitle}>
        {(
          [
            { id: 'about' as const, label: t.profile.tabAbout },
            { id: 'favorites' as const, label: `${t.profile.statFavs}${favorites.length ? ` · ${favorites.length}` : ''}` },
            { id: 'profiles' as const, label: t.profile.otherProfiles },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            className={`sc-profile-tab ${tab === item.id ? 'on' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {editing && (
        <section className="settings-card sc-profile-edit">
          <h2>{t.profile.edit}</h2>
          <label className="settings-field-label" htmlFor="pf-name">
            {t.profile.name}
          </label>
          <input id="pf-name" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} disabled={busy} />
          <label className="settings-field-label" htmlFor="pf-bio">
            {t.profile.bio}
          </label>
          <textarea
            id="pf-bio"
            className="miura-profile-textarea"
            value={bio}
            maxLength={160}
            rows={3}
            placeholder={t.profile.bioPlaceholder}
            onChange={(e) => setBio(e.target.value)}
            disabled={busy}
          />
          <p className="note">{bio.length}/160</p>
          <label className="settings-field-label" htmlFor="pf-accent">
            {t.profile.accent}
          </label>
          <div className="miura-profile-accent-row">
            <input
              id="pf-accent"
              type="color"
              value={accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#c23a2b'}
              onChange={(e) => setAccent(e.target.value)}
              disabled={busy}
            />
            <button type="button" className="btn" disabled={busy} onClick={() => setAccent('')}>
              {t.profile.accentDefault}
            </button>
          </div>
          <div className="row-btns" style={{ marginTop: 14 }}>
            <button type="button" className="btn solid" disabled={busy || !name.trim()} onClick={() => void save()}>
              {t.profile.save}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void changeBanner()}>
              {t.profile.pickBanner}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void changeAvatar()}>
              {t.profile.pickAvatar}
            </button>
          </div>
        </section>
      )}

      {msg && <p className="note miura-profile-msg">{msg}</p>}

      {tab === 'about' && (
        <section className="sc-profile-panel">
          <div className="settings-card">
            <h2>{t.profile.connected}</h2>
            <p className="settings-desc">{t.profile.connectedHint}</p>
            <ul className="miura-service-list">
              <li className={scConnected ? 'on' : ''}>
                <span className="miura-service-name">SoundCloud</span>
                <span className="miura-service-status">
                  {scConnected ? scUsername || t.profile.connectedOn : t.profile.connectedOff}
                </span>
                <button type="button" className="btn" onClick={onOpenSettings}>
                  {scConnected ? t.common.open : t.settings.signInBtn}
                </button>
              </li>
              <li>
                <span className="miura-service-name">YouTube</span>
                <span className="miura-service-status">{t.profile.noLoginNeeded}</span>
              </li>
            </ul>
          </div>
          <div className="settings-card miura-profile-danger">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(t.profile.deleteConfirm)) return;
                void (async () => {
                  setBusy(true);
                  try {
                    onProfileState(await deleteProfile(profile.id));
                  } catch (e) {
                    setMsg(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {t.profile.delete}
            </button>
          </div>
        </section>
      )}

      {tab === 'favorites' && (
        <section className="sc-profile-panel">
          <div className="chapter-h" style={{ marginBottom: 10 }}>
            <h2>{t.profile.statFavs}</h2>
            {favorites.length > 0 && (
              <button type="button" className="linkish" onClick={onOpenFavorites}>
                {t.common.seeAll}
              </button>
            )}
          </div>
          {favorites.length === 0 ? (
            <p className="note">{t.profile.favsEmpty}</p>
          ) : (
            <div className="cat track-list-compact">
              {favorites.map((f, i) => (
                <div key={f.id} className="cat-row track-row-compact">
                  <button
                    type="button"
                    className="idx"
                    onClick={() => onPlayFavorite?.(f)}
                    title={t.common.play}
                  >
                    <span className="idx-num">{i + 1}</span>
                    <span className="idx-play hover-only" aria-hidden>
                      ▶
                    </span>
                  </button>
                  <button type="button" className="cat-art-wrap" onClick={() => onPlayFavorite?.(f)}>
                    {f.artworkUrl ? (
                      <img className="cat-art" src={f.artworkUrl} alt="" loading="lazy" />
                    ) : (
                      <div className="cat-art ph">♪</div>
                    )}
                  </button>
                  <button type="button" className="cat-main" onClick={() => onPlayFavorite?.(f)}>
                    <span className="cat-title">{f.title}</span>
                    <span className="cat-sub">
                      {f.artist}
                      {f.source ? ` · ${f.source}` : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="op ico-btn hot"
                    title={t.common.remove}
                    onClick={() => onToggleFavorite?.(f)}
                  >
                    ★
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'profiles' && (
        <section className="sc-profile-panel">
          <div className="profile-gate-list">
            {profiles
              .filter((p) => p.id !== profile.id)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="profile-gate-item"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      setBusy(true);
                      try {
                        onProfileState(await switchProfile(p.id));
                      } catch (e) {
                        setMsg(e instanceof Error ? e.message : String(e));
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}
                >
                  {p.avatarUrl ? (
                    <img className="profile-gate-av" src={p.avatarUrl} alt="" />
                  ) : (
                    <div className="profile-gate-av ph">{profileInitials(p.displayName)}</div>
                  )}
                  <span className="profile-gate-item-name">{p.displayName}</span>
                </button>
              ))}
            {profiles.length <= 1 && <p className="note">{t.profile.noOtherProfiles}</p>}
          </div>
        </section>
      )}
    </div>
  );
}
