import React from 'react';
import type { MusicSource } from '../player/types';
import { trackSource } from '../player/playableBridge';
import type { Track } from '../types';

const LABEL: Record<string, string> = {
  local: 'Local',
  soundcloud: 'SC',
};

export function SourceBadge({
  source,
  track,
}: {
  source?: MusicSource | string;
  track?: Track | null;
}) {
  const s = source || (track ? trackSource(track) : 'soundcloud');
  const key = String(s || 'soundcloud');
  return (
    <span className={`src-badge src-badge-${key}`} title={key}>
      <span className="src-badge-dot" aria-hidden />
      {LABEL[key] || key}
    </span>
  );
}
