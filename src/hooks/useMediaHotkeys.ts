import { useEffect } from 'react';

type Handlers = {
  toggle: () => void;
  next: () => void;
  prev: () => void;
  stop?: () => void;
};

/** Keyboard + Media Session API + Electron IPC media keys */
export function useMediaHotkeys(h: Handlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) {
        return;
      }
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        h.toggle();
      } else if (e.code === 'ArrowRight' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        h.next();
      } else if (e.code === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        h.prev();
      } else if (e.code === 'MediaPlayPause') {
        e.preventDefault();
        h.toggle();
      } else if (e.code === 'MediaTrackNext') {
        e.preventDefault();
        h.next();
      } else if (e.code === 'MediaTrackPrevious') {
        e.preventDefault();
        h.prev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [h]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => h.toggle());
      navigator.mediaSession.setActionHandler('pause', () => h.toggle());
      navigator.mediaSession.setActionHandler('previoustrack', () => h.prev());
      navigator.mediaSession.setActionHandler('nexttrack', () => h.next());
      navigator.mediaSession.setActionHandler('stop', () => h.stop?.());
    } catch {
      /* ignore */
    }
  }, [h]);

  useEffect(() => {
    const api = window.electronAPI as
      | { onMediaCommand?: (cb: (cmd: string) => void) => () => void }
      | undefined;
    if (!api?.onMediaCommand) return;
    return api.onMediaCommand((cmd) => {
      if (cmd === 'toggle') h.toggle();
      else if (cmd === 'next') h.next();
      else if (cmd === 'prev') h.prev();
    });
  }, [h]);
}
