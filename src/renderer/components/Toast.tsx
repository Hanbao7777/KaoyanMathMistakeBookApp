import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type ToastType = 'success' | 'warning' | 'error';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  exiting: boolean;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, 300);
    timersRef.current.set(id, timer);
  }, []);

  const toast = useCallback((message: string, type: ToastType = 'success') => {
    const id = nextId++;
    setToasts((prev) => [...prev.slice(-4), { id, message, type, exiting: false }]);
    const timer = setTimeout(() => removeToast(id), 4000);
    timersRef.current.set(id, timer);
  }, [removeToast]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => { timers.forEach((t) => clearTimeout(t)); };
  }, []);

  const value: ToastContextValue = { toast };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container" role="status" aria-live="polite">
        {toasts.map((t) => {
          const icon = t.type === 'success' ? '✓' : t.type === 'warning' ? '⚠' : '✕';
          return (
            <div key={t.id} className={`toast-item toast-${t.type}${t.exiting ? ' toast-exit' : ''}`}>
              <span className="toast-icon">{icon}</span>
              <span className="toast-message">{t.message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
