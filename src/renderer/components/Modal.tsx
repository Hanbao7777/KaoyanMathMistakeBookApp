import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface ModalOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ModalContextValue {
  confirm: (options: ModalOptions) => Promise<boolean>;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function useModal() {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal must be used within ModalProvider');
  return ctx;
}

export function ModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ModalOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const handleClose = useCallback((result: boolean) => {
    if (resolveRef.current) {
      resolveRef.current(result);
      resolveRef.current = null;
    }
    setState(null);
  }, []);

  const confirm = useCallback((options: ModalOptions) => {
    // Issue 1: resolve prior promise so it does not hang forever
    if (resolveRef.current) {
      resolveRef.current(false);
      resolveRef.current = null;
    }
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setState(options);
    });
  }, []);

  // Issue 2: resolve on unmount so the promise does not leak
  useEffect(() => {
    return () => {
      if (resolveRef.current) {
        resolveRef.current(false);
        resolveRef.current = null;
      }
    };
  }, []);

  // Issue 3: dismiss on Escape key
  useEffect(() => {
    if (!state) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [state, handleClose]);

  return (
    <ModalContext.Provider value={{ confirm }}>
      {children}
      {state ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="confirm-modal">
            <h2>{state.title}</h2>
            <p>{state.message}</p>
            <div className="confirm-modal-actions">
              <button className="secondary-button" type="button" onClick={() => handleClose(false)}>
                {state.cancelLabel || '取消'}
              </button>
              <button
                className={state.danger ? 'primary-button danger-button' : 'primary-button'}
                type="button"
                onClick={() => handleClose(true)}
              >
                {state.confirmLabel || '确认'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ModalContext.Provider>
  );
}
