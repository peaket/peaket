// SCR-013 실제 월렛의 서버 셸(FIX-wallet-tickets, docs/frontend.md §4.2.4 '펼침', BAT-177 T6 ⑥).
// 첫 HTML에 '불러오는 중'과 QR 뼈대 그림(data URI)을 그리고 실제 화면(WalletLive, 클라이언트)에 넘긴다. 티켓 ID·계정 값은 읽지 않는다(캐시 화면에 개인 값이 섞이지 않게).
// QR 뼈대 data URI는 서버 컴포넌트만 가져간다(클라이언트가 가져가면 첫 JS에 1.2KB가 더해진다, T6 ②).
import { WALLET_QR_SKELETON } from './qr-skeleton';
import { WalletLive } from './WalletLive';

function QrSkeleton() {
  return (
    <div className="card-flat col items-center gap-3 px-4 py-7 text-center" style={{ minHeight: 400 }} aria-busy="true">
      <span className="state-icon is-primary">
        <i className="ic ic-phone" aria-hidden="true" />
      </span>
      <p className="t-md fw-b">입장할 때 쓸 휴대폰을 등록해야 QR이 나옵니다</p>
      <img src={WALLET_QR_SKELETON} alt="" width={312} height={156} decoding="async" className="wallet-qr-skeleton w-full max-w-[312px] rounded-(--r-lg)" style={{ height: 'auto' }} />
    </div>
  );
}

function WalletLoading() {
  return (
    <div className="col gap-3" role="status" aria-busy="true">
      <p className="t-md fw-b">티켓을 불러오는 중입니다</p>
      <QrSkeleton />
    </div>
  );
}

/** 목록(/my/tickets)과 펼침(/my/tickets/[ticketId])이 같은 셸을 쓴다. 펼침의 티켓 ID는 WalletLive가 붙은 뒤 주소에서 읽는다 */
export function WalletLiveShell({ detail = false }: { detail?: boolean }) {
  return <WalletLive detail={detail} loading={<WalletLoading />} qrFallback={<QrSkeleton />} />;
}
