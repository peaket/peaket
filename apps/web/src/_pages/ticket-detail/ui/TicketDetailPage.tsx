// SCR-013 티켓 펼침(d5 §5.13 '티켓 펼침 /my/tickets/[ticketId]', 캔버스 보드 SCR-013-m·t·d). 일반 셸(오프라인 캐시), (cached) 묶음.
// 보드는 월렛 목록 안에서 한 장을 펼쳐 그렸으므로 목록과 같은 본문(widgets/ticket-wallet의 Wallet)을 쓰고, 티켓 한 장의 상태 19가지를 고른다.
// 받은 티켓 id면 받은 티켓 펼침이 기본이고, 나머지는 첫 티켓(R구역 12열 7번) 펼침이 기본이다.
import { notFound } from 'next/navigation';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { getTicket } from '@/entities/ticket';
import { SCR013_DETAIL_STATES, type Scr013DetailState } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
// 같은 화면(SCR-013)의 목록 경로와 같은 본문을 쓴다(경로만 둘)
import { T3, Wallet, WALLET_TICKET_IDS } from '@/widgets/ticket-wallet';

export async function TicketDetailPage({ params, searchParams }: PageProps<{ ticketId: string }>) {
  const { ticketId } = await params;
  if (!WALLET_TICKET_IDS.includes(ticketId) && !getTicket(ticketId)) notFound();
  const sp = await searchParams;
  const fallback: Scr013DetailState = ticketId === T3.id ? '받은 티켓' : '기본(QR 펼침)';
  const state = resolvePreviewState(sp, SCR013_DETAIL_STATES, fallback);
  const dark = resolvePreviewTheme(sp) === 'dark';
  const path = `/my/tickets/${encodeURIComponent(ticketId)}`;
  return (
    <AppShell dark={dark}>
      <Wallet state={state} path={path} dark={dark} />
      {process.env.NODE_ENV !== 'production' ? (
        <PreviewSwitcher path={path} states={SCR013_DETAIL_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
      ) : null}
    </AppShell>
  );
}
