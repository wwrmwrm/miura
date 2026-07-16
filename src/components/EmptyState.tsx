import React from 'react';
import { useT } from '../i18n';
import { MiuraSeal } from './MiuraLogo';

type Props = {
  title?: string;
  hint?: string;
  children?: React.ReactNode;
};

/** Empty state with banner-style 音 seal */
export function EmptyState({ title, hint, children }: Props) {
  const t = useT();
  return (
    <div className="void">
      <div className="void-seal">
        <MiuraSeal size={48} />
      </div>
      <h3>{title ?? t.common.empty}</h3>
      {(hint ?? t.common.emptyHint) && <p>{hint ?? t.common.emptyHint}</p>}
      {children}
    </div>
  );
}
