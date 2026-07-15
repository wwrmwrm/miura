import React from 'react';

/** Simple elegant wordmark — just “miura” */
export function MiuraMark({ className }: { className?: string }) {
  return (
    <span className={`miura-logo ${className || ''}`.trim()} aria-label="miura">
      miura
    </span>
  );
}

export function MiuraWordmark(props: { height?: number; className?: string }) {
  return <MiuraMark className={props.className} />;
}

export function MiuraLogo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--accent)',
        display: 'inline-block',
      }}
      aria-hidden
    />
  );
}
