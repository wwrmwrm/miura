import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

type Props = {
  imageUrl: string;
  /** Initial focal point 0–100 */
  posX?: number;
  posY?: number;
  onCancel: () => void;
  onSave: (pos: { x: number; y: number }) => void;
};

/**
 * Twitter/Discord-style cover reposition:
 * drag the image inside a fixed banner frame to choose the visible area.
 */
export function BannerPositionEditor({ imageUrl, posX = 50, posY = 50, onCancel, onSave }: Props) {
  const t = useT();
  const [x, setX] = useState(clamp(posX));
  const [y, setY] = useState(clamp(posY));
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setX(clamp(posX));
    setY(clamp(posY));
  }, [imageUrl, posX, posY]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    last.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    // Drag image opposite to pointer (like cover reposition UIs)
    const sensX = rect.width > 0 ? (dx / rect.width) * 100 : 0;
    const sensY = rect.height > 0 ? (dy / rect.height) * 100 : 0;
    setX((v) => clamp(v - sensX));
    setY((v) => clamp(v - sensY));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="banner-editor-overlay" role="dialog" aria-modal="true" aria-label={t.profile.repositionBanner}>
      <div className="banner-editor-card">
        <h2>{t.profile.repositionBanner}</h2>
        <p className="banner-editor-hint">{t.profile.repositionHint}</p>

        <div
          ref={frameRef}
          className="banner-editor-frame"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div
            className="banner-editor-img"
            style={{
              backgroundImage: `url(${imageUrl})`,
              backgroundPosition: `${x}% ${y}%`,
            }}
          />
          <div className="banner-editor-guide" aria-hidden />
        </div>

        <div className="banner-editor-sliders">
          <label>
            <span>{t.profile.bannerHorizontal}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(x)}
              onChange={(e) => setX(Number(e.target.value))}
            />
          </label>
          <label>
            <span>{t.profile.bannerVertical}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(y)}
              onChange={(e) => setY(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="banner-editor-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t.common.cancel}
          </button>
          <button type="button" className="btn" onClick={() => { setX(50); setY(50); }}>
            {t.profile.bannerCenter}
          </button>
          <button type="button" className="btn solid" onClick={() => onSave({ x, y })}>
            {t.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}

function clamp(n: number) {
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
}
