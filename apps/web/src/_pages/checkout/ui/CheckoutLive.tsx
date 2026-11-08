'use client';
// SCR-011 주문·결제의 실제 화면(d5 §5.11, docs/frontend.md §5.3, ADR-0228). 탭 저장소의 입장·홀드 값으로 홀드를 다시 읽고,
// 서버가 계산한 금액과 판매자 정보를 보인 뒤 서명한 POST /v1/orders로 주문을 만든다. 결제창(결제 시도·결제사 위젯)은 HOT-358이다.
import type { PurchaseSigner } from '@peaket/api-client/purchase';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { PaymentReturnCard } from '@/entities/payment';
import { formatWon } from '@/entities/production';
import { holdClock } from '@/shared/lib/hold-clock';
import { AppShell } from '@/widgets/app-shell';
import { buyerErrors, gradeLines, orderIdempotencyKey, orderOutcome, ORDER_CONSENT_VERSION, readCheckoutRefs, roundText, type OrderOutcome, type StoredAdmissionRef } from '../model/order';
import type { PayMode } from '../model/view';
import { CheckoutConsentProvider, HoldExpiredDialog, PayAction, useCheckoutConsent } from './CheckoutClient';
import { CheckoutForm, type CheckoutFormData, type SellerView } from './CheckoutForm';

const VerifyIdentityButton = lazy(() => import('@/features/identity-verify').then((m) => ({ default: m.VerifyIdentityButton })));

/** 끝 안내를 보이는 시간(좌석 화면과 같다) */
const LEAVE_AFTER_MS = 2500;

interface HoldSeat {
  seatId: string;
  label: string;
  tierId: string;
  tierName?: string;
  price: number;
}
interface HoldView {
  holdId: string;
  expiresAt: string;
  seats?: HoldSeat[];
  totalAmount?: number;
}

type Phase = 'loading' | 'ready' | 'ended' | 'failed' | 'restricted' | 'other-tab';

const problemOf = (e: unknown, ApiError: typeof import('@peaket/api-client').ApiError) => (e instanceof ApiError ? { status: e.status, type: e.type } : {});

/** 불러오기를 멈출 까닭 */
class LoadStop extends Error {
  readonly phase: 'ended' | 'failed';
  constructor(phase: 'ended' | 'failed') {
    super(phase);
    this.phase = phase;
  }
}

/** 판매 정지 뒤 다시 주문을 받기까지 [가정](좌석 화면과 같다) */
const PAUSED_RETRY_MS = 10_000;

/** 홀드와 결제 초안(동의 체크)을 지운다 */
function clearDraft(eventId: string): void {
  sessionStorage.removeItem(`peaket.hold.${eventId}`);
  for (const k of Object.keys(sessionStorage)) if (k.startsWith('peaket.checkout.')) sessionStorage.removeItem(k);
}

