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
  /**
   * 팬 API(gw-fan) 출처(docs/frontend.md §2.1 `api`). 개발 서버에서 값이 없으면 비워 두고, 그때 본인확인 버튼은 퍼블리싱용 시험 창을 연다.
   * 로컬에서 실제 흐름을 돌릴 때는 게이트웨이 대역(scripts/local-fan-gateway.mjs) 주소를 넣는다(docs/features/identity.md §5)
   */
  api: process.env.NEXT_PUBLIC_API_ORIGIN || (DEV ? '' : 'https://api.peaket.example'),
  /** 대기열 API·파일 출처(docs/frontend.md §2.1 `queue`·`queue-files`). api-client 클라이언트가 함께 담는다(ADR-0199) */
  queue: process.env.NEXT_PUBLIC_QUEUE_ORIGIN || (DEV ? '' : 'https://queue.peaket.example'),
  queueFiles: process.env.NEXT_PUBLIC_QUEUE_FILES_ORIGIN || (DEV ? '' : 'https://queue-files.peaket.example'),
} as const;

/**
 * 소비자 웹의 공개 출처(docs/frontend.md §1 `www.peaket.example`). 정규 주소·구조화 데이터의 절대 주소에 쓴다(서버에서 읽는다).
 * 환경마다 다르면 PEAKET_SITE_ORIGIN으로 넣는다
 */
export const SITE_ORIGIN = (process.env.PEAKET_SITE_ORIGIN || 'https://www.peaket.example').replace(/\/+$/, '');

/** 대기실(로비·대기열, SCR-007·008·018) 주소. 대기실 경량 페이지는 별도 빌드(apps/web/queue-room)이고 운영에서는 같은 출처의 `/queue/{id}`다 */
export function queueRoomHref(eventId: string): string {
  return `${ORIGINS.queueRoom}/queue/${encodeURIComponent(eventId)}`;
}

/** 굿즈 대기(SCR-015 굿즈 대기) 주소. 운영에서는 같은 출처의 `/shop/{id}/queue`다 */
export function goodsQueueHref(productId: string): string {
  return `${ORIGINS.queueRoom}/shop/${encodeURIComponent(productId)}/queue`;
}
