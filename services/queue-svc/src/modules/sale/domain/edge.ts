// 엣지 매진 표시의 값과 포트(docs/features/queue-admission.md §4 '엣지 매진 표시와 좌석 수 칸의 첫 구현', docs/infra.md §4.1 '엣지 매진 응답', ADR-0219).
// 엣지 함수(대기열 API 배포 진입 경로의 시청자 요청 함수)가 키 값 저장소(KeyValueStore)에서 sale:{회차 ID}를 읽어, soldOut이 참이고 만료 전이면 410을 바로 낸다.
// 실제 KeyValueStore 어댑터는 BUILD_ORDER HOT-012(OPEN[24] 대기)다. 이 파일은 값의 꼴과 포트만 정한다.

/** 바라는 엣지 값: 켬(매진)·끔과 그 notice의 판 번호, 엣지가 무시하기 시작하는 때(판매 종료) */
export interface EdgeSaleFlag {
  soldOut: boolean;
  /** notice의 saleVersion. 저장된 판보다 작은 판은 쓰지 않는다 */
  version: number;
  /** 유닉스 밀리초. 엣지는 이 시각이 지난 값을 무시하고, 어댑터가 지운다 */
  expireAtMs: number;
}

/** 저장소에 쓰는 한 항목(키·값 글과 판 번호) */
export interface EdgeFlagEntry {
  key: string;
  value: string;
  version: number;
}

/** queue-svc가 쓰는 키의 접두사. 같은 저장소의 다른 항목(도착 시각 쿠키 서명 키 등)은 쓰지 않는다(ADR-0219 결정 4) */
export const EDGE_FLAG_KEY_PREFIX = 'sale:';
/** 쓰기 마감 [가정](docs/architecture.md §5 '시간 초과 기본값') */
export const EDGE_FLAG_PUT_DEADLINE_MS = 2_000;
/** 파드가 마지막으로 쓴 값을 두는 시간 [가정]. 지나면 같은 값이라도 다시 써서, 다른 파드가 덮은 옛 값을 바로잡는다 */
export const EDGE_FLAG_RESYNC_MS = 60_000;
/** 마지막 값을 두는 회차 수의 상한 [가정](동시에 판매하는 회차는 이보다 훨씬 적다) */
export const EDGE_FLAG_CACHE_MAX = 10_000;
/** 파드 안 다시 맞추기 주기 [가정]: 맞추지 못한 회차와 notice보다 큰 판이 저장된 회차를 notice의 지금 판으로 다시 쓴다(ADR-0219 결정 3) */
export const EDGE_FLAG_RESYNC_EVERY_MS = 5_000;
/** 다시 맞추기 한 번에 보는 회차 수의 상한 [가정] */
export const EDGE_FLAG_RESYNC_BATCH = 100;
/** 엣지 저장소 차단기 [가정]: 30초 창에서 쓰기 3번 이상이고 실패가 절반 이상이면 10초 동안 부르지 않는다(사건이 드물어 공용 기본값 20번으로는 열리지 않는다) */
export const EDGE_FLAG_BREAKER = Object.freeze({ windowMs: 30_000, buckets: 10, minCalls: 3, failureRatePercent: 50, openMs: 10_000, trialTimeoutMs: EDGE_FLAG_PUT_DEADLINE_MS });

/** 회차의 엣지 값 항목. 값은 soldOut·version·expireAtMs 세 칸의 JSON이다(docs/infra.md §4.1) */
export function edgeFlagEntry(eventId: string, f: EdgeSaleFlag): EdgeFlagEntry {
  return { key: `${EDGE_FLAG_KEY_PREFIX}${eventId}`, value: JSON.stringify({ soldOut: f.soldOut, version: f.version, expireAtMs: f.expireAtMs }), version: f.version };
}

/** 엣지 저장소를 잠시 쓸 수 없다(무응답·마감 넘김·거절). 판매 상태 받기는 던지지 않고 다음 사건에서 다시 맞춘다 */
export class EdgeFlagsUnavailable extends Error {
  constructor(cause?: unknown) {
    super('엣지 매진 표시 저장소를 잠시 쓸 수 없다', { cause });
    this.name = 'EdgeFlagsUnavailable';
  }
}

/** WRITTEN: 썼다(같은 판이면 덮었다). NEWER_STORED: 저장된 판이 이 판보다 커서 바꾸지 않았다(부른 쪽이 세어 드러낸다, ADR-0219 결정 2) */
export type EdgePutResult = 'WRITTEN' | 'NEWER_STORED';

/**
 * 엣지 매진 표시 저장소. 저장된 판이 이 판보다 크면 바꾸지 않고 NEWER_STORED를 돌려준다(다시 해도 결과가 같다).
 * 키는 EDGE_FLAG_KEY_PREFIX로 시작해야 한다(아니면 RangeError). 저장소가 안 되면 EdgeFlagsUnavailable
 */
export interface EdgeSaleFlags {
  put(entry: EdgeFlagEntry): Promise<EdgePutResult>;
}

/** 엣지 맞추기 신호(docs/observability.md §5): 쓰기 실패, 맞추지 못한 회차 수(want는 바라는 값), notice보다 큰 판이 저장된 회차 수 */
export interface EdgeFlagSignals {
  failed(): void;
  unsynced(want: 'on' | 'off', count: number): void;
  ahead(count: number): void;
}
