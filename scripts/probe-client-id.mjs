const API = 'https://api-v2.soundcloud.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function tryId(id) {
  try {
    const res = await fetch(`${API}/search/tracks?q=house&client_id=${id}&limit=1`, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    return res.status;
  } catch (e) {
    return `err:${e.cause?.code || e.message}`;
  }
}

async function main() {
  const pages = ['https://soundcloud.com/', 'https://m.soundcloud.com/', 'https://soundcloud.com/discover'];
  const candidates = new Set();

  for (const page of pages) {
    try {
      const html = await fetch(page, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
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

      for (const url of [...new Set(scripts)].slice(0, 30)) {
        try {
          const js = await fetch(url, { headers: { 'User-Agent': UA } }).then((r) => r.text());
          for (const m of js.matchAll(/client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{16,40})["']/gi)) {
            candidates.add(m[1]);
          }
          for (const m of js.matchAll(/clientId["']?\s*[:=]\s*["']([a-zA-Z0-9]{16,40})["']/gi)) {
            candidates.add(m[1]);
          }
          for (const m of js.matchAll(/["']client_id["']\s*:\s*["']([a-zA-Z0-9]{16,40})["']/gi)) {
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

  const known = [
    'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX',
    'a3e059563d7fd3372b49b37f00a00bcf',
    '2t9loNQH90kzJcsFCODdigxfp325aq4z',
    'YUKXoArFcqrlQn9tfNqjnbyKn4bM4dCh',
    '5MtwkCcsbE5NLlpdALp1UT4oQHhF1YqR',
  ];
  for (const id of known) {
    console.log('known', id, await tryId(id));
  }
}

main().catch(console.error);
