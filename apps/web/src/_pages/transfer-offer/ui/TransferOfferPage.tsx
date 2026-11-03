// SCR-041 양도 받기(d5 §5.23, d3 SCR-041 행, 캔버스 보드 SCR-041-m·t·d를 한 페이지 반응형으로 합쳤다). 일반 셸, 로그인한 받는 분(하늘).
// 한 열: 양도 요청 카드(CMP-059 recipient) → '결제한 분만 취소·환불' 고지 → [받기] [거절]. 고지가 버튼보다 먼저 읽힌다.
// 휴대폰은 가득, 태블릿(md)·데스크톱(lg)은 가운데 600. 데스크톱은 버튼을 오른쪽 정렬(보드 d).
// 상태는 보드 SCR-041-m의 9가지(t·d 보드는 기본 모양만 있어 m의 상태를 같은 배치에 얹었다).
// 받는 분에게는 결제 금액·결제자 연락처를 보이지 않는다(d2 CMP-059).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { TransferOfferCard } from '@peaket/ds/TransferOfferCard';
import { TRANSFER_OFFER_FRAUD_NOTICE } from '@/entities/appeal';
import { ME_HANEUL } from '@/entities/me';
import { getPerformance } from '@/entities/performance';
import { getProduction, ProductionPoster } from '@/entities/production';
import { getTransferOffer } from '@/entities/transfer';
import { getVenue } from '@/entities/venue';
import { SCR041_STATES } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { offerView } from '../model/view';
import { AcceptButtons, RegisterDevice } from './OfferActions';

type Props = PageProps<{ offerId: string }>;

function load(offerId: string) {
  const offer = getTransferOffer(offerId);
  if (!offer) return null;
  const perf = getPerformance(offer.performanceId);
  const production = getProduction(offer.productionId);
  const venue = production ? getVenue(production.venueId) : undefined;
  if (!perf || !production || !venue) return null;
  return { offer, perf, production, venue };
}

export async function TransferOfferPage({ params, searchParams }: Props) {
  const { offerId } = await params;
  const d = load(offerId);
  if (!d) notFound();
  const { offer, perf, production, venue } = d;
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR041_STATES, '요청');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const keep = { theme: dark ? 'dark' : undefined };
  const v = offerView(state);
  const path = `/my/transfers/${offer.id}`;

  return (
    <AppShell dark={dark} user={ME_HANEUL}>
      <main className="page-main px-4 pt-5 pb-10 md:px-6 md:pt-6 md:pb-12 lg:px-8 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[600px] gap-6">
          <h1 className="t-xl lg:text-2xl">양도 받기</h1>

          {v.banner ? (
            <NoticeBanner tone={v.banner.tone} role="alert" title={v.banner.title}>
              {v.banner.body}
            </NoticeBanner>
          ) : null}

          {v.denied ? (
            <div className="state px-4 py-10" role="alert">
              <span className="state-icon">
                <i className="ic ic-lock" aria-hidden="true" />
              </span>
              <h2 className="t-lg">지정된 분만 열 수 있습니다</h2>
            </div>
          ) : (
            <TransferOfferCard
              variant="recipient"
              aria-labelledby="of-h"
              className="md:gap-[18px] md:px-6 md:py-[22px] lg:px-7 lg:py-6"
              deadlineClassName="md:px-3.5 lg:px-4 lg:py-3"
              partyName={offer.senderName}
              partyInitial={offer.senderInitial}
              status={v.badge ?? { label: '수락 대기', tone: 'warning' }}
              media={
                <div className="row items-start gap-3 md:gap-3.5 lg:gap-4">
                  <ProductionPoster
                    art={production.poster.art}
                    size="sm"
                    title={production.poster.short}
                    label={`${production.title} 포스터`}
                    className="w-14 md:w-[60px] lg:w-16"
                  />
                  <div className="col grow gap-1">
                    <h2 className="t-lg lg:text-xl" id="of-h">
                      {production.title}
                    </h2>
                    <p className="t-sm muted lg:text-md">
                      {perf.label} · {venue.name}
                    </p>
                  </div>
                </div>
              }
              details={[
                { label: '좌석', value: offer.seatText },
                { label: '입장 게이트', value: offer.gateText },
              ]}
              deadline={
                v.deadline === 'active'
                  ? { label: `수락 기한 ${offer.deadlineText}`, value: `${offer.remainingText} 남음` }
                  : v.deadline === 'expired'
                    ? { label: `수락 기한 ${offer.deadlineText}`, value: '지남', expired: true }
                    : undefined
              }
            />
          )}

          {v.waiting ? (
            <>
              <NoticeBanner tone="warning" role={null} id="payer-note" title="결제한 분만 취소·환불할 수 있습니다">
                <p>
                  이 티켓은 결제한 사람만 취소할 수 있고, 공연이 취소되면 환불도 결제한 분에게 갑니다. 티켓값을 주고받았다면 두 분이 직접 정산해야 합니다
                </p>
                <p style={{ marginTop: 6 }}>받으면 이 티켓은 다시 양도할 수 없고 결제한 분에게 돌려주기만 할 수 있습니다</p>
                {/* d5 §5.23 ② 셋째 줄(POL-017, 약관법 제3조 제4항, 추천 적용 2026-10-31, ADR-0173 결정 4) */}
                <p style={{ marginTop: 6 }}>{TRANSFER_OFFER_FRAUD_NOTICE}</p>
              </NoticeBanner>
              <AcceptButtons seat={offer.seatText} path={path} keep={keep} />
            </>
          ) : null}

          {v.accepted ? <RegisterDevice seat={offer.seatText} ticketHref={`/my/tickets/${offer.ticketId}`} /> : null}

          {v.closed ? (
            <Link className="link-more self-center" href="/my/tickets">
              마이 티켓으로 가기
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      </main>
      <PreviewSwitcher path={path} states={SCR041_STATES} current={state} keep={keep} />
    </AppShell>
  );
}