export function CheckoutLive({ eventId }: { eventId: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [hold, setHold] = useState<HoldView | null>(null);
  const [event, setEvent] = useState<{ title: string; line: string; sellerName: string; seller?: SellerView; sortMode: CheckoutFormData['sortMode']; perPerson: number } | null>(null);
  const [expired, setExpired] = useState(false);
  const deadline = useRef<{ mono: number; wall: number } | null>(null);
  const admission = useRef<StoredAdmissionRef | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    const refs = readCheckoutRefs(eventId, sessionStorage);
    if (refs.kind === 'no-admission') {
      setPhase('ended');
      return;
    }
    if (refs.kind === 'no-hold') {
      window.location.replace(`/booking/${encodeURIComponent(eventId)}/seats`);
      return;
    }
    admission.current = refs.admission;
    void (async () => {
      const [{ ApiError, OPERATIONS }, api, { getEvent }] = await Promise.all([import('@peaket/api-client'), import('@/shared/api'), import('@peaket/api-client/endpoints/catalog')]);
      const client = api.browserApiClient();
      if (!client) return live && setPhase('failed');
      const read = () => client.send<HoldView>(OPERATIONS.getHold, { params: { holdId: refs.holdId }, headers: { 'X-Admission-Token': refs.admission.admissionToken }, signal: abort.signal });
      const heldRes = await read().catch(async (e: unknown) => {
        // 팬 쿠키가 만료됐으면 한 번 갱신한다(이름 없는 401, §4.1). 갱신이 일시 장애면 끝난 것으로 보지 않는다
        if (orderOutcome(problemOf(e, ApiError)).kind !== 'refresh') throw e;
        const r = await api.refreshFanToken();
        if (r === 'ok') return read();
        throw new LoadStop(r === 'rejected' ? 'ended' : 'failed');
      });
      // 응답을 받은 때를 기준으로 마감을 잡는다(회차 요약을 기다린 시간만큼 늦지 않게)
      const remaining = Date.parse(heldRes.data.expiresAt) - (Date.parse(heldRes.headers.get('date') ?? '') || Date.now());
      deadline.current = { mono: performance.now() + remaining, wall: Date.now() + remaining };
      const e = (await getEvent(eventId, { signal: abort.signal })).data;
      if (!live) return;
      const s = e.seller;
      setHold(heldRes.data);
      setEvent({
        title: e.title ?? '주문·결제',
        line: [roundText(e.startsAt), e.placeName].filter(Boolean).join(' · '),
        sellerName: s?.legalName ?? e.sellerName ?? '',
        // 판매자 신원정보가 없는 공연은 팔리지 않는다(ADR-0201). 비어 있으면 아래에서 실패로 본다
        ...(s ? { seller: { name: s.legalName, representative: s.representative, address: s.address, phone: s.phone, email: s.email, businessNo: s.businessRegNo, mailOrderNo: s.mailOrderReportNo ?? '' } } : {}),
        sortMode: (e.queueOrder ?? 'HYBRID') as CheckoutFormData['sortMode'],
        perPerson: e.perPersonLimit ?? 4,
      });
      setPhase(s ? 'ready' : 'failed');
    })().catch(async (err: unknown) => {
      if (!live || abort.signal.aborted) return;
      if (err instanceof LoadStop) return setPhase(err.phase);
      try {
        const { ApiError } = await import('@peaket/api-client');
        const out = orderOutcome(problemOf(err, ApiError));
        if (out.kind === 'hold-gone') {
          setExpired(true);
          setPhase('ready');
        } else setPhase(out.kind === 'ended' || out.kind === 'refresh' ? 'ended' : 'failed');
      } catch {
        // 코드 조각을 받지 못했다
        setPhase('failed');
      }
    });
    return () => {
      live = false;
      abort.abort();
    };
  }, [eventId, attempt]);

  // 홀드 타이머: 응답의 서버 시각으로 정한 마감까지(단조 시계와 벽시계 가운데 빠른 쪽, 기기가 잠들어도 늦지 않는다)
  const ready = phase === 'ready' && hold !== null;
  useEffect(() => {
    if (!ready) return;
    const tick = () => {
      const d = deadline.current;
      if (!d) return;
      const ms = Math.min(d.mono - performance.now(), d.wall - Date.now());
      setLeft(ms);
      if (ms <= 0) setExpired(true);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [ready]);

  // 홀드가 끝났으면 저장한 값도 지운다(좌석을 다시 고르면 새로 만든다)
  useEffect(() => {
    if (expired) clearDraft(eventId);
  }, [expired, eventId]);

  // 구매 세션이 끝났으면 키와 저장값을 지우고 대기실로 옮긴다(docs/frontend.md §5.3 '401')
  useEffect(() => {
    if (phase !== 'ended') return;
    const adm = admission.current;
    if (adm) {
      void import('@peaket/api-client/purchase')
        .then(({ openPurchaseSession }) => openPurchaseSession(adm))
        .then((s) => s.end())
        .catch(() => undefined);
    }
    clearDraft(eventId);
    sessionStorage.removeItem(`peaket.admission.${eventId}`);
    const t = setTimeout(() => window.location.replace(`/queue/${encodeURIComponent(eventId)}`), LEAVE_AFTER_MS);
    return () => clearTimeout(t);
  }, [phase, eventId]);

  const seatsHref = `/booking/${encodeURIComponent(eventId)}/seats`;
  const eventHref = `/events/${encodeURIComponent(eventId)}`;
  const clock = left !== null ? holdClock(left) : null;

  const shell = (children: React.ReactNode, bottomBar?: React.ReactNode) => (
    <AppShell
      variant="focus"
      bottomBar={bottomBar ?? null}
      focus={{
        title: event?.title ?? '주문·결제',
        subtitle: event?.line ?? '',
        closeHref: eventHref,
        hold: phase !== 'ready' ? null : expired ? { text: '만료', ariaLabel: '홀드 시간 끝남', tone: 'expired' } : clock ? { text: clock.text.replace('홀드 ', ''), ariaLabel: clock.ariaLabel, tone: clock.tone } : null,
        holdOnDesktop: false,
      }}
    >
      <main className="page-main" id="main" tabIndex={-1}>
        {children}
      </main>
    </AppShell>
  );

  if (phase === 'ended') {
    return shell(
      <section className="state" role="alert" style={{ padding: '96px 24px 24px' }}>
        <h1 className="sr-only">주문·결제</h1>
        <span className="state-icon">
          <i className="ic ic-clock" aria-hidden="true" />
        </span>
        <h2 className="t-lg">예매 시간이 끝났습니다</h2>
        <span className="spinner muted" aria-hidden="true" />
      </section>,
    );
  }
  if (phase === 'failed') {
    return shell(
      <section className="state" role="alert" style={{ padding: '96px 24px 24px' }}>
        <h1 className="sr-only">주문·결제</h1>
        <span className="state-icon">
          <i className="ic ic-alert" aria-hidden="true" />
        </span>
        <h2 className="t-lg">주문 정보를 불러오지 못했습니다</h2>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => {
            setPhase('loading');
            setAttempt((a) => a + 1);
          }}
        >
          다시 시도
        </button>
      </section>,
    );
  }
  if (phase === 'restricted' || phase === 'other-tab') {
    const seatText = hold?.seats?.map((s) => s.label).join(', ') ?? '';
    return shell(
      <div className="w-full px-4 pt-5 pb-8 md:px-6 md:pt-6 md:pb-10">
        <div className="col mx-auto w-full max-w-[600px]">
          <PaymentReturnCard kind={phase} seatText={seatText} totalText={formatWon(hold?.totalAmount ?? 0)} retryHref={seatsHref} appealHref="/my/appeals" />
          {phase === 'other-tab' ? (
            <a className="link-more mt-4 self-center" href="/my/orders">
              주문 내역 보기
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </a>
          ) : null}
        </div>
      </div>,
    );
  }
  if (phase === 'ready' && expired && !hold) {
    // 들어올 때 이미 홀드가 끝나 있었다(읽기 404)
    return (
      <>
        {shell(null)}
        <HoldExpiredDialog seatsHref={seatsHref} />
      </>
    );
  }
  if (phase === 'loading' || !hold || !event) {
    return shell(
      <div className="grid place-items-center" role="status" style={{ padding: 96 }}>
        <span className="spinner muted" aria-hidden="true" />
        <span className="sr-only">주문 정보를 불러오는 중</span>
      </div>,
    );
  }
  return (
    <CheckoutConsentProvider initialAgreed={false} storageKey={`peaket.checkout.${hold.holdId}`}>
      <Ready eventId={eventId} hold={hold} event={event} seatsHref={seatsHref} expired={expired} setExpired={setExpired} setPhase={setPhase} admission={admission.current!} shell={shell} clock={clock} />
    </CheckoutConsentProvider>
  );
}

