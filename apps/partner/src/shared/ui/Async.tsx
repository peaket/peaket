'use client';
// 화면이 API를 부를 때 같은 로딩·실패·빈 모양을 쓴다. 요청은 화면이 사라지면 끊는다(docs/frontend.md §4.4).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { problemMessage } from '@/shared/api/problem';

export type AsyncState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: unknown };

export type AsyncResult<T> = AsyncState<T> & {
  reload: () => void;
  setData: (next: T) => void;
};

/**
 * key가 바뀌면 다시 부른다. load는 매 렌더 새 함수여도 되고, 마지막 것만 쓴다.
 * reload는 같은 key로 한 번 더 부른다.
 */
export function useAsync<T>(key: string, load: (signal: AbortSignal) => Promise<T>): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading', data: null, error: null });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    setState({ status: 'loading', data: null, error: null });
    loadRef.current(ac.signal).then(
      (data) => {
        if (alive) setState({ status: 'ready', data, error: null });
      },
      (error: unknown) => {
        if (alive && !ac.signal.aborted) setState({ status: 'error', data: null, error });
      },
    );
    return () => {
      alive = false;
      ac.abort();
    };
  }, [key, tick]);
  const reload = useCallback(() => setTick((v) => v + 1), []);
  const setData = useCallback((next: T) => setState({ status: 'ready', data: next, error: null }), []);
  return { ...state, reload, setData };
}

export function LoadingCard({ label = '불러오는 중입니다' }: { label?: string }) {
  return (
    <div className="card-flat pad col" style={{ gap: 8 }} role="status">
      <p className="row t-sm" style={{ gap: 8 }}>
        <span className="spinner" aria-hidden="true" style={{ color: 'var(--link)' }} />
        {label}
      </p>
      <div className="progress" aria-hidden="true">
        <span style={{ width: '38%' }} />
      </div>
    </div>
  );
}

export function ErrorCard({ error, onRetry, fallback }: { error: unknown; onRetry?: () => void; fallback: string }) {
  return (
    <div className="banner banner-danger" role="alert">
      <i className="ic ic-alert-circle" aria-hidden="true" />
      <div className="banner-body col" style={{ gap: 8 }}>
        <span className="banner-title">{problemMessage(error, fallback)}</span>
        {onRetry ? (
          <button className="btn btn-outline btn-sm" type="button" onClick={onRetry} style={{ alignSelf: 'flex-start' }}>
            다시 불러오기
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyCard({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card-flat pad col" style={{ gap: 6 }}>
      <p className="t-sm fw-b">{title}</p>
      {children ? <p className="t-sm muted">{children}</p> : null}
    </div>
  );
}
