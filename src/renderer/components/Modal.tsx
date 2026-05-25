import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

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
  const [state, setState] = useState<(ModalOptions & { resolve: (value: boolean) => void }) | null>(null);

  const confirm = useCallback((options: ModalOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...options, resolve });
    });
  }, []);

  const handleClose = (result: boolean) => {
    state?.resolve(result);
    setState(null);
  };

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
