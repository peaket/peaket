'use client';
// SCR-009 추가 검증의 실제 화면(d5 §5.9, docs/frontend.md §4.2.1 8·9번, ADR-0259). 흐름은 model/verify-flow.ts가 정하고 이 파일은 그리고 잇기만 한다.
// - 첫 화면 JS(§5.8 '그 밖 소비자 화면' 200kB)에는 흐름과 그림만 싣는다. API 호출 함수(api-client), 사람 확인 위젯 로더(features/human-check),
//   본인확인 흐름(features/identity-verify, ReverifyStep)은 늦게 싣는다(결제 화면 CheckoutLive와 같은 방법)
// - 서버 값에서 온 글(사유 범주·보낸 이의)은 글 노드로만 그린다(ASVS 3.2.2). 옮겨 가는 곳은 고정 경로뿐이다(ASVS 3.7.2, view.ts fixedPaths)
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { buttonClass } from '@peaket/ds/Button';
import { TextArea } from '@peaket/ds/TextArea';
import { deviceId } from '@/shared/lib/device-id';
import { dateTimeText, parseTime } from '@/shared/lib/kst';
import { AppShell } from '@/widgets/app-shell';
import { createVerifyFlow, type KV, type VerifyFlow, type VerifyView } from '../model/verify-flow';
import { APPEAL_MAX, appealHasForbidden, appealLength, COPY, fixedPaths } from '../model/view';
import { AcceptedResult, AppealHeading, AppealReceived, DangerBanner, IntroBanner, PassedResult, PrivacyLink, RejectedResult, TurnNote, VerifyFrame, VerifySteps } from './parts';

const ReverifyStep = lazy(() => import('./ReverifyStep'));

const PRIMARY = buttonClass({ variant: 'primary', size: 'lg', block: true });

/** 저장소를 쓸 수 없으면(사생활 보호 모드 등) null */
function storageOf(kind: 'local' | 'session'): KV | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

async function queueApi() {
  const [queue, api] = await Promise.all([import('@peaket/api-client/endpoints/queue'), import('@/shared/api')]);
  api.ensureBrowserApi();
  return { queue, withFanRefresh: api.withFanRefresh };
}

/** 자리가 그려질 때까지 기다린다(추가 검증 중 화면이 그려진 다음 위젯을 그 자리에 그린다) */
function slotWaiter() {
  let el: HTMLElement | null = null;
  let waiters: ((e: HTMLElement) => void)[] = [];
  return {
    ref: (e: HTMLElement | null) => {
      el = e;
      if (e) {
        for (const w of waiters) w(e);
        waiters = [];
      }
    },
    get: (signal: AbortSignal) =>
      new Promise<HTMLElement | null>((resolve) => {
        if (el?.isConnected) return resolve(el);
        waiters.push(resolve);
        signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
  };
}

/** 남은 초(표시만, 실제 시각은 흐름이 정한다) */
function useSecondsLeft(at: number | undefined): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (at === undefined) return;
    const update = () => setLeft(Math.max(0, Math.ceil((at - Date.now()) / 1000)));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [at]);
  return left;
}

