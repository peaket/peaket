// SCR-055 예매 주문 상세(보드 '주문 상세'·'예매 확인서'·'입금 오류'). 좌석이 확정된 주문은 '예매 확인서', 티켓이 아직 없는 주문
// (결제 확인 중·발급 중·입금 대기·주문 취소됨·결제 취소)은 '주문 상세'다(d5 §5.29 근거). 예매 확인서 고지는 버튼보다 먼저 읽힌다(d3).
import Link from 'next/link';
import { maskedAccount, type TicketHistory } from '@/entities/account';
import { getPerformance } from '@/entities/performance';
import { formatWon, getProduction, ProductionPoster } from '@/entities/production';
import { getSeller } from '@/entities/seller';
import { getVenue } from '@/entities/venue';
import { badgeClass, toRow } from '@/widgets/order-history';
import { CopyBlockButton } from './CopyButton';
import { BackLink, DetailHead, InquiryLink, LegalBanner, MinorNotice, MORE, NumberCard, SellerSection } from './DetailParts';

export function TicketDetail({ t, depositError }: { t: TicketHistory; depositError: boolean }) {
  const production = getProduction(t.productionId);
  const perf = getPerformance(t.performanceId);
  const seller = production ? getSeller(production.sellerId) : undefined;
  if (!production || !perf || !seller) return null;
  const venue = getVenue(production.venueId);
  const confirmed = t.confirmed && !t.vbank;
  const round = production.performanceIds.indexOf(perf.id) + 1;
  const sub = confirmed
    ? [perf.label, venue?.name, t.gate ? `입장 게이트 ${t.gate}` : undefined]
    : [perf.label, round > 0 ? `${round}회차` : undefined, `${t.quantity}매`];
  const row = toRow(t);
  const ticketHref = t.ticketId ? `/my/tickets/${t.ticketId}` : confirmed && !t.refunds ? '/my/tickets' : undefined;

  return (
    <>
      <BackLink />
      <DetailHead title={confirmed ? '예매 확인서' : '주문 상세'} badges={t.badges} />
      <NumberCard label={confirmed ? '예매번호' : '주문번호'} number={t.number} />
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <ProductionPoster
          art={production.poster.art}
          size="sm"
          title={production.poster.short}
          label={`${production.title} 포스터`}
          className="w-[52px] flex-none md:w-14 lg:w-[52px]"
        />
        <div className="col grow" style={{ gap: 4 }}>
          <h2 className="t-md fw-b">{production.title}</h2>
          <p className="t-sm muted">{sub.filter(Boolean).join(' · ')}</p>
        </div>
      </div>

      {t.vbank ? (
        <>
          {depositError ? (
            <div className="banner banner-danger" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              <div className="banner-body">
                은행 처리 오류로 입금이 취소되었습니다. 발급한 티켓은 무효가 되었고, 입금 기한 {t.vbank.errorDeadlineText}까지 다시 입금하면 티켓을 다시
                발급합니다
              </div>
            </div>
          ) : null}
          <dl className="kv">
            <dt>입금 계좌</dt>
            <dd>{maskedAccount(t.vbank.bank, t.vbank.last4)}</dd>
            <dt>입금액</dt>
            <dd className="num fw-b">{formatWon(t.amount)}</dd>
            <dt>입금 기한</dt>
            <dd>{t.vbank.deadlineText}</dd>
          </dl>
          {/* 계좌번호는 끝 4자리만 보인다. 복사되는 값도 합성 값이다 */}
          <CopyBlockButton text={`0000000000${t.vbank.last4}`} label="계좌 복사" name="계좌 복사(가상계좌 번호)" done="가상계좌 번호를 복사했습니다" />
          <p className="t-sm muted">기한이 지나면 주문이 취소되고 좌석이 풀립니다</p>
          <LegalBanner kind="ticket" sellerName={seller.name} />
        </>
      ) : (
        <>
          <dl className="kv">
            {t.seats ? (
              <>
                <dt>좌석</dt>
                <dd>{t.seats}</dd>
              </>
            ) : null}
            <dt>매수</dt>
            <dd>{t.quantityText ?? (t.seats || !t.grade ? `${t.quantity}매` : `${t.grade} ${t.quantity}매`)}</dd>
            {confirmed ? (
              <>
                <dt>주문번호</dt>
                <dd className="mono">{t.number}</dd>
              </>
            ) : null}
            <dt>결제 수단</dt>
            <dd>{t.methodText}</dd>
            <dt>결제 금액</dt>
            <dd className="kv-total">{formatWon(t.amount)}</dd>
          </dl>
          {t.note && !t.refunds ? <p className="t-sm">{t.note}</p> : null}
          {row.alert ? (
            <div className="row wrap" style={{ gap: '4px 12px' }}>
              <span className="t-sm fw-b tx-warning">
                <i className="ic ic-alert ic-16" aria-hidden="true" /> {row.alert.text}
              </span>
              <Link className="link-more" href={row.alert.link.href}>
                {row.alert.link.label}
                {MORE}
              </Link>
            </div>
          ) : null}
          {confirmed ? (
            <div className="banner banner-info">
              <i className="ic ic-info" aria-hidden="true" />
              <div className="banner-body col" style={{ gap: 6 }}>
                <span>공연일 10일 이내 취소 시 기준에 따른 공제 후 환불</span>
                <Link className="link-more" href="/policy/terms" style={{ alignSelf: 'flex-start' }}>
                  취소 기준
                  {MORE}
                </Link>
                <MinorNotice />
              </div>
            </div>
          ) : null}
          <SellerSection kind="ticket" seller={seller} />
          {t.refunds?.length ? <RefundHistory t={t} /> : null}
          {ticketHref ? (
            <div className="row" style={{ gap: 8 }}>
              <Link className="btn btn-secondary grow" href={ticketHref}>
                <i className="ic ic-ticket" aria-hidden="true" />
                티켓 보기
              </Link>
              {t.cancellable && t.ticketId ? (
                <Link className="btn btn-outline grow" href={`/my/tickets/${t.ticketId}/cancel`}>
                  예매 취소
                </Link>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <InquiryLink />
    </>
  );
}

/** 취소·환불 이력(CMP-054 RefundQuote ticket 이력: 접수일·공제·환급액·환급 예정 3영업일·상태) */
function RefundHistory({ t }: { t: TicketHistory }) {
  return (
    <section className="col" style={{ gap: 10 }} aria-labelledby="h-hist">
      <h2 id="h-hist" className="t-md fw-b">
        취소·환불 이력
      </h2>
      {t.refunds?.map((r) => (
        <article key={r.target} className="card col" style={{ padding: '14px 16px', gap: 10 }} aria-label={`${r.target} 취소·환불`}>
          <div className="row between" style={{ gap: 8 }}>
            <strong className="t-sm fw-b">{r.target}</strong>
            <span className={badgeClass(r.badge.tone)}>{r.badge.text}</span>
          </div>
          <dl className="kv">
            <dt>취소 접수</dt>
            <dd>{r.receivedText}</dd>
            <dt>결제 금액</dt>
            <dd>{formatWon(r.paid)}</dd>
            <dt>{r.feeRate > 0 ? `공제(${r.feeRate}%)` : '공제'}</dt>
            <dd>{r.feeRate > 0 ? `−${formatWon(r.paid - r.refund)}` : '없음'}</dd>
            <dt>환급액</dt>
            <dd className="kv-total">{formatWon(r.refund)}</dd>
            <dt>{r.dueLabel}</dt>
            <dd>{r.dueText}</dd>
            <dt>환급 수단</dt>
            <dd>{r.methodText}</dd>
          </dl>
          <p className="t-xs muted">{r.note}</p>
        </article>
      ))}
    </section>
  );
}
