// SCR-013 마이 티켓(월렛) 목록 경로(d5 §5.13). 일반 셸(오프라인 캐시), (cached) 묶음. 서버는 값을 읽지 않고 실제 화면(WalletLive)을 낸다(FIX-wallet-tickets).
// 개발 서버에서 ?state=를 주면 퍼블리싱 그림(목업)을 본다(ADR-0224 결정 2). 운영 묶음에는 들지 않는다.
// QR 뼈대는 WalletLiveShell이 첫 HTML data URI로 그린다. 미리 받을 그림 요청이 없다(BAT-177).
import type { PageProps } from '@/shared/lib/page-props';
import { AppShell } from '@/widgets/app-shell';
import { WalletLiveShell } from '@/widgets/ticket-wallet';

export async function MyTicketsPage({ searchParams }: PageProps) {
  if (process.env.NODE_ENV === 'development' && (await searchParams).state !== undefined) {
    const { MyTicketsPreview } = await import('./MyTicketsPreview');
    return <MyTicketsPreview searchParams={searchParams} />;
  }
  return (
    <AppShell dark={false}>
      <WalletLiveShell />
    </AppShell>
  );
}
