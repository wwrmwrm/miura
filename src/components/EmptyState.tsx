import React from 'react';
import { useT } from '../i18n';

type Props = {
  title?: string;
  hint?: string;
  children?: React.ReactNode;
};

/** Simple empty state */
export function EmptyState({ title, hint, children }: Props) {
  const t = useT();
  return (
    <div className="void">
      <h3>{title ?? t.common.empty}</h3>
      {(hint ?? t.common.emptyHint) && <p>{hint ?? t.common.emptyHint}</p>}
      {children}
    </div>
  );
}
