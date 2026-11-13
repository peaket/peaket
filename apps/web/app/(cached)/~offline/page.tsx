// 오프라인 대체 화면(offline-gate §2·§4, SCR-013). 서비스 워커가 캐시하지 못한 문서를 열 때 보인다.
// 이미 받아 둔 마이 티켓 셸은 서비스 워커가 먼저 주므로, 이 화면은 처음 여는 경로에만 나온다.
import Link from 'next/link';

export const metadata = { title: '오프라인' };

export default function OfflinePage() {
  return (
    <main className="page-main" id="main" tabIndex={-1}>
      <div className="col mx-auto w-full max-w-[520px] gap-4 px-4 py-12 text-center">
        <span className="state-icon is-primary mx-auto">
          <i className="ic ic-wifi-off" aria-hidden="true" />
        </span>
        <h1 className="t-xl">인터넷에 연결되어 있지 않습니다</h1>
        <p className="t-sm muted">이미 열어 둔 마이 티켓과 입장 QR은 오프라인에서도 그대로 쓸 수 있습니다.</p>
        <Link className="btn btn-primary btn-lg btn-block" href="/my/tickets">
          마이 티켓 열기
        </Link>
      </div>
    </main>
  );
}
