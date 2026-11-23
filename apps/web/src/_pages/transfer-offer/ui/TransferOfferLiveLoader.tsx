'use client';
// SCR-041 실제 화면을 첫 묶음에서 빼고 늦게 싣는다(docs/frontend.md §5.8 '그 밖 소비자 화면' 200KB).
// 실제 화면은 브라우저 저장소·API를 쓰는 클라이언트 화면이라 서버 그리기에 기대지 않는다(ssr: false, R-T21 ③).
import dynamic from 'next/dynamic';

const TransferOfferLive = dynamic(() => import('./TransferOfferLive').then((m) => m.TransferOfferLive), {
  ssr: false,
  loading: () => (
    <p className="t-sm muted" role="status">
      양도 요청을 불러오는 중…
    </p>
  ),
});

export function TransferOfferLiveShell({ offerId }: { offerId: string }) {
  return <TransferOfferLive offerId={offerId} />;
}
