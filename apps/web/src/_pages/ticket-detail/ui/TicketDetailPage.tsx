// SCR-013 티켓 펼침 경로(d5 §5.13 '티켓 펼침 /my/tickets/[ticketId]'). 일반 셸(오프라인 캐시), (cached) 묶음(FIX-wallet-tickets).
// 서버 셸은 티켓 ID로 아무것도 읽지 않는다(캐시 화면에 개인 값이 섞이지 않게, docs/frontend.md §4.2.4 '펼침'). 실제 화면(WalletLive)이 주소의 ID로 저장소에서 찾고,
// 없으면 "티켓을 찾을 수 없습니다"다(남의 표와 없는 표를 가르지 않는다). 개발 서버에서 ?state=를 주면 퍼블리싱 그림(목업)을 본다(ADR-0224 결정 2).
import type { PageProps } from '@/shared/lib/page-props';
import { AppShell } from '@/widgets/app-shell';
import { WalletLiveShell } from '@/widgets/ticket-wallet';

export async function TicketDetailPage({ params, searchParams }: PageProps<{ ticketId: string }>) {
  if (process.env.NODE_ENV === 'development' && (await searchParams).state !== undefined) {
    const { TicketDetailPreview } = await import('./TicketDetailPreview');
    return <TicketDetailPreview params={params} searchParams={searchParams} />;
  }
  // 주소 값을 기다려 요청 때 그린다(값은 쓰지 않는다). 기다리지 않으면 빌드가 티켓 ID 없는 대체 셸을 만들고, 그 셸은 브라우저에서
  // 화면 조각을 다시 받는 인라인 스크립트(__NEXT_CLIENT_RESUME)를 싣는데 캐시 화면 CSP 해시 서버(server/csp-hash-server.mjs)가 그 스크립트를 막는다
  await params;
  return (
    <AppShell dark={false}>
      <WalletLiveShell detail />
    </AppShell>
  );
}
