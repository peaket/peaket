'use client';
// SCR-059 '500'의 [다시 시도](보드: 휴대폰 btn-secondary btn-lg, 태블릿·데스크톱 btn-secondary). onRetry가 없으면 페이지를 다시 불러온다.
export function RetryButton({ onRetry }: { onRetry?: () => void }) {
  return (
    <button
      className="btn btn-secondary btn-lg mt-1 md:min-h-10 md:rounded-(--r-md) md:px-4 md:text-sm md:leading-[19px]"
      type="button"
      onClick={() => (onRetry ? onRetry() : window.location.reload())}
    >
      <i className="ic ic-refresh" aria-hidden="true" />
      다시 시도
    </button>
  );
}
