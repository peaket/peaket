// SCR-043 배상금 계좌 입력(d5 §5.25, 캔버스 보드 SCR-043-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 id는 배상 건이다.
// 머리 → 배상 사유·금액 상자 → 상태별 본문(계좌 폼 CMP-062 + 재인증 시트 · 3회 실패 · 이미 지급 · 송금 결과).
// 휴대폰 먼저, 태블릿(md)·데스크톱(lg)은 가운데 560 폭 한 단이고 은행·계좌번호가 한 줄(1:2)이 된다. 상태는 ?state=, 다크는 ?theme=dark.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { maskedAccount, SAMPLE_BANK_INPUT } from '@/entities/account';
import { COMPENSATION_RATE_PERCENT, compensationAmount, getCompensation } from '@/entities/compensation';
import { getPerformance } from '@/entities/performance';
import { formatWon, getProduction } from '@/entities/production';
import { SCR043_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { compensationView } from '../model/state';
import { CompensationAccountForm } from './CompensationAccountForm';

export async function CompensationPage({ params, searchParams }: PageProps<{ id: string }>) {
  const { id } = await params;
  const c = getCompensation(id);
  const production = c ? getProduction(c.productionId) : undefined;
  const perf = c ? getPerformance(c.performanceId) : undefined;
  if (!c || !production || !perf) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR043_STATES, '입력');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = compensationView(state);
  // 실제 결제 금액 = 그 등급 가격 × 매수(목업), 배상금은 그 10%
  const paid = (production.tiers.find((t) => t.grade === c.grade)?.price ?? 0) * c.quantity;
  const amount = compensationAmount(paid);
  const account = maskedAccount(SAMPLE_BANK_INPUT.bank, SAMPLE_BANK_INPUT.account);

  return (
    <AppShell dark={dark}>
      <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-8 md:pb-12 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[560px] gap-5">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-xl">배상금 계좌 입력</h1>
            <p className="t-sm muted">배상금을 받을 계좌를 입력합니다</p>
          </div>

          <section className="card-flat col p-4 md:px-5" style={{ gap: 10 }} aria-labelledby="cp-h">
            <span className="eyebrow">배상 사유</span>
            <h2 id="cp-h" className="t-md fw-b">
              {c.reason}
            </h2>
            <p className="t-sm muted">
              {production.title} · {perf.label} · {c.grade} {c.quantity}매
            </p>
            <hr className="divider" />
            <dl className="kv">
              <dt>실제 결제 금액</dt>
              <dd>{formatWon(paid)}</dd>
              <dt>배상금(실제 결제 금액의 {COMPENSATION_RATE_PERCENT}%)</dt>
              <dd className="kv-total">{formatWon(amount)}</dd>
            </dl>
            <p className="t-sm muted">분쟁해결기준에 따른 배상금입니다</p>
          </section>

          {v.form ? <CompensationAccountForm key={state} mode={v.form} initialSheet={v.sheet} /> : null}

          {v.locked ? (
            <div className="col gap-4">
              <div className="banner banner-danger" role="alert">
                <i className="ic ic-alert-circle" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">송금이 3번 실패했습니다</span>고객센터에서 도와드리겠습니다
                </div>
              </div>
              <Link className="btn btn-primary btn-lg btn-block" href="/help/inquiries/new">
                문의하기
              </Link>
            </div>
          ) : null}

          {v.paid ? (
            <section className="card col items-start px-5 py-6" style={{ gap: 14 }} role="status" aria-labelledby="cp-paid-h">
              <span className="state-icon is-success" style={{ width: 56, height: 56 }}>
                <i className="ic ic-check-circle" aria-hidden="true" />
              </span>
              <h2 id="cp-paid-h" className="t-lg">
                이미 지급된 배상금입니다
              </h2>
              <dl className="kv w-full">
                <dt>배상금</dt>
                <dd>{formatWon(amount)}</dd>
                <dt>지급 계좌</dt>
                <dd>{account}</dd>
              </dl>
              <Link className="btn btn-secondary btn-block" href="/my/orders">
                예매·주문 내역
              </Link>
            </section>
          ) : null}

          {v.done ? (
            <section className="card col px-5 py-6" style={{ gap: 14 }} role="status" aria-labelledby="cp-done-h">
              <div className="row between" style={{ gap: 8 }}>
                <h2 id="cp-done-h" className="t-lg">
                  송금 결과
                </h2>
                <span className="badge badge-lg badge-primary">송금 요청됨</span>
              </div>
              <ol className="timeline" aria-label="송금 진행">
                <li className="tl-item">
                  <span className="tl-dot ok" aria-hidden="true" />
                  <div className="col" style={{ gap: 2 }}>
                    <span className="t-sm fw-b">송금 요청됨</span>
                    <span className="t-xs muted">{c.requestedAtText}</span>
                  </div>
                </li>
                <li className="tl-item">
                  <span className="tl-dot" aria-hidden="true" />
                  <div className="col" style={{ gap: 2 }}>
                    <span className="t-sm fw-b">송금 완료</span>
                    <span className="t-xs muted">대기</span>
                  </div>
                </li>
              </ol>
              <dl className="kv">
                <dt>배상금</dt>
                <dd className="kv-total">{formatWon(amount)}</dd>
                <dt>받을 계좌</dt>
                <dd>{account}</dd>
              </dl>
              <p className="t-xs muted">계좌번호는 저장하지 않아 은행과 끝 4자리만 보입니다</p>
              <Link className="btn btn-secondary btn-block" href="/my/orders">
                예매·주문 내역
              </Link>
            </section>
          ) : null}
        </div>
      </main>
      <PreviewSwitcher path={`/my/compensations/${id}`} states={SCR043_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
