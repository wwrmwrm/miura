import React, { useCallback, useEffect, useState } from 'react';

/**
 * Custom top chrome with brand strip + − □ × controls (Windows frameless).
 * On macOS traffic lights stay native; buttons are still shown as no-ops style-only skip.
 */
export function TitleBar({ subtitle }: { subtitle?: string }) {
  const [maximized, setMaximized] = useState(false);
  const isElectron = typeof window !== 'undefined' && Boolean(window.electronAPI?.windowMinimize);
  // Hide custom caption buttons on macOS — native traffic lights are used
  const showControls =
    isElectron && typeof navigator !== 'undefined' && !/Mac/i.test(navigator.platform || '');

  useEffect(() => {
    if (!window.electronAPI?.windowIsMaximized) return;
    void window.electronAPI.windowIsMaximized().then((r) => {
      if (r?.maximized != null) setMaximized(r.maximized);
    });
    const off = window.electronAPI.onWindowMaximized?.((v) => setMaximized(v));
    return () => {
      off?.();
    };
  }, []);

  const onMinimize = useCallback(() => {
    void window.electronAPI?.windowMinimize?.();
  }, []);

  const onMaximize = useCallback(() => {
    void window.electronAPI?.windowMaximizeToggle?.().then((r) => {
      if (typeof r?.maximized === 'boolean') setMaximized(r.maximized);
    });
  }, []);

  const onClose = useCallback(() => {
    void window.electronAPI?.windowClose?.();
  }, []);

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      // Double-click titlebar to maximize (Windows convention)
      if ((e.target as HTMLElement).closest('.titlebar-controls')) return;
      onMaximize();
    },
    [onMaximize]
  );

  return (
    <header className="titlebar" aria-label="miura" onDoubleClick={onDoubleClick}>
      <div className="titlebar-inner">
        <span className="titlebar-seal" aria-hidden>
          音
        </span>
        <span className="titlebar-name">miura</span>
        <span className="titlebar-sep" aria-hidden />
        <span className="titlebar-kicker">{subtitle || '音 の 余 白'}</span>
      </div>

      {showControls && (
        <div className="titlebar-controls">
          <button
            type="button"
            className="titlebar-btn titlebar-btn-min"
            onClick={onMinimize}
            title="Свернуть"
            aria-label="Свернуть"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 6.25h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-btn-max"
            onClick={onMaximize}
            title={maximized ? 'Восстановить' : 'Развернуть'}
            aria-label={maximized ? 'Восстановить' : 'Развернуть'}
          >
            {maximized ? (
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
                <path
                  d="M3.5 4.5h5v5h-5zM4.5 3.5h5v1M9.5 3.5v5h-1"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.15"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
                <rect
                  x="2.4"
                  y="2.4"
                  width="7.2"
                  height="7.2"
                  rx="0.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.15"
                />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-btn-close"
            onClick={onClose}
            title="Закрыть"
            aria-label="Закрыть"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
              <path
                d="M3 3l6 6M9 3L3 9"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}
    </header>
  );
}
