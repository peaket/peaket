// inventory 컨텍스트의 포트: 좌석 저장소(좌석 Redis), 좌석맵 판, 구매 세션, 홀드 시도 기록.
// 운영 어댑터: 좌석 저장소는 RedisSeatStore. 좌석맵 판·구매 세션은 PRF-130 ①에서 메모리 대역뿐이고(실제 구매 세션 s:session은 PRF-135),
// 홀드 시도 기록의 Kafka·Avro 보내기는 BAS-030이다. 도메인 층이라 프레임워크·플랫폼 형을 가져오지 않는다.
import type { HoldInput, HoldResult, ReplayInput, ReplayResult, SeatRef } from './hold.js';

export const SEAT_STORE = Symbol('purchase.SeatStore');
/**
 * 좌석 저장소(회차 슬롯 {event:E}의 좌석 Redis 키, docs/data.md §3). 운영은 홀드 Lua 하나(adapters/hold-lua.ts의 계약),
 * 시험은 같은 계약의 메모리 구현이다. 두 구현은 같은 사례에서 같은 결과를 낸다.
 */
export interface SeatStore {
  /**
   * 좌석 여러 개를 한 번에 잡는다. 결과 꼴과 검사 차례는 HoldResult의 설명이다.
   *
   * 전부 되거나 전부 안 된다: 모든 검사를 마친 뒤에만 쓴다. OK가 아니면 비트맵·홀드 Hash·만료 인덱스·보유 수·멱등 기록·fence·secver·Stream·
   * 샤드 Pub/Sub 어느 것도 바뀌지 않는다(키 수명도 걸지 않는다).
   *
   * OK일 때 쓰는 것(한 원자 연산 안에서):
   * - 시각: Redis TIME을 한 번만 읽는다(메모리 구현은 주입 Clock: µs = Clock.now() × 1000). heldAtMs = floor(µs / 1000), expiresAtMs = heldAtMs + HOLD_TTL_MS.
   *   REHOLD_WAIT 비교의 '지금'도 같은 값이다.
   * - 펜싱 토큰 = max(fence + 1, µs)(fence가 없으면 0으로 본다)이고 s:{event:E}:fence에 그 값을 쓴다. 그래서 회차 안에서 엄격히 단조 증가하고,
   *   fence를 잃어도(장애 전환) 시각이 앞서 있으면 되돌아가지 않는다. 키·Hash·Stream에는 앞 0 없는 10진 글로 쓴다(지금 시각으로 16자리. Lua 5.1 tostring은
   *   유효 숫자 14자리라 자릿수를 잃으므로 string.format('%.0f')로 바꾼다). 결과의 fencingToken은 그 글을 Number로 바꾼 값이다(안전한 정수가 아니면 Error).
   * - 좌석마다: 비트 1, 홀드 Hash s:{event:E}:hold:{색인} = holdId·owner(계정)·psid(구매 세션)·fence(토큰 글)·heldAt·exp·kind 'FAN'·ext '0'(연장 횟수)
   *   (있던 칸은 지우고 새로 쓴다), 만료 인덱스 s:{event:E}:expiry에 멤버 = 색인(10진 글), 점수 = exp.
   * - 보유 수 s:{event:E}:quota:{account} += 좌석 수.
   * - 멱등 기록 s:{event:E}:idem:{account}:{key} = fp(지문)·resp(처음 응답 '{holdId}:{heldAt}:{exp}:{토큰}'), 수명 IDEM_TTL_MS(7분).
   * - 바뀐 구역마다 secver의 그 구역 색인 칸 += 1(좌석이 여럿이어도 구역마다 한 번).
   * - 좌석마다 Stream s:{event:E}:stream에 HELD 한 건(MAXLEN을 쓰지 않는다). 칸은 docs/data.md §3의 HELD 칸: type 'HELD', seatIdx, seatId, tierId, sectionId,
   *   holdId, holdKind 'FAN', purchaseSessionId, accountId, fencingToken(글), sectionVersion(올린 뒤 번호), seatEpoch(세대 키의 epoch), occurredAtMs(= heldAt),
   *   expiresAtMs(= exp). 값은 모두 글이다.
   * - 바뀐 구역마다 샤드 Pub/Sub 한 건: 채널 s:{event:E}:sec:{구역 색인}, 글 '1 {seatEpoch} {구역 색인} {구역 번호} {heldAt} {seatOffset}:1 …'
   *   (그 구역 좌석을 seats 차례로, 상태 1 = SEAT_STATE_HELD).
   * - 키 수명: 비트맵·홀드 Hash·보유 수·fence·expiry·stream·secver·세대 키(epoch)에 keepUntilMs로 PEXPIREAT를 건다. 지금 만료 시각이 그보다 이르거나
   *   만료가 없을 때만 건다(이미 더 늦으면 둔다, 키가 새로 생겼으면 건다). 세대 키가 비트맵보다 먼저 지워져 산 회차가 NOT_READY가 되지 않게 한다.
   *
   * 쓰기 전 지킴(추천 적용 2026-11-04, HoldResult 설명의 5와 6 사이): keepUntilMs가 저장소 시각 이하, 보유 수·fence 값이 ^%d+$가 아님, expiry·stream·secver·
   * hold:{색인}의 키 형이 틀림이면 아무것도 쓰지 않고 일시 장애가 아닌 Error(PEAKET_KEEP_UNTIL_PAST·PEAKET_CORRUPT_KEY)를 던진다.
   *
   * 멱등 재생(IDEM_REPLAY)은 처음 응답을 그대로 준다(같은 holdId·토큰·heldAtMs·expiresAtMs). 아무것도 쓰지 않는다(보유 수·Stream·fence 그대로).
   * 멱등 기록은 잡았을 때만 적으므로 CONFLICT·REHOLD_WAIT·QUOTA_EXCEEDED 뒤 같은 키로 다시 부르면 새로 시도한다. 다른 계정의 같은 키는 다른 기록이다.
   *
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애(isRedisUnavailable). 이때 쓰였는지는 모른다(같은 멱등 키로 다시 부르면 재생되거나 새로 잡는다)
   * @throws Error 스크립트 오류 같은 버그(모르는 결과 값, 안전한 정수가 아닌 토큰, 위 쓰기 전 지킴 포함)
   */
  hold(i: HoldInput): Promise<HoldResult>;

