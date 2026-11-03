// SCR-014 티켓 양도(d5 §5.14, d3 SCR-014 행, 캔버스 보드 SCR-014-m·t·d를 한 페이지 반응형으로 합쳤다). 일반 셸.
// 한 열: 양도할 티켓 → 양도 마감 → 양도 정책 → 받는 분 확인 → 법정 고지(부정구매·부정판매, POL-024 라목) → 보내기 전 확인 → 진행 중인 요청.
// 휴대폰은 가득, 태블릿(md)은 가운데 600, 데스크톱(lg)은 가운데 640에 [양도 요청 보내기]를 오른쪽 정렬(보드 d).
// 상태는 보드 SCR-014-m의 11가지(t·d 보드는 기본 모양만 있어 m의 상태를 같은 배치에 얹었다). 시트 상태는 열린 채로 그린다.
// '부정 예매 조사로 잠김'(d5 §5.14, ADR-0173 결정 3)은 그 소명 요청으로 잠긴 표(apl-0003의 첫 좌석)를 보이고 ( 소명 보기 › )로 SCR-042에 보낸다(좌석은 추천 적용 2026-10-31).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge } from '@peaket/ds/Badge';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { TransferOfferCard } from '@peaket/ds/TransferOfferCard';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { DEMO_FRAUD_APPEAL_ID, getAppeal, transferLocked409Text, transferLockedText } from '@/entities/appeal';
import { ME } from '@/entities/me';
import { getPerformance } from '@/entities/performance';
import { getProduction, ProductionPoster, type Production } from '@/entities/production';
import { getTicket } from '@/entities/ticket';
import { DEMO_OFFER_ID, getTransferOffer } from '@/entities/transfer';
import { getVenue } from '@/entities/venue';
import { SCR014_STATES } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { RECEIVED_TICKET, RECIPIENT_INPUT_EXAMPLE, TRANSFER_SEAT, transferView } from '../model/view';
import { SendSection, WithdrawButton } from './TransferClient';

type Props = PageProps<{ ticketId: string }>;

/** POL-024 라목 부정구매·부정판매 처벌 법정 고지(원문 그대로, 양도 화면) */
const LEGAL_RESALE_NOTICE =
  '매크로 등으로 판매자가 정한 공정한 구입 과정을 우회하거나 방해하여 되팔 목적으로 입장권을 구매하는 부정구매와, 판매자의 동의 없이 상습 또는 영업으로 자신이 구입한 가격보다 비싸게 입장권을 판매하거나 알선하는 부정판매는 1년 이하의 징역 또는 1천만원 이하의 벌금에 처해질 수 있습니다(공연법 §41). 부정판매에는 판매금액의 50배 이하의 과징금이 부과될 수 있습니다(공연법 §4의4).';

/** h2: 휴대폰·태블릿 t-md 굵게, 데스크톱 t-lg */
const H2 = 't-md fw-b lg:text-lg';

function load(ticketId: string) {
  const ticket = getTicket(ticketId);
  if (!ticket) return null;
  const perf = getPerformance(ticket.performanceId);
  const production = getProduction(ticket.productionId);
  const venue = production ? getVenue(production.venueId) : undefined;
  if (!perf || !production || !venue) return null;
  return { ticket, perf, production, venue };
}

