// SCR-011 주문·결제(d5 §5.11, d3 SCR-011 행, 캔버스 보드 SCR-011-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 eventId는 회차다.
// 휴대폰: ① 좌석과 금액 → ② 예매자 → ③ 판매자에게 개인정보 제공 동의 → ④ 판매 조건·취소 규정 동의 → ⑤⑥ 결제수단·결제 프레임
//   → ⑧ 판매자 정보(법정 고지 + 7항목, 접지 않음) → ⑨ 미성년자 고지 → 아래 고정 결제 띠(⑦ 홀드 타이머 + [결제하기]).
// 태블릿(md): 가운데 600 한 열, 예매자 두 칸, 아래 띠는 한 줄. 데스크톱(lg): 왼쪽 8열 본문, 오른쪽 4열 고정 주문 요약(①⑦ + 결제 버튼).
// 결제창 복귀 뒤 상태(접수 중·새로고침·금액 불일치·이미 진행 중·예매 제한)는 본문 대신 상태 카드 하나를 보인다.
// 이 화면에서는 외부 분석 스크립트를 싣지 않는다(d5 §5.11).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { WebShellHold } from '@peaket/ds/WebShell';
import { PaymentWidgetFrame } from '@peaket/ds/PaymentWidgetFrame';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { CANCEL_FEE_ROWS, CHECKOUT_DEMO, PaymentReturnCard, PORTONE_METHODS, holdTimeText, thirdPartyRows } from '@/entities/payment';
import { getPerformance } from '@/entities/performance';
import { formatWon, getProduction } from '@/entities/production';
import { getSeller } from '@/entities/seller';
import { getVenue } from '@/entities/venue';
import { SCR011_STATES } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { brokerNotice, checkoutView, MINOR_NOTICE, SORT_NOTICE, type CheckoutView } from '../model/view';
import { CheckoutConsentProvider, ConsentCheck, HoldExpiredDialog, PayAction } from './CheckoutClient';

type Props = PageProps<{ eventId: string }>;


function load(eventId: string) {
  const perf = getPerformance(eventId);
  const production = perf ? getProduction(perf.productionId) : undefined;
  const venue = production ? getVenue(production.venueId) : undefined;
  const seller = production ? getSeller(production.sellerId) : undefined;
  if (!perf || !production || !venue || !seller) return null;
  return { perf, production, venue, seller };
}

type Loaded = NonNullable<ReturnType<typeof load>>;

function shellHold(v: CheckoutView): WebShellHold | null {
  const t = holdTimeText(CHECKOUT_DEMO.holdRemainingSeconds);
  if (v.hold === 'none') return null;
  if (v.hold === 'expired') return { text: '만료', ariaLabel: '홀드 시간 끝남', tone: 'expired' };
  if (v.hold === 'paused') return { text: t.text, ariaLabel: `${t.aria}, 멈춤`, tone: 'paused' };
  return { text: t.text, ariaLabel: t.aria };
}

export async function CheckoutPage({ params, searchParams }: Props) {
  const { eventId } = await params;
  const d = load(eventId);
  if (!d) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR011_STATES, '입력');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = checkoutView(state);
  const { perf, production, venue } = d;
  const path = `/booking/${perf.id}/checkout`;
  const hrefs = {
    seats: `/booking/${perf.id}/seats`,
    returnPath: `${path}/return`,
    event: `/events/${perf.id}`,
    appeal: '/my/appeals/apl-0001',
  };
  const totalText = formatWon(CHECKOUT_DEMO.total);
  const hold = holdTimeText(CHECKOUT_DEMO.holdRemainingSeconds);
  const payProps = { mode: v.pay, amountText: totalText, holdText: hold.text, holdAria: hold.aria, returnHref: hrefs.returnPath };

  return (
    <CheckoutConsentProvider initialAgreed={v.agreed}>
      <AppShell
        variant="focus"
        dark={dark}
        focus={{
          title: production.title,
          subtitle: `${perf.label} · ${venue.name}`,
          closeHref: hrefs.event,
          hold: shellHold(v),
          // 데스크톱은 오른쪽 결제 패널에 같은 타이머가 있어 머리에는 보이지 않는다(보드 SCR-011-d)
          holdOnDesktop: false,
        }}
        bottomBar={v.returnKind ? null : <PayAction layout="bar" {...payProps} />}
      >
        <main className="page-main" id="main" tabIndex={-1}>
          {v.returnKind ? (
            <div className="w-full px-4 pt-5 pb-8 md:px-6 md:pt-6 md:pb-10 lg:px-8 lg:pt-8 lg:pb-12">
              <div className="col mx-auto w-full max-w-[600px] lg:max-w-[560px]">
                <PaymentReturnCard
                  kind={v.returnKind}
                  seatText={CHECKOUT_DEMO.seatText}
                  totalText={totalText}
                  retryHref={path}
                  appealHref={hrefs.appeal}
                />
              </div>
            </div>
          ) : (
            <CheckoutForm v={v} d={d} totalText={totalText} payProps={payProps} />
          )}
        </main>
        {v.expiredDialog ? <HoldExpiredDialog seatsHref={hrefs.seats} /> : null}
        <PreviewSwitcher path={`/booking/${eventId}/checkout`} states={SCR011_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
      </AppShell>
    </CheckoutConsentProvider>
  );
}

