import fs from 'fs';

const p = 'src/api/soundcloud.ts';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('/* ---------- Social actions ---------- */');
const end = s.indexOf('/* ---------- Utils ---------- */');
if (start < 0 || end < 0) {
  console.error('markers', start, end);
  process.exit(1);
}

const replacement = `/* ---------- Social actions (Electron net + public API) ---------- */

const API_PUBLIC = 'https://api.soundcloud.com';

function socialHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: 'application/json; charset=utf-8',
    Authorization: \`OAuth \${accessToken}\`,
    Origin: 'https://soundcloud.com',
    Referer: 'https://soundcloud.com/',
    ...extra,
  };
}

function isWriteSuccess(status: number) {
  return status === 200 || status === 201 || status === 204 || status === 409 || status === 422;
}

async function ensureMeIdForLikes(): Promise<number> {
  await ensureAccessToken();
  if (meUserId) return meUserId;
  try {
    const me = await getMe();
    if (me?.id) return me.id;
  } catch {
    /* fall through */
  }
  throw new Error('Не удалось определить аккаунт — войди снова');
}

/** Prefer Electron main fetch (proxy + no CORS). */
async function scWrite(
  url: string,
  method: 'PUT' | 'POST' | 'DELETE' | 'GET',
  opts?: { jsonBody?: unknown }
): Promise<{ status: number; body: string }> {
  const headers = socialHeaders(
    opts?.jsonBody !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined
  );
  const body = opts?.jsonBody !== undefined ? JSON.stringify(opts.jsonBody) : undefined;

  if (window.electronAPI?.apiFetch) {
    const r = await window.electronAPI.apiFetch({ url, method, headers, body });
    return { status: r.status, body: r.body || '' };
  }

  const res = await fetch(url, { method, headers, body });
  const text = await res.text().catch(() => '');
  return { status: res.status, body: text };
}

async function tryWrite(
  attempts: Array<{ method: 'PUT' | 'POST' | 'DELETE' | 'GET'; url: string; jsonBody?: unknown }>,
  label: string
): Promise<void> {
  await ensureAccessToken();
  let lastStatus = 0;
  let lastBody = '';
  for (const a of attempts) {
    try {
      const r = await scWrite(a.url, a.method, { jsonBody: a.jsonBody });
      lastStatus = r.status;
      lastBody = r.body.slice(0, 180);
      if (isWriteSuccess(r.status) || (a.method === 'GET' && r.status >= 200 && r.status < 300)) {
        return;
      }
    } catch {
      /* next */
    }
  }
  if (lastStatus === 401 || lastStatus === 403) {
    throw new Error('Сессия устарела или нет прав — войди снова');
  }
  const hint = lastBody ? \`: \${lastBody.replace(/\\s+/g, ' ').slice(0, 80)}\` : '';
  throw new Error(\`\${label} (HTTP \${lastStatus || 'сеть'})\${hint}\`);
}

export async function likeTrack(trackId: number): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = \`client_id=\${encodeURIComponent(cid)}\`;
  await tryWrite(
    [
      { method: 'POST', url: \`\${API_PUBLIC}/likes/tracks/\${trackId}\` },
      { method: 'PUT', url: \`\${API_PUBLIC}/likes/tracks/\${trackId}\` },
      { method: 'PUT', url: \`\${API_PUBLIC}/me/favorites/\${trackId}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/track_likes/\${trackId}?\${q}\` },
      { method: 'PUT', url: \`\${API}/likes/tracks/\${trackId}?\${q}\` },
      { method: 'POST', url: \`\${API}/likes/tracks/\${trackId}?\${q}\` },
    ],
    'Не удалось лайкнуть'
  );
}

export async function unlikeTrack(trackId: number): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = \`client_id=\${encodeURIComponent(cid)}\`;
  await tryWrite(
    [
      { method: 'DELETE', url: \`\${API_PUBLIC}/likes/tracks/\${trackId}\` },
      { method: 'DELETE', url: \`\${API_PUBLIC}/me/favorites/\${trackId}\` },
      { method: 'DELETE', url: \`\${API}/users/\${uid}/track_likes/\${trackId}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/likes/tracks/\${trackId}?\${q}\` },
    ],
    'Не удалось убрать лайк'
  );
}

export async function followUser(userId: number): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = \`client_id=\${encodeURIComponent(cid)}\`;
  const urn = encodeURIComponent(\`soundcloud:users:\${userId}\`);
  await tryWrite(
    [
      { method: 'PUT', url: \`\${API_PUBLIC}/me/followings/\${userId}\` },
      { method: 'PUT', url: \`\${API_PUBLIC}/me/followings/\${urn}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/followings/\${userId}?\${q}\` },
      { method: 'PUT', url: \`\${API}/me/followings/\${userId}?\${q}\` },
      { method: 'POST', url: \`\${API}/users/\${uid}/followings/\${userId}?\${q}\` },
    ],
    'Не удалось подписаться'
  );
}

export async function unfollowUser(userId: number): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = \`client_id=\${encodeURIComponent(cid)}\`;
  const urn = encodeURIComponent(\`soundcloud:users:\${userId}\`);
  await tryWrite(
    [
      { method: 'DELETE', url: \`\${API_PUBLIC}/me/followings/\${userId}\` },
      { method: 'DELETE', url: \`\${API_PUBLIC}/me/followings/\${urn}\` },
      { method: 'DELETE', url: \`\${API}/users/\${uid}/followings/\${userId}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/me/followings/\${userId}?\${q}\` },
    ],
    'Не удалось отписаться'
  );
}

export async function isFollowing(userId: number): Promise<boolean> {
  try {
    await ensureAccessToken();
    const uid = meUserId || (await ensureMeIdForLikes());
    const cid = await ensureClientId();
    const q = \`client_id=\${encodeURIComponent(cid)}\`;
    const urls = [
      \`\${API_PUBLIC}/me/followings/\${userId}\`,
      \`\${API}/users/\${uid}/followings/\${userId}?\${q}\`,
      \`\${API}/me/followings/\${userId}?\${q}\`,
    ];
    for (const url of urls) {
      try {
        const r = await scWrite(url, 'GET');
        if (r.status >= 200 && r.status < 300) return true;
        if (r.status === 404) return false;
      } catch {
        /* next */
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function repostTrack(trackId: number): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = \`client_id=\${encodeURIComponent(cid)}\`;
  const urn = encodeURIComponent(\`soundcloud:tracks:\${trackId}\`);
  await tryWrite(
    [
      { method: 'POST', url: \`\${API}/reposts/tracks/\${trackId}?\${q}\` },
      { method: 'PUT', url: \`\${API}/reposts/tracks/\${trackId}?\${q}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/reposts/tracks/\${trackId}?\${q}\` },
      { method: 'POST', url: \`\${API}/users/\${uid}/reposts/tracks/\${trackId}?\${q}\` },
      { method: 'PUT', url: \`\${API}/reposts/tracks/\${urn}?\${q}\` },
      { method: 'POST', url: \`\${API_PUBLIC}/me/track_reposts/\${trackId}\` },
      { method: 'PUT', url: \`\${API_PUBLIC}/me/track_reposts/\${trackId}\` },
    ],
    'Не удалось сделать репост'
  );
}

export async function unrepostTrack(trackId: number): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = \`client_id=\${encodeURIComponent(cid)}\`;
  const urn = encodeURIComponent(\`soundcloud:tracks:\${trackId}\`);
  await tryWrite(
    [
      { method: 'DELETE', url: \`\${API}/reposts/tracks/\${trackId}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/users/\${uid}/reposts/tracks/\${trackId}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/reposts/tracks/\${urn}?\${q}\` },
      { method: 'DELETE', url: \`\${API_PUBLIC}/me/track_reposts/\${trackId}\` },
    ],
    'Не удалось убрать репост'
  );
}

export async function likePlaylist(playlistId: number | string): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = \`client_id=\${encodeURIComponent(cid)}\`;
  const enc = encodeURIComponent(String(playlistId));
  await tryWrite(
    [
      { method: 'POST', url: \`\${API_PUBLIC}/likes/playlists/\${enc}\` },
      { method: 'PUT', url: \`\${API_PUBLIC}/likes/playlists/\${enc}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/playlist_likes/\${enc}?\${q}\` },
      { method: 'POST', url: \`\${API}/likes/playlists/\${enc}?\${q}\` },
      { method: 'PUT', url: \`\${API}/likes/playlists/\${enc}?\${q}\` },
    ],
    'Не удалось лайкнуть плейлист'
  );
}

export async function unlikePlaylist(playlistId: number | string): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = \`client_id=\${encodeURIComponent(cid)}\`;
  const enc = encodeURIComponent(String(playlistId));
  await tryWrite(
    [
      { method: 'DELETE', url: \`\${API_PUBLIC}/likes/playlists/\${enc}\` },
      { method: 'DELETE', url: \`\${API}/users/\${uid}/playlist_likes/\${enc}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/likes/playlists/\${enc}?\${q}\` },
    ],
    'Не удалось убрать лайк плейлиста'
  );
}

`;

s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(p, s);
console.log('patched social actions ok');
