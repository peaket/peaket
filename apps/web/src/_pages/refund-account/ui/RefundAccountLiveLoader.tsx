'use client';
// SCR-060 실제 화면을 첫 묶음에서 빼고 늦게 싣는다(docs/frontend.md §5.8).
// 실제 화면은 브라우저 저장소·API를 쓰는 클라이언트 화면이라 서버 그리기에 기대지 않는다(ssr: false).
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { AppShell } from '@/widgets/app-shell';

const RefundAccountLive = dynamic(() => import('./RefundAccountLive').then((m) => m.RefundAccountLive), {
  ssr: false,
  loading: () => <RefundAccountLoading />,
});

export function RefundAccountLiveLoader({ refundId }: { refundId: string }) {
  return <RefundAccountLive refundId={refundId} />;
}

function RefundAccountLoading() {
  return (
    <AppShell>
      <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-8 md:pb-12 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[560px] gap-5">
          <Link className="row t-sm gap-0.5 self-start text-(--text-muted)" href="/my/orders">
            <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
            예매·주문 내역
          </Link>
          <h1 className="t-xl">환불 계좌 입력</h1>
          <p className="t-sm muted" role="status">
            환급 정보를 불러오는 중…
          </p>
        </div>
      </main>
    </AppShell>
  );
}