export function QueueVerifyLive({ eventId }: { eventId: string }) {
  const [view, setView] = useState<VerifyView | null>(null);
  const [head, setHead] = useState<{ title: string; line: string } | null>(null);
  const flowRef = useRef<VerifyFlow | null>(null);
  const slot = useRef(slotWaiter());
  const paths = fixedPaths(eventId);

  useEffect(() => {
    const flow = createVerifyFlow({
      eventId,
      now: () => Date.now(),
      random: Math.random,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      visible: () => document.visibilityState === 'visible',
      onVisible: (cb) => {
        const f = () => {
          if (document.visibilityState === 'visible') cb();
        };
        document.addEventListener('visibilitychange', f);
        return () => document.removeEventListener('visibilitychange', f);
      },
      humanCheck: async (signal) => {
        const el = await slot.current.get(signal);
        if (!el) return null;
        const { runHumanCheck } = await import('@/features/human-check/load');
        const r = await runHumanCheck(el, 'verify', signal);
        return r === 'interactive' ? null : r;
      },
      read: async (signal) => {
        const { queue, withFanRefresh } = await queueApi();
        return (await withFanRefresh(() => queue.getQueueVerification(eventId, { signal }))).data;
      },
      submit: async (body, signal) => {
        const { queue, withFanRefresh } = await queueApi();
        const r = await withFanRefresh(() => queue.createQueueVerification(eventId, body, { signal }));
        return { status: r.status, body: r.data };
      },
      admit: async (body, signal) => {
        const { queue, withFanRefresh } = await queueApi();
        const r = await withFanRefresh(() => queue.createQueueAdmission(eventId, body as { queueTicket?: string; lobbyToken?: string }, { signal }));
        return { status: r.status, body: r.data };
      },
      deviceId,
      local: storageOf('local'),
      session: storageOf('session'),
      // 뒤로 가기로 이 화면에 돌아오지 않게 바꾼다(통과·끝 상태 뒤)
      navigate: (u) => window.location.replace(u),
      onChange: setView,
    });
    flowRef.current = flow;
    return () => {
      flowRef.current = null;
      flow.dispose();
    };
  }, [eventId]);

  // 머리의 공연 이름·회차(없으면 '추가 검증'). 받지 못해도 화면은 그대로다
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      const [{ getEvent }, api] = await Promise.all([import('@peaket/api-client/endpoints/catalog'), import('@/shared/api')]);
      api.ensureBrowserApi();
      const e = (await getEvent(eventId, { signal: abort.signal })).data;
      const at = parseTime(e.startsAt);
      setHead({ title: e.title ?? '추가 검증', line: [at === undefined ? '' : dateTimeText(at), e.placeName ?? ''].filter(Boolean).join(' · ') });
    })().catch(() => undefined);
    return () => abort.abort();
  }, [eventId]);

  const flow = () => flowRef.current;
  return (
    <AppShell variant="focus" focus={{ title: head?.title ?? '추가 검증', subtitle: head?.line ?? '', closeHref: paths.event }}>
      <VerifyFrame>
        <Body view={view} slotRef={slot.current.ref} flow={flow} />
      </VerifyFrame>
    </AppShell>
  );
}

