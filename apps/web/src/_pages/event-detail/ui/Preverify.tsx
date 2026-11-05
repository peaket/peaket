'use client';
// SCR-002 사전 사람 확인(CMP-047)과 사전 검증 토큰(ADR-0211, docs/frontend.md §4.2.1 3번, d5 §5.2 '사전 사람 확인'·'오픈 뒤 진입').
// 첫 화면 묶음에는 가벼운 부분만 둔다(§5.8 첫 JS): 저장된 토큰 읽기, 행동 신호 요약(수·간격만, ADR-0065 결정 9), 카드와 버튼.
// 흐름(features/preverify/flow.ts)·대화상자·위젯·API 호출은 첫 그리기 뒤 늦게 싣는 PreverifyHost가 맡는다. 그 전에 누르면 실린 뒤 이어서 한다.
// - 선착순 오픈 전: 카드가 "오픈 전에 확인을 마쳐 두세요"와 [확인하기]를 보이고, 통과하면 '확인 완료'와 남은 시간이다(만료 2분 전 조용히 갱신).
// - 오픈 뒤 [대기열 들어가기]: 이미 줄을 섰거나 유효한 토큰이 있으면 바로 대기실로, 없으면 사람 확인 대화상자를 거친다.
// 위젯은 대화상자 안 자리 하나와 조용한 갱신용 숨긴 자리 하나에만 그린다(카드는 휴대폰 히어로와 데스크톱 패널에 둘이라 위젯을 갖지 않는다).
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createBehaviorTracker, readPreverify, type KV, type Preverify } from '@/features/preverify/model';
import { browserClock } from '@/shared/lib/clock';

const PreverifyHost = lazy(() => import('./PreverifyHost'));

export type PreverifyStep = 'idle' | 'checking' | 'sending' | 'failed' | 'unavailable' | 'not-open' | 'verify' | 'retry' | 'storage';

/** 흐름이 내는 화면 값(flow.ts FlowState와 같은 모양) */
export interface PreverifyView {
  token: Preverify | null;
  step: PreverifyStep;
  open: boolean;
  intent: 'early' | 'enter';
  retryAt?: number;
}

/** 늦게 싣는 쪽이 꽂는 동작 */
export interface PreverifyActions {
  check(): void;
  enter(): void;
  retry(): void;
  close(): void;
}

interface PreverifyCtx {
  view: PreverifyView;
  check(): void;
  enter(): void;
}

const IDLE: PreverifyView = { token: null, step: 'idle', open: false, intent: 'early' };
const Ctx = createContext<PreverifyCtx>({ view: IDLE, check: () => undefined, enter: () => undefined });
export const usePreverify = (): PreverifyCtx => useContext(Ctx);

export function preverifyStorage(): KV | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function PreverifyProvider({ eventId, loginHref, children }: { eventId: string; loginHref: string; children: ReactNode }) {
  const [view, setView] = useState<PreverifyView>(IDLE);
  const [mounted, setMounted] = useState(false);
  const actions = useRef<PreverifyActions | null>(null);
  const pending = useRef<'check' | 'enter' | null>(null);
  const tracker = useRef<ReturnType<typeof createBehaviorTracker> | null>(null);

  // 첫 그리기 뒤: 저장된 토큰을 읽고, 행동 신호를 이 화면이 열린 동안만 센다(좌표·키 값은 남기지 않는다)
  useEffect(() => {
    setMounted(true);
    setView((v) => ({ ...v, token: readPreverify(preverifyStorage(), eventId, browserClock().now()) }));
    const t = createBehaviorTracker(() => performance.now());
    tracker.current = t;
    let lastY = window.scrollY;
    const move = (e: PointerEvent) => t.move(e.clientX, e.clientY);
    const tap = () => t.input();
    // 키를 누르고 있을 때의 자동 반복은 입력 간격에 넣지 않는다
    const key = (e: KeyboardEvent) => {
      if (!e.repeat) t.input();
    };
    const scroll = () => {
      t.scroll(window.scrollY - lastY);
      lastY = window.scrollY;
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', tap, { passive: true });
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, { passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', tap);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll);
    };
  }, [eventId]);

  const bind = useCallback((a: PreverifyActions | null) => {
    actions.current = a;
    if (a && pending.current) {
      a[pending.current]();
      pending.current = null;
    }
  }, []);
  const check = useCallback(() => {
    if (actions.current) actions.current.check();
    else pending.current = 'check';
  }, []);
  const enter = useCallback(() => {
    if (actions.current) actions.current.enter();
    else pending.current = 'enter';
  }, []);
  const summary = useCallback(() => tracker.current?.summary(), []);

  return (
    <Ctx.Provider value={{ view, check, enter }}>
      {children}
      {mounted ? (
        <Suspense fallback={null}>
          <PreverifyHost eventId={eventId} loginHref={loginHref} summary={summary} onView={setView} bind={bind} />
        </Suspense>
      ) : null}
    </Ctx.Provider>
  );
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** 선착순 오픈 전의 사전 사람 확인 카드(CMP-047). 통과하면 '확인 완료'와 남은 시간이다(남은 시간은 낭독하지 않는다) */
export function PreverifyCard({ className }: { className?: string }) {
  const { view, check } = usePreverify();
  const token = view.token;
  const [left, setLeft] = useState<number | null>(null);
  // 휴대폰 히어로와 데스크톱 패널에 하나씩 그려 id가 겹치지 않게 한다
  const hId = useId();
  useEffect(() => {
    if (!token) {
      setLeft(null);
      return;
    }
    const update = () => setLeft(token.expiresAt - browserClock().now());
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [token]);
  const passed = token !== null && left !== null && left > 0;
  return (
    <section className={`card col ${className ?? ''}`} style={{ gap: 8 }} aria-labelledby={hId}>
      <div className="row between" style={{ gap: 10 }}>
        <h2 className="t-md fw-b row" id={hId} style={{ gap: 8 }}>
          <i className={`ic ic-shield ${passed ? 'tx-success' : 'muted'}`} aria-hidden="true" />
          사람 확인
        </h2>
        {passed ? (
          <span className="badge badge-success">
            <i className="ic ic-check" aria-hidden="true" />
            확인 완료
          </span>
        ) : (
          <button type="button" className="btn btn-outline btn-sm" aria-haspopup="dialog" onClick={check}>
            확인하기
          </button>
        )}
      </div>
      <p className="t-sm muted">
        오픈 전에 확인을 마쳐 두세요. 확인은 15분 동안 유효하고 그동안 조용히 갱신됩니다
        {passed ? (
          <span aria-hidden="true">
            {' '}
            · 남은 시간 <span className="num">{mmss(left)}</span>
          </span>
        ) : null}
      </p>
    </section>
  );
}
