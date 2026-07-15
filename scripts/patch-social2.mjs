import fs from 'fs';

const p = 'src/api/soundcloud.ts';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('/* ---------- Social actions (Electron net + public API) ---------- */');
const end = s.indexOf('/* ---------- Utils ---------- */');
if (start < 0 || end < 0) {
  console.error('markers', start, end);
  process.exit(1);
}

const replacement = `/* ---------- Social actions (api-v2 + browser OAuth token) ---------- */
/*
 * Browser-captured OAuth tokens work on api-v2.soundcloud.com.
 * Official api.soundcloud.com often returns 401/404 for those tokens — avoid it for writes.
 */

function socialHeaders(): Record<string, string> {
  const token = (accessToken || '').replace(/^OAuth\\s+/i, '').trim();
  return {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    Authorization: \`OAuth \${token}\`,
    Origin: 'https://soundcloud.com',
    Referer: 'https://soundcloud.com/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

function isWriteSuccess(status: number) {
  // 409 conflict / 422 already liked|reposted
  return status === 200 || status === 201 || status === 204 || status === 409 || status === 422;
}

/** Resolve numeric user id; always hit /me when writing so token is validated. */
async function ensureMeIdForLikes(): Promise<number> {
  await ensureAccessToken();
  // Prefer live /me — catches expired tokens early
  try {
    const me = await getMe();
    if (me?.id) {
      meUserId = me.id;
      return me.id;
    }
  } catch (e) {
    if (meUserId) return meUserId;
    throw new Error(
      e instanceof Error && /401|истек|войди/i.test(e.message)
        ? 'Сессия устарела — войди снова (Настройки → войти)'
        : 'Не удалось проверить аккаунт — войди снова'
    );
  }
  throw new Error('Не удалось определить аккаунт — войди снова');
}

async function scWrite(
  url: string,
  method: 'PUT' | 'POST' | 'DELETE' | 'GET'
): Promise<{ status: number; body: string }> {
  const headers = socialHeaders();
  // PUT/POST with empty body (SoundCloud web does this for likes/reposts)
  const sendEmpty = method === 'PUT' || method === 'POST';

  if (window.electronAPI?.apiFetch) {
    const r = await window.electronAPI.apiFetch({
      url,
      method,
      headers,
      body: sendEmpty ? '' : null,
    });
    return { status: r.status, body: r.body || '' };
  }

  const res = await fetch(url, {
    method,
    headers,
    body: sendEmpty ? '' : undefined,
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, body: text };
}

type Attempt = { method: 'PUT' | 'POST' | 'DELETE' | 'GET'; url: string };

async function tryWrite(attempts: Attempt[], label: string): Promise<void> {
  await ensureAccessToken();
  const results: string[] = [];
  let sawAuthFail = false;

  for (const a of attempts) {
    try {
      const r = await scWrite(a.url, a.method);
      const short = a.url.replace(/^https:\\/\\/[^/]+/, '').replace(/\\?.*/, '');
      results.push(\`\${a.method} \${short} → \${r.status}\`);
      if (r.status === 401 || r.status === 403) sawAuthFail = true;
      if (isWriteSuccess(r.status)) {
        console.info('[social ok]', label, results[results.length - 1]);
        return;
      }
    } catch (e) {
      results.push(\`\${a.method} fail: \${e instanceof Error ? e.message : 'err'}\`);
    }
  }

  console.warn('[social fail]', label, results.join(' | '));

  if (sawAuthFail && results.every((x) => /→ 401|→ 403|fail:/.test(x))) {
    throw new Error('Сессия устарела или токен без прав — войди снова (Настройки)');
  }

  const last = results[results.length - 1] || '';
  const code = last.match(/→ (\\d+)/)?.[1];
  throw new Error(
    \`\${label} (HTTP \${code || 'сеть'}). \${results.slice(0, 3).join('; ')}\`
  );
}

function v2q(cid: string, token?: string | null) {
  const sp = new URLSearchParams();
  sp.set('client_id', cid);
  if (token) sp.set('oauth_token', token.replace(/^OAuth\\s+/i, '').trim());
  sp.set('app_locale', 'en');
  return sp.toString();
}

export async function likeTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  if (!Number.isFinite(id)) throw new Error('Некорректный id трека');
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const token = accessToken;
  const q = v2q(cid);
  const qTok = v2q(cid, token);

  await tryWrite(
    [
      // Paths used by the SoundCloud web client
      { method: 'PUT', url: \`\${API}/users/\${uid}/track_likes/\${id}?\${q}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/likes/tracks/\${id}?\${q}\` },
      { method: 'PUT', url: \`\${API}/likes/tracks/\${id}?\${q}\` },
      { method: 'POST', url: \`\${API}/likes/tracks/\${id}?\${q}\` },
      { method: 'PUT', url: \`\${API}/me/track_likes/\${id}?\${q}\` },
      // Same with oauth_token query (some gateways prefer it)
      { method: 'PUT', url: \`\${API}/users/\${uid}/track_likes/\${id}?\${qTok}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/likes/tracks/\${id}?\${qTok}\` },
      { method: 'PUT', url: \`\${API}/likes/tracks/\${id}?\${qTok}\` },
    ],
    'Не удалось лайкнуть'
  );
}

export async function unlikeTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = v2q(cid);
  const qTok = v2q(cid, accessToken);

  await tryWrite(
    [
      { method: 'DELETE', url: \`\${API}/users/\${uid}/track_likes/\${id}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/users/\${uid}/likes/tracks/\${id}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/likes/tracks/\${id}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/me/track_likes/\${id}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/users/\${uid}/track_likes/\${id}?\${qTok}\` },
    ],
    'Не удалось убрать лайк'
  );
}

export async function followUser(userId: number): Promise<void> {
  const target = Number(userId);
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = v2q(cid);
  const qTok = v2q(cid, accessToken);

  await tryWrite(
    [
      { method: 'PUT', url: \`\${API}/users/\${uid}/followings/\${target}?\${q}\` },
      { method: 'PUT', url: \`\${API}/me/followings/\${target}?\${q}\` },
      { method: 'POST', url: \`\${API}/users/\${uid}/followings/\${target}?\${q}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/followings/\${target}?\${qTok}\` },
    ],
    'Не удалось подписаться'
  );
}

export async function unfollowUser(userId: number): Promise<void> {
  const target = Number(userId);
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = v2q(cid);
  const qTok = v2q(cid, accessToken);

  await tryWrite(
    [
      { method: 'DELETE', url: \`\${API}/users/\${uid}/followings/\${target}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/me/followings/\${target}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/users/\${uid}/followings/\${target}?\${qTok}\` },
    ],
    'Не удалось отписаться'
  );
}

export async function isFollowing(userId: number): Promise<boolean> {
  try {
    const target = Number(userId);
    const uid = await ensureMeIdForLikes();
    const cid = await ensureClientId();
    const q = v2q(cid);
    for (const url of [
      \`\${API}/users/\${uid}/followings/\${target}?\${q}\`,
      \`\${API}/me/followings/\${target}?\${q}\`,
    ]) {
      const r = await scWrite(url, 'GET');
      if (r.status >= 200 && r.status < 300) return true;
      if (r.status === 404) return false;
    }
    return false;
  } catch {
    return false;
  }
}

export async function repostTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = v2q(cid);
  const qTok = v2q(cid, accessToken);
  const urn = encodeURIComponent(\`soundcloud:tracks:\${id}\`);

  await tryWrite(
    [
      { method: 'PUT', url: \`\${API}/reposts/tracks/\${id}?\${q}\` },
      { method: 'POST', url: \`\${API}/reposts/tracks/\${id}?\${q}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/reposts/tracks/\${id}?\${q}\` },
      { method: 'POST', url: \`\${API}/users/\${uid}/reposts/tracks/\${id}?\${q}\` },
      { method: 'PUT', url: \`\${API}/reposts/tracks/\${urn}?\${q}\` },
      { method: 'PUT', url: \`\${API}/reposts/tracks/\${id}?\${qTok}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/reposts/tracks/\${id}?\${qTok}\` },
    ],
    'Не удалось сделать репост'
  );
}

export async function unrepostTrack(trackId: number): Promise<void> {
  const id = Number(trackId);
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = v2q(cid);
  const qTok = v2q(cid, accessToken);
  const urn = encodeURIComponent(\`soundcloud:tracks:\${id}\`);

  await tryWrite(
    [
      { method: 'DELETE', url: \`\${API}/reposts/tracks/\${id}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/users/\${uid}/reposts/tracks/\${id}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/reposts/tracks/\${urn}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/reposts/tracks/\${id}?\${qTok}\` },
    ],
    'Не удалось убрать репост'
  );
}

export async function likePlaylist(playlistId: number | string): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = v2q(cid);
  const qTok = v2q(cid, accessToken);
  const enc = encodeURIComponent(String(playlistId));

  await tryWrite(
    [
      { method: 'PUT', url: \`\${API}/users/\${uid}/playlist_likes/\${enc}?\${q}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/likes/playlists/\${enc}?\${q}\` },
      { method: 'POST', url: \`\${API}/likes/playlists/\${enc}?\${q}\` },
      { method: 'PUT', url: \`\${API}/likes/playlists/\${enc}?\${q}\` },
      { method: 'PUT', url: \`\${API}/users/\${uid}/playlist_likes/\${enc}?\${qTok}\` },
    ],
    'Не удалось лайкнуть плейлист'
  );
}

export async function unlikePlaylist(playlistId: number | string): Promise<void> {
  const uid = await ensureMeIdForLikes();
  const cid = await ensureClientId();
  const q = v2q(cid);
  const qTok = v2q(cid, accessToken);
  const enc = encodeURIComponent(String(playlistId));

  await tryWrite(
    [
      { method: 'DELETE', url: \`\${API}/users/\${uid}/playlist_likes/\${enc}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/users/\${uid}/likes/playlists/\${enc}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/likes/playlists/\${enc}?\${q}\` },
      { method: 'DELETE', url: \`\${API}/users/\${uid}/playlist_likes/\${enc}?\${qTok}\` },
    ],
    'Не удалось убрать лайк плейлиста'
  );
}

`;

s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(p, s);
console.log('patched social v2');
