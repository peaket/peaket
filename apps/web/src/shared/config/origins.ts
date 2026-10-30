// 다른 앱으로 가는 주소(add-screen-publishing design.md 결정 6).
// - 개발 서버(`next dev`)에서만 앱마다 개발 포트 주소로 잇는다(브리프 공통 규칙 '이동 링크').
// - 운영 빌드에서 대기실(apps/web/queue-room)은 소비자 웹과 같은 www 출처라 상대 경로다(queue-room/src/config.ts와 같은 방식).
// - 출처가 다른 앱은 공개 환경값(NEXT_PUBLIC_…_ORIGIN)으로 받고, 값이 없으면 정본 호스트 이름을 쓴다(docs/frontend.md §2.1).
//   포렌식 2단계는 관제 호스트 아래 `/forensics`로 연다(docs/frontend.md §2.5).
// `process.env.NODE_ENV`는 빌드 때 글자로 바뀌어, 운영 묶음에는 개발 주소가 남지 않는다.
const DEV = process.env.NODE_ENV === 'development';
/** 개발 서버 주소(포트는 design.md 결정 6: 웹 3000 · 파트너 3001 · 관제 3002 · 스캐너 3003 · 대기실 3004 · 포렌식 3005) */
const dev = (port: number) => `http://localhost:${port}`;

export const ORIGINS = {
  web: DEV ? dev(3000) : '',
  partner: process.env.NEXT_PUBLIC_PARTNER_ORIGIN || (DEV ? dev(3001) : 'https://partner.peaket.example'),
  console: process.env.NEXT_PUBLIC_CONSOLE_ORIGIN || (DEV ? dev(3002) : 'https://console.peaket.example'),
  scanner: process.env.NEXT_PUBLIC_SCANNER_ORIGIN || (DEV ? dev(3003) : 'https://scanner.peaket.example'),
  queueRoom: DEV ? dev(3004) : '',
  forensics: process.env.NEXT_PUBLIC_FORENSICS_ORIGIN || (DEV ? dev(3005) : 'https://console.peaket.example/forensics'),
} as const;

/** 대기실(로비·대기열, SCR-007·008·018) 주소. 대기실 경량 페이지는 별도 빌드(apps/web/queue-room)이고 운영에서는 같은 출처의 `/queue/{id}`다 */
export function queueRoomHref(eventId: string): string {
  return `${ORIGINS.queueRoom}/queue/${encodeURIComponent(eventId)}`;
}

/** 굿즈 대기(SCR-015 굿즈 대기) 주소. 운영에서는 같은 출처의 `/shop/{id}/queue`다 */
export function goodsQueueHref(productId: string): string {
  return `${ORIGINS.queueRoom}/shop/${encodeURIComponent(productId)}/queue`;
}
