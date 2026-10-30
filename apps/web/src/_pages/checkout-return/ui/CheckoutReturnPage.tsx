// SCR-011 결제창 복귀(/booking/[eventId]/checkout/return, (cached) 묶음 — 결제창에서 돌아오는 첫 요청은 쿠키가 없다).
// 별도 화면이 아니라 주문·결제의 상태다(d5 §5.11): 결제 값을 읽은 즉시 주소창에서 지우고 "결제 접수 중"을 보인 뒤 접수를 보낸다.
// 202면 결제 결과(SCR-012)로, 접수 400이면 '금액 불일치', 409면 '이미 진행 중'(→ SCR-012), 접수 전 새로고침이면 '복귀 뒤 새로고침'.
// 보드 SCR-011-m·t·d의 복귀 상태 카드를 그대로 옮겼다(카드는 entities/payment의 PaymentReturnCard, 주문·결제 화면과 같이 쓴다).
import { notFound } from 'next/navigation';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { CHECKOUT_DEMO, PaymentReturnCard, holdTimeText, type PaymentReturnKind } from '@/entities/payment';
import { getPerformance } from '@/entities/performance';
import { formatWon, getProduction } from '@/entities/production';
import { getVenue } from '@/entities/venue';
import { SCR011_RETURN_STATES, type Scr011ReturnState } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';

type Props = PageProps<{ eventId: string }>;

const KIND: Record<Scr011ReturnState, PaymentReturnKind> = {
  '결제창 복귀 · 접수 중': 'accepting',
  '복귀 뒤 새로고침': 'reload',
  '금액 불일치': 'mismatch',
  '이미 진행 중': 'other-tab',
};

export async function CheckoutReturnPage({ params, searchParams }: Props) {
  const { eventId } = await params;
  const perf = getPerformance(eventId);
  const production = perf ? getProduction(perf.productionId) : undefined;
  const venue = production ? getVenue(production.venueId) : undefined;
  if (!perf || !production || !venue) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR011_RETURN_STATES, '결제창 복귀 · 접수 중');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const hold = holdTimeText(CHECKOUT_DEMO.holdRemainingSeconds);
  const path = `/booking/${perf.id}/checkout`;

  return (
    <AppShell
      variant="focus"
      dark={dark}
      focus={{
        title: production.title,
        subtitle: `${perf.label} · ${venue.name}`,
        closeHref: `/events/${perf.id}`,
        hold: { text: hold.text, ariaLabel: hold.aria },
        // 데스크톱 머리에는 홀드 타이머가 없다(보드 SCR-011-d)
        holdOnDesktop: false,
      }}
    >
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="w-full px-4 pt-5 pb-8 md:px-6 md:pt-6 md:pb-10 lg:px-8 lg:pt-8 lg:pb-12">
          <div className="col mx-auto w-full max-w-[600px] lg:max-w-[560px]">
            <PaymentReturnCard
              kind={KIND[state]}
              seatText={CHECKOUT_DEMO.seatText}
              totalText={formatWon(CHECKOUT_DEMO.total)}
              retryHref={path}
              appealHref="/my/appeals/apl-0001"
            />
          </div>
        </div>
      </main>
      <PreviewSwitcher path={`${path}/return`} states={SCR011_RETURN_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