interface FormProps {
  v: CheckoutView;
  d: Loaded;
  totalText: string;
  payProps: Omit<Parameters<typeof PayAction>[0], 'layout'>;
}

function CheckoutForm({ v, d, totalText, payProps }: FormProps) {
  const { perf, production, seller } = d;
  const sort = SORT_NOTICE[production.sortMode];
  const phone = v.inputError ? CHECKOUT_DEMO.invalidPhone : CHECKOUT_DEMO.buyer.phone;
  return (
    <div className="w-full px-4 pt-5 pb-8 md:px-6 md:pt-6 md:pb-10 lg:px-8 lg:pt-8 lg:pb-12">
      <div className="mx-auto w-full max-w-[600px] lg:grid lg:max-w-[976px] lg:grid-cols-12 lg:items-start lg:gap-x-6">
        <div className="col min-w-0 gap-6 md:gap-7 lg:col-span-8">
          <h1 className="t-xl">주문·결제</h1>

          {v.inputError ? (
            <div className="error-summary" role="alert" aria-labelledby="err-h">
              <strong id="err-h">결제하기 전에 1곳을 고쳐 주세요</strong>
              <a href="#co-phone">휴대폰 번호 자릿수가 맞지 않습니다</a>
            </div>
          ) : null}
          {v.salePaused ? (
            <div className="banner banner-danger" role="alert">
              <i className="ic ic-pause" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">판매가 잠시 멈췄습니다.</span>고른 좌석은 홀드 시간 동안 유지됩니다
              </div>
            </div>
          ) : null}
          {v.switchFail ? (
            <div className="banner banner-danger" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              <div className="banner-body">
                결제 대행사 장애로 결제되지 않았습니다. 다른 결제 대행사로 다시 결제해 주세요. 요금은 청구되지 않았습니다
              </div>
            </div>
          ) : null}

          {/* ① 좌석과 금액(휴대폰·태블릿. 데스크톱은 오른쪽 패널) */}
          <section className="card pad col md:p-6 lg:hidden" style={{ gap: 12 }} aria-labelledby="co-sum-h">
            <div className="row between">
              <h2 className="t-md fw-b" id="co-sum-h">
                좌석과 금액
              </h2>
              <span className="badge badge-primary">홀드 중</span>
            </div>
            <p className="t-lg">{CHECKOUT_DEMO.seatText}</p>
            <dl className="kv">
              <dt>등급</dt>
              <dd>
                {CHECKOUT_DEMO.grade} {CHECKOUT_DEMO.quantity}매
              </dd>
              <dt>좌석 금액</dt>
              <dd className="num">
                {formatWon(CHECKOUT_DEMO.unitPrice)} × {CHECKOUT_DEMO.quantity}
              </dd>
              <dt className="kv-total">합계</dt>
              <dd className="kv-total num">{totalText}</dd>
            </dl>
          </section>

          {/* ② 예매자(저장된 정보 자동 입력. 이메일 칸은 없다, ADR-0044 결정 10) */}
          <fieldset className="col gap-4 md:gap-3">
            <legend className="t-lg" style={{ marginBottom: 12 }}>
              예매자
            </legend>
            <div className="col gap-4 md:grid md:grid-cols-2 md:items-start">
              <div className="field">
                <label className="label" htmlFor="co-name">
                  예매자 이름 <span className="opt">(필수)</span>
                </label>
                <input className="input" id="co-name" type="text" autoComplete="name" defaultValue={CHECKOUT_DEMO.buyer.name} aria-describedby="co-buyer-h" />
              </div>
              <div className="field">
                <label className="label" htmlFor="co-phone">
                  휴대폰 번호 <span className="opt">(필수)</span>
                </label>
                <input
                  className={v.inputError ? 'input is-error' : 'input'}
                  id="co-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  defaultValue={phone}
                  aria-invalid={v.inputError ? true : undefined}
                  aria-describedby={v.inputError ? 'co-phone-e' : 'co-buyer-h'}
                  // 입력 오류: 오류 요약을 보이고 첫 오류 칸에 초점(d5 §5.11)
                  autoFocus={v.inputError}
                />
                {v.inputError ? (
                  <span className="error-msg" id="co-phone-e">
                    <i className="ic ic-alert-circle" aria-hidden="true" />
                    휴대폰 번호 자릿수가 맞지 않습니다. 숫자 10~11자리로 입력해 주세요.
                  </span>
                ) : null}
              </div>
            </div>
            <p className="hint" id="co-buyer-h">
              저장된 예매자 정보로 채웠습니다
            </p>
          </fieldset>

          {/* ③ 판매자에게 개인정보 제공(받는 자·목적·보유 기간 굵게) */}
          <section className="card pad col md:p-6" style={{ gap: 14 }} aria-labelledby="co-3p-h">
            <h2 className="t-lg" id="co-3p-h">
              판매자에게 개인정보 제공
            </h2>
            <dl className="col gap-2 md:gap-2.5 lg:grid lg:grid-cols-2 lg:gap-x-6 lg:gap-y-3">
              {thirdPartyRows(seller.name).map((r) => (
                <div key={r.term} className="col" style={{ gap: 2 }}>
                  <dt className="t-xs fw-b muted">{r.term}</dt>
                  <dd className={r.bold ? 't-sm fw-b' : 't-sm'}>{r.value}</dd>
                </div>
              ))}
            </dl>
            <div className="divider" />
            <ConsentCheck id="co-agree1" which="thirdParty">
              위 내용에 동의합니다 (필수)
            </ConsentCheck>
          </section>

          {/* ④ 판매 조건과 취소 규정(정렬 방식 세 번째 고지 자리, 취소 수수료 재고지) */}
          <section className="col" style={{ gap: 12 }} aria-labelledby="co-terms-h">
            <h2 className="t-lg" id="co-terms-h">
              판매 조건과 취소 규정
            </h2>
            <div className="banner banner-info">
              <i className="ic ic-info" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">{sort.title}</span>
                {sort.body}
              </div>
            </div>
            <div className="banner banner-info">
              <i className="ic ic-receipt" aria-hidden="true" />
              <div className="banner-body col min-w-0" style={{ gap: 10 }}>
                <span className="banner-title">공연일 10일 이내 취소 시 기준에 따른 공제 후 환불</span>
                <CancelFeeTable />
                <span className="t-xs muted">
                  <span className="hidden lg:inline">관람일 기준이고, 당일 취소는 공연 시작 전까지 받습니다. </span>
                  예매 후 24시간 안 취소는 관람일 3일 전까지만 해당하고, 주말·공휴일은 24시간 계산에서 뺍니다. 근거: 소비자분쟁해결기준
                </span>
                {/* 추천안: 취소 규정 전문은 이용약관(SCR-057)의 취소·환불 조항으로 잇는다 */}
                <Link className="link-more" href="/policy/terms">
                  취소 규정 자세히 보기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            </div>
            <p className="t-sm">
              이 공연의 판매 조건: <span className="fw-b">1인 1순번</span> · <span className="fw-b">1인 {production.perPerson}매</span>
            </p>
            <ConsentCheck id="co-agree2" which="terms">
              판매 조건(정렬 방식·1인 1순번·매수 한도·취소 규정)에 동의합니다 (필수)
            </ConsentCheck>
          </section>

          {/* ⑤⑥ 결제수단 · 결제 프레임(CMP-027) */}
          {v.frame === 'portone' ? (
            <section className="col" style={{ gap: 12 }} aria-labelledby="co-pay-h">
              <h2 className="t-lg" id="co-pay-h">
                결제수단
              </h2>
              <fieldset className="col" style={{ gap: 8 }} role="radiogroup" aria-labelledby="co-m-l">
                <legend className="label" id="co-m-l" style={{ marginBottom: 10 }}>
                  결제수단 고르기 (필수)
                </legend>
                <div className="col gap-2 md:flex-row md:gap-6">
                  {PORTONE_METHODS.map((m, i) => (
                    <label key={m.value} className="check-row" htmlFor={`co-m-${m.value}`}>
                      <input className="rd" id={`co-m-${m.value}`} type="radio" name="co-method" value={m.value} defaultChecked={i === 0} />
                      {m.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <PaymentWidgetFrame pg="portone" state="pg-switched" bodyClassName="min-h-[100px] md:min-h-[120px] lg:min-h-[140px]" />
            </section>
          ) : (
            <section className="col" style={{ gap: 12 }} aria-labelledby="co-pay-h">
              <h2 className="t-lg" id="co-pay-h">
                결제수단
              </h2>
              <p className="t-sm muted">결제수단은 토스페이먼츠 결제 위젯 안에서 고릅니다</p>
              <PaymentWidgetFrame
                pg="toss"
                state={v.frame === 'toss-loading' ? 'loading' : 'ready'}
                bodyClassName="min-h-[140px] md:min-h-[160px] lg:min-h-[200px]"
              />
            </section>
          )}

          {/* ⑧ 판매자 정보(POL-037 고지 + 신원정보 7항목, 접지 않고 늘 보인다) · ⑨ 미성년자 계약 취소 고지 */}
          <section className="col" style={{ gap: 12 }} aria-labelledby="co-seller-h">
            <h2 className="t-lg" id="co-seller-h">
              판매자 정보
            </h2>
            <div className="banner banner-legal">
              <i className="ic ic-scale" aria-hidden="true" />
              <div className="banner-body t-md">
                <span className="legal-tag">법정 고지</span>
                {brokerNotice(seller.name)}
              </div>
            </div>
            <div className="card-flat" style={{ padding: '14px 16px' }}>
              <dl className="kv" style={{ gap: '6px 12px', fontSize: 13, lineHeight: '18px' }}>
                <dt>상호</dt>
                <dd>{seller.name}</dd>
                <dt>대표자</dt>
                <dd>{seller.representative}</dd>
                <dt>주소</dt>
                <dd>{seller.address}</dd>
                <dt>전화</dt>
                <dd>{seller.phone}</dd>
                <dt>전자우편</dt>
                <dd>{seller.email}</dd>
                <dt>사업자등록번호</dt>
                <dd>{seller.businessNo}</dd>
                <dt>통신판매업 신고번호</dt>
                <dd>{seller.mailOrderNo}</dd>
              </dl>
            </div>
            <p className="t-md">
              {MINOR_NOTICE}{' '}
              <Link className="link-more" href="/help">
                미성년자 계약 취소 안내
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
            </p>
          </section>
        </div>

        {/* 데스크톱 오른쪽 고정 주문 요약(①⑦ + 결제 버튼) */}
        <aside className="hidden lg:sticky lg:top-6 lg:col-span-4 lg:block" aria-label="주문 요약">
          <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="co-sum-h2">
            <div className="row between">
              <h2 className="t-md fw-b" id="co-sum-h2">
                좌석과 금액
              </h2>
              <span className="badge badge-primary">홀드 중</span>
            </div>
            <p className="t-sm muted">
              {production.title} · {perf.label}
            </p>
            <p className="t-lg">{CHECKOUT_DEMO.seatText}</p>
            <dl className="kv">
              <dt className="kv-total">합계</dt>
              <dd className="kv-total num">{totalText}</dd>
            </dl>
            <div className="divider" />
            <PayAction layout="panel" {...payProps} />
          </section>
        </aside>
      </div>
    </div>
  );
}

/** 취소 시점별 공제율 표: 휴대폰·태블릿은 세로(시점·공제 두 열), 데스크톱은 가로 한 줄 */
function CancelFeeTable() {
  return (
    <>
      <div className="table-wrap lg:hidden">
        <table className="table dense">
          <caption className="sr-only">취소 시점별 공제율</caption>
          <thead>
            <tr>
              <th scope="col">취소 시점</th>
              <th className="r" scope="col">
                공제
              </th>
            </tr>
          </thead>
          <tbody>
            {CANCEL_FEE_ROWS.map((r) => (
              <tr key={r.when}>
                <td>{r.when}</td>
                <td className="r">{r.fee}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap relative hidden lg:block">
        <table className="table dense">
          <caption className="sr-only">취소 시점별 공제율(관람일 기준)</caption>
          <thead>
            <tr>
              <th scope="col">취소 시점</th>
              {CANCEL_FEE_ROWS.map((r) => (
                <th key={r.short} scope="col">
                  {r.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">공제</th>
              {CANCEL_FEE_ROWS.map((r) => (
                <td key={r.short} className={r.fee === '없음' ? undefined : 'num'}>
                  {r.fee}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
