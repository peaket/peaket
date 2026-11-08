'use client';
// SCR-012 결제 결과(d5 §5.12, docs/frontend.md §3.6, ADR-0230). 주소의 주문 ID로 결제 상태를 롱 폴링하고 결제 결과 기계가 정한 카드를 그린다.
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppShell } from '@/widgets/app-shell';
import type { ResultContext } from '../model/result-machine';
import { failureText } from '../model/result-text';
import { CopyButton, InstallGuideButton } from './ResultClient';

const ICON56 = { width: 56, height: 56 } as const;
const TOP_WAIT = 'mt-10 md:mt-12 lg:mt-16';
const TOP = 'mt-6 md:mt-8 lg:mt-10';

interface Seller {
  legalName: string;
  representative: string;
  address: string;
  phone: string;
  email: string;
  businessRegNo: string;
  mailOrderReportNo?: string;
}

interface Head {
  title: string;
  subtitle: string;
  seller?: Seller;
}

interface TicketLine {
  ticketId: string;
  seatLabel?: string;
  gateZone?: string;
}

function StateIcon({ icon, tone }: { icon: string; tone: string }) {
  return (
    <span className={`state-icon ${tone}`} style={ICON56}>
      <i className={`ic ${icon}`} aria-hidden="true" />
    </span>
  );
}

function Indeterminate({ label }: { label: string }) {
  return (
    <div className="progress indet" role="progressbar" aria-label={label}>
      <span />
    </div>
  );
}

const CENTER = { gap: 10, alignItems: 'center', textAlign: 'center' } as const;

function OrderLink({ href }: { href: string }) {
  return (
    <Link className="btn btn-secondary btn-lg btn-block" href={href}>
      예매·주문 내역 보기
    </Link>
  );
}

function BookingNo({ no }: { no: string }) {
  return (
    <dl className="kv">
      <dt>예매번호</dt>
      <dd className="mono">{no}</dd>
    </dl>
  );
}

