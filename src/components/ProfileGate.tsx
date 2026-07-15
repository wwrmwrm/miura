import React, { useState } from 'react';
import { MiuraMark } from './MiuraLogo';
import { useT } from '../i18n';
import {
  createProfile,
  pickProfileAvatar,
  profileInitials,
  switchProfile,
  type MiuraProfile,
  type MiuraProfileState,
} from '../lib/miuraProfile';

type Props = {
  profiles: MiuraProfile[];
  onReady: (state: MiuraProfileState) => void;
};

export function ProfileGate({ profiles, onReady }: Props) {
  const t = useT();
  const [mode, setMode] = useState<'pick' | 'create'>(profiles.length ? 'pick' : 'create');
  const [name, setName] = useState('');
  const [avatarPath, setAvatarPath] = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickAvatar = async () => {
    setError(null);
    try {
      const res = await pickProfileAvatar();
      if (res.canceled) return;
      if (res.error) {
        setError(res.error);
        return;
      }
      setAvatarPath(res.path || null);
      setAvatarPreview(res.dataUrl || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const displayName = name.trim();
    if (!displayName) {
      setError(t.profile.nameRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const state = await createProfile({
        displayName,
        avatarPath,
        avatarUrl: avatarPreview,
      });
      onReady(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onPick = async (p: MiuraProfile) => {
    setBusy(true);
    setError(null);
    try {
      const state = await switchProfile(p.id);
      onReady(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="profile-gate">
      <div className="profile-gate-card">
        <div className="profile-gate-brand">
          <MiuraMark />
          <div>
            <h1>{t.profile.welcome}</h1>
            <p>{t.profile.welcomeLead}</p>
          </div>
        </div>

        {mode === 'pick' && profiles.length > 0 ? (
          <>
            <h2 className="profile-gate-h2">{t.profile.whoAreYou}</h2>
            <div className="profile-gate-list">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="profile-gate-item"
                  disabled={busy}
                  onClick={() => void onPick(p)}
                >
                  {p.avatarUrl ? (
                    <img className="profile-gate-av" src={p.avatarUrl} alt="" />
                  ) : (
                    <div className="profile-gate-av ph">{profileInitials(p.displayName)}</div>
                  )}
                  <span className="profile-gate-item-name">{p.displayName}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn"
              style={{ width: '100%', marginTop: 16 }}
              disabled={busy}
              onClick={() => {
                setMode('create');
                setName('');
                setAvatarPath(null);
                setAvatarPreview(null);
                setError(null);
              }}
            >
              {t.profile.createNew}
            </button>
          </>
        ) : (
          <form className="profile-gate-form" onSubmit={(e) => void onCreate(e)}>
            <h2 className="profile-gate-h2">{t.profile.createTitle}</h2>
            <p className="profile-gate-hint">{t.profile.createHint}</p>

            <div className="profile-gate-avatar-row">
              <button type="button" className="profile-gate-av-btn" onClick={() => void pickAvatar()} disabled={busy}>
                {avatarPreview ? (
                  <img className="profile-gate-av lg" src={avatarPreview} alt="" />
                ) : (
                  <div className="profile-gate-av lg ph">
                    {name.trim() ? profileInitials(name) : '+'}
                  </div>
                )}
              </button>
              <div>
                <button type="button" className="btn" onClick={() => void pickAvatar()} disabled={busy}>
                  {t.profile.pickAvatar}
                </button>
                {avatarPreview && (
                  <button
                    type="button"
                    className="btn"
                    style={{ marginLeft: 8 }}
                    disabled={busy}
                    onClick={() => {
                      setAvatarPath(null);
                      setAvatarPreview(null);
                    }}
                  >
                    {t.common.remove}
                  </button>
                )}
              </div>
            </div>

            <label className="profile-gate-label" htmlFor="miura-profile-name">
              {t.profile.name}
            </label>
            <input
              id="miura-profile-name"
              className="profile-gate-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.profile.namePlaceholder}
              maxLength={48}
              autoFocus
              disabled={busy}
            />

            {error && <p className="profile-gate-error">{error}</p>}

            <div className="profile-gate-actions">
              <button type="submit" className="btn solid" disabled={busy || !name.trim()}>
                {busy ? t.common.loading : t.profile.enter}
              </button>
              {profiles.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setMode('pick');
                    setError(null);
                  }}
                >
                  {t.profile.backToList}
                </button>
              )}
            </div>
          </form>
        )}

        {error && mode === 'pick' && <p className="profile-gate-error">{error}</p>}
      </div>
    </div>
  );
}
