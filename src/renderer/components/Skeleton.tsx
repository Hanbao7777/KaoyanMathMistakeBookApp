import type { ReactNode } from 'react';

function SkeletonBlock({ width, height }: { width?: string; height?: string }) {
  return (
    <div
      className="skeleton-block"
      style={{ width: width || '100%', height: height || '16px' }}
    />
  );
}

export function Skeleton() {
  return <SkeletonBlock />;
}

export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <SkeletonBlock width="60%" height="20px" />
      <SkeletonBlock height="14px" />
      <SkeletonBlock width="80%" height="14px" />
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <SkeletonBlock width="60px" height="24px" />
        <SkeletonBlock width="70px" height="24px" />
        <SkeletonBlock width="50px" height="24px" />
      </div>
    </div>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="skeleton-list">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonPage({ children }: { children?: ReactNode }) {
  return (
    <div className="page">
      <SkeletonBlock width="40%" height="32px" />
      <SkeletonBlock width="60%" height="18px" />
      <div style={{ height: 20 }} />
      <SkeletonList count={3} />
      {children}
    </div>
  );
}
