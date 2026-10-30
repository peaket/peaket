// SCR-012 결제 결과(d5 §5.12, d3 SCR-012 행, 캔버스 보드 SCR-012-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 eventId는 회차다.
// 집중 셸(머리에 닫기만). 어느 폭에서나 가운데 상태 카드(최대 560). 확정이면 ② 예매 완료 카드 → ⑤ 홈 화면 추가 안내
// → ④ 이 공연 부가 상품 → ⑥ 예매 확인서(판매자 정보 + 중개자 고지). 태블릿부터 예매번호 줄에 결제 금액이 함께 서고 티켓이 두 칸이 된다.
// 결과 문장은 role="alert"(확정·실패·결과 불명) 또는 role="status"(확인 중·발급 중)로 한 번 알린다.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { DEMO_ORDER_ID } from '@/entities/order';
import { CHECKOUT_DEMO, RESULT_DEMO, VBANK_DEMO } from '@/entities/payment';
import { getPerformance } from '@/entities/performance';
import { formatWon, getProduction } from '@/entities/production';
import { getSeller } from '@/entities/seller';
import { DEMO_TICKET_ID } from '@/entities/ticket';
import { getVenue } from '@/entities/venue';
import { SCR012_STATES, type Scr012State } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { CopyButton, InstallGuideButton } from './ResultClient';

type Props = PageProps<{ eventId: string }>;

/** 가상계좌 예시 회차(E-3 소극장 뮤지컬. LUMEN 같은 고수요 온세일은 가상계좌를 끈다, POL-014) */
const VBANK_EVENT_ID = 'evt-musical-1101';

const ICON56 = { width: 56, height: 56 } as const;
/** 확인 중 카드의 위 여백(휴대폰 40 · 태블릿 48 · 데스크톱 64)과 나머지 결과 카드의 위 여백(24 · 32 · 40) */
const TOP_WAIT = 'mt-10 md:mt-12 lg:mt-16';
const TOP = 'mt-6 md:mt-8 lg:mt-10';

function load(eventId: string) {
  const perf = getPerformance(eventId);
  const production = perf ? getProduction(perf.productionId) : undefined;
  const venue = production ? getVenue(production.venueId) : undefined;
  const seller = production ? getSeller(production.sellerId) : undefined;
  if (!perf || !production || !venue || !seller) return null;
  return { perf, production, venue, seller };
}