function Body({ view, slotRef, flow }: { view: VerifyView | null; slotRef: (e: HTMLElement | null) => void; flow: () => VerifyFlow | null }) {
  const retryLeft = useSecondsLeft(view?.submit === 'retry' || view?.submit === 'limited' ? view.retryAt : undefined);
  // 서버가 재통과를 찾지 못했다(REVERIFY_REQUIRED·PERSON_MISMATCH): ③ 본인확인 버튼으로 옮긴다. 기관 창(팝업)은 누른 동작 안에서만 열 수 있어
  // 저절로 열지 않고 버튼에 초점을 둔다(d5 §5.9 '제출 차례와 되살리기'의 "본인확인 창을 연다")
  const askReverify = view?.phase === 'verifying' && (view.submit === 'reverify' || view.submit === 'mismatch');
  useEffect(() => {
    if (!askReverify) return;
    const t = window.setTimeout(() => {
      const b = document.querySelector<HTMLElement>('[data-verify-trigger]');
      b?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      b?.focus({ preventScroll: true });
    }, 50);
    return () => window.clearTimeout(t);
  }, [askReverify]);
  if (!view || view.phase === 'loading' || view.phase === 'leaving') {
    return (
      <>
        <h1 className="t-xl">추가 검증</h1>
        <div className="grid place-items-center" role="status" style={{ padding: 64 }}>
          <span className="spinner muted" aria-hidden="true" />
          <span className="sr-only">추가 검증 정보를 불러오는 중</span>
        </div>
      </>
    );
  }
  if (view.phase === 'load-failed') {
    return (
      <>
        <h1 className="t-xl">추가 검증</h1>
        <section className="state" role="alert" style={{ padding: '48px 8px 16px' }}>
          <span className="state-icon">
            <i className="ic ic-alert" aria-hidden="true" />
          </span>
          <h2 className="t-lg">{COPY.loadFailed}</h2>
          <button className="btn btn-primary" type="button" onClick={() => flow()?.retryLoad()}>
            다시 시도
          </button>
        </section>
      </>
    );
  }
  if (view.phase === 'passed' || view.phase === 'accepted' || view.phase === 'rejected') {
    return (
      <>
        <div className="col" style={{ gap: 14 }}>
          <h1 className="t-xl">추가 검증</h1>
          {view.phase === 'passed' ? <VerifySteps current={3} /> : null}
        </div>
        {view.phase === 'passed' ? <PassedResult turn={view.turn ?? 'deciding'} /> : null}
        {view.phase === 'accepted' ? <AcceptedResult turn={view.turn ?? 'deciding'} spinner /> : null}
        {view.phase === 'rejected' ? <RejectedResult reason={view.reason} /> : null}
        <PrivacyLink />
      </>
    );
  }

  // 추가 검증 중
  const step = view.challenge !== 'ready' ? 1 : 2;
  const retrying = view.submit === 'retry' || view.submit === 'limited';
  return (
    <>
      <div className="col" style={{ gap: 14 }}>
        <h1 className="t-xl">추가 검증</h1>
        <VerifySteps current={step} />
      </div>
      <IntroBanner reason={view.reason} />

      <section className="col" style={{ gap: 10 }} aria-labelledby="ch-h">
        <h2 className="t-md fw-b" id="ch-h">
          사람 확인
        </h2>
        {/* CMP-047 사람 확인 심층 챌린지(action verify). 위젯 스크립트는 이 자리가 그려진 뒤 늦게 싣는다 */}
        <div className="card center min-h-[132px] md:min-h-40" role="group" aria-label="사람 확인 심층 챌린지" style={{ padding: 16, textAlign: 'center' }}>
          {view.challenge === 'ready' ? (
            <p className="row t-sm" style={{ gap: 8 }}>
              <i className="ic ic-check-circle tx-success" aria-hidden="true" />
              사람 확인을 마쳤습니다
            </p>
          ) : null}
          {view.challenge === 'checking' ? <div ref={slotRef} /> : null}
          {view.challenge === 'idle' || view.challenge === 'failed' || view.challenge === 'unavailable' ? <i className="ic ic-shield ic-32 muted" aria-hidden="true" /> : null}
        </div>
        {view.challenge === 'failed' || view.challenge === 'unavailable' ? (
          <DangerBanner
            text={view.challenge === 'failed' ? COPY.challengeFailed : COPY.challengeUnavailable}
            action={
              <button type="button" className={buttonClass({ variant: 'outline', size: 'sm' })} style={{ alignSelf: 'flex-start' }} onClick={() => flow()?.retryChallenge()}>
                다시 시도
              </button>
            }
          />
        ) : null}
        {view.submit === 'stalled' ? (
          // 자동 다시 보내기(3번 [가정])를 다 썼다: [다시 시도]를 누르면 위젯을 다시 돌린 새 토큰으로 보낸다(d5 §5.9 '챌린지 실패')
          <DangerBanner
            text={COPY.challengeFailed}
            action={
              <button type="button" className={buttonClass({ variant: 'outline', size: 'sm' })} style={{ alignSelf: 'flex-start' }} onClick={() => flow()?.retrySubmit()}>
                다시 시도
              </button>
            }
          />
        ) : null}
        {retrying ? (
          <DangerBanner
            text={view.submit === 'limited' ? COPY.limited : COPY.challengeFailed}
            sub={
              <p className="t-sm">
                <span className="sr-only" role="status">
                  {COPY.autoRetry}
                </span>
                <span aria-hidden="true">
                  {COPY.autoRetry} · <span className="num">{retryLeft}초</span>
                </span>
              </p>
            }
          />
        ) : null}
      </section>

      <div className="col" style={{ gap: 8 }}>
        <p className="t-sm" id="iv-purpose">
          같은 분인지 다시 확인합니다
        </p>
        {/* 처음 제출의 REVERIFY_REQUIRED는 ③으로만 옮긴다. 이 탭에서 마쳤는데도 서버가 찾지 못했거나 다른 분이면 안내를 보인다 */}
        {view.submit === 'mismatch' || (view.submit === 'reverify' && view.reverifyAgain) ? <DangerBanner text={view.submit === 'mismatch' ? COPY.personMismatch : COPY.reverifyAgain} /> : null}
        {view.submit === 'sending' ? (
          <p className="row t-sm" role="status" style={{ gap: 8 }}>
            <span className="spinner" aria-hidden="true" />
            확인하는 중입니다
          </p>
        ) : null}
        {!view.reverified ? (
          <Suspense
            fallback={
              <button className={PRIMARY} type="button" disabled aria-describedby="iv-purpose">
                <i className="ic ic-phone" aria-hidden="true" />
                휴대폰 본인확인 다시 하기
              </button>
            }
          >
            <ReverifyStep onDone={() => flow()?.reverified()} className={PRIMARY} describedBy="iv-purpose">
              <i className="ic ic-phone" aria-hidden="true" />
              휴대폰 본인확인 다시 하기
            </ReverifyStep>
          </Suspense>
        ) : null}
      </div>

      <TurnNote />

      <section className="col border-t border-(--border)" id="appeal" style={{ gap: 12, paddingTop: 20 }} aria-labelledby="ap-h">
        <AppealHeading received={view.appeal === 'received'} />
        {view.appeal === 'received' ? <AppealReceived text={view.appealText} /> : <LiveAppealForm view={view} flow={flow} />}
      </section>

      <PrivacyLink />
    </>
  );
}

