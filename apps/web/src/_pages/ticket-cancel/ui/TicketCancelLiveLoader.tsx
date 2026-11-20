'use client';
// SCR-038 실제 화면을 첫 묶음에서 빼고 늦게 싣는다(docs/frontend.md §5.8 '그 밖 소비자 화면' 200KB).
// 실제 화면은 브라우저 저장소·API를 쓰는 클라이언트 화면이라 서버 그리기에 기대지 않는다(ssr: false).
// 미리보기(목업 티켓·?state=)는 TicketCancelPage가 지금처럼 서버에서 그리고, 이 로더는 UUID 티켓만 쓴다.
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { AppShell } from '@/widgets/app-shell';

const TicketCancelLive = dynamic(() => import('./TicketCancelLive').then((m) => m.TicketCancelLive), {
  ssr: false,
  loading: () => <CancelLoading />,
});

export function TicketCancelLiveLoader({ ticketId }: { ticketId: string }) {
  return <TicketCancelLive ticketId={ticketId} />;
}

/** 실행부를 받는 동안의 얇은 뼈대. 제목·돌아가기만 두고 카드 자리는 비워 둔다(레이아웃이 튀지 않게) */
function CancelLoading() {
  return (
    <AppShell>
      <main className="page-main px-4 pt-4 pb-8 md:px-6 md:pt-5 md:pb-10 lg:px-8 lg:pt-8 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[600px] gap-6 lg:max-w-[976px] lg:gap-7">
          <div className="col gap-2">
            <Link className="row t-sm gap-0.5 self-start text-(--text-muted)" href="/my/tickets">
              <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
              마이 티켓
            </Link>
            <h1 className="t-xl lg:text-2xl">예매 취소</h1>
          </div>
          <p className="t-sm muted" role="status">
            티켓과 환급액을 불러오는 중…
          </p>
        </div>
      </main>
    </AppShell>
  );
}
