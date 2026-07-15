import React, { useEffect, useState } from 'react';

type Props = {
  /** data: / miura-file: / http artwork if already known */
  artworkUrl?: string | null;
  /** Absolute path of the audio file — used to re-hydrate cover from disk cache */
  filePath?: string | null;
  className?: string;
  placeholder?: string;
};

/**
 * Local track cover. Prefers ready artworkUrl; otherwise loads cached cover
 * for filePath via Electron IPC (avoids flaky custom protocol for images).
 */
export function LocalCover({
  artworkUrl,
  filePath,
  className = 'cat-art',
  placeholder = '♪',
}: Props) {
  const [src, setSrc] = useState<string | null>(() => {
    if (artworkUrl && (artworkUrl.startsWith('data:') || artworkUrl.startsWith('blob:') || artworkUrl.startsWith('http'))) {
      return artworkUrl;
    }
    return artworkUrl || null;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (artworkUrl && (artworkUrl.startsWith('data:') || artworkUrl.startsWith('blob:') || artworkUrl.startsWith('http'))) {
      setSrc(artworkUrl);
      return;
    }
    if (artworkUrl && artworkUrl.startsWith('miura-file:')) {
      setSrc(artworkUrl);
      // also try IPC hydrate as backup if miura-file fails (onError)
    } else {
      setSrc(artworkUrl || null);
    }

    if (!filePath || !window.electronAPI?.localCoverForPath) return;
    // If we already have a data URL, skip disk cache
    if (artworkUrl?.startsWith('data:')) return;

    let cancelled = false;
    (async () => {
      try {
        const r = await window.electronAPI!.localCoverForPath!(filePath);
        if (cancelled) return;
        if (r && r.ok && r.dataUrl) {
          setSrc(r.dataUrl);
          setFailed(false);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artworkUrl, filePath]);

  if (!src || failed) {
    return (
      <div className={`${className} ph`} style={{ borderRadius: 8 }} aria-hidden>
        {placeholder}
      </div>
    );
  }

  return (
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => {
        // Try disk cache once more if we only had miura-file
        if (filePath && window.electronAPI?.localCoverForPath && !src.startsWith('data:')) {
          void window.electronAPI.localCoverForPath(filePath).then((r) => {
            if (r?.ok && r.dataUrl) {
              setSrc(r.dataUrl);
            } else {
              setFailed(true);
            }
          });
          return;
        }
        setFailed(true);
      }}
    />
  );
}
