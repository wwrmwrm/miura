const API = 'https://api-v2.soundcloud.com';

async function tryId(id) {
  const res = await fetch(`${API}/search/tracks?q=house&client_id=${id}&limit=1`);
  return res.status;
}

async function main() {
  // Try homepage and a few mobile/web entry points
  const pages = [
    'https://soundcloud.com/',
    'https://m.soundcloud.com/',
    'https://soundcloud.com/discover',
  ];

  const candidates = new Set();

  for (const page of pages) {
    try {
      const html = await fetch(page, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html',
        },
      }).then((r) => r.text());
      console.log(page, 'html', html.length);

      for (const m of html.matchAll(/client_id["'=\s:]+([a-zA-Z0-9]{16,40})/g)) {
        candidates.add(m[1]);
      }

      const scripts = [
        ...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g),
        ...html.matchAll(/src="(https:\/\/[^"]+\.sndcdn\.com\/assets\/[^"]+\.js)"/g),
      ].map((m) => m[1]);

      console.log(page, 'scripts', scripts.length);

      for (const url of [...new Set(scripts)].slice(0, 25)) {
        try {
          const js = await fetch(url).then((r) => r.text());
          for (const m of js.matchAll(/client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{16,40})["']/g)) {
            candidates.add(m[1]);
          }
          for (const m of js.matchAll(/["']([a-zA-Z0-9]{32})["']\s*[,}]/g)) {
            // too noisy — only keep if nearby client
          }
          // Look for patterns like clientId:"xxx"
          for (const m of js.matchAll(/clientId["']?\s*[:=]\s*["']([a-zA-Z0-9]{16,40})["']/g)) {
            candidates.add(m[1]);
          }
        } catch (e) {
          console.log('asset fail', String(e).slice(0, 80));
        }
      }
    } catch (e) {
      console.log(page, 'FAIL', e.cause?.code || e.message);
    }
  }

  console.log('candidates', [...candidates]);

  for (const id of candidates) {
    const status = await tryId(id);
    console.log(id, status);
    if (status === 200) {
      console.log('WORKING', id);
      return;
    }
  }

  // Fallback: try some historically public IDs (may be dead)
  const known = [
    'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX',
    'a3e059563d7fd3372b49b37f00a00bcf',
    '2t9loNQH90kzJcsFCODdigxfp325aq4z',
  ];
  for (const id of known) {
    console.log('known', id, await tryId(id));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
