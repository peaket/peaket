'use client';
// SCR-014 실제 화면을 첫 묶음에서 빼고 늦게 싣는다(docs/frontend.md §5.8 '그 밖 소비자 화면' 200KB).
// 미리보기(목업 티켓·?state=)는 TicketTransferPage가 지금처럼 서버에서 그리고, 이 로더는 UUID 티켓만 쓴다.
import dynamic from 'next/dynamic';

const TicketTransferLive = dynamic(() => import('./TicketTransferLive').then((m) => m.TicketTransferLive), {
  ssr: false,
  loading: () => (
    <p className="t-sm muted" role="status">
      티켓과 양도 조건을 불러오는 중…
    </p>
  ),
});

export function TicketTransferLiveShell({ ticketId }: { ticketId: string }) {
  return <TicketTransferLive ticketId={ticketId} />;
}
