// SCR-011 개발 서버 미리보기(?state=, 운영 묶음에 들지 않는다, ADR-0228). 주문·결제(d5 §5.11, d3 SCR-011 행, 캔버스 보드 SCR-011-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 eventId는 회차다.
// 휴대폰: ① 좌석과 금액 → ② 예매자 → ③ 판매자에게 개인정보 제공 동의 → ④ 판매 조건·취소 규정 동의 → ⑤⑥ 결제수단·결제 프레임
//   → ⑧ 판매자 정보(법정 고지 + 7항목, 접지 않음) → ⑨ 미성년자 고지 → 아래 고정 결제 띠(⑦ 홀드 타이머 + [결제하기]).
// 태블릿(md): 가운데 600 한 열, 예매자 두 칸, 아래 띠는 한 줄. 데스크톱(lg): 왼쪽 8열 본문, 오른쪽 4열 고정 주문 요약(①⑦ + 결제 버튼).
// 결제창 복귀 뒤 상태(접수 중·새로고침·금액 불일치·이미 진행 중·예매 제한)는 본문 대신 상태 카드 하나를 보인다.
// 이 화면에서는 외부 분석 스크립트를 싣지 않는다(d5 §5.11).
import { notFound } from 'next/navigation';
import type { WebShellHold } from '@peaket/ds/WebShell';
import { PaymentWidgetFrame } from '@peaket/ds/PaymentWidgetFrame';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { APPEALS, checkoutLockWarning } from '@/entities/appeal';
import { CHECKOUT_DEMO, PaymentReturnCard, PORTONE_METHODS, holdTimeText } from '@/entities/payment';
import { getPerformance } from '@/entities/performance';
import { formatWon, getProduction } from '@/entities/production';
import { getSeller } from '@/entities/seller';
import { getVenue } from '@/entities/venue';
import { SCR011_STATES } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { checkoutView, type CheckoutView } from '../model/view';
import { CheckoutConsentProvider, HoldExpiredDialog, PayAction } from './CheckoutClient';
import { CheckoutForm } from './CheckoutForm';

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

export async function CheckoutPreview({ params, searchParams }: Props) {
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
  // 이 회차에 양도가 잠긴 결제자 소명 요청(GET /v1/fraud-appeal-requests의 PAYER·lockActive 항목)의 잠금 기한. 받은 사람 항목으로는 보이지 않는다
  const lockAppeal = v.fraudLock
    ? APPEALS.find((a) => a.kind === 'fraud' && a.party === 'PAYER' && a.target?.performanceId === perf.id && a.lockExpiresAtText)
    : undefined;
  const fraudLockText = lockAppeal?.lockExpiresAtText ? checkoutLockWarning(lockAppeal.lockExpiresAtText) : undefined;
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
            <CheckoutForm
              data={{
                title: d.production.title,
                line: `${d.perf.label} · ${d.venue.name}`,
                seatText: CHECKOUT_DEMO.seatText,
                grades: [{ grade: CHECKOUT_DEMO.grade, price: CHECKOUT_DEMO.unitPrice, quantity: CHECKOUT_DEMO.quantity }],
                totalText,
                sellerName: d.seller.name,
                seller: d.seller,
                sortMode: d.production.sortMode,
                perPerson: d.production.perPerson,
              }}
              payPanel={<PayAction layout="panel" {...payProps} />}
              top={<PreviewTop v={v} />}
              buyer={<PreviewBuyer v={v} />}
              lockNote={
                v.fraudLock && fraudLockText ? (
                  <div className="banner banner-warning" role="note">
                    <i className="ic ic-lock" aria-hidden="true" />
                    <div className="banner-body">{fraudLockText}</div>
                  </div>
                ) : null
              }
              payment={<PreviewPayment v={v} />}
            />
          )}
        </main>
        {v.expiredDialog ? <HoldExpiredDialog seatsHref={hrefs.seats} /> : null}
        <PreviewSwitcher path={`/booking/${eventId}/checkout`} states={SCR011_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
      </AppShell>
    </CheckoutConsentProvider>
  );
}

function PreviewTop({ v }: { v: CheckoutView }) {
  return (
    <>
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
    </>
  );
}

function PreviewBuyer({ v }: { v: CheckoutView }) {
  const phone = v.inputError ? CHECKOUT_DEMO.invalidPhone : CHECKOUT_DEMO.buyer.phone;
  return (
    <>
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
    </>
  );
}

function PreviewPayment({ v }: { v: CheckoutView }) {
  return (
    <>
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
    </>
  );
}