interface ReadyProps {
  eventId: string;
  hold: HoldView;
  event: { title: string; line: string; sellerName: string; seller?: SellerView; sortMode: CheckoutFormData['sortMode']; perPerson: number };
  seatsHref: string;
  expired: boolean;
  setExpired(v: boolean): void;
  setPhase(p: Phase): void;
  admission: StoredAdmissionRef;
  shell(children: React.ReactNode, bottomBar?: React.ReactNode): React.ReactElement;
  clock: ReturnType<typeof holdClock> | null;
}

function Ready({ eventId, hold, event, seatsHref, expired, setExpired, setPhase, admission, shell, clock }: ReadyProps) {
  const { clear } = useCheckoutConsent();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'danger' | 'warning' } | null>(null);
  const [blocked, setBlocked] = useState<'sale-paused' | 'sale-ended' | 'no-id' | null>(null);
  // 주문을 만들었으면 새로고침해도 다시 만들지 않는다(값은 주문 ID뿐이다, docs/frontend.md §3.12)
  const orderKey = `peaket.checkout.${hold.holdId}.order`;
  const [orderId, setOrderId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(orderKey);
    } catch {
      return null;
    }
  });
  const idem = useRef<{ key: string; body: string } | null>(null);
  const signer = useRef<PurchaseSigner | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  const seats = useMemo(() => hold.seats ?? [], [hold.seats]);
  const total = hold.totalAmount ?? seats.reduce((n, s) => n + s.price, 0);
  const totalText = formatWon(total);
  const seatText = seats.map((s) => s.label).join(', ');
  const hasErrors = Boolean(errors.name || errors.phone);

  const mode: PayMode = orderId ? 'ordered' : expired ? 'expired' : blocked === 'sale-paused' ? 'sale-paused' : blocked === 'sale-ended' ? 'sale-ended' : blocked === 'no-id' ? 'no-id' : 'consent';

  // 판매 재개를 알려 주는 길이 아직 없어(실시간은 HOT-357) 잠시 뒤 다시 주문할 수 있게 한다. 여전히 정지면 서버가 423으로 답한다
  useEffect(() => {
    if (blocked !== 'sale-paused') return;
    const t = setTimeout(() => {
      setBlocked(null);
      setNotice(null);
    }, PAUSED_RETRY_MS);
    return () => clearTimeout(t);
  }, [blocked]);

  /** 실패를 화면으로 옮긴다 */
  const apply = (out: OrderOutcome) => {
    switch (out.kind) {
      case 'ended':
      case 'refresh':
        return setPhase('ended');
      case 'hold-gone':
        return setExpired(true);
      case 'restricted':
        // 서버가 그 구매 세션의 홀드를 모두 풀었다(createOrder 403 booking-restricted)
        sessionStorage.removeItem(`peaket.hold.${eventId}`);
        return setPhase('restricted');
      case 'other-tab':
        return setPhase('other-tab');
      case 'no-id':
        return setBlocked('no-id');
      case 'sale-paused':
        setNotice({ text: '판매가 잠시 멈췄습니다. 고른 좌석은 홀드 시간 동안 유지됩니다', tone: 'danger' });
        return setBlocked('sale-paused');
      case 'sale-ended':
        setNotice({ text: '판매 시간이 끝나 주문할 수 없습니다', tone: 'warning' });
        return setBlocked('sale-ended');
      case 'consent':
        clear();
        return setNotice({ text: '동의 문안이 바뀌었습니다. 내용을 다시 확인하고 동의해 주세요', tone: 'warning' });
      case 'input':
        return setNotice({ text: '입력한 내용을 확인해 주세요', tone: 'danger' });
      default:
        return setNotice({ text: '요청을 처리하지 못했습니다. 다시 시도해 주세요', tone: 'danger' });
    }
  };

  const pay = async () => {
    if (busy || orderId) return;
    setNotice(null);
    const errs = buyerErrors(name, phone);
    setErrors(errs);
    if (errs.name || errs.phone) {
      // 오류 요약으로 초점을 옮긴다(d5 §5.11 '입력 오류')
      requestAnimationFrame(() => (errs.name ? nameRef.current : phoneRef.current)?.focus());
      return;
    }
    setBusy(true);
    try {
      const [{ ApiError, OPERATIONS }, { PurchaseKeyError, openPurchaseSession }, api] = await Promise.all([import('@peaket/api-client'), import('@peaket/api-client/purchase'), import('@/shared/api')]);
      const client = api.browserApiClient();
      if (!client) return apply({ kind: 'retry' });
      const body = { holdId: hold.holdId, buyer: { name: name.trim(), phone: phone.trim() }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: ORDER_CONSENT_VERSION } };
      idem.current = orderIdempotencyKey(idem.current, JSON.stringify(body), () => crypto.randomUUID());
      try {
        signer.current ??= await openPurchaseSession({
          admissionToken: admission.admissionToken,
          ...(admission.serverEcdhPublicKey ? { serverEcdhPublicKey: admission.serverEcdhPublicKey } : {}),
          ...(admission.purchaseSessionExpiresAt ? { purchaseSessionExpiresAt: admission.purchaseSessionExpiresAt } : {}),
        });
      } catch (e) {
        return apply(e instanceof PurchaseKeyError && e.reason !== 'storage' ? { kind: 'ended' } : { kind: 'retry' });
      }
      const send = () => client.send<{ orderId: string; amount: number }>(OPERATIONS.createOrder, { body, idempotencyKey: idem.current!.key, purchase: signer.current! });
      let refreshed = false;
      for (;;) {
        try {
          const r = await send();
          setOrderId(r.data.orderId);
          sessionStorage.setItem(orderKey, r.data.orderId);
          return;
        } catch (e) {
          if (e instanceof PurchaseKeyError) return apply(e.reason === 'storage' ? { kind: 'retry' } : { kind: 'ended' });
          const out = orderOutcome(e instanceof ApiError ? { status: e.status, type: e.type } : {});
          if (out.kind !== 'refresh' || refreshed) return apply(out);
          refreshed = true;
          const r2 = await api.refreshFanToken();
          if (r2 !== 'ok') return apply(r2 === 'rejected' ? { kind: 'ended' } : { kind: 'retry' });
        }
      }
    } catch {
      // 코드 조각을 받지 못했거나 저장소를 쓰지 못했다
      apply({ kind: 'retry' });
    } finally {
      setBusy(false);
    }
  };

  const verify = (
    <Suspense
      fallback={
        <button className="btn btn-primary btn-lg grow md:grow-0" type="button" aria-disabled="true">
          휴대폰 본인확인
        </button>
      }
    >
      <VerifyIdentityButton className="btn btn-primary btn-lg grow md:grow-0">
        <i className="ic ic-phone" aria-hidden="true" />
        휴대폰 본인확인
      </VerifyIdentityButton>
    </Suspense>
  );

  const payProps = {
    mode,
    amountText: totalText,
    holdText: clock ? clock.text.replace('홀드 ', '') : '',
    holdAria: clock?.ariaLabel ?? '',
    onPay: () => void pay(),
    busy,
    verify,
  };

  const data: CheckoutFormData = {
    title: event.title,
    line: event.line,
    seatText,
    grades: gradeLines(seats),
    totalText,
    sellerName: event.sellerName,
    seller: event.seller!,
    sortMode: event.sortMode,
    perPerson: event.perPerson,
  };

  return (
    <>
      {shell(
        <CheckoutForm
          data={data}
          payPanel={<PayAction layout="panel" {...payProps} />}
          top={
            <>
              {hasErrors ? (
                <div className="error-summary" role="alert" aria-labelledby="err-h">
                  <strong id="err-h">결제하기 전에 {[errors.name, errors.phone].filter(Boolean).length}곳을 고쳐 주세요</strong>
                  {errors.name ? <a href="#co-name">{errors.name}</a> : null}
                  {errors.phone ? <a href="#co-phone">{errors.phone}</a> : null}
                </div>
              ) : null}
              {notice ? (
                <div className={`banner banner-${notice.tone}`} role="alert">
                  <i className="ic ic-alert-circle" aria-hidden="true" />
                  <div className="banner-body">{notice.text}</div>
                </div>
              ) : null}
              {blocked === 'no-id' ? (
                <div className="banner banner-info" role="status">
                  <i className="ic ic-info" aria-hidden="true" />
                  <div className="banner-body col" style={{ gap: 6 }}>
                    <span>주문하려면 본인확인이 필요합니다. 확인을 마친 뒤 다시 결제해 주세요</span>
                    <button className="btn btn-outline btn-sm self-start" type="button" onClick={() => setBlocked(null)}>
                      본인확인을 마쳤습니다
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          }
          buyer={
            <>
              <div className="field">
                <label className="label" htmlFor="co-name">
                  예매자 이름 <span className="opt">(필수)</span>
                </label>
                <input ref={nameRef} className={errors.name ? 'input is-error' : 'input'} id="co-name" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? 'co-name-e' : undefined} />
                {errors.name ? (
                  <span className="error-msg" id="co-name-e">
                    <i className="ic ic-alert-circle" aria-hidden="true" />
                    {errors.name}
                  </span>
                ) : null}
              </div>
              <div className="field">
                <label className="label" htmlFor="co-phone">
                  휴대폰 번호 <span className="opt">(필수)</span>
                </label>
                <input ref={phoneRef} className={errors.phone ? 'input is-error' : 'input'} id="co-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={errors.phone ? true : undefined} aria-describedby={errors.phone ? 'co-phone-e' : undefined} />
                {errors.phone ? (
                  <span className="error-msg" id="co-phone-e">
                    <i className="ic ic-alert-circle" aria-hidden="true" />
                    {errors.phone}
                  </span>
                ) : null}
              </div>
            </>
          }
          payment={
            <section className="col" style={{ gap: 12 }} aria-labelledby="co-pay-h">
              <h2 className="t-lg" id="co-pay-h">
                결제수단
              </h2>
              {/* 결제 시도와 결제사 위젯은 HOT-358이다. 그 전에는 주문까지만 만든다 */}
              <p className="t-sm muted">{orderId ? '주문을 만들었습니다' : '결제수단은 주문을 만든 뒤 고릅니다'}</p>
              {orderId ? (
                <p className="t-sm" role="status">
                  주문이 접수되었습니다. 결제창을 여는 기능은 아직 준비 중입니다
                </p>
              ) : null}
            </section>
          }
        />,
        <PayAction layout="bar" {...payProps} />,
      )}
      {expired && !orderId ? <HoldExpiredDialog seatsHref={seatsHref} /> : null}
    </>
  );
}
