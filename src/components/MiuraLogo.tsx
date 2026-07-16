import React from 'react';

type MarkProps = {
  className?: string;
  /** Hide Japanese kicker under the wordmark */
  compact?: boolean;
};

/**
 * Brand wordmark — matches GitHub banner:
 * thin coral bar + serif “miura” + 音の余白
 */
export function MiuraMark({ className, compact }: MarkProps) {
  return (
    <span
      className={`miura-brand ${compact ? 'is-compact' : ''} ${className || ''}`.trim()}
      aria-label="miura"
    >
      <span className="miura-brand-bar" aria-hidden />
      <span className="miura-brand-stack">
        <span className="miura-logo">miura</span>
        {!compact && <span className="miura-kicker">音 の 余 白</span>}
      </span>
    </span>
  );
}

export function MiuraWordmark(props: { height?: number; className?: string }) {
  return <MiuraMark className={props.className} />;
}

/** Square seal with 音 — bottom-right mark from the banner */
export function MiuraSeal({
  size = 40,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`miura-seal ${className || ''}`.trim()}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      音
    </span>
  );
}

/** Colored source pills as on the GitHub banner */
export function SourcePills({ className }: { className?: string }) {
  return (
    <div className={`src-pills ${className || ''}`.trim()} aria-hidden>
      <span className="src-pill src-pill-local">
        <i />
        Local
      </span>
      <span className="src-pill src-pill-sc">
        <i />
        SoundCloud
      </span>
      <span className="src-pill src-pill-yt">
        <i />
        YouTube
      </span>
    </div>
  );
}

export function MiuraLogo({ size = 22, className }: { size?: number; className?: string }) {
  return <MiuraSeal size={size} className={className} />;
}
