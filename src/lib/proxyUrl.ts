/** Helpers for proxy URL compose / parse in settings UI. */

export type ProxyScheme = 'socks5' | 'socks4' | 'http' | 'https';

export type ProxyParts = {
  scheme: ProxyScheme;
  host: string;
  port: string;
  user: string;
  pass: string;
};

export const PROXY_PRESETS: Array<{
  id: string;
  /** i18n key under settings.* or plain label fallback */
  labelKey: string;
  label: string;
  scheme: ProxyScheme;
  host: string;
  port: string;
}> = [
  { id: 'clash-http', labelKey: 'proxyPresetClashHttp', label: 'Clash HTTP', scheme: 'http', host: '127.0.0.1', port: '7890' },
  { id: 'clash-socks', labelKey: 'proxyPresetClashSocks', label: 'Clash SOCKS', scheme: 'socks5', host: '127.0.0.1', port: '7891' },
  { id: 'v2rayn', labelKey: 'proxyPresetV2rayn', label: 'v2rayN', scheme: 'socks5', host: '127.0.0.1', port: '10808' },
  { id: 'hiddify', labelKey: 'proxyPresetHiddify', label: 'Hiddify', scheme: 'socks5', host: '127.0.0.1', port: '12334' },
  { id: 'socks1080', labelKey: 'proxyPresetSocks1080', label: 'SOCKS :1080', scheme: 'socks5', host: '127.0.0.1', port: '1080' },
  { id: 'http8080', labelKey: 'proxyPresetHttp8080', label: 'HTTP :8080', scheme: 'http', host: '127.0.0.1', port: '8080' },
];

/** Ports to probe on 127.0.0.1 when looking for a local client */
export const LOCAL_PROBE_PORTS: Array<{ port: number; scheme: ProxyScheme; hint: string }> = [
  { port: 7890, scheme: 'http', hint: 'Clash / Mihomo HTTP' },
  { port: 7891, scheme: 'socks5', hint: 'Clash SOCKS' },
  { port: 7897, scheme: 'http', hint: 'Clash mixed' },
  { port: 10808, scheme: 'socks5', hint: 'v2rayN' },
  { port: 10809, scheme: 'http', hint: 'v2rayN HTTP' },
  { port: 12334, scheme: 'socks5', hint: 'Hiddify / custom' },
  { port: 1080, scheme: 'socks5', hint: 'SOCKS' },
  { port: 1081, scheme: 'socks5', hint: 'SOCKS alt' },
  { port: 2080, scheme: 'socks5', hint: 'Nekoray' },
  { port: 6152, scheme: 'socks5', hint: 'Surge / others' },
  { port: 6153, scheme: 'http', hint: 'Surge HTTP' },
  { port: 20171, scheme: 'socks5', hint: 'NekoBox' },
  { port: 20172, scheme: 'http', hint: 'NekoBox HTTP' },
];

export function emptyParts(): ProxyParts {
  return { scheme: 'socks5', host: '127.0.0.1', port: '12334', user: '', pass: '' };
}

export function parseProxyUrl(raw: string): ProxyParts {
  const base = emptyParts();
  let s = String(raw || '').trim();
  if (!s) return base;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // host:port or just port
    if (/^\d{2,5}$/.test(s)) s = `socks5://127.0.0.1:${s}`;
    else if (/^[^/]+:\d+/.test(s)) s = `socks5://${s}`;
    else s = `socks5://${s}`;
  }
  try {
    const u = new URL(s);
    let schemeRaw = u.protocol.replace(':', '').toLowerCase();
    if (schemeRaw === 'socks') schemeRaw = 'socks5';
    const scheme = (
      ['socks5', 'socks4', 'http', 'https'].includes(schemeRaw) ? schemeRaw : 'socks5'
    ) as ProxyScheme;
    return {
      scheme,
      host: u.hostname || '127.0.0.1',
      port: u.port || (scheme.startsWith('socks') ? '1080' : '8080'),
      user: u.username ? decodeURIComponent(u.username) : '',
      pass: u.password ? decodeURIComponent(u.password) : '',
    };
  } catch {
    return base;
  }
}

export function buildProxyUrl(p: ProxyParts): string {
  const host = (p.host || '127.0.0.1').trim() || '127.0.0.1';
  const port = String(p.port || '').trim() || (p.scheme.startsWith('socks') ? '1080' : '8080');
  const scheme = p.scheme || 'socks5';
  let auth = '';
  if (p.user || p.pass) {
    auth = `${encodeURIComponent(p.user || '')}:${encodeURIComponent(p.pass || '')}@`;
  }
  return `${scheme}://${auth}${host}:${port}`;
}

export function matchPresetId(url: string): string | null {
  const built = buildProxyUrl(parseProxyUrl(url));
  for (const pr of PROXY_PRESETS) {
    const u = buildProxyUrl({
      scheme: pr.scheme,
      host: pr.host,
      port: pr.port,
      user: '',
      pass: '',
    });
    if (u === built) return pr.id;
  }
  return null;
}
