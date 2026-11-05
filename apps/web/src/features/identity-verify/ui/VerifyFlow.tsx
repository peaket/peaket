'use client';
// SCR-006 본인확인 흐름(d5 §5.6, d3 SCR-006 행, 캔버스 보드 SCR-006-m·t·d). 별도 화면이 없고 부르는 화면 위에서 돈다(ADR-0063):
// [휴대폰 본인확인] → 본인확인기관 창(팝업) + 부르는 화면의 "본인확인 창에서 진행해 주세요" → 결과 대화상자 또는 완료 토스트.
// - 기관 창은 퍼블리싱용 근사다(design.md 결정 8): 보드처럼 문서 안의 창 모양만 그린다. 버튼을 눌러 연 창에는
//   d5 §5.6 '시연 흉내 방법'대로 결과를 고르는 시험 버튼을 둔다(추천안). 상태 미리보기(?state=)로 연 창은 보드 그대로 aria-hidden이다.
// - 결과 대화상자는 휴대폰 시트, md 이상 대화상자(WebShellModal). 닫으면 초점이 연 버튼으로 돌아간다(d3 SCR-006 접근성).
// - 부르는 화면은 VerifyFlowProvider로 감싸고 VerifyTrigger·VerifyWaitingStatus·VerifyShow를 둔다. 버튼 하나만 이으면 VerifyIdentityButton.
// - 실제 흐름(BUILD_ORDER BOT-010, docs/features/identity.md §5 '모의 기관과 기관 창 흐름'): 팬 API 출처가 있고 상태 미리보기가 아니면
//   버튼이 진짜 기관 창을 연다(../flow.ts). 부스 대조는 그 경로(BUILD_ORDER GAT-190 쪽)가 붙기 전까지 시험 창이다.
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { WebShellModal, webModalButtonClass } from '@peaket/ds/WebShell';
import { sleep } from '@/shared/lib/sleep';
import { useToast } from '@/shared/ui/toast';
import { browserCallerEnv, browserSessionStore, browserVerifyApi, isLiveVerify } from '../browser';
import { resumeReturnedResult, startCallerFlow } from '../flow';
import {
  BOOTH_CONSENT,
  demoOutcomes,
  VERIFY_DONE_TOAST,
  VERIFY_PURPOSE_TEXT,
  VERIFY_RESULT_COPY,
  VERIFY_WAITING_TEXT,
  type VerifyOutcome,
  type VerifyPurpose,
} from '../model';

type ResultOutcome = Exclude<VerifyOutcome, 'success'>;

/** 처음 그릴 모양(상태 미리보기). 없으면 아무것도 열지 않은 모양 */
export interface VerifyFlowInitial {
  /** 기관 창이 열려 기다리는 중 */
  waiting?: boolean;
  /** 열어 둔 결과 대화상자 */
  outcome?: ResultOutcome | null;
  /** 부스 대조 동의 시트를 연다(동의 없음 오류를 보인 채) */
  consentError?: boolean;
  /** 이미 마침(완료 토스트 상태) */
  done?: boolean;
  /** 부스 대조 동의를 이미 했다(1/3단계 끝) */
  consented?: boolean;
}

interface Flow {
  purpose: VerifyPurpose;
  waiting: boolean;
  done: boolean;
  consented: boolean;
  /** 트리거를 누름: 부스 대조에서 동의 전이면 동의 시트, 아니면 기관 창. 누른 버튼을 기억해 창을 닫은 뒤 초점을 돌려준다 */
  begin: (trigger?: HTMLElement) => void;
  /** 동의 시트를 연다 */
  askConsent: (trigger?: HTMLElement) => void;
}

const FlowContext = createContext<Flow | null>(null);

function useFlow(): Flow {
  const f = useContext(FlowContext);
  if (!f) throw new Error('VerifyFlowProvider 안에서 써야 합니다');
  return f;
}

export interface VerifyFlowProviderProps {
  purpose?: VerifyPurpose;
  initial?: VerifyFlowInitial;
  /** '다른 계정의 본인'의 [로그인] 주소 */
  loginHref?: string;
  children: ReactNode;
}