  /**
   * 멱등 재생 읽기(추천 적용 2026-11-04). HoldSeats가 앱 쪽 거절(판매 종료 410, 좌석맵에 없는 좌석 422, 회차 설정 없음 503) 전에 부른다.
   * 같은 슬롯의 멱등 기록 s:{event:E}:idem:{account}:{key} 하나만 읽고 아무것도 쓰지 않는다.
   * @returns 같은 지문이면 처음 응답(IDEM_REPLAY, hold의 재생과 같은 값), 다른 지문이면 IDEM_REUSED, 기록이 없거나 수명(7분)이 지났으면 null.
   *   다른 계정의 같은 키는 null이다(범위가 계정 × 키)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애
   * @throws Error 기록의 처음 응답 모양이 틀렸거나 토큰이 안전한 정수가 아님
   */
  replay(i: ReplayInput): Promise<ReplayResult>;

  /**
   * 판매 열기(시험·시드 데이터용, HTTP로 열지 않는다. 운영의 판매 승인 경로는 LCH-080).
   * 차례: ① s:ctl:events에 회차를 넣는다 ② 비트맵을 seatCount비트(모두 0)로 만든다 ③ 마지막에 세대 키 s:{event:E}:epoch(칸 epoch = Redis TIME의 초,
   * node = 그 회차 슬롯 주 노드 표지(대기열 q:{event:E}:epoch의 node와 같은 모양), 단일 노드는 'standalone')를 쓴다.
   * ②·③과 그 두 키의 PEXPIREAT(keepUntilMs)는 한 원자 연산이다.
   * 세대 키를 마지막에 쓰므로, 세대 키가 서기 전의 홀드는 NOT_READY다.
   * 이미 세대 키의 epoch 칸이 있으면 아무것도 바꾸지 않고 { created: false }와 그 세대를 준다(다시 불러도 잡은 홀드를 지우지 않는다).
   * @param i.seatCount 회차 좌석 수(1 이상의 정수. 비트맵 색인은 0 ~ seatCount − 1)
   * @param i.keepUntilMs 회차 키 만료 시각(epoch ms, 판매 종료 + 1일)
   * @returns created: 이번에 만들었는지, seatEpoch: 세대 키의 세대(초)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애
   */
  openSale(i: { eventId: string; seatCount: number; keepUntilMs: number }): Promise<{ created: boolean; seatEpoch: number }>;
}

/** 회차의 좌석 판매 설정(좌석맵 판과 판매 정책에서 온다) */
export interface EventSeatConfig {
  eventId: string;
  /** 지금 좌석맵 판(seatmap-layouts/{layoutVersion}.json) */
  layoutVersion: string;
  /** 회차 좌석 수(비트맵 크기) */
  seatCount: number;
  /** 1인 한도(예 2매, 최대 4매, POL-011) */
  perAccountLimit: number;
  /** 판매 종료 시각(epoch ms, 공연 시작 24시간 전, ADR-0064). 주입 Clock의 지금이 이 시각 이상이면 새 홀드는 410 sale-ended */
  saleEndsAtMs: number;
}