export async function BookingResultPage({ params, searchParams }: Props) {
  const { eventId } = await params;
  const d = load(eventId);
  if (!d) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR012_STATES, '확정');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const vbank = state === '입금 대기' || state === '입금 오류';
  // 가상계좌 상태는 보드대로 다른 공연(소극장 뮤지컬 1매)의 머리를 보인다. 보드의 '[회차]' 자리는 목업 회차로 채웠다(추천안)
  const vPerf = vbank ? getPerformance(VBANK_EVENT_ID) : undefined;
  const head = vPerf
    ? { title: VBANK_DEMO.productionTitle, subtitle: `${vPerf.label} · 1매`, closeHref: `/events/${vPerf.id}` }
    : { title: d.production.title, subtitle: `${d.perf.label} · ${d.venue.name}`, closeHref: `/events/${d.perf.id}` };

  return (
    <AppShell variant="focus" dark={dark} focus={{ ...head, closeLabel: '닫고 공연 상세로 가기' }}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="w-full px-4 pt-6 pb-10 md:px-6 md:pt-8 md:pb-12 lg:px-8">
          <div className="col mx-auto w-full max-w-[560px]" style={{ gap: 20 }}>
            <ResultBody state={state} d={d} />
          </div>
        </div>
      </main>
      <PreviewSwitcher path={`/booking/${eventId}/result`} states={SCR012_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

type Loaded = NonNullable<ReturnType<typeof load>>;

function ResultBody({ state, d }: { state: Scr012State; d: Loaded }) {
  const seatsHref = `/booking/${d.perf.id}/seats`;
  const ordersHref = `/my/orders/${DEMO_ORDER_ID}`;
  const amount = formatWon(RESULT_DEMO.amount);
  const orderLink = (href: string) => (
    <Link className="btn btn-secondary btn-lg btn-block" href={href}>
      예매·주문 내역 보기
    </Link>
  );
  const facts = (rows: { term: string; value: ReactNode; className?: string }[]) => (
    <dl className="kv">
      {rows.map((r) => (
        <KvRow key={r.term} term={r.term} value={r.value} className={r.className} />
      ))}
    </dl>
  );
  const bookingFacts = facts([
    { term: '예매번호', value: RESULT_DEMO.bookingNo, className: 'mono' },
    { term: '결제 금액', value: amount, className: 'num' },
  ]);

  switch (state) {
    case '확정':
      return <Confirmed d={d} />;
    case '확인 중':
      return (
        <section className={`card pad-lg col ${TOP_WAIT}`} style={{ gap: 16, alignItems: 'center', textAlign: 'center' }} role="status" aria-labelledby="ck-h">
          <StateIcon icon="ic-clock" tone="is-primary" />
          <h1 className="t-xl" id="ck-h">
            결제 확인 중
          </h1>
          <Indeterminate label="결제 확인 중" />
          <p className="t-sm muted">결제 접수 후 확정까지 몇 초가 걸립니다</p>
        </section>
      );
    case '확인이 길어짐':
      return (
        <section className={`card pad-lg col ${TOP_WAIT}`} style={{ gap: 16, alignItems: 'center', textAlign: 'center' }} role="status" aria-labelledby="sl-h">
          <StateIcon icon="ic-clock" tone="is-primary" />
          <h1 className="t-xl" id="sl-h">
            결제 확인 중
          </h1>
          <Indeterminate label="결제 확인 중" />
          <p className="t-md">결과를 확인하고 있습니다. 화면을 닫아도 결과가 나오면 알림으로 알려 드립니다</p>
          <p className="t-xs muted">이 화면을 열어 두면 계속 확인합니다</p>
          {orderLink(ordersHref)}
        </section>
      );
    case '결제 완료·티켓 발급 중':
      return (
        <section className={`card pad-lg col ${TOP}`} style={{ gap: 16 }} aria-labelledby="is-h">
          <div className="col" style={{ gap: 10, alignItems: 'center', textAlign: 'center' }} role="status">
            <StateIcon icon="ic-ticket" tone="is-primary" />
            <h1 className="t-xl" id="is-h">
              결제가 완료되었습니다
            </h1>
            <p className="t-md">티켓을 발급하고 있습니다. 발급되면 알림으로 알려 드립니다</p>
          </div>
          <Indeterminate label="티켓 발급 중" />
          {bookingFacts}
          {orderLink(ordersHref)}
        </section>
      );
    case '결과 불명':
    case '결과 불명 1시간 넘음': {
      const long = state === '결과 불명 1시간 넘음';
      return (
        <section className={`card pad-lg col ${TOP}`} style={{ gap: 16 }} aria-labelledby="uk-h">
          <div className="col" style={{ gap: 10, alignItems: 'center', textAlign: 'center' }} role="alert">
            <StateIcon icon="ic-history" tone="is-warning" />
            <h1 className="t-xl" id="uk-h">
              결제 확인이 지연되고 있습니다
            </h1>
            <p className="t-md">
              {long ? '확인을 계속하고 있습니다. 중복 청구는 발생하지 않습니다' : '결과가 확정되는 대로 이메일과 알림으로 보내 드립니다'}
            </p>
          </div>
          {long ? null : (
            <div className="banner banner-info">
              <i className="ic ic-shield" aria-hidden="true" />
              <div className="banner-body fw-b">확인 중이며 중복 청구는 발생하지 않습니다</div>
            </div>
          )}
          {bookingFacts}
          {orderLink(ordersHref)}
        </section>
      );
    }
    case '승인 거절':
      return (
        <section className={`card pad-lg col ${TOP}`} style={{ gap: 18 }} aria-labelledby="dc-h">
          <div className="col" style={{ gap: 10, alignItems: 'center', textAlign: 'center' }} role="alert">
            <StateIcon icon="ic-x-circle" tone="is-danger" />
            <h1 className="t-lg" id="dc-h">
              카드사에서 결제를 승인하지 않아 좌석이 해제되었습니다.
            </h1>
            <p className="t-md">요금은 청구되지 않았습니다. 좌석을 다시 골라 주세요</p>
          </div>
          <Link className="btn btn-primary btn-lg btn-block" href={seatsHref}>
            좌석 다시 고르기
          </Link>
        </section>
      );
    case '발권 불가 결제 취소':
      return (
        <section className={`card pad-lg col ${TOP}`} style={{ gap: 18 }} aria-labelledby="cp-h">
          <div className="col" style={{ gap: 10, alignItems: 'center', textAlign: 'center' }} role="alert">
            <StateIcon icon="ic-undo" tone="is-warning" />
            <h1 className="t-lg" id="cp-h">
              티켓을 발급하지 못해 결제를 취소(환불)했습니다
            </h1>
          </div>
          {facts([{ term: '예매번호', value: RESULT_DEMO.bookingNo, className: 'mono' }])}
          {orderLink(ordersHref)}
        </section>
      );
    case '입금 대기':
    case '입금 오류':
      return <VirtualAccount error={state === '입금 오류'} />;
  }
}

/** dt·dd 한 쌍(키트 .kv 격자) */
function KvRow({ term, value, className }: { term: string; value: ReactNode; className?: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd className={className}>{value}</dd>
    </>
  );
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

/** ② 예매 완료 · ⑤ 홈 화면 추가 · ④ 부가 상품 · ⑥ 예매 확인서 */
function Confirmed({ d }: { d: Loaded }) {
  const { perf, production, seller } = d;
  const amount = formatWon(RESULT_DEMO.amount);
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
            <span className="mono fw-b">{RESULT_DEMO.bookingNo}</span>
          </div>
          <div className="col hidden md:flex" style={{ gap: 2, alignItems: 'flex-end' }}>
            <span className="t-xs muted">결제 금액</span>
            <span className="num fw-b">{amount}</span>
          </div>
          <CopyButton
            text={RESULT_DEMO.bookingNo}
            label="복사"
            ariaLabel={`예매번호 ${RESULT_DEMO.bookingNo} 복사`}
            done="예매번호를 복사했습니다"
          />
        </div>
        <dl className="kv md:hidden">
          <dt>결제 금액</dt>
          <dd className="num">{amount}</dd>
        </dl>
        <div className="col" style={{ gap: 8 }}>
          <h2 className="eyebrow">발권한 티켓 {CHECKOUT_DEMO.seats.length}매</h2>
          <div className="col gap-2 md:grid md:grid-cols-2 md:gap-3">
            {CHECKOUT_DEMO.seats.map((s, i) => (
              <article key={s.seat} className="card row" style={{ gap: 12, padding: '12px 14px' }} aria-labelledby={`tk${i + 1}`}>
                <span className="state-icon is-primary" style={{ width: 40, height: 40 }}>
                  <i className="ic ic-ticket" aria-hidden="true" />
                </span>
                <div className="col grow" style={{ gap: 2 }}>
                  <h3 className="t-md fw-b" id={`tk${i + 1}`}>
                    {s.seat}
                  </h3>
                  <p className="t-sm muted">
                    {s.grade} · {s.gate}
                  </p>
                </div>
              </article>
            ))}
          </div>
          <p className="t-xs muted">
            {production.title} · {perf.label} · 양도 마감 {perf.transferDeadlineText} · 취소는 공연 시작 전까지
          </p>
        </div>
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

      <Link className="card-flat flex items-center gap-3.5 p-4 md:px-5" href={`/my/tickets/${DEMO_TICKET_ID}/addons`} style={{ color: 'inherit' }}>
        <span className="state-icon is-primary" style={{ width: 48, height: 48 }}>
          <i className="ic ic-bag" aria-hidden="true" />
        </span>
        <span className="col grow" style={{ gap: 2 }}>
          <span className="t-md fw-b">이 공연 부가 상품</span>
          <span className="t-sm muted">{RESULT_DEMO.addonText}</span>
        </span>
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>

      <section className="col" style={{ gap: 12 }} aria-labelledby="rs-rcpt-h">
        <h2 className="t-lg" id="rs-rcpt-h">
          예매 확인서
        </h2>
        <div className="banner banner-legal">
          <i className="ic ic-scale" aria-hidden="true" />
          <div className="banner-body t-md">
            <span className="legal-tag">법정 고지</span>
            판매자: {seller.name}. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고, 예매 취소와 환불은
            PEAKET이 처리합니다
          </div>
        </div>
        <dl className="row wrap t-sm gap-x-3.5 gap-y-1.5 md:gap-x-4">
          {[
            ['상호', seller.name],
            ['대표자', seller.representative],
            ['주소', seller.address],
            ['전화', seller.phone],
            ['전자우편', seller.email],
            ['사업자등록번호', seller.businessNo],
            ['통신판매업 신고번호', seller.mailOrderNo],
          ].map(([term, value]) => (
            <div key={term} className="row" style={{ gap: 4 }}>
              <dt className="muted">{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}

/** 입금 대기 · 입금 오류(가상계좌) */
function VirtualAccount({ error }: { error: boolean }) {
  return (
    <section className={`card pad-lg col ${TOP}`} style={{ gap: 16 }} aria-labelledby="vb-h">
      <div className="col" style={{ gap: 10, alignItems: 'center', textAlign: 'center' }} role={error ? undefined : 'alert'}>
        <StateIcon icon="ic-bank" tone={error ? 'is-warning' : 'is-primary'} />
        <h1 className="t-xl" id="vb-h">
          입금하면 예매가 확정됩니다
        </h1>
        <span className="badge badge-warning badge-lg">
          <i className="ic ic-clock" aria-hidden="true" />
          입금 대기
        </span>
      </div>
      {error ? (
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            은행 처리 오류로 입금이 취소되었습니다. 발급한 티켓은 무효가 되었고, 입금 기한 {VBANK_DEMO.dueShortText}까지 다시 입금하면 티켓을 다시 발급합니다
          </div>
        </div>
      ) : null}
      <dl className="kv">
        <dt>입금 계좌</dt>
        <dd>{VBANK_DEMO.account}</dd>
        <dt>입금액</dt>
        <dd className="num fw-b">{formatWon(VBANK_DEMO.amount)}</dd>
        <dt>입금 기한</dt>
        <dd>{VBANK_DEMO.dueText}</dd>
        <dt>예매번호</dt>
        <dd className="mono">{VBANK_DEMO.bookingNo}</dd>
      </dl>
      <CopyButton
        className="btn btn-outline btn-block"
        text={VBANK_DEMO.account}
        label="계좌 복사"
        ariaLabel="가상계좌 번호 복사"
        done="계좌번호를 복사했습니다"
      />
      <p className="t-sm muted">기한이 지나면 주문이 취소되고 좌석이 풀립니다</p>
      <Link className="link-more" href="/my/orders" style={{ alignSelf: 'center' }}>
        예매·주문 내역 보기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>
    </section>
  );
}
