// SCR-060 환불 계좌 입력(지연 환급)(d5 §5.34, 캔버스 보드 SCR-060-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 refundId는 취소 ID다.
// 머리 → 환급 대상·금액 상자 → 상태별 본문(계좌 폼 CMP-062 + 재인증 시트 · 완료).
// 휴대폰 먼저, 태블릿(md)·데스크톱(lg)은 가운데 560 폭 한 단이고 은행·계좌번호가 한 줄(1:2)이 된다. 상태는 ?state=, 다크는 ?theme=dark.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { maskedAccount, SAMPLE_BANK_INPUT } from '@/entities/account';
import { getOrder } from '@/entities/order';
import { getPerformance } from '@/entities/performance';
import { formatWon, getProduction } from '@/entities/production';
import { getDelayedRefund, refundBreakdown } from '@/entities/refund';
import { SCR060_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { refundAccountView } from '../model/state';
import { RefundAccountForm } from './RefundAccountForm';

export async function RefundAccountPage({ params, searchParams }: PageProps<{ refundId: string }>) {
  const { refundId } = await params;
  const r = getDelayedRefund(refundId);
  const order = r ? getOrder(r.orderId) : undefined;
  const production = order?.productionId ? getProduction(order.productionId) : undefined;
  const perf = order?.performanceId ? getPerformance(order.performanceId) : undefined;
  if (!r || !order || !production || !perf) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR060_STATES, '입력');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = refundAccountView(state);
  const { deduction, refund } = refundBreakdown(order.amount, r.deductionPercent);

  return (
    <AppShell dark={dark}>
      <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-8 md:pb-12 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[560px] gap-5">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-xl">환불 계좌 입력</h1>
            <p className="t-sm muted">가상계좌로 결제해 바로 환급하지 못한 금액을 받을 계좌를 입력합니다</p>
          </div>

          <section className="card-flat col p-4 md:px-5" style={{ gap: 10 }} aria-labelledby="rf-h">
            <span className="eyebrow">환급 대상</span>
            <div className="col" style={{ gap: 2 }}>
              <h2 id="rf-h" className="t-md fw-b">
                {production.title}
              </h2>
              <p className="t-sm muted">
                {perf.label} · {order.quantity}매 · {order.method} 결제
              </p>
            </div>
            <hr className="divider" />
            <dl className="kv">
              <dt>결제 금액</dt>
              <dd className="num">{formatWon(order.amount)}</dd>
              <dt>취소 공제({r.deductionPercent}%)</dt>
              <dd className="num">−{formatWon(deduction)}</dd>
              <dt>환급액</dt>
              <dd className="kv-total">{formatWon(refund)}</dd>
            </dl>
            <p className="t-xs muted">{r.deductionNote}</p>
            <p className="t-sm">{r.reasonText}</p>
          </section>

          {v.form ? <RefundAccountForm key={state} mode={v.form} initialSheet={v.sheet} /> : null}

          {v.done ? (
            <section className="card col items-start px-5 py-6" style={{ gap: 14 }} role="status" aria-labelledby="rf-done-h">
              <span className="state-icon is-success" style={{ width: 56, height: 56 }}>
                <i className="ic ic-check-circle" aria-hidden="true" />
              </span>
              <h2 id="rf-done-h" className="t-lg">
                환급을 요청했습니다. 3영업일 안에 입금됩니다
              </h2>
              <dl className="kv w-full">
                <dt>환급액</dt>
                <dd className="kv-total">{formatWon(refund)}</dd>
                <dt>입금 계좌</dt>
                <dd>{maskedAccount(SAMPLE_BANK_INPUT.bank, SAMPLE_BANK_INPUT.account)}</dd>
              </dl>
              <p className="t-xs muted">계좌번호는 저장하지 않아 은행과 끝 4자리만 보입니다</p>
              <Link className="btn btn-secondary btn-block" href="/my/orders">
                예매·주문 내역
              </Link>
            </section>
          ) : null}
        </div>
      </main>
      <PreviewSwitcher
        path={`/my/refunds/${refundId}/account`}
        states={SCR060_STATES}
        current={state}
        keep={{ theme: dark ? 'dark' : undefined }}
      />
    </AppShell>
  );
}