export async function TicketTransferPage({ params, searchParams }: Props) {
  const { ticketId } = await params;
  const d = load(ticketId);
  if (!d) notFound();
  const { perf, production, venue } = d;
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR014_STATES, '받는 사람 확인');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const keep = { theme: dark ? 'dark' : undefined };
  const v = transferView(state);
  const offer = getTransferOffer(DEMO_OFFER_ID)!;
  const path = `/my/tickets/${ticketId}/transfer`;
  const ticketHref = `/my/tickets/${ticketId}`;
  const when = `${perf.label} · ${venue.name}`;
  const recvPerf = getPerformance(RECEIVED_TICKET.performanceId);
  // 부정 예매 조사로 잠긴 표: 소명 요청(apl-0003)으로 잠긴 첫 좌석과 잠금 최대 기한(transferLockExpiresAt)
  const fraudAppeal = v.fraudLocked ? getAppeal(DEMO_FRAUD_APPEAL_ID) : undefined;
  const lockedSeat = fraudAppeal?.lockedSeatLabels?.[0];
  const appealHref = `/my/appeals/${DEMO_FRAUD_APPEAL_ID}`;
  const backToTickets = (
    <Link className="link-more self-center" href="/my/tickets">
      마이 티켓으로 돌아가기
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </Link>
  );

  return (
    <AppShell dark={dark}>
      <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-5 md:pb-12 lg:px-8 lg:pt-8 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[600px] gap-6 lg:max-w-[640px]">
          <div className="col gap-2">
            <Link className="row t-sm gap-0.5 self-start text-(--text-muted)" href="/my/tickets">
              <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
              마이 티켓
            </Link>
            <h1 className="t-xl lg:text-2xl">티켓 양도</h1>
          </div>

          {v.sent ? (
            <NoticeBanner tone="success" title="양도 요청을 보냈습니다">
              {offer.recipientMasked} 님에게 알림을 보냈습니다. {offer.recipientMasked} 님이 수락하면 티켓이 넘어갑니다.
            </NoticeBanner>
          ) : null}

          {v.ticketCard ? (
            <TicketCard
              production={production}
              label="양도할 티켓"
              when={when}
              seat={
                v.fraudLocked && lockedSeat ? (
                  <strong>{lockedSeat}</strong>
                ) : (
                  <>
                    <strong>{TRANSFER_SEAT.seat}</strong> · {TRANSFER_SEAT.gate}
                  </>
                )
              }
              badge={
                v.fraudLocked ? (
                  <Badge tone="warning">양도 잠김</Badge>
                ) : v.badgeOk ? (
                  <Badge tone="success">사용 가능</Badge>
                ) : v.sentSec ? (
                  <Badge tone="warning">양도 요청 중</Badge>
                ) : null
              }
            />
          ) : null}

          {v.blockRecv ? (
            <>
              <TicketCard
                production={production}
                label="양도하려는 티켓"
                when={`${recvPerf?.label ?? ''} · ${venue.name}`}
                seat={
                  <>
                    <strong>{RECEIVED_TICKET.seat}</strong> · 보낸 분 &apos;{RECEIVED_TICKET.from}&apos;
                  </>
                }
                badge={<Badge tone="primary">받은 티켓</Badge>}
              />
              <NoticeBanner tone="danger" role="alert" title="이 티켓은 양도할 수 없습니다">
                받은 티켓은 다시 양도할 수 없고 결제한 분에게 돌려주기만 할 수 있습니다
              </NoticeBanner>
              <div className="col items-center gap-3.5">
                <Link className="link-more" href={ticketHref} aria-label={`${RECEIVED_TICKET.seat} 티켓에서 결제자에게 돌려주기`}>
                  티켓에서 결제자에게 돌려주기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
                <Link className="link-more" href="/my/tickets">
                  마이 티켓으로 돌아가기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            </>
          ) : null}

          {v.showDeadline ? (
            <NoticeBanner tone="info" icon="clock" role={null} title={`양도 마감 ${perf.transferDeadlineText}`}>
              공연 시작 2시간 전과 입장 시작 중 이른 때까지 양도할 수 있습니다
            </NoticeBanner>
          ) : null}

          {v.blockDeadline ? (
            <>
              <NoticeBanner tone="danger" role="alert" title="양도 가능 시간이 지났습니다">
                이 공연의 양도 마감은 {perf.transferDeadlineText}이었습니다. 공연 시작 2시간 전과 입장 시작 중 이른 때가 마감입니다.
              </NoticeBanner>
              {backToTickets}
            </>
          ) : null}

          {v.blockProduct ? (
            <>
              <section className="col gap-2.5" aria-labelledby="h-pol-x">
                <div className="row between gap-2">
                  <h2 className={H2} id="h-pol-x">
                    이 티켓의 양도 정책
                  </h2>
                  <Badge tone="danger">양도 불가</Badge>
                </div>
                <NoticeBanner tone="danger" role="alert">
                  이 상품은 양도할 수 없습니다
                </NoticeBanner>
              </section>
              {backToTickets}
            </>
          ) : null}

          {v.policy ? (
            <section className="col gap-2.5" aria-labelledby="h-pol">
              <div className="row between gap-2">
                <h2 className={H2} id="h-pol">
                  이 티켓의 양도 정책
                </h2>
                {/* 잠긴 표(409 뒤 포함)에는 <양도 가능> 대신 <양도 잠김>(아래 잠김 안내와 어긋나지 않게, FRN-090 리뷰 결함 7) */}
                {v.fraudLocked ? <Badge tone="warning">양도 잠김</Badge> : <Badge tone="success">양도 가능</Badge>}
              </div>
              <ul className="col t-sm gap-2">
                {[
                  '회원에게만 양도할 수 있습니다. 본인확인을 마친 피켓 회원만 받을 수 있습니다',
                  '받은 분은 다시 양도할 수 없고 결제한 분에게 돌려주기만 할 수 있습니다',
                  `예매 취소와 환불은 결제한 분(${ME.name} 님)만 할 수 있습니다`,
                ].map((t) => (
                  <li key={t} className="row items-start gap-2.5">
                    <span className="dot muted mt-1.5" aria-hidden="true" />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {v.fraudLocked && fraudAppeal?.lockExpiresAtText ? (
            <>
              {v.transferLockedError ? (
                // d5 §9.2 양도 요청 409 transfer-locked: 요청 사이에 잠겼다. 글은 §9.2 그대로(§5.14 상태 글과 다르다)
                <NoticeBanner tone="danger" role="alert" title="양도 요청을 보내지 못했습니다">
                  {transferLocked409Text(fraudAppeal.lockExpiresAtText)}
                </NoticeBanner>
              ) : (
                <NoticeBanner tone="warning" role="alert" title="이 티켓은 지금 양도할 수 없습니다">
                  {transferLockedText(fraudAppeal.lockExpiresAtText)}
                </NoticeBanner>
              )}
              <div className="col items-center gap-3.5">
                <Link className="link-more" href={appealHref}>
                  소명 보기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
                {backToTickets}
              </div>
            </>
          ) : null}

          {v.form ? (
            <>
              <section className="col gap-3" aria-labelledby="h-rc">
                <h2 className={H2} id="h-rc">
                  받는 분 확인
                </h2>
                <RecipientField error={v.rcNoMember ? 'noMember' : v.rcTooMany ? 'tooMany' : null} />
                {v.rcOk ? (
                  <div className="card-flat row gap-3 px-3.5 py-3 md:px-4" role="status">
                    <span className="avatar" aria-hidden="true">
                      {offer.recipientInitial}
                    </span>
                    <span className="col grow gap-0.5">
                      <span className="t-md fw-b">{offer.recipientMasked}</span>
                      <span className="t-xs muted">본인확인을 마친 피켓 회원입니다</span>
                    </span>
                    <i className="ic ic-check-circle tx-success" aria-hidden="true" />
                  </div>
                ) : null}
              </section>

              {v.sendSec ? (
                <>
                  <NoticeBanner tone="legal" role={null} tag="법정 고지">
                    {LEGAL_RESALE_NOTICE}
                  </NoticeBanner>
                  <SendSection
                    initialSheet={v.sheet}
                    path={path}
                    keep={keep}
                    seat={TRANSFER_SEAT.seat}
                    recipient={offer.recipientMasked}
                    title={production.title}
                    when={perf.label}
                    deadline={offer.deadlineText}
                  />
                </>
              ) : null}
            </>
          ) : null}

          {v.sentSec ? (
            <section className="col gap-3" aria-labelledby="h-prog">
              <h2 className={H2} id="h-prog">
                진행 중인 요청
              </h2>
              <TransferOfferCard
                variant="sender"
                aria-label={`${TRANSFER_SEAT.seat} 양도 요청`}
                partyName={`${offer.recipientMasked} 님`}
                partyInitial={offer.recipientInitial}
                status={{ label: '수락 대기', tone: 'warning' }}
                details={[
                  { label: '좌석', value: TRANSFER_SEAT.seat },
                  { label: '남은 시간', value: offer.sentRemainingText, num: true },
                  { label: '수락 기한', value: offer.deadlineText },
                ]}
              >
                {v.sent ? <WithdrawButton seat={TRANSFER_SEAT.seat} recipient={offer.recipientMasked} backHref={ticketHref} /> : null}
                {v.wdFail ? (
                  <>
                    <NoticeBanner tone="danger" role="alert">
                      이미 처리된 요청입니다
                    </NoticeBanner>
                    {backToTickets}
                  </>
                ) : null}
              </TransferOfferCard>
            </section>
          ) : null}
        </div>
      </main>
      <PreviewSwitcher path={path} states={SCR014_STATES} current={state} keep={keep} />
    </AppShell>
  );
}

/** 양도할 티켓 카드(CMP-028 TicketCard transfer 모양, 보드 마크업) */
function TicketCard({
  production,
  label,
  when,
  seat,
  badge,
}: {
  production: Production;
  label: string;
  when: string;
  seat: ReactNode;
  badge: ReactNode;
}) {
  return (
    <div className="card row items-start gap-3 px-4 py-3.5 md:gap-3.5 md:px-5 md:py-4 lg:gap-4 lg:py-[18px]" role="group" aria-label={label}>
      <ProductionPoster
        art={production.poster.art}
        size="sm"
        title={production.poster.short}
        label={`${production.title} 포스터`}
        className="w-11 md:w-12 lg:w-[52px]"
      />
      <div className="col grow gap-1">
        <p className="t-md fw-b lg:text-lg">{production.title}</p>
        <p className="t-sm muted">{when}</p>
        <p className="t-sm">{seat}</p>
      </div>
      {badge}
    </div>
  );
}

/** ③ 받는 분 휴대폰 번호 또는 회원 코드 + [회원 확인]. 오류는 칸에 aria-describedby로 잇는다 */
function RecipientField({ error }: { error: 'noMember' | 'tooMany' | null }) {
  const errorText =
    error === 'noMember' ? '본인확인을 마친 피켓 회원에게만 양도할 수 있습니다' : error === 'tooMany' ? '잠시 뒤 다시 확인해 주세요' : null;
  return (
    <div className="field">
      <label className="label" htmlFor="rc-id">
        휴대폰 번호 또는 회원 코드
      </label>
      <div className="row gap-2">
        <input
          className={errorText ? 'input is-error' : 'input'}
          id="rc-id"
          type="text"
          autoComplete="off"
          defaultValue={RECIPIENT_INPUT_EXAMPLE}
          aria-invalid={errorText ? true : undefined}
          aria-describedby={errorText ? 'rc-id-e rc-h' : 'rc-h'}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="btn btn-secondary" type="button" style={{ height: 48, flex: 'none' }}>
          회원 확인
        </button>
      </div>
      {errorText ? (
        <span className="error-msg" id="rc-id-e" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          {errorText}
        </span>
      ) : null}
      <span className="hint" id="rc-h">
        회원 코드는 받는 분의 계정 설정에 있습니다
      </span>
    </div>
  );
}
