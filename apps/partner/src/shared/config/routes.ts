// 파트너 콘솔 경로(d5 §2 인벤토리, §6). 화면 사이 링크는 이 함수로 만든다.

export type EventTab = 'overview' | 'edit' | 'seatmap' | 'policy' | 'live' | 'staff' | 'settlement' | 'cancellation';

/** 공연 문맥 탭(d5 §3.2): 개요 · 등록 정보 · 좌석맵 · 판매 정책 · 판매 현황 · 현장 · 정산·명단 · 회차 취소 */
export const EVENT_TABS: readonly { key: EventTab; label: string; scr: string }[] = [
  { key: 'overview', label: '개요', scr: 'SCR-063' },
  { key: 'edit', label: '등록 정보', scr: 'SCR-021' },
  { key: 'seatmap', label: '좌석맵', scr: 'SCR-022' },
  { key: 'policy', label: '판매 정책', scr: 'SCR-024' },
  { key: 'live', label: '판매 현황', scr: 'SCR-026' },
  { key: 'staff', label: '현장', scr: 'SCR-037' },
  { key: 'settlement', label: '정산·명단', scr: 'SCR-027' },
  { key: 'cancellation', label: '회차 취소', scr: 'SCR-044' },
];

export const routes = {
  home: () => '/events',
  login: () => '/login',
  invite: () => '/invite',
  unlock: () => '/unlock',
  preview: () => '/preview',
  events: () => '/events',
  eventNew: () => '/events/new',
  event: (id: string) => `/events/${id}`,
  eventTab: (id: string, tab: EventTab) => (tab === 'overview' ? `/events/${id}` : `/events/${id}/${tab}`),
  eventSaleReview: (id: string) => `/events/${id}/sale-review`,
  products: () => '/products',
  productNew: () => '/products/new',
  productOrders: () => '/products/orders',
  product: (id: string) => `/products/${id}`,
  settings: () => '/settings',
  settingsAccount: () => '/settings/account',
  settingsSeller: () => '/settings/seller',
  settingsPayout: () => '/settings/payout',
  settingsTeam: () => '/settings/team',
  settingsWebhooks: () => '/settings/webhooks',
} as const;

/** 파트너 지원 문의 [가정: 지원 창구 주소는 정본에 없어 예시 도메인의 메일 주소로 둔다] */
export const PARTNER_SUPPORT_HREF = 'mailto:partners@peaket.example';
