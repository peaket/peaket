// 로비의 숨긴 링크 주소(docs/features/bot-defense.md §7·§4.8, ADR-0249 결정 3). 경로 값은 빌드 환경 값 VITE_PEAKET_HONEYPOT_PATH로 받는다.

const SHAPE = /^\/_t\/[A-Za-z0-9_-]{8,64}$/;

export function hiddenLinkHref(eventId: string, path: string | undefined): string | null {
  if (!path || !SHAPE.test(path)) return null;
  return `${path}?e=${encodeURIComponent(eventId)}`;
}
