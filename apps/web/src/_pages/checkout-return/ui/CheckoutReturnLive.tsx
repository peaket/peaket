'use client';
import { attemptStorageKey } from '../../checkout/model/payment-attempt';
// SCR-011 결제창 복귀(캐시 셸, 쿠키 없는 첫 요청, docs/frontend.md §5.3 '복귀 화면', ADR-0229). 스크립트가 주소의 결제 값을 읽고 바로 지운 뒤
// 서명한 결제 접수를 보낸다. 접수를 보낸 사실과 멱등 키는 탭 저장소에 둬 새로고침하면 결과 확인으로 바로 간다. 결제사 값은 저장하지 않는다.
import { useEffect, useRef, useState } from 'react';
import { PaymentReturnCard } from '@/entities/payment';
import { AppShell } from '@/widgets/app-shell';
import { acceptOutcome, findAcceptRecord, parseReturn, writeAcceptRecord, type AcceptBody } from '../model/payment-return';

type Phase = 'accepting' | 'mismatch' | 'not-finished' | 'order-expired' | 'cancelled' | 'declined' | 'other-tab' | 'retry';

/** 다른 탭에서 접수한 것을 알린 뒤 결과 화면으로 가기까지 */
const OTHER_TAB_MS = 1500;
/** 끝 안내를 보이는 시간 없이 좌석 화면이 '예매 시간이 끝났습니다'를 보인다 */
const NOT_CHARGED = '요금은 청구되지 않았습니다. 고른 좌석은 홀드 시간 동안 그대로 있습니다';

const eventIdOf = (path: string): string => {
  try {
    return decodeURIComponent(path.split('/')[2] ?? '');
  } catch {
    return '';
  }
};

function readAdmission(eventId: string): { admissionToken: string; serverEcdhPublicKey?: Record<string, string>; purchaseSessionExpiresAt?: string } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(`peaket.admission.${eventId}`) ?? 'null') as { admissionToken?: unknown } | null;
    return v && typeof v.admissionToken === 'string' && v.admissionToken ? (v as { admissionToken: string }) : null;
  } catch {
    return null;
  }
}

const resultHref = (eventId: string, orderId: string): string => `/booking/${encodeURIComponent(eventId)}/result?order=${encodeURIComponent(orderId)}`;
const seatsHref = (eventId: string): string => `/booking/${encodeURIComponent(eventId)}/seats`;

export function CheckoutReturnLive() {
  const [phase, setPhase] = useState<Phase>('accepting');
  const [eventId, setEventId] = useState('');
  const retry = useRef<(() => void) | null>(null);
  const started = useRef(false);
  const orderRef = useRef<string | null>(null);

  useEffect(() => {
    // 개발 모드 StrictMode가 효과를 두 번 돌려도 접수는 한 번만 시작한다
    if (started.current) return;
    started.current = true;
    const id = eventIdOf(window.location.pathname);
    setEventId(id);
    const values = parseReturn(window.location.search);
    // 결제 값이 기록·주소창에 남지 않게 바로 지운다
    window.history.replaceState(null, '', window.location.pathname);

    if (values.kind === 'fail') return setPhase(values.cancelled ? 'cancelled' : 'declined');
    if (values.kind === 'none') {
      // 새로고침: 접수를 보낸 뒤면 결과 확인으로, 보내기 전이면 결제 값을 잃었다
      const orderId = findAcceptRecord(sessionStorage, id);
      if (orderId) return window.location.replace(resultHref(id, orderId));
      return setPhase('not-finished');
    }
    const { orderId, body } = values;
    orderRef.current = orderId;
    // 결제 값이 왔으면 기록이 있어도 접수한다(앞 시도가 실패한 뒤 다시 결제했을 수 있다). 이미 접수됐으면 서버가 409로 막는다
    const key = crypto.randomUUID();
    writeAcceptRecord(sessionStorage, orderId, { eventId: id, key, at: Date.now() });
    const run = () => {
      setPhase('accepting');
      void send(id, orderId, body, key, setPhase).catch(() => setPhase('retry'));
    };
    retry.current = run;
    run();
  }, []);

  useEffect(() => {
    if (phase !== 'other-tab' || !eventId) return;
    const orderId = orderRef.current ?? findAcceptRecord(sessionStorage, eventId);
    const t = setTimeout(() => window.location.replace(orderId ? resultHref(eventId, orderId) : seatsHref(eventId)), OTHER_TAB_MS);
    return () => clearTimeout(t);
  }, [phase, eventId]);

  const checkoutHref = eventId ? `/booking/${encodeURIComponent(eventId)}/checkout` : '/';
  const card = { retryHref: checkoutHref, appealHref: '/my/appeals' };
  return (
    <AppShell variant="focus" focus={{ title: '결제', subtitle: '', closeHref: eventId ? `/events/${encodeURIComponent(eventId)}` : '/' }}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="w-full px-4 pt-5 pb-8 md:px-6 md:pt-6 md:pb-10 lg:px-8 lg:pt-8 lg:pb-12">
          {/* 상태가 바뀌면 낭독되게 자리를 미리 둔다(카드와 함께 새로 끼우면 읽히지 않을 수 있다) */}
          <div className="col mx-auto w-full max-w-[600px] lg:max-w-[560px]" aria-live="polite">
            {phase === 'accepting' || phase === 'mismatch' || phase === 'other-tab' ? <PaymentReturnCard kind={phase} {...card} /> : null}
            {phase === 'not-finished' ? <PaymentReturnCard kind="reload" {...card} /> : null}
            {phase === 'order-expired' ? <PaymentReturnCard kind="reload" note="결제하지 않아 주문이 끝났습니다. 요금은 청구되지 않았습니다" retryLabel="좌석 다시 고르기" {...card} retryHref={eventId ? seatsHref(eventId) : '/'} /> : null}
            {phase === 'cancelled' ? <PaymentReturnCard kind="reload" note={`결제창을 닫았습니다. ${NOT_CHARGED}`} {...card} /> : null}
            {phase === 'declined' ? <PaymentReturnCard kind="reload" note={`결제가 승인되지 않았습니다. ${NOT_CHARGED}`} {...card} /> : null}
            {phase === 'retry' ? (
              <section className="state" role="alert" style={{ padding: '64px 24px 24px' }}>
                <span className="state-icon">
                  <i className="ic ic-alert" aria-hidden="true" />
                </span>
                <h1 className="t-lg">결제 접수를 끝내지 못했습니다</h1>
                <button className="btn btn-primary" type="button" onClick={() => retry.current?.()}>
                  다시 시도
                </button>
              </section>
            ) : null}
          </div>
        </div>
      </main>
    </AppShell>
  );
}

