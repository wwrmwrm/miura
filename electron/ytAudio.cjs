

'use strict';

const CHROME_UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const YT_PARTITION = 'persist:miura-yt-audio';

const PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.darkness.services',
  'https://pipedapi.reallyaweso.me',
];

const INVIDIOUS = [
  'https://yewtu.be',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://iv.ggtyler.dev',
  'https://invidious.fdn.fr',
];

function createYtAudio(deps) {
  const {
    session,
    net,
    protocol,
    BrowserWindow,
    chromeUa = CHROME_UA_DEFAULT,
    readProxyConfig,
    applyProxyToSession,
  } = deps;

  const inflight = new Map();
  const cache = new Map();
  let browserQueue = Promise.resolve();

  let proxyKeyBySes = new WeakMap();
  let lightBlockInstalled = new WeakSet();

  function getSes() {
    return session.fromPartition(YT_PARTITION);
  }

  function proxyKey(cfg) {
    return `${cfg?.enabled ? 1 : 0}|${cfg?.mode || ''}|${cfg?.url || ''}`;
  }

  async function ensureProxy(ses) {
    try {
      const cfg = readProxyConfig();
      const key = proxyKey(cfg);
      if (proxyKeyBySes.get(ses) !== key) {
        await applyProxyToSession(ses, cfg, { forceReconnect: false });
        proxyKeyBySes.set(ses, key);
        console.log('[yt-audio] proxy applied', cfg.mode, (cfg.url || '').replace(/\/\/[^@]+@/, '//***@'));
      }
    } catch (e) {
      console.warn('[yt-audio] proxy', e?.message || e);
    }
    try {
      ses.setUserAgent(chromeUa);
    } catch {
      /* ignore */
    }
  }


  function installLightBlocking(ses) {
    if (lightBlockInstalled.has(ses)) return;
    lightBlockInstalled.add(ses);
    try {
      ses.webRequest.onBeforeRequest(
        {
          urls: [
            '*://*.doubleclick.net/*',
            '*://*.googlesyndication.com/*',
            '*://*.googleadservices.com/*',
            '*://*.adservice.google.com/*',
            '*://*.facebook.com/*',
            '*://*.fbcdn.net/*',
            '*://*.ytimg.com/*',
            '*://i.ytimg.com/*',
            '*://*.ggpht.com/*',
            '*://*.googleusercontent.com/*',
          ],
        },
        (details, cb) => {
          const u = details.url || '';
          if (/doubleclick|googlesyndication|googleadservices|adservice|facebook|fbcdn/i.test(u)) {
            cb({ cancel: true });
            return;
          }
          if (/\.(jpg|jpeg|png|webp|gif|svg|ico)(\?|$)/i.test(u) || /\/vi\/|\/an_webp\//i.test(u)) {
            cb({ cancel: true });
            return;
          }
          cb({});
        }
      );
    } catch (e) {
      console.warn('[yt-audio] light block', e?.message || e);
    }
  }

  function fetchOn(ses) {
    return typeof ses.fetch === 'function' ? ses.fetch.bind(ses) : net.fetch.bind(net);
  }

  async function fetchJson(ses, url, init = {}, timeoutMs = 10000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchOn(ses)(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* ignore */
      }
      return { status: res.status, ok: res.ok, data, text, len: text.length };
    } finally {
      clearTimeout(t);
    }
  }

  async function probeUrl(url, ses) {
    try {
      const res = await fetchOn(ses)(url, {
        method: 'GET',
        headers: {
          'User-Agent': chromeUa,
          Referer: 'https://www.youtube.com/',
          Origin: 'https://www.youtube.com',
          Accept: '*/*',
          Range: 'bytes=0-1023',
        },
        bypassCustomProtocolHandlers: true,
      });
      if (res.ok || res.status === 206) {
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore */
        }
        return true;
      }
      console.warn('[yt-audio] probe', res.status, String(url).slice(0, 70));
      return false;
    } catch (e) {
      console.warn('[yt-audio] probe err', e?.message || e);
      return false;
    }
  }

  function wrapForPlayer(url, mime) {
    const u = String(url || '');
    if (!/^https:\/\//i.test(u)) return u;
    if (u.startsWith('miura-yt:')) return u;
    if (/\.m3u8(\?|$)/i.test(u)) return u;
    const q = new URLSearchParams();
    q.set('u', u);
    if (mime) q.set('m', String(mime).split(';')[0].trim());
    return `miura-yt://play/?${q.toString()}`;
  }

  function scoreUrl(u, mimeHint = '') {
    const mime = mimeHint || u;
    let s = 0;
    if (/[/&?]itag=141(?:[&/]|$)/.test(u)) s += 1200;
    else if (/[/&?]itag=140(?:[&/]|$)/.test(u)) s += 1100;
    else if (/[/&?]itag=139(?:[&/]|$)/.test(u)) s += 900;
    else if (/[/&?]itag=18(?:[&/]|$)/.test(u)) s += 850;
    else if (/[/&?]itag=22(?:[&/]|$)/.test(u)) s += 700;
    else if (/[/&?]itag=251(?:[&/]|$)/.test(u)) s += 400;
    else if (/[/&?]itag=250(?:[&/]|$)/.test(u)) s += 300;
    else if (/[/&?]itag=249(?:[&/]|$)/.test(u)) s += 200;
    if (/mime=audio%2Fmp4|mime=audio\/mp4|audio\/mp4|mp4a/i.test(mime)) s += 500;
    if (/mime=audio%2Fwebm|audio\/webm|opus/i.test(mime)) s += 80;
    if (/mime=video%2F|mime=video\//i.test(mime) && !/[/&?]itag=(18|22)(?:[&/]|$)/.test(u)) s -= 2000;
    return s;
  }

  function looksLikeAudio(u) {
    if (!u || !/googlevideo\.com/i.test(u)) return false;
    if (scoreUrl(u) < 0) return false;
    if (/mime=audio/i.test(u)) return true;
    if (/[/&?]itag=(139|140|141|249|250|251|256|258|18|22)(?:[&/]|$)/.test(u)) return true;
    return false;
  }

  function cleanMediaUrl(u) {
    try {
      const url = new URL(u);
      url.searchParams.delete('range');
      url.searchParams.delete('rn');
      url.searchParams.delete('rbuf');
      return url.toString();
    } catch {
      return String(u).replace(/&range=\d+-\d+/g, '').replace(/&rn=\d+/g, '');
    }
  }

  function mimeFromUrl(u) {
    if (/mime=audio%2Fwebm|mime=audio\/webm/i.test(u)) return 'audio/webm';
    if (/mime=audio%2Fmp4|mime=audio\/mp4|itag=(139|140|141)/i.test(u)) return 'audio/mp4';
    if (/itag=(18|22)/i.test(u)) return 'video/mp4';
    return 'audio/mp4';
  }

  function pickFromStreamingData(sd, label) {
    if (!sd) return null;
    const formats = [
      ...(sd.adaptiveFormats || sd.adaptive_formats || []),
      ...(sd.formats || []),
    ];
    const scored = [];
    let withUrl = 0;
    for (const f of formats) {
      let url = f.url ? String(f.url) : '';
      if (!url.startsWith('http')) continue;
      withUrl++;
      const mime = String(f.mimeType || f.mime_type || '');
      const sc = scoreUrl(url, mime);
      if (sc < 0) continue;
      scored.push({ url, mime: mime || 'audio/mp4', score: sc });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored[0]) {
      return {
        ok: true,
        url: scored[0].url,
        mime: scored[0].mime,
        protocol: 'progressive',
        client: label,
        _meta: { formats: formats.length, withUrl },
      };
    }
    const hls = sd.hlsManifestUrl || sd.hls_manifest_url;
    if (hls && String(hls).startsWith('http')) {
      return {
        ok: true,
        url: String(hls),
        mime: 'application/x-mpegURL',
        protocol: 'hls',
        client: `${label}/hls`,
      };
    }
    return { _empty: true, formats: formats.length, withUrl };
  }

  async function tryInnertube(ses, videoId) {
    const clients = [
      {
        key: 'ANDROID',
        clientName: 'ANDROID',
        clientVersion: '19.44.38',
        clientId: '3',
        ua: 'com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip',
        extra: { androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
      },
      {
        key: 'ANDROID_VR',
        clientName: 'ANDROID_VR',
        clientVersion: '1.57.29',
        clientId: '28',
        ua: 'com.google.android.apps.youtube.vr.oculus/1.57.29 (Linux; U; Android 12; XX; Build/SQ3A.220605.009.A1; Cronet/113.0.5672.33)',
        extra: { androidSdkVersion: 32, osName: 'Android', osVersion: '12' },
      },
      {
        key: 'IOS',
        clientName: 'IOS',
        clientVersion: '19.45.4',
        clientId: '5',
        ua: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
        extra: { deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '17.5.1.21F90' },
      },
      {
        key: 'TVHTML5',
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        clientId: '85',
        ua: chromeUa,
        extra: {},
      },
    ];
    const endpoint = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
    const notes = [];

    for (const c of clients) {
      try {
        const body = {
          context: {
            client: {
              clientName: c.clientName,
              clientVersion: c.clientVersion,
              hl: 'en',
              gl: 'US',
              utcOffsetMinutes: 0,
              ...c.extra,
            },
          },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          playbackContext: {
            contentPlaybackContext: {
              html5Preference: 'HTML5_PREF_WANTS',
              signatureTimestamp: Math.floor(Date.now() / 1000),
            },
          },
        };
        const { data, status, len } = await fetchJson(
          ses,
          endpoint,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': c.ua,
              'X-YouTube-Client-Name': c.clientId,
              'X-YouTube-Client-Version': c.clientVersion,
              Origin: 'https://www.youtube.com',
              Referer: `https://www.youtube.com/watch?v=${videoId}`,
            },
            body: JSON.stringify(body),
          },
          9000
        );
        if (!data) {
          notes.push(`${c.key}:http${status}`);
          continue;
        }
        const picked = pickFromStreamingData(data.streamingData || data.streaming_data, c.key);
        if (picked?.ok) {
          console.log('[yt-audio] innertube', c.key, 'len', len);
          return picked;
        }
        const st = data.playabilityStatus?.status || '?';
        notes.push(
          `${c.key}:${st}/fmt${picked?.formats ?? 0}/url${picked?.withUrl ?? 0}`
        );
      } catch (e) {
        notes.push(`${c.key}:${String(e?.message || e).slice(0, 40)}`);
      }
    }
    console.warn('[yt-audio] innertube miss', notes.join(' · '));
    return null;
  }

  async function tryPiped(ses, videoId) {
    const notes = [];
    return await new Promise((resolve) => {
      let left = PIPED.length;
      let done = false;
      for (const base of PIPED) {
        void (async () => {
          const host = (() => {
            try {
              return new URL(base).hostname;
            } catch {
              return base;
            }
          })();
          try {
            const { data, status } = await fetchJson(
              ses,
              `${base}/streams/${videoId}`,
              {
                method: 'GET',
                headers: { Accept: 'application/json', 'User-Agent': chromeUa },
              },
              8000
            );
            if (done) return;
            if (!data) {
              notes.push(`${host}:http${status}`);
              return;
            }
            const audio = Array.isArray(data.audioStreams) ? data.audioStreams : [];
            const scored = audio
              .filter((s) => s?.url && String(s.url).startsWith('http'))
              .map((s) => {
                const mime = String(s.mimeType || s.format || 'audio/mp4');
                let score = Number(s.bitrate || 0);
                if (/mp4|m4a/i.test(mime)) score += 1e9;
                return { url: String(s.url), mime, score };
              })
              .sort((a, b) => b.score - a.score);
            if (scored[0]) {
              done = true;
              console.log('[yt-audio] piped', host);
              resolve({
                ok: true,
                url: scored[0].url,
                mime: scored[0].mime,
                protocol: 'progressive',
                client: `piped:${host}`,
              });
              return;
            }
            notes.push(`${host}:0audio`);
          } catch (e) {
            notes.push(`${host}:${String(e?.message || e).slice(0, 30)}`);
          } finally {
            left -= 1;
            if (left <= 0 && !done) {
              console.warn('[yt-audio] piped miss', notes.slice(0, 5).join(' · '));
              resolve(null);
            }
          }
        })();
      }
    });
  }

  async function tryInvidious(ses, videoId) {
    for (const base of INVIDIOUS) {
      const host = (() => {
        try {
          return new URL(base).hostname;
        } catch {
          return base;
        }
      })();
      try {
        const { data, status } = await fetchJson(
          ses,
          `${base}/api/v1/videos/${videoId}`,
          {
            method: 'GET',
            headers: { Accept: 'application/json', 'User-Agent': chromeUa },
          },
          8000
        );
        if (!data) {
          console.warn('[yt-audio] inv', host, 'http', status);
          continue;
        }
        const formats = [
          ...(Array.isArray(data.adaptiveFormats) ? data.adaptiveFormats : []),
          ...(Array.isArray(data.formatStreams) ? data.formatStreams : []),
        ];
        const scored = [];
        for (const f of formats) {
          const url = String(f.url || '');
          if (!url.startsWith('http')) continue;
          const mime = String(f.type || f.mimeType || '');
          const sc = scoreUrl(url, mime);
          if (sc < 0) continue;
          scored.push({ url, mime, score: sc });
        }
        scored.sort((a, b) => b.score - a.score);
        if (scored[0]) {
          console.log('[yt-audio] invidious', host);
          return {
            ok: true,
            url: scored[0].url,
            mime: scored[0].mime || 'audio/mp4',
            protocol: 'progressive',
            client: `invidious:${host}`,
          };
        }
      } catch (e) {
        console.warn('[yt-audio] inv', host, e?.message || e);
      }
    }
    return null;
  }


  function resolveViaMutedBrowser(videoId) {
    const run = () => resolveViaMutedBrowserImpl(videoId);
    const p = browserQueue.then(run, run);
    browserQueue = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  }

  function resolveViaMutedBrowserImpl(videoId) {
    const id = String(videoId || '').trim();
    return new Promise(async (resolve) => {
      if (!BrowserWindow) {
        resolve(null);
        return;
      }
      let settled = false;
      let win = null;
      const ses = getSes();
      await ensureProxy(ses);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ses.webRequest.onBeforeRequest(null);
        } catch {
          /* ignore */
        }
        try {
          if (win && !win.isDestroyed()) win.destroy();
        } catch {
          /* ignore */
        }
        resolve(result);
      };

      const candidates = [];
      const timer = setTimeout(() => {
        if (candidates.length) {
          const best = candidates
            .map((c) => ({ ...c, score: scoreUrl(c.url, c.mime) }))
            .filter((c) => c.score >= 0)
            .sort((a, b) => b.score - a.score)[0];
          if (best) {
            console.log('[yt-audio] browser timeout-pick', best.mime, best.url.slice(0, 64));
            finish({
              ok: true,
              url: best.url,
              mime: best.mime,
              protocol: 'progressive',
              client: 'browser-intercept',
            });
            return;
          }
        }
        finish(null);
      }, 22000);

      let probing = false;
      const maybeFinish = async (force) => {
        if (settled || !candidates.length || probing) return;
        const ranked = candidates
          .map((c) => ({ ...c, score: scoreUrl(c.url, c.mime) }))
          .filter((c) => c.score >= 0)
          .sort((a, b) => b.score - a.score);
        if (!ranked.length) return;
        const great = ranked[0].score >= 900;
        if (!force && !great && candidates.length < 2) return;

        probing = true;
        try {
          const best = ranked[0];
          console.log(
            '[yt-audio] browser intercept',
            best.mime,
            'score',
            best.score,
            best.url.slice(0, 72)
          );
          finish({
            ok: true,
            url: best.url,
            mime: best.mime,
            protocol: 'progressive',
            client: 'browser-intercept',
          });
        } finally {
          probing = false;
        }
      };

      try {
        ses.webRequest.onBeforeRequest({ urls: ['*://*.googlevideo.com/*'] }, (details, cb) => {
          try {
            if (!settled && looksLikeAudio(details.url)) {
              const url = cleanMediaUrl(details.url);
              if (!candidates.some((c) => c.url === url)) {
                candidates.push({ url, mime: mimeFromUrl(url) });
              }
              if (scoreUrl(url) >= 900) {
                void maybeFinish(true);
              } else {
                void maybeFinish(false);
              }
            }
          } catch {
            /* ignore */
          }
          cb({});
        });
      } catch (e) {
        finish(null);
        return;
      }

      try {
        win = new BrowserWindow({
          show: false,
          width: 800,
          height: 450,
          skipTaskbar: true,
          webPreferences: {
            session: ses,
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
            autoplayPolicy: 'no-user-gesture-required',
            sandbox: true,
          },
        });
        try {
          win.webContents.setAudioMuted(true);
          win.webContents.setUserAgent(chromeUa);
          win.webContents.setBackgroundThrottling(false);
        } catch {
          /* ignore */
        }

        win.webContents.on('did-finish-load', () => {
          void (async () => {
            if (settled) return;
            try {
              await win.webContents.executeJavaScript(
                `
                (async () => {
                  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                  try {
                    const consent = document.querySelector(
                      'button[aria-label*="Accept"], button[aria-label*="Agree"], form[action*="consent"] button'
                    );
                    if (consent) consent.click();
                  } catch (e) {}
                  for (let i = 0; i < 12; i++) {
                    const v = document.querySelector('video');
                    if (v) {
                      try {
                        v.muted = true;
                        v.volume = 0;
                        v.defaultMuted = true;
                        if (v.paused) {
                          try { await v.play(); } catch (e1) {
                            const b = document.querySelector(
                              'button.ytp-large-play-button, button.ytp-play-button'
                            );
                            if (b) b.click();
                            try { await v.play(); } catch (e2) {}
                          }
                        }
                        try { if (v.duration > 8) v.currentTime = 2; } catch (e) {}
                        return 'ok';
                      } catch (e) {}
                    } else {
                      const b = document.querySelector(
                        'button.ytp-large-play-button, button.ytp-play-button'
                      );
                      if (b) try { b.click(); } catch (e) {}
                    }
                    await sleep(350);
                  }
                  return 'none';
                })()
                `,
                true
              );
              setTimeout(() => void maybeFinish(true), 3500);
            } catch (e) {
              console.warn('[yt-audio] browser script', e?.message || e);
            }
          })();
        });

        await win.loadURL(
          `https://www.youtube.com/watch?v=${id}&bpctr=9999999999&has_verified=1`,
          {
            userAgent: chromeUa,
            httpReferrer: 'https://www.youtube.com/',
          }
        );
      } catch (e) {
        console.warn('[yt-audio] browser load', e?.message || e);
        finish(null);
      }
    });
  }

  async function finalize(hit) {
    if (!hit?.ok || !hit.url) return null;
    const ses = getSes();
    await ensureProxy(ses);

    if (hit.protocol === 'hls' || /\.m3u8/i.test(hit.url)) {
      return {
        ok: true,
        url: hit.url,
        mime: hit.mime || 'application/x-mpegURL',
        protocol: 'hls',
        client: hit.client,
      };
    }

    const fromBrowser = /browser-intercept/i.test(hit.client || '');
    if (fromBrowser) {
      return null;
    }

    let ok = await probeUrl(hit.url, ses);
    let tag = 'yt';
    if (!ok) {
      ok = await probeUrl(hit.url, session.defaultSession);
      tag = 'def';
    }
    if (!ok) {
      console.warn('[yt-audio] dead after probe', hit.client);
      return null;
    }

    const mime = hit.mime || 'audio/mp4';
    const wrapped = wrapForPlayer(hit.url, mime);
    return {
      ok: true,
      url: wrapped,
      sourceUrl: hit.url,
      mime,
      protocol: 'progressive',
      client: `${hit.client}/${tag}`,
    };
  }

  async function resolveAudio(videoId) {
    const id = String(videoId || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,}$/.test(id)) {
      return { ok: false, error: 'YouTube: bad video id' };
    }

    if (inflight.has(id)) return inflight.get(id);

    const job = (async () => {
      const cached = cache.get(id);
      if (cached && cached.exp > Date.now() && cached.result?.ok) {
        console.log('[yt-audio] cache', id);
        return { ...cached.result, client: `${cached.result.client}/cache` };
      }

      const ses = getSes();
      await ensureProxy(ses);
      const def = session.defaultSession;
      const attempts = [];

      const tryPath = async (label, fn) => {
        try {
          const hit = await fn();
          if (!hit?.ok) {
            attempts.push(`${label}:empty`);
            return null;
          }
          const out = await finalize(hit);
          if (out?.ok) {
            cache.set(id, { exp: Date.now() + 6 * 60_000, result: out });
            console.log('[yt-audio] ok', out.client, String(out.url).slice(0, 52));
            return out;
          }
          attempts.push(`${label}:403`);
        } catch (e) {
          attempts.push(`${label}:${String(e?.message || e).slice(0, 40)}`);
        }
        return null;
      };

      const browserP = tryPath('browser', () => resolveViaMutedBrowser(id));
      const androidP = tryPath('android', () => tryInnertube(ses, id));
      const pipedP = tryPath('piped', () => tryPiped(ses, id));

      const first = await new Promise((resolve) => {
        let pending = 3;
        let done = false;
        const one = (r) => {
          if (done) return;
          if (r?.ok) {
            done = true;
            resolve(r);
            return;
          }
          pending -= 1;
          if (pending <= 0) resolve(null);
        };
        browserP.then(one).catch(() => one(null));
        androidP.then(one).catch(() => one(null));
        pipedP.then(one).catch(() => one(null));
      });
      if (first?.ok) return first;

      let hit =
        (await tryPath('invidious', () => tryInvidious(ses, id))) ||
        (await tryPath('android-def', () => tryInnertube(def, id))) ||
        (await tryPath('piped-def', () => tryPiped(def, id))) ||
        (await browserP) ||
        (await androidP) ||
        (await pipedP);

      if (hit?.ok) return hit;

      return {
        ok: false,
        error: `YouTube: нет audio-потока (${attempts.slice(0, 8).join(' · ') || 'all failed'}). Проверь SOCKS «весь трафик» и что 127.0.0.1:12334 жив.`,
      };
    })().finally(() => inflight.delete(id));

    inflight.set(id, job);
    return job;
  }

  function registerProtocol() {
    try {
      protocol.handle('miura-yt', async (request) => {
        try {
          const parsed = new URL(request.url);
          const target = parsed.searchParams.get('u');
          if (!target || !/^https:\/\//i.test(target)) {
            return new Response('bad yt url', { status: 400 });
          }
          const mimeHint = parsed.searchParams.get('m') || '';
          const headers = {
            'User-Agent': chromeUa,
            Referer: 'https://www.youtube.com/',
            Origin: 'https://www.youtube.com',
            Accept: '*/*',
          };
          try {
            const range =
              request.headers?.get?.('Range') || request.headers?.get?.('range') || null;
            if (range) headers.Range = range;
          } catch {
            /* ignore */
          }

          const ytSes = getSes();
          await ensureProxy(ytSes);

          let res = await fetchOn(ytSes)(target, {
            method: 'GET',
            headers,
            bypassCustomProtocolHandlers: true,
          });

          if (!res.ok && res.status !== 206) {
            try {
              await res.arrayBuffer();
            } catch {
              /* ignore */
            }
            res = await fetchOn(session.defaultSession)(target, {
              method: 'GET',
              headers,
              bypassCustomProtocolHandlers: true,
            });
          }

          const out = new Headers();
          const ct =
            res.headers.get('Content-Type') ||
            res.headers.get('content-type') ||
            mimeHint ||
            'audio/mp4';
          out.set('Content-Type', ct);
          const cl = res.headers.get('Content-Length') || res.headers.get('content-length');
          if (cl) out.set('Content-Length', cl);
          const cr = res.headers.get('Content-Range') || res.headers.get('content-range');
          if (cr) out.set('Content-Range', cr);
          out.set('Accept-Ranges', 'bytes');
          out.set('Access-Control-Allow-Origin', '*');

          if (!res.ok && res.status !== 206) {
            console.warn('[miura-yt]', res.status, target.slice(0, 80));
            return new Response(`upstream ${res.status}`, { status: res.status });
          }
          return new Response(res.body, { status: res.status, headers: out });
        } catch (e) {
          console.error('[miura-yt]', e);
          return new Response(String(e?.message || e), { status: 502 });
        }
      });
      console.log('[miura-yt] protocol ready (clean)');
    } catch (e) {
      console.warn('[miura-yt] protocol', e);
    }
  }

  let playWin = null;
  let playGen = 0;
  let playChain = Promise.resolve();

  function withTimeout(promise, ms, label) {
    let timer;
    const t = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label || `timeout ${ms}ms`)), ms);
    });
    return Promise.race([promise, t]).finally(() => clearTimeout(timer));
  }

  function getPlayWindow() {
    if (playWin && !playWin.isDestroyed()) return playWin;
    const ses = getSes();
    void ensureProxy(ses);
    installLightBlocking(ses);
    playWin = new BrowserWindow({
      width: 640,
      height: 360,
      show: false,
      skipTaskbar: true,
      frame: false,
      focusable: false,
      x: -32000,
      y: -32000,
      title: 'miura-yt-audio',
      backgroundColor: '#000',
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        sandbox: true,
      },
    });
    try {
      playWin.webContents.setUserAgent(chromeUa);
      playWin.webContents.setBackgroundThrottling(false);
      playWin.webContents.setAudioMuted(true); // start muted — ads
      playWin.setMenuBarVisibility(false);
    } catch {
      /* ignore */
    }
    playWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    playWin.on('closed', () => {
      playWin = null;
    });
    playWin.on('show', () => {
      try {
        if (playWin && !playWin.isDestroyed()) playWin.hide();
      } catch {
        /* ignore */
      }
    });
    return playWin;
  }

  let playVolume = 0.85;
  let playUserMuted = false;

  const PAGE_PLAY_SCRIPT = (volume, startAt, waitMs) => `
    (async () => {
      const vol = Math.max(0, Math.min(1, ${Number(volume)}));
      const startAt = ${Number(startAt)};
      const deadline = Date.now() + ${Number(waitMs)};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      const applyVol = () => {
        try {
          window.__miuraVol = vol;
          document.querySelectorAll('video, audio').forEach((m) => {
            // Exact slider level — never fall back to 1.0 / full volume
            if (Math.abs((m.volume || 0) - vol) > 0.01) m.volume = vol;
            m.volume = vol;
            m.muted = vol <= 0.001;
          });
        } catch (e) {}
      };

      const isAd = () => {
        try {
          const p = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
          if (p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'))) return true;
        } catch (e) {}
        return !!(
          document.querySelector('.ad-showing') ||
          document.querySelector('.ytp-ad-player-overlay') ||
          document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button') ||
          document.querySelector('.ytp-ad-preview-container')
        );
      };

      const killAd = () => {
        document.querySelectorAll(
          '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[class*="skip-button"], .ytp-ad-overlay-close-button, button[aria-label*="Skip"], button[aria-label*="Пропуст"]'
        ).forEach((el) => { try { el.click(); } catch (e) {} });
        document.querySelectorAll('video, audio').forEach((m) => {
          try { m.muted = true; m.volume = 0; } catch (e) {}
        });
        try {
          const v = document.querySelector('video');
          if (v && isAd() && Number.isFinite(v.duration) && v.duration > 0 && v.duration < 90) {
            v.currentTime = Math.max(0, v.duration - 0.15);
          }
        } catch (e) {}
      };

      if (!window.__miuraAdKill) {
        window.__miuraAdKill = setInterval(() => {
          try {
            if (isAd()) killAd();
            else applyVol();
          } catch (e) {}
        }, 250);
      }

      try {
        const c = document.querySelector('button[aria-label*="Accept"], button[aria-label*="Agree"], form[action*="consent"] button');
        if (c) c.click();
      } catch (e) {}

      const clickPlay = () => {
        for (const s of [
          'button.ytp-large-play-button', 'button.ytp-play-button',
          'button[aria-label*="Play"]', '.ytp-cued-thumbnail-overlay',
        ]) {
          const el = document.querySelector(s);
          if (el) { try { el.click(); return; } catch (e) {} }
        }
        try { document.getElementById('movie_player')?.click?.(); } catch (e) {}
      };

      while (Date.now() < deadline) {
        if (isAd()) { killAd(); clickPlay(); await sleep(180); continue; }
        const v = document.querySelector('video');
        if (!v) { clickPlay(); await sleep(160); continue; }
        try {
          if (v.paused) {
            clickPlay();
            try { await v.play(); } catch (e) {}
          }
          if (isAd()) { killAd(); await sleep(180); continue; }
          applyVol();
          if (startAt > 1 && Number.isFinite(v.duration) && v.duration > startAt + 2) {
            try { if (Math.abs(v.currentTime - startAt) > 2) v.currentTime = startAt; } catch (e) {}
          }
          if (!v.paused && !v.ended) {
            const t0 = Number(v.currentTime) || 0;
            await sleep(380);
            if (isAd()) { killAd(); continue; }
            const t1 = Number(v.currentTime) || 0;
            if (!v.paused && !isAd() && (t1 > t0 + 0.04 || t1 > 0.15)) {
              applyVol();
              return {
                ok: true,
                mode: 'page',
                duration: Number.isFinite(v.duration) ? Number(v.duration) : 0,
                currentTime: t1,
                paused: false,
              };
            }
          }
        } catch (e) {}
        clickPlay();
        await sleep(160);
      }
      if (isAd()) return { ok: false, error: 'YouTube: застряли на рекламе, попробуй ещё раз' };
      return { ok: false, error: 'YouTube: трек не стартовал' };
    })()
  `;

  async function playPageImpl(payload) {
    const videoId = String(payload?.videoId || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
      return { ok: false, error: 'YouTube: bad video id' };
    }
    const volume = Math.max(0, Math.min(1, Number(payload?.volume ?? 0.85)));
    const startAt = Math.max(0, Number(payload?.startAt || 0) || 0);
    playVolume = volume;
    playUserMuted = Boolean(payload?.muted) || volume <= 0.001;
    const myGen = ++playGen;
    const t0 = Date.now();
    const win = getPlayWindow();

    try {
      win.webContents.setAudioMuted(true);
    } catch {
      /* ignore */
    }
    try {
      win.hide();
    } catch {
      /* ignore */
    }

    await ensureProxy(win.webContents.session);

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    console.log('[yt-audio] page play', videoId, 'vol', volume);
    try {
      win.webContents.stop();
    } catch {
      /* ignore */
    }
    await withTimeout(
      win.loadURL(url, {
        userAgent: chromeUa,
        httpReferrer: 'https://www.youtube.com/',
      }),
      14000,
      'YouTube: load timeout (прокси/SOCKS?)'
    );
    if (myGen !== playGen) return { ok: false, error: 'cancelled' };
    console.log('[yt-audio] page loaded', Date.now() - t0, 'ms');

    const result = await withTimeout(
      win.webContents.executeJavaScript(PAGE_PLAY_SCRIPT(volume, startAt, 22000), true),
      26000,
      'YouTube: play timeout'
    );
    if (myGen !== playGen) return { ok: false, error: 'cancelled' };

    if (result?.ok) {
      try {
        // Keep window muted if user muted; else open audio at exact slider level
        win.webContents.setAudioMuted(playUserMuted);
        await win.webContents.executeJavaScript(
          `(() => {
            const vol = ${volume};
            document.querySelectorAll('video,audio').forEach((m) => {
              m.volume = vol;
              m.muted = vol <= 0.001;
            });
            true;
          })()`,
          true
        );
      } catch {
        /* ignore */
      }
      console.log(
        '[yt-audio] page ok',
        Date.now() - t0,
        'ms t=',
        result.currentTime,
        'dur=',
        result.duration,
        'vol',
        volume
      );
      return result;
    }
    try {
      win.webContents.setAudioMuted(true);
    } catch {
      /* ignore */
    }
    return { ok: false, error: result?.error || 'YouTube: page play failed' };
  }

  function playPage(payload) {
    const run = () => playPageImpl(payload);
    const p = playChain.then(run, run);
    playChain = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  }

  async function pageCommand(payload) {
    const cmd = String(payload?.cmd || '');
    const value = payload?.value;
    try {
      if (cmd === 'stop') {
        playGen += 1;
        if (playWin && !playWin.isDestroyed()) {
          try {
            playWin.webContents.setAudioMuted(true);
            await playWin.webContents
              .executeJavaScript(
                `document.querySelectorAll('video,audio').forEach(m=>{try{m.pause();m.removeAttribute('src');m.load()}catch(e){}});true`,
                true
              )
              .catch(() => {});
            playWin.hide();
          } catch {
            /* ignore */
          }
        }
        return { ok: true };
      }
      if (!playWin || playWin.isDestroyed()) {
        return { ok: false, hasMedia: false, paused: true, error: 'no window' };
      }
      if (cmd === 'pause') {
        return await playWin.webContents.executeJavaScript(
          `(() => { const v=document.querySelector('video'); if(v){v.pause(); return {ok:true};} return {ok:false}; })()`,
          true
        );
      }
      if (cmd === 'play') {
        const vol = playVolume;
        const userMuted = playUserMuted;
        try {
          playWin.webContents.setAudioMuted(userMuted);
        } catch {
          /* ignore */
        }
        return await playWin.webContents.executeJavaScript(
          `(async()=>{ const v=document.querySelector('video'); if(!v) return {ok:false};
            const vol=${vol}; const userMuted=${userMuted ? 'true' : 'false'};
            try {
              document.querySelectorAll('video,audio').forEach(m=>{
                m.volume = vol; m.muted = userMuted || vol <= 0.001;
              });
              await v.play();
              return {ok:true,paused:!!v.paused};
            } catch(e){ return {ok:false,error:String(e)}; }
          })()`,
          true
        );
      }
      if (cmd === 'seek') {
        const t = Number(value) || 0;
        return await playWin.webContents.executeJavaScript(
          `(() => { const v=document.querySelector('video'); if(!v) return {ok:false};
            v.currentTime=Math.max(0,${t}); return {ok:true,currentTime:v.currentTime,duration:v.duration||0}; })()`,
          true
        );
      }
      if (cmd === 'volume') {
        const v = Math.max(0, Math.min(1, Number(value) || 0));
        playVolume = v;
        playUserMuted = v <= 0.001;
        try {
          playWin.webContents.setAudioMuted(playUserMuted);
        } catch {
          /* ignore */
        }
        return await playWin.webContents.executeJavaScript(
          `(() => {
            const vol=${v};
            window.__miuraVol = vol;
            document.querySelectorAll('video,audio').forEach(m=>{m.volume=vol; m.muted=vol<=0.001;});
            return {ok:true};
          })()`,
          true
        );
      }
      if (cmd === 'status') {
        const vol = playVolume;
        const userMuted = playUserMuted;
        const st = await playWin.webContents.executeJavaScript(
          `(() => {
            const vol = ${vol};
            const userMuted = ${userMuted ? 'true' : 'false'};
            const isAd = () => {
              try {
                const p = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
                if (p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'))) return true;
              } catch (e) {}
              return !!(document.querySelector('.ad-showing') || document.querySelector('.ytp-ad-player-overlay') ||
                document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern'));
            };
            if (isAd()) {
              document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button').forEach(el=>{try{el.click()}catch(e){}});
              document.querySelectorAll('video,audio').forEach(m=>{try{m.muted=true;m.volume=0}catch(e){}});
            } else {
              // YouTube often resets volume to 1 after ads — re-apply user level every poll
              document.querySelectorAll('video,audio').forEach(m=>{
                try {
                  m.volume = vol;
                  m.muted = userMuted || vol <= 0.001;
                } catch (e) {}
              });
              try { window.__miuraVol = vol; } catch (e) {}
            }
            const v = document.querySelector('video');
            if (!v) return { ok:true, hasMedia:false, paused:true, currentTime:0, duration:0, ended:false, isAd:false };
            const ad = isAd();
            return {
              ok: true, hasMedia: true, paused: !!v.paused,
              ended: !!v.ended || (v.duration>0 && v.currentTime>=v.duration-0.35),
              currentTime: Number(v.currentTime)||0, duration: Number(v.duration)||0, isAd: ad,
            };
          })()`,
          true
        );
        try {
          if (playWin && !playWin.isDestroyed()) {
            // Mute for ads OR user mute — never force-unmute after ad ends
            playWin.webContents.setAudioMuted(userMuted || Boolean(st?.isAd));
          }
        } catch {
          /* ignore */
        }
        return st;
      }
      return { ok: false, error: 'unknown cmd' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    resolveAudio,
    registerProtocol,
    getSes,
    playPage,
    pageCommand,
  };
}

module.exports = { createYtAudio };