/** 주문 조회 API가 없어 주문 ID를 예매번호로 보인다(ADR-0230 결정 3) */
function Confirmed({ orderId, head, tickets }: { orderId: string; head: Head | null; tickets: readonly TicketLine[] }) {
  const seller = head?.seller;
  return (
    <>
      <section className="card pad-lg col gap-[18px] lg:gap-4" aria-labelledby="rs-h">
        <div className="col items-center gap-2.5 text-center lg:flex-row lg:gap-3.5 lg:text-left" role="alert">
          <span className="state-icon is-success size-14 lg:size-12">
            <i className="ic ic-check-circle" aria-hidden="true" />
          </span>
          <h1 className="t-xl" id="rs-h">
            예매 완료
          </h1>
          <span className="badge badge-success badge-lg">
            <i className="ic ic-ticket" aria-hidden="true" />
            발권됨
          </span>
        </div>
        <div className="card-flat row gap-3 px-3.5 py-3 md:gap-4 md:px-4">
          <div className="col grow" style={{ gap: 2 }}>
            <span className="t-xs muted">예매번호</span>
            <span className="mono fw-b" style={{ wordBreak: 'break-all' }}>
              {orderId}
            </span>
          </div>
          <CopyButton text={orderId} label="복사" ariaLabel={`예매번호 ${orderId} 복사`} done="예매번호를 복사했습니다" />
        </div>
        {tickets.length > 0 ? (
          <div className="col" style={{ gap: 8 }}>
            <h2 className="eyebrow">발권한 티켓 {tickets.length}매</h2>
            <div className="col gap-2 md:grid md:grid-cols-2 md:gap-3">
              {tickets.map((t) => (
                <article key={t.ticketId} className="card row" style={{ gap: 12, padding: '12px 14px' }}>
                  <span className="state-icon is-primary" style={{ width: 40, height: 40 }}>
                    <i className="ic ic-ticket" aria-hidden="true" />
                  </span>
                  <div className="col grow" style={{ gap: 2 }}>
                    <h3 className="t-md fw-b">{t.seatLabel ?? '티켓'}</h3>
                    {t.gateZone ? <p className="t-sm muted">입장 게이트 {t.gateZone}</p> : null}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}
        <Link className="btn btn-primary btn-lg btn-block" href="/my/tickets">
          마이 티켓 보기
        </Link>
      </section>
      <div className="banner banner-info">
        <i className="ic ic-phone" aria-hidden="true" />
        <div className="banner-body">
          홈 화면에 추가하면 공연장에서 인터넷이 없어도 티켓을 엽니다 <InstallGuideButton />
        </div>
      </div>
      {tickets[0] ? (
        <Link className="card-flat flex items-center gap-3.5 p-4 md:px-5" href={`/my/tickets/${encodeURIComponent(tickets[0].ticketId)}/addons`} style={{ color: 'inherit' }}>
          <span className="state-icon is-primary" style={{ width: 48, height: 48 }}>
            <i className="ic ic-bag" aria-hidden="true" />
          </span>
          <span className="col grow" style={{ gap: 2 }}>
            <span className="t-md fw-b">이 공연 부가 상품</span>
            <span className="t-sm muted">주차권과 공연 상품을 티켓에 더할 수 있습니다</span>
          </span>
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      ) : null}
      {seller ? (
        <section className="col" style={{ gap: 12 }} aria-labelledby="rs-rcpt-h">
          <h2 className="t-lg" id="rs-rcpt-h">
            예매 확인서
          </h2>
          <div className="banner banner-legal">
            <i className="ic ic-scale" aria-hidden="true" />
            <div className="banner-body t-md">
              <span className="legal-tag">법정 고지</span>
              판매자: {seller.legalName}. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있습니다
            </div>
          </div>
          <dl className="row wrap t-sm gap-x-3.5 gap-y-1.5 md:gap-x-4">
            {[
              ['상호', seller.legalName],
              ['대표자', seller.representative],
              ['주소', seller.address],
              ['전화', seller.phone],
              ['전자우편', seller.email],
              ['사업자등록번호', seller.businessRegNo],
              ['통신판매업 신고번호', seller.mailOrderReportNo ?? ''],
            ].map(([term, value]) => (
              <div key={term} className="row" style={{ gap: 4 }}>
                <dt className="muted">{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
  );
}

function Body({ value, ctx, orderId, head, tickets, eventId }: { value: string; ctx: ResultContext; orderId: string; head: Head | null; tickets: readonly TicketLine[]; eventId: string }) {
  const seatsHref = `/booking/${encodeURIComponent(eventId)}/seats`;
  const ordersHref = `/my/orders/${encodeURIComponent(orderId)}`;
  // 안내 글도 낭독 영역 안에 둔다(상태가 바뀔 때 제목과 함께 읽힌다)
  const center = (id: string, tone: string, icon: string, title: string, role: 'alert' | 'status', lead: ReactNode, extra: ReactNode, top = TOP) => (
    <section className={`card pad-lg col ${top}`} style={{ gap: 16 }} aria-labelledby={id}>
      <div className="col" style={CENTER} role={role}>
        <StateIcon icon={icon} tone={tone} />
        <h1 className="t-xl" id={id}>
          {title}
        </h1>
        {lead}
      </div>
      {extra}
    </section>
  );
  switch (value) {
    case 'confirmed':
      return <Confirmed orderId={orderId} head={head} tickets={tickets} />;
    case 'checking':
      return center('ck-h', 'is-primary', 'ic-clock', '결제 확인 중', 'status', <p className="t-sm muted">결제 접수 후 확정까지 몇 초가 걸립니다</p>, <Indeterminate label="결제 확인 중" />, TOP_WAIT);
    case 'checkingLong':
      return center(
        'sl-h',
        'is-primary',
        'ic-clock',
        '결제 확인 중',
        'status',
        <>
          <p className="t-md">결과를 확인하고 있습니다. 화면을 닫아도 결과가 나오면 알림으로 알려 드립니다</p>
          <p className="t-xs muted">이 화면을 열어 두면 10분 동안 계속 확인합니다</p>
        </>,
        <>
          <Indeterminate label="결제 확인 중" />
          <OrderLink href={ordersHref} />
        </>,
        TOP_WAIT,
      );
    case 'issuing':
      return center(
        'is-h',
        'is-primary',
        'ic-ticket',
        '결제가 완료되었습니다',
        'status',
        <p className="t-md">티켓을 발급하고 있습니다. 발급되면 알림으로 알려 드립니다</p>,
        <>
          <Indeterminate label="티켓 발급 중" />
          <BookingNo no={orderId} />
          <OrderLink href={ordersHref} />
        </>,
      );
    case 'unknown':
      return center(
        'uk-h',
        'is-warning',
        'ic-history',
        '결제 확인이 지연되고 있습니다',
        'alert',
        <p className="t-md">{ctx.unknownLong ? '확인을 계속하고 있습니다. 중복 청구는 발생하지 않습니다' : '결과가 확정되는 대로 이메일과 알림으로 보내 드립니다'}</p>,
        <>
          {ctx.unknownLong ? null : (
            <div className="banner banner-info">
              <i className="ic ic-shield" aria-hidden="true" />
              <div className="banner-body fw-b">확인 중이며 중복 청구는 발생하지 않습니다</div>
            </div>
          )}
          <BookingNo no={orderId} />
          <OrderLink href={ordersHref} />
        </>,
      );
    case 'failed':
      return center(
        'dc-h',
        'is-danger',
        'ic-x-circle',
        failureText(ctx.reason),
        'alert',
        null,
        <Link className="btn btn-primary btn-lg btn-block" href={seatsHref}>
          좌석 다시 고르기
        </Link>,
      );
    case 'compensated':
      return center(
        'cp-h',
        'is-warning',
        'ic-undo',
        '티켓을 발급하지 못해 결제를 취소(환불)했습니다',
        'alert',
        null,
        <>
          <BookingNo no={orderId} />
          <OrderLink href={ordersHref} />
        </>,
      );
    case 'awaitingDeposit': {
      const a = ctx.account;
      const line = [a?.bank, a?.accountNumber].filter(Boolean).join(' ');
      return center(
        'vb-h',
        'is-primary',
        'ic-bank',
        '입금하면 예매가 확정됩니다',
        'alert',
        null,
        <>
          <dl className="kv">
            <dt>입금 계좌</dt>
            <dd>{line}</dd>
            <dt>입금 기한</dt>
            <dd>{a?.dueAt ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(a.dueAt)) : ''}</dd>
            <dt>예매번호</dt>
            <dd className="mono">{orderId}</dd>
          </dl>
          {line ? <CopyButton className="btn btn-outline btn-block" text={a?.accountNumber ?? line} label="계좌 복사" ariaLabel="가상계좌 번호 복사" done="계좌번호를 복사했습니다" /> : null}
          <p className="t-sm muted">기한이 지나면 주문이 취소되고 좌석이 풀립니다</p>
          <Link className="link-more" href="/my/orders" style={{ alignSelf: 'center' }}>
            예매·주문 내역 보기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </>,
      );
    }
    case 'notAccepted':
      return center(
        'na-h',
        'is-warning',
        'ic-alert-circle',
        '결제가 끝나지 않았습니다',
        'alert',
        <p className="t-md">요금은 청구되지 않습니다. 고른 좌석은 홀드 시간 동안 그대로 있습니다</p>,
        <Link className="btn btn-primary btn-lg btn-block" href={`/booking/${encodeURIComponent(eventId)}/checkout`}>
          다시 결제하기
        </Link>,
      );
    case 'orderExpired':
      return center(
        'oe-h',
        'is-warning',
        'ic-clock',
        '결제하지 않아 주문이 끝났습니다',
        'alert',
        <p className="t-md">요금은 청구되지 않았습니다</p>,
        <Link className="btn btn-primary btn-lg btn-block" href={seatsHref}>
          좌석 다시 고르기
        </Link>,
      );
    default:
      return center(
        'nf-h',
        'is-warning',
        'ic-alert-circle',
        '결제 결과를 확인하지 못했습니다',
        'alert',
        null,
        <Link className="btn btn-secondary btn-lg btn-block" href="/my/orders">
          예매·주문 내역 보기
        </Link>,
      );
  }
}

const clearPurchase = (eventId: string, orderId: string, all: boolean) => {
  // 이 탭에서 접수한 주문일 때만 지운다(뒤로 가기로 옛 결과에 들어와 새 홀드를 지우지 않게)
  if (sessionStorage.getItem(`peaket.accept.${orderId}`) === null) return;
  sessionStorage.removeItem(`peaket.accept.${orderId}`);
  sessionStorage.removeItem(`peaket.hold.${eventId}`);
  if (!all) return;
  // 구매 세션이 끝났다: 입장 저장값과 서명 키를 지운다(§3.6 '구매 세션 저장물 정리')
  try {
    const adm = JSON.parse(sessionStorage.getItem(`peaket.admission.${eventId}`) ?? 'null') as { admissionToken?: string } | null;
    if (adm?.admissionToken) {
      void import('@peaket/api-client/purchase')
        .then(({ openPurchaseSession }) => openPurchaseSession(adm as { admissionToken: string }))
        .then((s) => s.end())
        .catch(() => undefined);
    }
  } catch {
    /* 저장값이 깨졌으면 지울 키도 찾지 못한다 */
  }
  sessionStorage.removeItem(`peaket.admission.${eventId}`);
};

export function ResultLive({ eventId }: { eventId: string }) {
  const [snap, setSnap] = useState<{ value: string; ctx: ResultContext }>({ value: 'checking', ctx: { unknownLong: false } });
  const [orderId, setOrderId] = useState('');
  const [head, setHead] = useState<Head | null>(null);
  const [tickets, setTickets] = useState<readonly TicketLine[]>([]);
  const started = useRef(false);

  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    const order = new URLSearchParams(window.location.search).get('order');
    if (!order) {
      setSnap({ value: 'gone', ctx: { unknownLong: false } });
      return;
    }
    setOrderId(order);
    let stop: (() => void) | undefined;
    void (async () => {
      const [api, { startResult }, { getEvent }] = await Promise.all([import('@/shared/api'), import('../model/result-runtime'), import('@peaket/api-client/endpoints/catalog')]);
      if (!live) return;
      const client = api.browserApiClient();
      if (!client) return setSnap({ value: 'gone', ctx: { unknownLong: false } });
      let acceptedAt = Date.now();
      try {
        acceptedAt = (JSON.parse(sessionStorage.getItem(`peaket.accept.${order}`) ?? 'null') as { at?: number } | null)?.at ?? acceptedAt;
      } catch {
        /* 기록이 없으면 지금부터 잰다 */
      }
      const r = startResult({ orderId: order, client, refresh: api.refreshFanToken, acceptedAt });
      stop = r.stop;
      r.actor.subscribe((s) => live && setSnap({ value: String(s.value), ctx: s.context }));
      const e = (await getEvent(eventId, { signal: abort.signal }).catch(() => null))?.data;
      if (live && e) setHead({ title: e.title ?? '결제 결과', subtitle: e.placeName ?? '', ...(e.seller ? { seller: e.seller as Seller } : {}) });
    })().catch(() => live && setSnap({ value: 'gone', ctx: { unknownLong: false } }));
    return () => {
      live = false;
      abort.abort();
      stop?.();
    };
  }, [eventId]);

  // 끝난 결과의 저장물을 정리한다. 확정·입금 대기는 구매 세션이 끝나고, 실패는 이어진다(§3.6)
  const value = snap.value;
  useEffect(() => {
    if (!orderId || started.current) return;
    if (value === 'confirmed' || value === 'awaitingDeposit') {
      started.current = true;
      clearPurchase(eventId, orderId, true);
    } else if (value === 'failed' || value === 'orderExpired') {
      started.current = true;
      clearPurchase(eventId, orderId, false);
    } else if (value === 'notAccepted') {
      started.current = true;
      sessionStorage.removeItem(`peaket.accept.${orderId}`);
    }
  }, [value, orderId, eventId]);

  // 확정이면 발권한 티켓을 보인다(받지 못해도 마이 티켓 링크로 볼 수 있다)
  useEffect(() => {
    if (value !== 'confirmed') return;
    let live = true;
    void (async () => {
      const [{ OPERATIONS }, api] = await Promise.all([import('@peaket/api-client'), import('@/shared/api')]);
      const client = api.browserApiClient();
      if (!client) return;
      // 커서를 따라 끝까지 받되(guidelines §3) 몇 쪽 [가정]에서 멈춘다. 이 회차의 쓸 수 있는 티켓만 보인다(환불·무효 제외)
      const found: TicketLine[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await client.send<{ items?: Array<TicketLine & { eventId?: string; status?: string }>; nextCursor?: string | null }>(OPERATIONS.listTickets, cursor ? { query: { cursor } } : {});
        for (const t of r.data.items ?? []) if (t.eventId === eventId && t.status !== 'REFUNDED' && t.status !== 'VOIDED') found.push(t);
        cursor = r.data.nextCursor ?? undefined;
        if (!cursor) break;
      }
      if (live) setTickets(found);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [value, eventId]);

  return (
    <AppShell variant="focus" focus={{ title: head?.title ?? '결제 결과', subtitle: head?.subtitle ?? '', closeHref: `/events/${encodeURIComponent(eventId)}`, closeLabel: '닫고 공연 상세로 가기' }}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="w-full px-4 pt-6 pb-10 md:px-6 md:pt-8 md:pb-12 lg:px-8">
          <div className="col mx-auto w-full max-w-[560px]" style={{ gap: 20 }}>
            <Body value={value} ctx={snap.ctx} orderId={orderId} head={head} tickets={tickets} eventId={eventId} />
          </div>
        </div>
      </main>
    </AppShell>
  );
}
