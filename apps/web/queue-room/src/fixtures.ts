// 합성 목업(고정 값). 공연·회사·공연장 이름은 docs/design/d5에 나온 지어낸 이름이다.
// 폴링·진입 API는 붙이지 않는다. 대기 상태 파일(queue-admission §4)의 모양만 흉내 내 고정 값으로 읽는다.

export type Ordering = 'HYBRID' | 'FIFO';
export type SaleStatus = 'ON_SALE' | 'PAUSED' | 'ALL_HELD' | 'SOLD_OUT' | 'ENDED';

/** 대기 상태 파일 목업. 앞 인원은 브라우저가 계산한다(docs/frontend.md §2.6·§3.4) */
export interface QueueStatusFile {
  generatedAtMs: number;
  serving: number;
  /** serving과 내 순번 사이에서 빠진 번호 수(removedUpToServing·removedBeforeSegment·내 구간 removedBitmap을 센 값) */
  removedBetween: number;
  /** 1초에 serving이 지나는 유효 순번 수(POL-007) */
  servingRate: number;
  saleStatus: SaleStatus;
  pollHintMs?: number;
}

export interface Round {
  id: string;
  label: string;
  status: 'SOLD_OUT' | 'ON_SALE';
}

export interface Preference {
  tiers: readonly string[];
  tier: string;
  qty: number;
  maxQty: number;
  wheelchair: boolean;
  second: string;
  allowSplit: boolean;
}

export interface EventFixture {
  id: string;
  title: string;
  /** 집중 셸 머리 둘째 줄(회차 일시 · 공연장). 시각은 공연장 현지 시각(KST) */
  when: string;
  openAt: string;
  ordering: Ordering;
  autoAssign: boolean;
  seedHash: string;
  /** 운영 공지(명령 7 승인 템플릿). 없으면 null */
  notice: string | null;
  /** 저장소에 있는 토큰(목업): boot 상태가 어디로 갈지 정한다(§3.4 boot) */
  session: { queueTicket: boolean; joinToken: boolean; beforeOpen: boolean };
  /** 오픈까지 남은 초(목업 시계) */
  secondsToOpen: number;
  /** 이 기기의 로비 버튼이 열리기까지 남은 초(§5.9 기기마다 고정된 지연) */
  joinOpensIn: number;
  myNumber: number;
  /** 처음 받은 앞 인원(탭의 세션 저장소에 두는 값, ADR-0063) */
  initialAhead: number;
  status: QueueStatusFile;
  rounds: readonly Round[];
  currentRound: string;
  tierStatus: string;
  pref: Preference;
  lastSync: string;
  appealId: string;
}

const LUMEN_STATUS: QueueStatusFile = {
  generatedAtMs: Date.UTC(2026, 9, 14, 11, 3, 0),
  serving: 8_700,
  removedBetween: 20,
  servingRate: 26.8,
  saleStatus: 'ON_SALE',
  pollHintMs: 0,
};

const ENTRY_DELAY_NOTICE = '접속이 많아 입장이 평소보다 늦어질 수 있습니다. 대기 순서는 그대로이며, 새로고침하지 않아도 자동으로 이어집니다.';

const base = {
  seedHash: '3f9a…c21e',
  secondsToOpen: 9 * 60 + 58,
  joinOpensIn: 42,
  myNumber: 11_935,
  initialAhead: 8_458,
  status: LUMEN_STATUS,
  rounds: [
    { id: 'r1', label: '1회차', status: 'SOLD_OUT' },
    { id: 'r2', label: '2회차', status: 'ON_SALE' },
    { id: 'r3', label: '3회차', status: 'SOLD_OUT' },
  ],
  currentRound: 'r1',
  tierStatus: '등급별: R석 매진 · S석 매진 · A석 매진',
  pref: { tiers: ['R석', 'S석', 'A석'], tier: 'R석', qty: 2, maxQty: 2, wheelchair: false, second: 'S석', allowSplit: true },
  lastSync: '19:50',
  appealId: 'apl-1027',
} satisfies Partial<EventFixture>;