/** ⑤ 설명 요청·재검토 신청(0~1,000자, NFC 뒤 grapheme). 비워 보내면 설명 요청, 쓰면 설명과 재검토. 버튼은 하나다(d5 §5.9 ⑤) */
function LiveAppealForm({ view, flow }: { view: VerifyView; flow: () => VerifyFlow | null }) {
  const [text, setText] = useState('');
  const left = useSecondsLeft(view.appeal === 'retry' ? view.appealRetryAt : undefined);
  const busy = view.appeal === 'sending' || view.appeal === 'retry';
  const over = appealLength(text) > APPEAL_MAX;
  // 서버와 같은 규칙: 보이지 않는 글자·방향 바꿈 글자가 있으면 보내지 않고 칸 아래에 알린다
  const bad = appealHasForbidden(text);
  return (
    <form
      className="col"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && !over && !bad) flow()?.sendAppeal(text);
      }}
    >
      <TextArea id="ap-text" name="appeal" label="내용" maxLength={APPEAL_MAX} hint="건강 정보 같은 민감한 내용은 적지 않아도 됩니다" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} {...(bad ? { error: COPY.appealBadChars } : {})} />
      {view.appeal === 'failed' ? <DangerBanner text={COPY.appealFailed} /> : null}
      {view.appeal === 'retry' ? (
        <p className="t-sm">
          <span className="sr-only" role="status">
            {COPY.autoRetry}
          </span>
          <span aria-hidden="true">
            {COPY.autoRetry} · <span className="num">{left}초</span>
          </span>
        </p>
      ) : null}
      <button
        className="btn btn-secondary btn-lg btn-block md:w-auto md:self-start lg:min-h-10 lg:rounded-(--r-md) lg:px-4 lg:text-sm lg:leading-[19px]"
        type="submit"
        disabled={busy || over || bad}
        aria-busy={busy || undefined}
      >
        재검토 신청하기
      </button>
    </form>
  );
}
