'use client';
// 짧은 알림 토스트(키트 .toast, CMP-018). 화면 아래 가운데에 3초 보이고 role="status"로 한 번 읽힌다.
// 셸 감싸개(widgets/app-shell)가 ToastProvider를 두므로 화면 안 어디서나 useToast()로 띄운다.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type ShowToast = (message: string, icon?: string) => void;
const ToastContext = createContext<ShowToast>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string; icon: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback<ShowToast>((message, icon = 'ic-check-circle') => {
    clearTimeout(timer.current);
    setToast({ id: Date.now(), message, icon });
    timer.current = setTimeout(() => setToast(null), 3000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[95] flex justify-center px-4 lg:bottom-8" role="status" aria-live="polite">
        {toast ? (
          <div key={toast.id} className="toast">
            <i className={`ic ${toast.icon}`} aria-hidden="true" />
            {toast.message}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  return useContext(ToastContext);
}