export function VerifyFlowProvider({ purpose = 'first', initial, loginHref = '/login', children }: VerifyFlowProviderProps) {
  const toast = useToast();
  // 미리보기로 연 기관 창은 보드 그대로(시험 버튼 없음), 사용자가 연 창은 시험용 결과 고르기를 둔다. live는 진짜 기관 창이 열려 있다
  const [popup, setPopup] = useState<'none' | 'preview' | 'demo' | 'live'>(initial?.waiting ? 'preview' : 'none');
  // 실제 흐름: 상태 미리보기가 아니고 팬 API 출처가 있을 때(부스 대조는 아직 시험 창). 출처는 빌드 때 정해지는 값이라 서버·브라우저가 같다
  const live = initial === undefined && purpose !== 'booth' && isLiveVerify();
  const flowRef = useRef<{ cancel(): void } | null>(null);
  const [outcome, setOutcome] = useState<ResultOutcome | null>(initial?.outcome ?? null);
  const [consent, setConsent] = useState<{ open: boolean; error: boolean }>({ open: !!initial?.consentError, error: !!initial?.consentError });
  const [consented, setConsented] = useState(initial?.consented ?? purpose !== 'booth');
  const [done, setDone] = useState(!!initial?.done);
  const [staticToast, setStaticToast] = useState(!!initial?.done);
  const triggerRef = useRef<HTMLElement | null>(null);

  // 결과 대화상자·기관 창을 닫으면 초점을 본인확인 버튼 자리로 돌린다(d3 SCR-006). 연 버튼이 없으면(상태 미리보기) 보이는 첫 트리거
  const returnFocus = useCallback(() => {
    requestAnimationFrame(() => {
      const remembered = triggerRef.current;
      const target =
        remembered && remembered.isConnected && remembered.getClientRects().length > 0
          ? remembered
          : Array.from(document.querySelectorAll<HTMLElement>('[data-verify-trigger]')).find((el) => el.getClientRects().length > 0);
      target?.focus();
    });
  }, []);

  const pick = useCallback(
    (o: VerifyOutcome) => {
      setPopup('none');
      if (o === 'success') {
        // 늦게 온 결과가 앞서 띄운 '창을 닫음·실패'를 바꿀 수 있다(flow.ts 늦은 메시지)
        setOutcome(null);
        setDone(true);
        setStaticToast(false);
        toast(VERIFY_DONE_TOAST);
        returnFocus();
      } else setOutcome(o);
    },
    [toast, returnFocus],
  );

  // 실제 흐름은 누른 동작 안에서 시작해야 한다(창을 먼저 열어 팝업 차단을 피한다, identity §5)
  const openWindow = useCallback(() => {
    setOutcome(null);
    if (!live) {
      setPopup('demo');
      return;
    }
    flowRef.current?.cancel();
    flowRef.current = startCallerFlow(browserCallerEnv(), {
      purpose: purpose === 'reverify' ? 'REVERIFY' : 'FIRST',
      onWaiting: () => setPopup('live'),
      // 흐름은 다음 시도나 화면을 떠날 때 끝낸다(창이 닫힌 뒤에도 늦은 메시지를 들을 수 있다)
      onDone: (o) => pick(o),
    });
  }, [live, purpose, pick]);

  // 페이지 이동으로 돌아왔으면(복귀 화면 → next) 그 건의 결과 대화상자를 띄운다. 저장소 값은 처음 읽을 때 지우므로,
  // 개발 모드 StrictMode가 효과를 두 번 돌려도 한 번만 읽고 그 결과를 그대로 쓴다(새 맥락 리뷰 낮음 L1)
  const resumed = useRef(false);
  useEffect(() => {
    if (!live || resumed.current) return;
    resumed.current = true;
    void resumeReturnedResult({ api: browserVerifyApi(), storage: browserSessionStore, now: () => Date.now(), sleep }).then((o) => {
      if (o === null) return;
      if (o === 'login') location.assign(`${loginHref}?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      else pick(o);
    });
  }, [live, loginHref, pick]);

  useEffect(() => () => flowRef.current?.cancel(), []);

  const askConsent = useCallback((trigger?: HTMLElement) => {
    if (trigger) triggerRef.current = trigger;
    setConsent({ open: true, error: false });
  }, []);

  const begin = useCallback(
    (trigger?: HTMLElement) => {
      if (trigger) triggerRef.current = trigger;
      if (purpose === 'booth' && !consented) setConsent({ open: true, error: false });
      else openWindow();
    },
    [purpose, consented, openWindow],
  );

  const flow = useMemo<Flow>(
    () => ({ purpose, waiting: popup !== 'none', done, consented, begin, askConsent }),
    [purpose, popup, done, consented, begin, askConsent],
  );

  return (
    <FlowContext.Provider value={flow}>
      {children}
      {popup === 'preview' || popup === 'demo' ? (
        <VerifyPopupWindow
          demo={popup === 'demo' ? { purpose, onPick: pick } : undefined}
        />
      ) : null}
      {outcome ? (
        <VerifyResultDialog
          outcome={outcome}
          loginHref={loginHref}
          onClose={() => {
            setOutcome(null);
            returnFocus();
          }}
          onRetry={openWindow}
        />
      ) : null}
      <BoothConsentDialog
        open={consent.open}
        initialError={consent.error}
        onClose={() => {
          setConsent({ open: false, error: false });
          returnFocus();
        }}
        onAgree={() => {
          setConsent({ open: false, error: false });
          setConsented(true);
          openWindow();
        }}
      />
      {staticToast ? <StaticToast message={VERIFY_DONE_TOAST} /> : null}
    </FlowContext.Provider>
  );
}

export interface VerifyTriggerProps {
  className?: string;
  style?: CSSProperties;
  /** 목적 문구 등의 id */
  describedBy?: string;
  ariaLabel?: string;
  /** 'consent'면 부스 재발급 요청 버튼(동의 시트를 연다) */
  action?: 'verify' | 'consent';
  children: ReactNode;
}

/** 부르는 화면의 [휴대폰 본인확인]·[부스 재발급 요청]. 누른 동작 안에서 창을 연다(d3 SCR-006) */
export function VerifyTrigger({ className, style, describedBy, ariaLabel, action = 'verify', children }: VerifyTriggerProps) {
  const f = useFlow();
  return (
    <button
      className={className}
      style={style}
      type="button"
      aria-describedby={describedBy}
      aria-label={ariaLabel}
      data-verify-trigger=""
      onClick={(e) => (action === 'consent' ? f.askConsent(e.currentTarget) : f.begin(e.currentTarget))}
    >
      {children}
    </button>
  );
}

/** 기관 창이 열린 동안의 진행 글(role="status"). 기다리지 않을 때는 fallback(목적 문구 등)을 보인다 */
export function VerifyWaitingStatus({ fallback = null, className }: { fallback?: ReactNode; className?: string }) {
  const f = useFlow();
  if (!f.waiting) return <>{fallback}</>;
  return (
    <p className={className ?? 'row t-sm fw-m'} role="status" style={{ gap: 8 }}>
      <span className="spinner" aria-hidden="true" />
      {VERIFY_WAITING_TEXT}
    </p>
  );
}

/** 흐름 상태에 따라 보이기: done(마침)·pending(아직)·consented(부스 대조 동의 끝)·needConsent(동의 전) */
export function VerifyShow({ when, children }: { when: 'done' | 'pending' | 'consented' | 'needConsent'; children: ReactNode }) {
  const f = useFlow();
  const show = when === 'done' ? f.done : when === 'pending' ? !f.done : when === 'consented' ? f.consented : !f.consented;
  return show ? <>{children}</> : null;
}

export interface VerifyIdentityButtonProps extends Omit<VerifyTriggerProps, 'action'> {
  purpose?: VerifyPurpose;
  loginHref?: string;
  /** 버튼 아래에 진행 글을 둔다(기본 true) */
  showStatus?: boolean;
}

/** 버튼 하나로 잇는 본인확인(공연 상세·가입 완료·초대 수락 등). 흐름 상태를 버튼 안에 따로 가진다 */
export function VerifyIdentityButton({ purpose = 'first', loginHref, showStatus = true, ...trigger }: VerifyIdentityButtonProps) {
  return (
    <VerifyFlowProvider purpose={purpose} loginHref={loginHref}>
      <VerifyTrigger {...trigger} />
      {showStatus ? <VerifyWaitingStatus /> : null}
    </VerifyFlowProvider>
  );
}

/** 본인확인기관 창(팝업) 근사: 주소 막대 · 창 제목 '휴대폰 본인확인' · 기관이 그리는 자리(보드 showPopup) */
export function VerifyPopupWindow({ demo }: { demo?: { purpose: VerifyPurpose; onPick: (o: VerifyOutcome) => void } }) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  useEffect(() => {
    if (demo) firstRef.current?.focus();
  }, [demo]);
  return (
    <div
      className="card-raised col fixed inset-x-3 top-[72px] z-50 h-[600px] max-h-[calc(100dvh-88px)] overflow-hidden md:inset-x-auto md:left-1/2 md:top-24 md:h-[640px] md:w-[480px] md:-translate-x-1/2 lg:top-[150px] lg:h-[600px]"
      style={{ boxShadow: 'var(--shadow-lg),0 0 0 1px var(--border)' }}
      aria-hidden={demo ? undefined : true}
      role={demo ? 'group' : undefined}
      aria-labelledby={demo ? labelId : undefined}
      onKeyDown={
        demo
          ? (e) => {
              if (e.key === 'Escape') demo.onPick('closed');
            }
          : undefined
      }
    >
      <div className="row" style={{ gap: 8, height: 40, padding: '0 12px', background: 'var(--fill-weak)', borderBottom: '1px solid var(--border)', flex: 'none' }}>
        <i className="ic ic-lock ic-14 muted" aria-hidden="true" />
        {/* 기관 주소 자리(합성 값). 실제 기관은 PoC에서 고른다 */}
        <span className="t-xs muted ellipsis grow">mock-idv.example/verify</span>
        {demo ? (
          <button className="icon-btn" type="button" aria-label="본인확인 창 닫기" onClick={() => demo.onPick('closed')} style={{ width: 32, height: 32, marginRight: -8 }}>
            <i className="ic ic-close ic-16 muted" aria-hidden="true" />
          </button>
        ) : (
          <i className="ic ic-close ic-16 muted" aria-hidden="true" />
        )}
      </div>
      <div className="row" style={{ height: 40, padding: '0 14px', borderBottom: '1px solid var(--border)', flex: 'none' }}>
        <strong className="t-sm fw-b" id={labelId}>
          휴대폰 본인확인
        </strong>
        <span className="t-xs muted" style={{ marginLeft: 'auto' }}>
          새 창
        </span>
      </div>
      <div
        className="col center m-3.5 min-h-0 overflow-auto md:m-4"
        style={{ flex: 1, justifyContent: 'safe center', gap: 10, padding: 16, border: '2px dashed var(--border)', borderRadius: 'var(--r-lg)', textAlign: 'center' }}
      >
        <i className="ic ic-phone ic-32 muted" aria-hidden="true" />
        <p className="t-md fw-b muted">본인확인기관 화면(기관이 그림)</p>
        <p className="t-xs muted">피켓은 이 창의 내용을 그리지 않습니다</p>
        {demo ? (
          <div className="col" style={{ gap: 8, marginTop: 8, width: '100%', maxWidth: 280 }}>
            <p className="t-xs fw-b">시험용 결과 고르기</p>
            <div className="row wrap center" style={{ gap: 6 }}>
              {demoOutcomes(demo.purpose).map((o, i) => (
                <button
                  key={o.value}
                  ref={i === 0 ? firstRef : undefined}
                  className={o.value === 'success' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                  type="button"
                  onClick={() => demo.onPick(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 결과 대화상자(CMP-019 default, alert 아님). 휴대폰 시트 · md 이상 대화상자 */
export function VerifyResultDialog({
  outcome,
  loginHref = '/login',
  onClose,
  onRetry,
}: {
  outcome: ResultOutcome;
  loginHref?: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  const c = VERIFY_RESULT_COPY[outcome];
  const descId = `${useId()}-desc`;
  let actions: ReactNode;
  if (c.action === 'retry') {
    actions = (
      <>
        <button className={webModalButtonClass('primary')} type="button" onClick={onRetry}>
          <i className="ic ic-refresh" aria-hidden="true" />
          다시 시도
        </button>
        <button className={webModalButtonClass('ghost')} type="button" onClick={onClose}>
          닫기
        </button>
      </>
    );
  } else if (c.action === 'login') {
    actions = (
      <>
        <Link className={webModalButtonClass('primary')} href={loginHref}>
          로그인
        </Link>
        <button className={webModalButtonClass('ghost')} type="button" onClick={onClose}>
          닫기
        </button>
      </>
    );
  } else if (c.action === 'home') {
    actions = (
      <Link className={webModalButtonClass('primary')} href="/">
        홈으로
      </Link>
    );
  } else {
    actions = (
      <button className={webModalButtonClass('primary')} type="button" onClick={onClose}>
        닫기
      </button>
    );
  }
  return (
    <WebShellModal
      open
      onClose={onClose}
      title={c.title}
      icon={<i className={`ic ic-${c.icon}`} aria-hidden="true" />}
      iconTone={c.tone}
      describedBy={descId}
      maxWidth={c.maxWidth ?? 420}
      actions={actions}
    >
      <p className={c.small ? 't-sm' : 't-md'} id={descId}>
        {c.body}
      </p>
    </WebShellModal>
  );
}

/** 부스 재발급 1/3단계 대조 동의 시트(보드 dlgConsent). 동의하지 않고 누르면 오류 글을 보이고 시작하지 않는다(422와 같은 안내) */
export function BoothConsentDialog({
  open,
  initialError = false,
  onClose,
  onAgree,
}: {
  open: boolean;
  initialError?: boolean;
  onClose: () => void;
  onAgree: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState(initialError);
  useEffect(() => {
    if (open) {
      setAgreed(false);
      setError(initialError);
    }
  }, [open, initialError]);
  return (
    <WebShellModal
      open={open}
      onClose={onClose}
      // 보드처럼 단계 글을 제목 위에 둔다(창 이름에는 넣지 않는다)
      eyebrow={BOOTH_CONSENT.eyebrow}
      title={BOOTH_CONSENT.title}
      describedBy="bc-d"
      maxWidth={560}
      scroll
      actions={
        <>
          <button
            className={webModalButtonClass('primary')}
            type="button"
            aria-disabled={agreed ? undefined : 'true'}
            aria-describedby={error ? 'bc-why' : undefined}
            onClick={() => (agreed ? onAgree() : setError(true))}
          >
            {BOOTH_CONSENT.confirm}
          </button>
          <button className={webModalButtonClass('ghost')} type="button" onClick={onClose}>
            닫기
          </button>
        </>
      }
    >
      <p className="t-sm" id="bc-d">
        {VERIFY_PURPOSE_TEXT.booth}
      </p>
      <dl className="card-flat col" style={{ gap: 8, padding: '14px 16px' }}>
        {BOOTH_CONSENT.items.map((it) => (
          <div key={it.term} className="col" style={{ gap: 2 }}>
            <dt className="t-xs fw-b muted">{it.term}</dt>
            <dd className="t-sm">{it.desc}</dd>
          </div>
        ))}
      </dl>
      <label className="check-row" htmlFor="bc-agree">
        <input
          className="cb"
          id="bc-agree"
          type="checkbox"
          checked={agreed}
          aria-invalid={error && !agreed ? true : undefined}
          aria-describedby={error && !agreed ? 'bc-why' : undefined}
          onChange={(e) => {
            setAgreed(e.target.checked);
            if (e.target.checked) setError(false);
          }}
        />
        {BOOTH_CONSENT.checkbox}
      </label>
      {error && !agreed ? (
        <p className="error-msg" id="bc-why" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          {BOOTH_CONSENT.error}
        </p>
      ) : null}
    </WebShellModal>
  );
}

/** 상태 미리보기용 고정 토스트(셸 토스트와 같은 자리·모양, 사라지지 않는다) */
function StaticToast({ message }: { message: string }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[95] flex justify-center px-4 lg:bottom-8">
      <div className="toast" role="status">
        <i className="ic ic-check-circle" aria-hidden="true" />
        {message}
      </div>
    </div>
  );
}
