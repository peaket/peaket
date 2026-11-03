// 다른 화면으로 가는 주소. 운영에서 대기실은 소비자 웹과 같은 출처(www 배포)라 상대 경로이고,
// 개발에서는 소비자 웹 개발 서버(포트 3000)로 잇는다(브리프 공통 규칙 '이동 링크').
export const WEB = import.meta.env.DEV ? 'http://localhost:3000' : '';

export const links = {
  home: () => `${WEB}/`,
  event: (eventId: string, round?: string) => `${WEB}/events/${encodeURIComponent(eventId)}${round ? `?round=${encodeURIComponent(round)}` : ''}`,
  shuffleProof: (eventId: string) => `${WEB}/events/${encodeURIComponent(eventId)}/shuffle-proof`,
  /** 입장 확정 뒤 좌석 화면(SCR-010). 대기실 → 좌석은 페이지 전체를 다시 불러오는 이동이다(§2.7) */
  seats: (eventId: string) => `${WEB}/booking/${encodeURIComponent(eventId)}/seats`,
  verify: (eventId: string) => `${WEB}/queue/${encodeURIComponent(eventId)}/verify`,
  /** 로그인 뒤 같은 주소로 돌아온다. 돌아갈 주소는 같은 출처 상대 경로만 넘긴다(§2.7 safeNext) */
  login: (next: string) => `${WEB}/login?next=${encodeURIComponent(next)}`,
  orders: () => `${WEB}/my/orders`,
  tickets: () => `${WEB}/my/tickets`,
  likes: () => `${WEB}/my/likes`,
  settings: () => `${WEB}/my/settings`,
  appeal: (appealId: string) => `${WEB}/my/appeals/${encodeURIComponent(appealId)}`,
  search: () => `${WEB}/search`,
  help: () => `${WEB}/help`,
  shop: () => `${WEB}/shop`,
  product: (productId: string) => `${WEB}/shop/${encodeURIComponent(productId)}`,
  policy: (slug: string) => `${WEB}/policy/${encodeURIComponent(slug)}`,
} as const;
