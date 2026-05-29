import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface ContextMenuAction {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onClick?: () => void;
  children?: Omit<ContextMenuAction, 'children'>[];
}

interface ContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
}

export function ContextMenu({ x, y, actions, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [submenuIndex, setSubmenuIndex] = useState<number | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    const handler = () => onClose();
    document.addEventListener('scroll', handler, true);
    return () => document.removeEventListener('scroll', handler, true);
  }, [onClose]);

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 180);
  const adjustedY = Math.min(y, window.innerHeight - actions.length * 36 - 8);

  const subAction = submenuIndex !== null ? actions[submenuIndex] : null;
  const subItems = subAction?.children;
  const subCount = subItems ? subItems.length : 0;

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: adjustedX,
        top: adjustedY,
        zIndex: 9999,
        background: 'var(--tt-bg)',
        border: '1px solid var(--tt-border)',
        borderRadius: 'var(--tt-radius-md)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        minWidth: 160,
        padding: '4px 0',
      }}
    >
      {actions.map((action, i) => {
        const hasChildren = action.children && action.children.length > 0;
        return (
          <button
            key={i}
            onClick={() => {
              if (hasChildren) {
                setSubmenuIndex(submenuIndex === i ? null : i);
              } else {
                action.onClick?.();
                onClose();
              }
            }}
            onMouseEnter={() => { if (hasChildren) setSubmenuIndex(i); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '8px 14px',
              border: 'none',
              background: submenuIndex === i ? 'var(--tt-bg-hover)' : 'none',
              cursor: 'pointer',
              fontSize: 13,
              color: action.danger ? 'var(--tt-danger)' : 'var(--tt-text)',
              textAlign: 'left',
            }}
            type="button"
          >
            {action.icon}
            {action.label}
            {hasChildren ? <ChevronRight size={12} style={{ marginLeft: 'auto', opacity: 0.5 }} /> : null}
          </button>
        );
      })}

      {subItems ? (
        <div
          onMouseLeave={() => setSubmenuIndex(null)}
          style={{
            position: 'fixed',
            left: adjustedX + 170,
            top: adjustedY + submenuIndex! * 36 - 4,
            zIndex: 10000,
            background: 'var(--tt-bg)',
            border: '1px solid var(--tt-border)',
            borderRadius: 'var(--tt-radius-md)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            minWidth: 160,
            padding: '4px 0',
          }}
        >
          {subItems.map((child, j) => (
            <button
              key={j}
              onClick={() => { child.onClick?.(); onClose(); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 14px',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                fontSize: 13,
                color: child.danger ? 'var(--tt-danger)' : 'var(--tt-text)',
                textAlign: 'left',
              }}
              type="button"
            >
              {child.icon}
              {child.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
