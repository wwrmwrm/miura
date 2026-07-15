import React from 'react';

export function Ico({
  children,
  size = 18,
  className,
}: {
  children: React.ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const IconHeart = ({ filled, size = 18 }: { filled?: boolean; size?: number }) => (
  <Ico size={size}>
    <path
      d="M12 20s-7-4.4-7-10a4 4 0 017-2.5A4 4 0 0119 10c0 5.6-7 10-7 10z"
      fill={filled ? 'currentColor' : 'none'}
    />
  </Ico>
);

export const IconRepost = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M17 1l4 4-4 4" />
    <path d="M3 11V9a4 4 0 014-4h14" />
    <path d="M7 23l-4-4 4-4" />
    <path d="M21 13v2a4 4 0 01-4 4H3" />
  </Ico>
);

export const IconStation = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M6 14v-4" />
    <path d="M10 17V7" />
    <path d="M14 15V9" />
    <path d="M18 13v-2" />
    <circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none" />
  </Ico>
);

export const IconLink = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M10 13a5 5 0 007.07 0l1.41-1.41a5 5 0 00-7.07-7.07L10 5.93" />
    <path d="M14 11a5 5 0 00-7.07 0L5.52 12.4a5 5 0 007.07 7.07L14 18.07" />
  </Ico>
);

export const IconExternal = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M14 3h7v7" />
    <path d="M10 14L21 3" />
    <path d="M21 14v6a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1h6" />
  </Ico>
);

export const IconPlay = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M9 6.5v11l9-5.5-9-5.5z" fill="currentColor" stroke="none" />
  </Ico>
);

export const IconUserPlus = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M19 8v6M22 11h-6" />
  </Ico>
);

export const IconUserCheck = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M16 11l2 2 4-4" />
  </Ico>
);

export const IconCheck = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M20 6L9 17l-5-5" />
  </Ico>
);

export const IconEdit = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
  </Ico>
);

export const IconTrash = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14H6L5 6" />
    <path d="M10 11v6M14 11v6" />
  </Ico>
);

export const IconImage = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="M21 15l-5-5L5 21" />
  </Ico>
);

export const IconPlus = ({ size = 18 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M12 5v14M5 12h14" />
  </Ico>
);
