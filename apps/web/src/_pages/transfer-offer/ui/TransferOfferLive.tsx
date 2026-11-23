'use client';
// SCR-041 양도 받기 실제 화면(F-05-2). 첫 이동은 정적 셸이고, 요청 값은 화면 스크립트가 같은 사이트 요청으로 읽는다(R-T21 ③).
// 고지 세 문장이 [받기]보다 먼저 읽힌다(d5 §5.23, POL-017·ADR-0173 결정 4). [거절]은 뒤 몫 F-05-11이라 그리지 않는다.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { TransferOfferCard } from '@peaket/ds/TransferOfferCard';
import { TRANSFER_OFFER_FRAUD_NOTICE } from '@/entities/appeal';
import { createEventSummaryReader, type EventSummary } from '@/entities/event-summary';
import { ORIGINS } from '@/shared/config/origins';
import { acceptFailureStateOf, acceptOffer, loadOffer, offerStateOf, type OfferBody } from '../model/offer-flow';
import { offerView } from '../model/view';

type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; text: string; denied?: boolean };

const NOTICES = [
  '이 티켓은 결제한 사람만 취소할 수 있고, 공연이 취소되면 환불도 결제한 분에게 갑니다. 티켓값을 주고받았다면 두 분이 직접 정산해야 합니다',
  '받으면 이 티켓은 다시 양도할 수 없고 결제한 분에게 돌려주기만 할 수 있습니다',
] as const;

export function TransferOfferLive({ offerId }: { offerId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [offer, setOffer] = useState<OfferBody | null>(null);
  const [summary, setSummary] = useState<EventSummary | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const keyRef = useRef<string | null>(null);
  if (keyRef.current === null) keyRef.current = crypto.randomUUID();

  useEffect(() => {
    let cancelled = false;
    const origin = ORIGINS.api;
    if (origin === '') {
      setLoad({ kind: 'error', text: '지금은 양도 요청을 열 수 없습니다. 잠시 뒤 다시 시도해 주세요' });
      return;
    }
    void (async () => {
      const r = await loadOffer({ offerId, origin, fetch: globalThis.fetch });
      if (cancelled) return;
      if (r.kind === 'network') {
        setLoad({ kind: 'error', text: '연결을 확인한 뒤 다시 시도해 주세요' });
        return;
      }
      if (r.kind === 'problem') {
        if (r.status === 404) setLoad({ kind: 'error', text: '지정된 분만 열 수 있습니다', denied: true });
        else setLoad({ kind: 'error', text: '양도 요청을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요' });
        return;
      }
      setOffer(r.body);
      setState(offerStateOf(r.body, Date.now()));
      setAccepted(r.body.status === 'ACCEPTED');
      setLoad({ kind: 'ready' });
      if (r.body.eventId) {
        const answer = await createEventSummaryReader({ origin, fetch: globalThis.fetch }).read(r.body.eventId);
        if (!cancelled && answer.kind === 'ok') setSummary(answer.summary);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [offerId]);

  const accept = async () => {
    const origin = ORIGINS.api;
    if (origin === '' || offer === null) return;
    setBusy(true);
    setNotice(null);
    const r = await acceptOffer({ offerId, idempotencyKey: keyRef.current ?? crypto.randomUUID(), origin, fetch: globalThis.fetch });
    setBusy(false);
    if (r.kind === 'network') {
      setNotice('연결이 끊겨 받지 못했습니다. 같은 요청으로 다시 시도해 주세요');
      return;
    }
    if (r.kind === 'problem') {
      setState(acceptFailureStateOf(r));
      return;
    }
    setOffer(r.body);
    setState(offerStateOf(r.body, Date.now()));
    setAccepted(true);
  };

  const st = state ?? (offer ? offerStateOf(offer, Date.now()) : '요청');
  const v = offerView(st as Parameters<typeof offerView>[0]);
  const title = summary?.title ?? (offer ? '공연 정보를 불러오지 못했습니다' : '양도 받기');
  const when = summary?.startsAt ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(summary.startsAt)) : '';

  return (
    <main className="page-main px-4 pt-5 pb-10 md:px-6 md:pt-6 md:pb-12 lg:px-8 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
      <div className="col mx-auto w-full max-w-[600px] gap-6">
        <h1 className="t-xl lg:text-2xl">양도 받기</h1>

        {v.banner ? (
          <NoticeBanner tone={v.banner.tone} role="alert" title={v.banner.title}>
            {v.banner.body}
          </NoticeBanner>
        ) : null}

        {load.kind === 'loading' ? (
          <p className="t-sm muted" role="status">
            양도 요청을 불러오는 중…
          </p>
        ) : null}
        {load.kind === 'error' ? (
          <div className="state px-4 py-10" role="alert">
            <span className="state-icon">
              <i className="ic ic-lock" aria-hidden="true" />
            </span>
            <h2 className="t-lg">{load.denied ? '지정된 분만 열 수 있습니다' : '양도 요청을 열 수 없습니다'}</h2>
            <p className="t-sm muted">{load.text}</p>
          </div>
        ) : null}

        {load.kind === 'ready' && offer ? (
          <>
            <TransferOfferCard
              variant="recipient"
              aria-label="양도 요청"
              partyName="보낸 분"
              partyInitial="보"
              status={v.badge ?? { label: '수락 대기', tone: 'warning' }}
              details={[]}
              media={
                <div className="col gap-1">
                  <h2 className="t-lg lg:text-xl">{title}</h2>
                  {when ? <p className="t-sm muted">{when}</p> : null}
                </div>
              }
              deadline={
                v.deadline === 'active' && offer.expiresAt
                  ? { label: '수락 기한', value: new Date(offer.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) }
                  : v.deadline === 'expired'
                    ? { label: '수락 기한', value: '지남', expired: true }
                    : undefined
              }
            />

            {v.waiting ? (
              <>
                <NoticeBanner tone="warning" role={null} title="결제한 분만 취소·환불할 수 있습니다">
                  {NOTICES.map((text) => (
                    <p key={text} style={{ marginTop: 6 }}>
                      {text}
                    </p>
                  ))}
                  <p style={{ marginTop: 6 }}>{TRANSFER_OFFER_FRAUD_NOTICE}</p>
                </NoticeBanner>
                {notice ? (
                  <NoticeBanner tone="danger" role="alert">
                    {notice}
                  </NoticeBanner>
                ) : null}
                <button className="btn btn-primary btn-lg btn-block" type="button" disabled={busy} onClick={() => void accept()}>
                  받기
                </button>
                <p className="t-xs muted">받기 전에 위 고지를 확인해 주세요. 받은 뒤에는 이 휴대폰에서 입장용 등록을 해야 QR이 나옵니다.</p>
              </>
            ) : null}

            {accepted ? (
              <div className="card col gap-3 p-4 md:p-5" role="status">
                <p className="t-md fw-b">티켓을 받았습니다</p>
                <p className="t-sm">입장할 휴대폰에서 등록해야 QR이 나옵니다.</p>
                <Link className="btn btn-primary btn-lg btn-block" href={`/my/tickets/${encodeURIComponent(offer.ticketId ?? '')}`}>
                  이 휴대폰을 입장용으로 등록
                </Link>
              </div>
            ) : null}

            {v.closed ? (
              <Link className="link-more self-center" href="/my/tickets">
                마이 티켓으로 가기
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
            ) : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