async function send(eventId: string, orderId: string, body: AcceptBody, key: string, setPhase: (p: Phase) => void): Promise<void> {
  const adm = readAdmission(eventId);
  if (!adm) return window.location.replace(seatsHref(eventId));
  const [{ ApiError, OPERATIONS }, { PurchaseKeyError, openPurchaseSession }, api] = await Promise.all([import('@peaket/api-client'), import('@peaket/api-client/purchase'), import('@/shared/api')]);
  const client = api.browserApiClient();
  if (!client) return setPhase('retry');
  let session: Awaited<ReturnType<typeof openPurchaseSession>> | undefined;
  const ended = () => {
    // 구매 세션이 끝났다: 키와 기록을 지운다. 좌석 화면이 입장 저장값이 없는 것을 보고 '예매 시간이 끝났습니다'로 간다
    void session?.end().catch(() => undefined);
    sessionStorage.removeItem(`peaket.accept.${orderId}`);
    sessionStorage.removeItem(`peaket.admission.${eventId}`);
    window.location.replace(seatsHref(eventId));
  };
  try {
    session = await openPurchaseSession(adm);
  } catch (e) {
    return e instanceof PurchaseKeyError && e.reason !== 'storage' ? ended() : setPhase('retry');
  }
  let refreshed = false;
  for (;;) {
    try {
      // 결제 시도 ID를 싣는다(대체된 시도의 늦은 접수를 서버가 409로 막는다, docs/features/payment.md §2 '활성 결제 시도 대조')
      const attemptId = sessionStorage.getItem(attemptStorageKey(orderId));
      await client.send(OPERATIONS.createOrderPaymentAcceptance, { params: { orderId }, body: { ...body, ...(attemptId ? { attemptId } : {}) }, idempotencyKey: key, purchase: session });
      sessionStorage.removeItem(attemptStorageKey(orderId));
      for (const k of Object.keys(sessionStorage)) if (k.startsWith('peaket.checkout.')) sessionStorage.removeItem(k);
      return window.location.replace(resultHref(eventId, orderId));
    } catch (e) {
      if (e instanceof PurchaseKeyError) return e.reason === 'storage' ? setPhase('retry') : ended();
      const out = acceptOutcome(e instanceof ApiError ? { status: e.status, type: e.type } : {});
      if (out.kind === 'refresh' && !refreshed) {
        refreshed = true;
        const r = await api.refreshFanToken();
        if (r === 'ok') continue;
        return r === 'rejected' ? ended() : setPhase('retry');
      }
      if (out.kind === 'refresh' || out.kind === 'ended') return ended();
      // 접수되지 않았으니 기록을 지운다(다시 결제하면 새로 접수한다). 다른 탭에서 접수했다면 기록을 두고 결과로 간다
      if (out.kind === 'mismatch' || out.kind === 'not-finished' || out.kind === 'order-expired') sessionStorage.removeItem(`peaket.accept.${orderId}`);
      return setPhase(out.kind);
    }
  }
}
