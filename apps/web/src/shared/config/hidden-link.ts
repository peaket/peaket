// 공연 상세의 숨긴 링크 주소(docs/features/bot-defense.md §7·§4.8, docs/frontend.md §5.15, ADR-0249 결정 3).
// 경로 값은 저장소에 두지 않고 서버의 실행 환경 값으로 받는다(NEXT_PUBLIC이 아니라 브라우저 묶음에 실리지 않는다). 값이 없으면 링크를 그리지 않는다.
// 빌드 때 미리 그린 화면에는 값을 박지 않는다(그 화면은 다시 그릴 때 실행 환경의 값을 읽는다).

const SHAPE = /^\/_t\/[A-Za-z0-9_-]{8,64}$/;

const runtimePath = (): string | undefined => (process.env.NEXT_PHASE === 'phase-production-build' ? undefined : process.env.PEAKET_HONEYPOT_PATH);

/** 숨긴 링크의 주소. 값이 없거나 `/_t/` 아래 한 칸이 아니면 null이다 */
export function hiddenLinkHref(eventId: string, path: string | undefined = runtimePath()): string | null {
  if (!path || !SHAPE.test(path)) return null;
  return `${path}?e=${encodeURIComponent(eventId)}`;
}
