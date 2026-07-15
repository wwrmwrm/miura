import type { Playable } from '../player/types';
import { isAudioFileName } from '../sources/localLibrary';

/** Parse M3U / M3U8 playlist text into absolute/relative file paths + optional titles. */
export function parseM3u(text: string, baseDir?: string): Array<{ path: string; title?: string }> {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  const out: Array<{ path: string; title?: string }> = [];
  let pendingTitle: string | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF:')) {
      // #EXTINF:123,Artist - Title
      const comma = line.indexOf(',');
      pendingTitle = comma >= 0 ? line.slice(comma + 1).trim() : undefined;
      continue;
    }
    if (line.startsWith('#')) continue;

    let p = line;
    // file:// URLs
    if (/^file:\/\//i.test(p)) {
      try {
        p = decodeURIComponent(p.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, ''));
        if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      } catch {
        /* keep */
      }
    }

    // relative → join baseDir
    if (baseDir && !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/') && !p.startsWith('\\\\')) {
      const sep = baseDir.includes('\\') ? '\\' : '/';
      p = baseDir.replace(/[/\\]+$/, '') + sep + p.replace(/^\.?[/\\]/, '');
    }

    if (!isAudioFileName(p) && !/\.(mp3|flac|m4a|aac|wav|ogg|opus)$/i.test(p)) {
      // still allow — user may have unusual ext
    }
    out.push({ path: p, title: pendingTitle });
    pendingTitle = undefined;
  }
  return out;
}

export function exportM3u(tracks: Playable[], opts?: { absolute?: boolean }): string {
  const lines = ['#EXTM3U'];
  for (const t of tracks) {
    if (!t.filePath) continue;
    const sec = t.durationMs ? Math.round(t.durationMs / 1000) : -1;
    const title = `${t.artist || 'Unknown'} - ${t.title || 'Track'}`;
    lines.push(`#EXTINF:${sec},${title}`);
    lines.push(t.filePath);
  }
  return lines.join('\n') + '\n';
}
