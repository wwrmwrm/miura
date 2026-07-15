import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

type Props<T> = {
  items: T[];
  /** Fixed row height in px */
  rowHeight: number;
  /**
   * Explicit viewport height. If omitted, uses parent / maxHeight and
   * shrinks to content when the list is shorter (no empty bottom pad).
   */
  height?: number;
  /** Cap when auto-sizing (default: fill parent or 70vh) */
  maxHeight?: number;
  overscan?: number;
  className?: string;
  style?: React.CSSProperties;
  getKey: (item: T, index: number) => string | number;
  renderRow: (item: T, index: number) => React.ReactNode;
};

/**
 * Fixed-row virtual list — only mounts ~viewport rows.
 * Viewport height never exceeds content height (avoids empty bottom gap).
 */
export function VirtualList<T>({
  items,
  rowHeight,
  height,
  maxHeight,
  overscan = 6,
  className,
  style,
  getKey,
  renderRow,
}: Props<T>) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  /** Measured available height from parent / maxHeight prop */
  const [availH, setAvailH] = useState(() => height || maxHeight || 480);

  const total = items.length;
  const contentH = Math.max(0, total * rowHeight);

  // Viewport = min(content, available) — no empty pad under last rows
  const viewportH = height != null
    ? height
    : Math.min(contentH || 0, Math.max(0, availH));

  // If content fits entirely, no need to reserve a tall empty box
  const scrollerH = contentH === 0 ? 0 : height != null ? height : Math.min(contentH, availH);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
  }, []);

  const measure = useCallback(() => {
    if (height != null) return;
    const el = scrollerRef.current;
    if (!el) return;

    let next = maxHeight;
    if (next == null || !Number.isFinite(next)) {
      // Prefer parent client height if parent has a real size
      const parent = el.parentElement;
      const ph = parent?.clientHeight || 0;
      if (ph > 40) {
        next = ph;
      } else {
        // Fallback: remaining viewport under player bar
        next = Math.max(200, Math.min(window.innerHeight * 0.7, window.innerHeight - 280));
      }
    }
    setAvailH((prev) => (Math.abs(prev - next!) < 1 ? prev : next!));
  }, [height, maxHeight]);

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerRef.current = el;
      if (el) measure();
    },
    [measure]
  );

  useLayoutEffect(() => {
    measure();
  }, [measure, total, contentH]);

  useLayoutEffect(() => {
    if (height != null) return;
    const el = scrollerRef.current;
    if (!el) return;
    const parent = el.parentElement;
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => measure())
        : null;
    if (ro) {
      ro.observe(el);
      if (parent) ro.observe(parent);
    }
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [height, measure]);

  // Clamp scrollTop if content shrank
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, contentH - scrollerH);
    if (el.scrollTop > maxScroll) {
      el.scrollTop = maxScroll;
      setScrollTop(maxScroll);
    }
  }, [contentH, scrollerH]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleCount = Math.ceil((viewportH || scrollerH || 1) / rowHeight) + overscan * 2;
  const end = Math.min(total, start + visibleCount);

  const slice = useMemo(() => {
    const out: Array<{ item: T; index: number }> = [];
    for (let i = start; i < end; i++) {
      const item = items[i];
      if (item !== undefined) out.push({ item, index: i });
    }
    return out;
  }, [items, start, end]);

  if (total === 0) {
    return <div className={className} style={{ height: 0, ...style }} />;
  }

  return (
    <div
      ref={setRef}
      className={className}
      style={{
        overflow: contentH > scrollerH ? 'auto' : 'hidden',
        position: 'relative',
        height: scrollerH,
        maxHeight: maxHeight ?? height ?? undefined,
        ...style,
      }}
      onScroll={onScroll}
    >
      <div
        style={{
          height: contentH,
          position: 'relative',
          // Prevent flex/gap on .cat from affecting spacer
          flex: 'none',
          display: 'block',
        }}
      >
        {slice.map(({ item, index }) => (
          <div
            key={getKey(item, index)}
            className="vl-row"
            style={{
              position: 'absolute',
              top: index * rowHeight,
              left: 0,
              right: 0,
              height: rowHeight,
              overflow: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            {renderRow(item, index)}
          </div>
        ))}
      </div>
    </div>
  );
}
