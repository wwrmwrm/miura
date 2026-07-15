const API = 'https://api-v2.soundcloud.com';

async function main() {
  const html = await fetch('https://soundcloud.com/', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
    .then((r) => r.text())
    .catch(() => '');

  const ids = [...html.matchAll(/client_id["'=\s:]+([a-zA-Z0-9]{16,40})/g)].map((m) => m[1]);
  console.log('ids from html', ids.slice(0, 5));

  let cid = null;
  const known = [
    ...ids,
    'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX',
    'a3e059563d7fd3372b49b37f00a00bcf',
    '2t9loNQH90kzJcsFCODdigxfp325aq4z',
  ];
  for (const id of [...new Set(known)]) {
    const r = await fetch(`${API}/search/tracks?q=test&client_id=${id}&limit=1`);
    console.log('try', id.slice(0, 8), r.status);
    if (r.ok) {
      cid = id;
      break;
    }
  }
  if (!cid) {
    console.log('no client id');
    return;
  }
  console.log('using', cid);

  const mix = await fetch(`${API}/mixed-selections?client_id=${cid}&limit=8`, {
    headers: { Accept: 'application/json' },
  });
  console.log('mixed status', mix.status);
  if (!mix.ok) {
    console.log(await mix.text());
    return;
  }

  const j = await mix.json();
  const col = j.collection || [];
  console.log('blocks', col.length);

  for (const b of col.slice(0, 6)) {
    const items = b.items?.collection || [];
    console.log('\n===', b.title || b.tracking_feature_name, 'items', items.length);
    for (const it of items.slice(0, 4)) {
      const keys = Object.keys(it || {});
      const sp = it.system_playlist || it.systemPlaylist;
      const pl = it.playlist;
      const tr = it.track;
      const kind =
        it.kind || sp?.kind || pl?.kind || tr?.kind || (sp ? 'system_playlist' : pl ? 'playlist' : tr ? 'track' : '?');
      const title = it.title || sp?.title || pl?.title || tr?.title;
      const id = it.id ?? sp?.id ?? pl?.id ?? tr?.id;
      const urn = it.urn || sp?.urn || pl?.urn || tr?.urn;
      console.log(' item keys:', keys.join(', '));
      console.log('  kind=', kind, 'id=', id, 'urn=', urn);
      console.log('  title=', String(title || '').slice(0, 50));
      if (sp) {
        console.log('  system_playlist tracks?', sp.tracks?.length, 'short?', sp.short_description || sp.description?.slice?.(0, 40));
        console.log('  sp keys', Object.keys(sp).slice(0, 20).join(', '));
      }
      if (pl) {
        console.log('  playlist tracks?', pl.tracks?.length, 'track_count', pl.track_count);
      }
    }
  }

  // try system playlist endpoints if we found one
  for (const b of col) {
    for (const it of b.items?.collection || []) {
      const sp = it.system_playlist || it;
      if (!(sp?.kind === 'system-playlist' || sp?.urn?.includes?.('system-playlists') || it.system_playlist)) {
        continue;
      }
      const target = it.system_playlist || sp;
      const urn = target.urn || `soundcloud:system-playlists:${target.id}`;
      console.log('\ntrying system playlist', urn);
      for (const path of [
        `/system-playlists/${encodeURIComponent(urn)}`,
        `/system-playlists/${encodeURIComponent(urn)}?representation=full`,
        `/playlists/${encodeURIComponent(urn)}`,
      ]) {
        const url = `${API}${path}${path.includes('?') ? '&' : '?'}client_id=${cid}`;
        const r = await fetch(url, { headers: { Accept: 'application/json' } });
        console.log(' ', path, r.status);
        if (r.ok) {
          const data = await r.json();
          console.log('  title', data.title, 'tracks', data.tracks?.length, 'keys', Object.keys(data).slice(0, 15).join(','));
          if (data.tracks?.[0]) {
            console.log('  first track', data.tracks[0].id, data.tracks[0].title, 'media?', !!data.tracks[0].media);
          }
        }
      }
      return;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