export const SEAT_MAP = Symbol('purchase.SeatMap');
/** 회차의 지금 좌석맵 판(좌석 ID → 비트맵 색인·구역·등급)과 판매 설정 */
export interface SeatMap {
  /** 회차 설정. 그 회차의 좌석맵 판이 없으면 undefined(받는 층은 503 seat-store-unavailable) */
  config(eventId: string): Promise<EventSeatConfig | undefined>;
  /**
   * 좌석 ID들을 지금 판의 좌석(색인·구역 ID·구역 색인·구역 안 거리·등급)으로 바꾼다. 결과는 입력과 같은 길이·같은 차례이고,
   * 그 판에 없는 좌석·다른 회차의 좌석·판매 제외석은 그 자리가 undefined다.
   * 같은 ID가 두 번 오면 두 자리 모두 같은 좌석이다(겹침은 부르는 쪽이 가른다). 회차가 없으면 모두 undefined다
   */
  resolve(eventId: string, seatIds: readonly string[]): Promise<(SeatRef | undefined)[]>;
}

/** 구매 세션 하나의 상태(docs/data.md §3 s:session:{sid}의 일부) */
export interface PurchaseSessionInfo {
  /** 구매 세션 ID(@CurrentPurchaseSession()의 참조와 같다) */
  sessionId: string;
  /** 구매 세션을 연 계정 */
  accountId: string;
  /** 구매 세션이 묶인 회차(입장 토큰의 event) */
  eventId: string;
  /** 여정 ID(입장 토큰의 jny, UUIDv7). 판정에는 쓰지 않고 HoldAttempt에 싣는다 */
  journeyId: string;
}

export const PURCHASE_SESSIONS = Symbol('purchase.PurchaseSessions');
/**
 * 구매 세션 읽기 포트. 구현은 플랫폼 구매 요청 인증 훅의 포트(PurchaseSessionPort: resolve·advance, createService의 purchaseSessions)도
 * 함께 맡는다(같은 세션을 보게, adapters/memory-purchase-sessions.ts의 PurchaseSessionAccess). PRF-130 ①에는 시험 대역(MemoryPurchaseSessions)만 있다
 */
export interface PurchaseSessions {
  /** 구매 세션 상태. 없거나 끝났으면 undefined */
  get(sessionId: string): Promise<PurchaseSessionInfo | undefined>;
}

/** HoldAttempt의 result(asyncapi HoldAttempt.result와 같은 값) */
export type HoldAttemptResult = 'HELD' | 'CONFLICT' | 'LIMIT' | 'RECENTLY_RELEASED' | 'ERROR';

/** 홀드 시도 하나(S-T35, ADR-0171). asyncapi HoldAttempt로 바꿔 보내는 것은 BAS-030이다 */
export interface HoldAttemptRecord {
  eventId: string;
  accountId: string;
  purchaseSessionId: string;
  /** 구매 세션의 여정 ID */
  journeyId: string;
  /** 직접 선택만 있다(자동 배정 AUTO는 wbs 2.5.4) */
  mode: 'PICK';
  /** 시도한 좌석 ID(결과와 관계없이 요청 본문의 seatIds를 보낸 차례 그대로, 겹친 것도 그대로) */
  seatIds: string[];
  /** 요청 seatIds 첫 좌석의 등급(여러 등급이 섞여도 첫 좌석의 것). 첫 좌석을 좌석맵 판에서 찾기 전에 거절했거나 판에 없으면 없다 */
  tierId?: string;
  /** 요청 seatIds 첫 좌석의 구역 ID(tierId와 같은 때에 없다) */
  sectionId?: string;
  result: HoldAttemptResult;
  /** HELD일 때만: 홀드 Lua가 돌려준 잡은 시각(epoch ms) */
  heldAtMs?: number;
  /** 결과를 낸 시각(주입 Clock, epoch ms) */
  occurredAtMs: number;
  /** HoldSeats.execute 시작부터 결과까지 걸린 시간(주입 Clock의 단조 시계 차이, ms, 0 이상) */
  latencyMs: number;
}

export const HOLD_ATTEMPTS = Symbol('purchase.HoldAttempts');
/** 홀드 시도 기록(텔레메트리라 버려질 수 있다). 부른 쪽을 막거나 던지지 않는다 */
export interface HoldAttempts {
  record(a: HoldAttemptRecord): void;
}
