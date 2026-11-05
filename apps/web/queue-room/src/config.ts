// 다른 화면으로 가는 주소. 운영에서 대기실은 소비자 웹과 같은 출처(www 배포)라 상대 경로이고,
// 개발에서는 소비자 웹 개발 서버(포트 3000)로 잇는다(브리프 공통 규칙 '이동 링크').
export const WEB = import.meta.env.DEV ? 'http://localhost:3000' : '';

/**
 * 대기열 API·대기열 파일·팬 API 출처(docs/frontend.md §2.1 queue·queue-files·api, ADR-0207). 빌드 때 VITE_PEAKET_*로 바꾼다.
 * 개발 서버는 계약 모양 가짜 API(127.0.0.1:4010, apps/web/scripts/mock-api.mjs)를 쓴다
 */
const env = import.meta.env as Record<string, string | boolean | undefined>;
const pick = (key: string, dev: string, prod: string): string => (typeof env[key] === 'string' && env[key] ? (env[key] as string) : import.meta.env.DEV ? dev : prod);
const MOCK = 'http://127.0.0.1:4010';
export const ORIGINS = {
  queue: pick('VITE_PEAKET_QUEUE_ORIGIN', MOCK, 'https://queue.peaket.example'),
  files: pick('VITE_PEAKET_QUEUE_FILES_ORIGIN', MOCK, 'https://queue-files.peaket.example'),
  api: pick('VITE_PEAKET_API_ORIGIN', MOCK, 'https://api.peaket.example'),
} as const;

/**
 * 사람 확인 위젯(ADR-0208 결정 3). 운영은 Cloudflare Turnstile(사이트 키는 공개 값 VITE_PEAKET_TURNSTILE_SITEKEY),
 * 개발 서버는 같은 함수 모양의 시뮬레이터(src/dev/human-check-sim.ts)다. 개발에서도 VITE_PEAKET_HUMAN_CHECK=turnstile이면 실제 위젯을 싣는다
 */
export const HUMAN_CHECK = {
  mode: import.meta.env.DEV && env.VITE_PEAKET_HUMAN_CHECK !== 'turnstile' ? ('simulator' as const) : ('turnstile' as const),
  siteKey: typeof env.VITE_PEAKET_TURNSTILE_SITEKEY === 'string' ? env.VITE_PEAKET_TURNSTILE_SITEKEY : '',
};

export const links = {
  home: () => `${WEB}/`,
  /** 로그아웃 처리기(웹 앱 서버, 같은 출처). 개발 서버는 vite.config.ts가 흉내 낸다(ADR-0208 결정 7) */
  logout: () => '/logout',
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
