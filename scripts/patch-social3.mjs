import fs from 'fs';

const p = 'src/api/soundcloud.ts';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('/* ---------- Social actions (api-v2 + browser OAuth token) ---------- */');
const end = s.indexOf('/* ---------- Utils ---------- */');
if (start < 0 || end < 0) {
  console.error('markers', start, end);
  process.exit(1);
}

const replacement = `/* ---------- Social actions (api-v2, browser OAuth) ---------- */
/*
 * Real web client uses:
 *   PUT /users/{uid}/track_likes/{trackId}?client_id=...
 *   PUT /reposts/tracks/{trackId}?client_id=...
 * with Authorization: OAuth <browser token>
 * Writes go through Electron api-fetch (page context on soundcloud.com).
 */

function cleanToken(): string {
  return (accessToken || '').replace(/^OAuth\\s+/i, '').trim();
}

function socialHeaders(kind: 'auth' | 'query' = 'auth'): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
  };
  if (kind === 'auth') {
    h.Authorization = \`OAuth \${cleanToken()}\`;
  }
  return h;
}

function isWriteSuccess(status: number) {
  return status === 200 || status === 201 || status === 204 || status === 409 || status === 422;
}

async function ensureMeIdForLikes(): Promise<number> {
  await ensureAccessToken();
  try {
    const me = await getMe();
    if (me?.id) {
      meUserId = me.id;
      return me.id;
    }
  } catch (e) {
    if (meUserId) return meUserId;
    throw new Error('Сессия недействительна — войди снова (Настройки → войти)');
  }
  throw new Error('Не удалось определить аккаунт — войди снова');
}

type WriteMode = {
  /** auth = Authorization header; query = oauth_token in URL only */
  auth: 'auth' | 'query';
  /** none = no body; empty = ""; json = "{}" */
  body: 'none' | 'empty' | 'json';
  withClientId: boolean;
};

async function scWrite(
  url: string,
  method: 'PUT' | 'POST' | 'DELETE' | 'GET',
  mode: WriteMode
): Promise<{ status: number; body: string }> {
  let finalUrl = url;
  const token = cleanToken();
  if (mode.withClientId) {
    const cid = await ensureClientId();
    const sep = finalUrl.includes('?') ? '&' : '?';
    finalUrl += \`\${sep}client_id=\${encodeURIComponent(cid)}\`;
  }
  if (mode.auth === 'query' && token) {
    const sep = finalUrl.includes('?') ? '&' : '?';
    finalUrl += \`\${sep}oauth_token=\${encodeURIComponent(token)}\`;
  }

  const headers = socialHeaders(mode.auth);
  let body: string | null | undefined = undefined;
  if (mode.body === 'empty') {
    body = '';
  } else if (mode.body === 'json') {
    headers['Content-Type'] = 'application/json';
    body = '{}';
  }

  if (window.electronAPI?.apiFetch) {
    const r = await window.electronAPI.apiFetch({
      url: finalUrl,
      method,
      headers,
      body: body === undefined ? null : body,
    });
    return { status: r.status, body: r.body || '' };
  }

  const res = await fetch(finalUrl, {
    method,
    headers,
    body: body === undefined ? undefined : body,
  });
  return { status: res.status, body: await res.text().catch(() => '') };
}

type Attempt = {
  method: 'PUT' | 'POST' | 'DELETE';
  path: string; // path only, starting with /
  modes?: WriteMode[];
};

const DEFAULT_MODES: WriteMode[] = [
  // Match browser as closely as possible first
  { auth: 'auth', body: 'none', withClientId: true },
  { auth: 'auth', body: 'empty', withClientId: true },
  { auth: 'auth', body: 'json', withClientId: true },
  { auth: 'auth', body: 'none', withClientId: false },
  { auth: 'query', body: 'none', withClientId: true },
  { auth: 'query', body: 'empty', withClientId: true },
];

async function tryWrite(attempts: Attempt[], label: string): Promise<void> {
  await ensureAccessToken();
  const log: string[] = [];

  for (const a of attempts) {
    const modes = a.modes || DEFAULT_MODES;
    for (const mode of modes) {
      const url = \`\${API}\${a.path}\`;
      try {
        const r = await scWrite(url, a.method, mode);
        const tag = \`\${a.method} \${a.path} [\${mode.auth}/\${mode.body}/cid=\${mode.withClientId}] → \${r.status}\`;
        log.push(tag);
        if (isWriteSuccess(r.status)) {
          console.info('[social ok]', label, tag);
          return;
        }
      } catch (e) {
        log.push(\`\${a.method} \${a.path} err: \${e instanceof Error ? e.message : 'x'}\`);
      }
    }
  }

  console.warn('[social fail]', label, log.join(' | '));
  const authAll = log.length > 0 && log.every((x) => /→ 401|→ 403/.test(x));
  if (authAll) {
    throw new Error(
      'Нет прав на действие (403/401). Токен, возможно, только на чтение — скопируй Authorization с запроса like/repost в Network на soundcloud.com'
    );
  }
  // Prefer showing first non-404 if any
  const interesting = log.find((x) => /→ 403|→ 401|→ 429/.test(x)) || log[0] || '';
  const code = interesting.match(/→ (\\d+)/)?.[1] || 'сеть';
  throw new Error(\`\${label} (HTTP \${code}). \${log.slice(0, 2).join('; ')}\`);
}

export async function likeTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  if (!Number.isFinite(id)) throw new Error('Некорректный id трека');
  const uid = await ensureMeIdForLikes();
  const urn = encodeURIComponent(\`soundcloud:tracks:\${id}\`);
  const uurn = encodeURIComponent(\`soundcloud:users:\${uid}\`);

  await tryWrite(
    [
      // Canonical web path (got 403 before — retry with body/header variants)
      { method: 'PUT', path: \`/users/\${uid}/track_likes/\${id}\` },
      { method: 'PUT', path: \`/users/\${uid}/likes/tracks/\${id}\` },
      { method: 'POST', path: \`/users/\${uid}/track_likes/\${id}\` },
      { method: 'PUT', path: \`/me/track_likes/\${id}\` },
      { method: 'PUT', path: \`/users/\${uurn}/track_likes/\${urn}\` },
      { method: 'PUT', path: \`/likes/tracks/\${id}\` },
      { method: 'PUT', path: \`/likes/tracks/\${urn}\` },
      { method: 'POST', path: \`/likes/tracks/\${id}\` },
    ],
    'Не удалось лайкнуть'
  );
}

export async function unlikeTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  const uid = await ensureMeIdForLikes();
  const urn = encodeURIComponent(\`soundcloud:tracks:\${id}\`);

  await tryWrite(
    [
      { method: 'DELETE', path: \`/users/\${uid}/track_likes/\${id}\` },
      { method: 'DELETE', path: \`/users/\${uid}/likes/tracks/\${id}\` },
      { method: 'DELETE', path: \`/me/track_likes/\${id}\` },
      { method: 'DELETE', path: \`/likes/tracks/\${id}\` },
      { method: 'DELETE', path: \`/likes/tracks/\${urn}\` },
    ],
    'Не удалось убрать лайк'
  );
}

export async function followUser(userId: number): Promise<void> {
  const target = Number(userId);
  const uid = await ensureMeIdForLikes();
  await tryWrite(
    [
      { method: 'PUT', path: \`/users/\${uid}/followings/\${target}\` },
      { method: 'PUT', path: \`/me/followings/\${target}\` },
      { method: 'POST', path: \`/users/\${uid}/followings/\${target}\` },
    ],
    'Не удалось подписаться'
  );
}

export async function unfollowUser(userId: number): Promise<void> {
  const target = Number(userId);
  const uid = await ensureMeIdForLikes();
  await tryWrite(
    [
      { method: 'DELETE', path: \`/users/\${uid}/followings/\${target}\` },
      { method: 'DELETE', path: \`/me/followings/\${target}\` },
    ],
    'Не удалось отписаться'
  );
}

export async function isFollowing(userId: number): Promise<boolean> {
  try {
    const target = Number(userId);
    const uid = await ensureMeIdForLikes();
    const r = await scWrite(\`\${API}/users/\${uid}/followings/\${target}\`, 'GET', {
      auth: 'auth',
      body: 'none',
      withClientId: true,
    });
    if (r.status >= 200 && r.status < 300) return true;
    if (r.status === 404) return false;
    return false;
  } catch {
    return false;
  }
}

export async function repostTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  const uid = await ensureMeIdForLikes();
  const urn = encodeURIComponent(\`soundcloud:tracks:\${id}\`);

  await tryWrite(
    [
      { method: 'PUT', path: \`/reposts/tracks/\${id}\` },
      { method: 'POST', path: \`/reposts/tracks/\${id}\` },
      { method: 'PUT', path: \`/users/\${uid}/reposts/tracks/\${id}\` },
      { method: 'POST', path: \`/users/\${uid}/reposts/tracks/\${id}\` },
      { method: 'PUT', path: \`/me/track_reposts/\${id}\` },
      { method: 'PUT', path: \`/users/\${uid}/track_reposts/\${id}\` },
      { method: 'PUT', path: \`/reposts/tracks/\${urn}\` },
    ],
    'Не удалось сделать репост'
  );
}

export async function unrepostTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  const uid = await ensureMeIdForLikes();
  const urn = encodeURIComponent(\`soundcloud:tracks:\${id}\`);

  await tryWrite(
    [
      { method: 'DELETE', path: \`/reposts/tracks/\${id}\` },
      { method: 'DELETE', path: \`/users/\${uid}/reposts/tracks/\${id}\` },
      { method: 'DELETE', path: \`/me/track_reposts/\${id}\` },
      { method: 'DELETE', path: \`/reposts/tracks/\${urn}\` },
    ],
    'Не удалось убрать репост'
  );
}

export async function likePlaylist(playlistId: number | string): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const enc = encodeURIComponent(String(playlistId));
  await tryWrite(
    [
      { method: 'PUT', path: \`/users/\${uid}/playlist_likes/\${enc}\` },
      { method: 'PUT', path: \`/users/\${uid}/likes/playlists/\${enc}\` },
      { method: 'POST', path: \`/likes/playlists/\${enc}\` },
      { method: 'PUT', path: \`/likes/playlists/\${enc}\` },
    ],
    'Не удалось лайкнуть плейлист'
  );
}

export async function unlikePlaylist(playlistId: number | string): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const enc = encodeURIComponent(String(playlistId));
  await tryWrite(
    [
      { method: 'DELETE', path: \`/users/\${uid}/playlist_likes/\${enc}\` },
      { method: 'DELETE', path: \`/users/\${uid}/likes/playlists/\${enc}\` },
      { method: 'DELETE', path: \`/likes/playlists/\${enc}\` },
    ],
    'Не удалось убрать лайк плейлиста'
  );
}

`;

s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(p, s);
console.log('social v3 patched');