export const EVENTS: Record<string, EventFixture> = {
  // 기본 공연(하이브리드, 직접 좌석 선택). 대기표가 있어 기본 화면은 대기열(SCR-008 대기 중)이다
  'evt-lumen-2026': {
    ...base,
    id: 'evt-lumen-2026',
    title: 'LUMEN 콘서트 2026 서울',
    when: '10/25(일) 18:00 · 피켓 아레나',
    openAt: '10/14(수) 20:00',
    ordering: 'HYBRID',
    autoAssign: false,
    notice: ENTRY_DELAY_NOTICE,
    session: { queueTicket: true, joinToken: true, beforeOpen: false },
  },
  // 하이브리드 + 자동 배정 공연(SCR-007 '자동 배정 공연'). 보드는 자리표시 글([자동 배정 공연])이라 d5의 지어낸 공연 이름을 썼다
  'evt-winter-fanmeet': {
    ...base,
    id: 'evt-winter-fanmeet',
    title: '겨울 팬미팅',
    when: '11/22(일) 17:00 · 피켓 아레나',
    openAt: '11/2(월) 20:00',
    ordering: 'HYBRID',
    autoAssign: true,
    notice: null,
    session: { queueTicket: false, joinToken: true, beforeOpen: true },
  },
  // 선착순 + 자동 배정 공연(SCR-008 보드의 둘째 공연). 선착순 공연은 로비가 없다
  'evt-autumn-fest': {
    ...base,
    id: 'evt-autumn-fest',
    title: '가을 야외 페스티벌',
    when: '11/7(토) · 1회차',
    openAt: '10/12(월) 20:00',
    ordering: 'FIFO',
    autoAssign: true,
    notice: ENTRY_DELAY_NOTICE,
    session: { queueTicket: true, joinToken: false, beforeOpen: false },
  },
  // 매진 공연(SCR-018 보드). 보드의 '[일시]' 자리표시는 지어낸 일시로 채웠다
  'evt-musical-small': {
    ...base,
    id: 'evt-musical-small',
    title: '소극장 뮤지컬',
    when: '1회차 · 11/14(토) 14:00 · 피켓 아레나',
    openAt: '10/20(화) 20:00',
    ordering: 'HYBRID',
    autoAssign: false,
    notice: null,
    session: { queueTicket: true, joinToken: true, beforeOpen: false },
    status: { ...LUMEN_STATUS, saleStatus: 'SOLD_OUT' },
  },
};

export const DEFAULT_EVENT_ID = 'evt-lumen-2026';

/** 주소의 회차 ID로 목업을 찾는다. 모르는 ID면 기본 공연 값을 그 ID로 보인다(목업 ID 아무거나 열리게) */
export function findEvent(id: string): EventFixture {
  return EVENTS[id] ?? { ...EVENTS[DEFAULT_EVENT_ID]!, id };
}

export interface ProductFixture {
  id: string;
  name: string;
  meta: string;
  myNumber: number;
  initialAhead: number;
  status: QueueStatusFile;
  saleBadge: string;
}

export const PRODUCTS: Record<string, ProductFixture> = {
  'md-lumen-lightstick': {
    id: 'md-lumen-lightstick',
    name: 'LUMEN 공식 응원봉',
    meta: '한정 120개 · 계정당 최대 2개',
    myNumber: 11_935,
    initialAhead: 8_458,
    status: LUMEN_STATUS,
    saleBadge: '판매 중',
  },
};

export const DEFAULT_PRODUCT_ID = 'md-lumen-lightstick';

export function findProduct(id: string): ProductFixture {
  return PRODUCTS[id] ?? { ...PRODUCTS[DEFAULT_PRODUCT_ID]!, id };
}

/** 로그인한 팬(목업). 보드의 계정 메뉴 이름 */
export const ACCOUNT = { name: '지민', initial: '지', verified: true } as const;
