// SCR-038 예매 취소(d5 §5.20, d3 SCR-038 행, 캔버스 보드 SCR-038-m·t·d를 한 페이지 반응형으로 합쳤다). 일반 셸.
// 휴대폰·태블릿: 한 열(좌석 고르기 → 취소 수수료 기준표 → 환급 예상액 → 입장 시작 뒤 취소 유의 → (가상계좌) 환불받을 계좌) + 아래 고정 막대.
// 데스크톱(lg): 왼쪽 8열 본문, 오른쪽 4열에 환급 명세와 실행 버튼을 고정(보드 d). 명세가 실행 버튼보다 먼저 읽힌다(d2 CMP-054).
// 상태는 보드 SCR-038-m의 14가지(t·d 보드는 기본 모양만 있어 m의 상태를 같은 배치에 얹었다). 시트 상태는 열린 채로 그린다.
// 보드 t는 가상계좌 결제 예매(환불받을 계좌 칸, 결제 수단 줄)다. 그 변형은 ?pay=vbank로 본다(퍼블리싱용 검색 값, 추천안).
// 연기 환급 모드는 d5 주소대로 ?mode=postponed로도 연다(상태를 고르지 않았을 때 '연기 환급').
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { buttonClass } from '@peaket/ds/Button';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { Select } from '@peaket/ds/Select';
import { TextField } from '@peaket/ds/TextField';
import { getPerformance } from '@/entities/performance';
import { getProduction } from '@/entities/production';
import { getTicket } from '@/entities/ticket';
import { getVenue } from '@/entities/venue';
import { SCR038_STATES, type Scr038State } from '@/shared/config/screens.booking';
import { cx } from '@/shared/lib/cx';
import { firstParam, type PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import {
  BOOKING_NO,
  CANCEL_SEATS,
  CARD_REFUND_TEXT,
  CURRENT_FEE_BP,
  FEE_TABLE,
  SAME_DAY_FEE_BP,
  cancelView,
  refundOf,
  type CancelResult,
} from '../model/view';
import { CancelBar, CancelProvider, CancelSheets, QuoteAside, QuoteInline, SeatChoices } from './CancelFlow';

type Props = PageProps<{ ticketId: string }>;

const won = (n: number) => `₩${new Intl.NumberFormat('ko-KR').format(n)}`;
/** h2: 휴대폰·태블릿 t-md 굵게, 데스크톱 t-lg */
const H2 = 't-md fw-b lg:text-lg';

/** 환불 계좌 은행 목록(합성 예시) */
const BANKS = [
  { value: 'kb', label: '국민은행' },
  { value: 'shinhan', label: '신한은행' },
  { value: 'woori', label: '우리은행' },
  { value: 'hana', label: '하나은행' },
  { value: 'nh', label: '농협은행' },
];

function load(ticketId: string) {
  const ticket = getTicket(ticketId);
  if (!ticket) return null;
  const perf = getPerformance(ticket.performanceId);
  const production = getProduction(ticket.productionId);
  const venue = production ? getVenue(production.venueId) : undefined;
  if (!perf || !production || !venue) return null;
  return { ticket, perf, production, venue };
}

export async function TicketCancelPage({ params, searchParams }: Props) {
  const { ticketId } = await params;
  const d = load(ticketId);
  if (!d) notFound();
  const { ticket, perf, production, venue } = d;
  const sp = await searchParams;
  const fallback: Scr038State = firstParam(sp, 'mode') === 'postponed' ? '연기 환급' : '선택';
  const state = resolvePreviewState(sp, SCR038_STATES, fallback);
  const dark = resolvePreviewTheme(sp) === 'dark';
  const vbank = firstParam(sp, 'pay') === 'vbank';
  const keep = { theme: dark ? 'dark' : undefined, pay: vbank ? 'vbank' : undefined };
  const v = cancelView(state);
  const path = `/my/tickets/${ticketId}/cancel`;
  const orderHref = `/my/orders/${ticket.orderId}`;
  const transferHref = `/my/tickets/${ticketId}/transfer`;
  const refundAccountHref = '/my/refunds/rfd-0001/account';
  // 이 주소의 티켓을 미리 고른다(보드: 8번). 양도 요청 중 상태에서는 그 티켓이 막히고 아무것도 고르지 않은 채다
  const blockedId = v.xfer ? ticketId : null;
  const initialSelected = v.xfer ? [] : [ticketId];
  const mine = CANCEL_SEATS.find((s) => s.ticketId === ticketId) ?? CANCEL_SEATS[1]!;
  const withForm = v.formView || v.postponed;

  return (
    <CancelProvider
      seats={CANCEL_SEATS}
      initialSelected={initialSelected}
      blockedId={blockedId}
      postponed={v.postponed}
      calculating={v.calculating}
      vbank={vbank}
      initialSheet={v.sheet}
      path={path}
      keep={keep}
      doneHref={orderHref}
    >
      <AppShell dark={dark} bottomBar={withForm ? <CancelBar /> : null}>
        <main className="page-main px-4 pt-4 pb-8 md:px-6 md:pt-5 md:pb-10 lg:px-8 lg:pt-8 lg:pb-16" id="main" tabIndex={-1}>
          <div className={cx('col mx-auto w-full max-w-[600px] gap-6 lg:gap-7', withForm ? 'lg:max-w-[976px]' : 'lg:max-w-[640px]')}>
            <div className="col gap-2">
              <Link className="row t-sm gap-0.5 self-start text-(--text-muted)" href="/my/tickets">
                <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
                마이 티켓
              </Link>
              <h1 className="t-xl lg:text-2xl">예매 취소</h1>
              <p className="t-sm muted lg:text-md">
                {production.title} · {perf.label}
                <span className="hidden lg:inline"> · {venue.name}</span> · 예매번호 <span className="mono">{BOOKING_NO}</span>
                {vbank ? ' · 가상계좌 결제' : null}
              </p>
            </div>

            {v.xfer ? (
              <div className="error-summary" role="alert">
                <strong className="row gap-1.5" style={{ color: 'var(--danger)' }}>
                  <i className="ic ic-alert-circle ic-16" aria-hidden="true" />
                  {mine.seat}은 지금 취소할 수 없습니다
                </strong>
                <span>양도 요청을 철회한 뒤 취소할 수 있습니다</span>
                <a href={`#c-${ticketId}`}>해당 좌석으로 가기</a>
              </div>
            ) : null}

            {withForm ? (
              <div className="col gap-6 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:gap-y-6">
                <div className="col gap-6 lg:col-span-8 lg:gap-7">
                  {v.postponed ? (
                    <>
                      <NoticeBanner tone="info" icon="calendar" role={null}>
                        공연 일정이 10/25 18:00에서 10/31 18:00으로 바뀌었습니다. 원하면 공제 없이 전액 환급받을 수 있습니다
                      </NoticeBanner>
                      <dl className="kv">
                        <dt>신청 기한</dt>
                        <dd>바뀐 공연 시작 전까지(10/31 18:00)</dd>
                      </dl>
                    </>
                  ) : (
                    <>
                      <SeatChoices transferHref={transferHref} />
                      <FeeTable />
                    </>
                  )}
                  <QuoteInline className="lg:hidden" />
                  {v.postponed ? null : (
                    <NoticeBanner tone="warning" role={null} title={`입장 시작(${perf.gateOpenText ?? '16:30'}) 뒤 취소 유의`}>
                      입장이 시작된 뒤 취소하면 티켓은 바로 쓸 수 없게 되고, 환급은 입장 기록 마감 뒤 입장하지 않은 것이 확인되면 실행합니다
                    </NoticeBanner>
                  )}
                  {vbank ? <RefundAccountFields /> : null}
                </div>
                <aside className="hidden lg:sticky lg:top-6 lg:col-span-4 lg:block" aria-label="환급 명세">
                  <QuoteAside />
                </aside>
              </div>
            ) : null}

            {v.cannot ? (
              <div className="card-flat state px-5 py-9" role="alert">
                <span className="state-icon is-danger">
                  <i className="ic ic-ban" aria-hidden="true" />
                </span>
                <h2 className="t-lg">공연이 시작되어 취소할 수 없습니다</h2>
                <p className="t-sm muted">
                  {perf.label}에 공연이 시작되어 이 예매는 취소할 수 없습니다. 도움이 필요하면 고객센터에 문의해 주세요.
                </p>
                <div className="col gap-2 self-stretch">
                  <Link className={buttonClass({ variant: 'secondary', block: true })} href="/my/tickets">
                    마이 티켓으로 가기
                  </Link>
                  <Link className={buttonClass({ variant: 'ghost', block: true })} href="/help/inquiries/new">
                    고객센터 문의하기
                  </Link>
                </div>
              </div>
            ) : null}

            {v.result ? (
              <ResultCard kind={v.result} seat={mine.seat} price={mine.price} orderHref={orderHref} vbank={vbank} refundAccountHref={refundAccountHref} />
            ) : null}
          </div>
        </main>
        {withForm ? <CancelSheets /> : null}
        <PreviewSwitcher path={path} states={SCR038_STATES} current={state} keep={keep} />
      </AppShell>
    </CancelProvider>
  );
}

/** ② 취소 수수료 기준표(POL-032). 지금 적용되는 줄을 배지 '지금'과 바탕색으로 함께 보인다(색만으로 말하지 않는다) */
function FeeTable() {
  return (
    <section className="col gap-2.5 lg:gap-3" aria-labelledby="h-rule">
      <h2 className={H2} id="h-rule">
        취소 수수료 기준
      </h2>
      <div className="table-wrap">
        {/* 휴대폰·태블릿은 보드대로 dense, 데스크톱은 기본 표 여백(보드 d) */}
        <table className="table dense lg:[&_td]:p-3 lg:[&_td]:text-sm lg:[&_th]:px-3 lg:[&_th]:py-2.5">
          <caption className="sr-only">취소 시점별 취소 수수료. 지금은 공연 5일 전이라 6~3일 전 기준을 적용합니다</caption>
          <thead>
            <tr>
              <th scope="col">취소 시점</th>
              <th scope="col" className="r">
                수수료
              </th>
            </tr>
          </thead>
          <tbody>
            {FEE_TABLE.map((r) => (
              <tr key={r.when} className={r.current ? 'is-selected' : undefined}>
                <td>
                  {r.current ? (
                    <span className="row gap-1.5">
                      {r.when}
                      <span className="badge badge-primary">지금</span>
                    </span>
                  ) : (
                    r.when
                  )}
                </td>
                <td className={cx('r', r.current && 'fw-b')}>{r.fee}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="t-xs muted">수수료는 티켓 금액에서 공제합니다. 예매 후 24시간은 주말·공휴일을 빼고 셉니다. 근거: 소비자분쟁해결기준(공정거래위원회 고시) 공연업</p>
    </section>
  );
}

/** ⑦ 환불받을 계좌(가상계좌 결제이고 지금 환급할 때만, CMP-062 refund의 칸 셋. 제출은 아래 막대·오른쪽 패널의 실행 버튼이 한다) */
function RefundAccountFields() {
  return (
    <section className="col gap-3.5" aria-labelledby="h-acct">
      <div className="col gap-1">
        <h2 className={H2} id="h-acct">
          환불받을 계좌
        </h2>
        <p className="t-sm muted">가상계좌로 결제한 예매라 환불받을 계좌가 필요합니다.</p>
      </div>
      <Select id="rf-bank" label="은행" placeholder="은행을 고르세요" options={BANKS} defaultValue="" autoComplete="off" />
      <TextField
        id="rf-no"
        label="계좌번호"
        inputMode="numeric"
        autoComplete="off"
        placeholder="숫자만 입력"
        hint="계좌번호는 저장하지 않고 환불 요청에만 씁니다"
      />
      <TextField id="rf-holder" label="예금주" autoComplete="off" />
    </section>
  );
}

const RESULT_META: Record<CancelResult, { id: string; badge: string; tone: string }> = {
  pending: { id: 'h-res-p', badge: '환급 진행 중', tone: 'badge-primary' },
  hold: { id: 'h-res-h', badge: '환급 보류', tone: 'badge-warning' },
  check: { id: 'h-res-c', badge: '확인 중', tone: 'badge-warning' },
  void: { id: 'h-res-v', badge: '취소 무효', tone: 'badge-danger' },
  delay: { id: 'h-res', badge: '환급 지연', tone: 'badge-warning' },
};

/** ⑥ 취소 결과(취소 접수 → 환급 진행 → 환급 완료). 진행 줄의 점 색 옆에 늘 글자로 단계를 적는다 */
function ResultCard({
  kind,
  seat,
  price,
  orderHref,
  vbank,
  refundAccountHref,
}: {
  kind: CancelResult;
  seat: string;
  price: number;
  orderHref: string;
  vbank: boolean;
  refundAccountHref: string;
}) {
  const meta = RESULT_META[kind];
  const now = refundOf(price, CURRENT_FEE_BP).refund;
  const sameDay = refundOf(price, SAME_DAY_FEE_BP).refund;
  const to = vbank ? '입력한 환불 계좌' : CARD_REFUND_TEXT;
  const accepted = <Step dot="ok" title="취소 접수됨" sub="이 좌석의 티켓은 바로 쓸 수 없게 되었습니다" />;

  let summary: ReactNode;
  let notice: ReactNode = null;
  let steps: ReactNode;
  if (kind === 'pending') {
    summary = (
      <>
        {seat} · 환급 예상액 <strong className="num">{won(now)}</strong>
      </>
    );
    steps = (
      <>
        {accepted}
        <Step dot="info" title="환급 진행 중" sub={`${to}로 ${won(now)}`} />
        <Step title="환급 완료 · 3영업일 안" sub="완료되면 이메일과 알림으로 알려 드립니다" pending />
      </>
    );
  } else if (kind === 'delay') {
    summary = (
      <>
        {seat} · 환급 예상액 <strong className="num">{won(now)}</strong>
      </>
    );
    notice = (
      <NoticeBanner tone="warning" icon="clock" role="alert" title="환급이 지연되고 있습니다. 자동으로 다시 요청합니다">
        결제사 응답이 늦어 환급 요청을 자동으로 다시 보내고 있습니다. 따로 하실 일은 없습니다.
        {vbank ? (
          <>
            {' '}
            환급할 때 알림으로 계좌를 다시 받습니다. <Link href={refundAccountHref}>환불 계좌 입력</Link>
          </>
        ) : null}
      </NoticeBanner>
    );
    steps = (
      <>
        {accepted}
        <Step dot="warn" title="환급 요청 · 자동 재시도 중" sub={`${to}로 ${won(now)}`} />
        <Step title="환급 완료" sub="완료되면 이메일과 알림으로 알려 드립니다" pending />
      </>
    );
  } else if (kind === 'hold' || kind === 'check') {
    summary = (
      <>
        {seat} · 공연 당일 취소라 90% 공제 · 환급 예상액 <strong className="num">{won(sameDay)}</strong>
      </>
    );
    notice =
      kind === 'hold' ? (
        <NoticeBanner tone="info" icon="clock" role={null}>
          입장 기록 마감 뒤 환급됩니다
          {vbank ? (
            <>
              . 가상계좌 결제라 그때 알림으로 계좌를 받습니다. <Link href={refundAccountHref}>환불 계좌 입력</Link>
            </>
          ) : null}
        </NoticeBanner>
      ) : (
        <NoticeBanner tone="warning" role={null}>
          입장 기록을 확인하고 있습니다. 환급은 확인 뒤 진행됩니다
        </NoticeBanner>
      );
    steps = (
      <>
        {accepted}
        {kind === 'hold' ? (
          <Step dot="warn" title="환급 보류" sub="입장 기록 마감 뒤 입장하지 않은 것이 확인되면 환급합니다" />
        ) : (
          <Step dot="warn" title="확인 중" sub="환급은 보류되어 있습니다" />
        )}
        <Step title="환급 완료" sub={`${to}로 ${won(sameDay)}`} pending />
      </>
    );
  } else {
    summary = seat;
    notice = (
      <NoticeBanner tone="danger" icon="x-circle" role="alert">
        취소 접수 뒤 입장 기록이 확인되어 취소가 무효가 되었습니다
      </NoticeBanner>
    );
    steps = (
      <>
        {accepted}
        <Step dot="bad" title="취소 무효" sub="입장 기록이 확인되었습니다" />
      </>
    );
  }

  return (
    <section className="card col gap-3.5 p-4 md:px-5 md:py-[18px]" aria-labelledby={meta.id}>
      <div className="row between gap-2">
        <h2 className={H2} id={meta.id}>
          취소 결과
        </h2>
        <span className={cx('badge', meta.tone)}>{meta.badge}</span>
      </div>
      <p className="t-sm">{summary}</p>
      {notice}
      <ol className="timeline" aria-label="취소 진행 상태">
        {steps}
      </ol>
      <Link className="link-more" href={orderHref}>
        예매·주문 내역에서 진행 상태 보기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>
    </section>
  );
}

function Step({ dot, title, sub, pending = false }: { dot?: 'ok' | 'warn' | 'bad' | 'info'; title: string; sub: string; pending?: boolean }) {
  return (
    <li className="tl-item">
      <span className={cx('tl-dot', dot)} aria-hidden="true" />
      <div className="col gap-0.5">
        <span className={cx('t-sm fw-b', pending && 'muted')}>{title}</span>
        <span className="t-xs muted">{sub}</span>
      </div>
    </li>
  );
}
