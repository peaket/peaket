// 홀드 만료의 규칙 값과 타입(docs/features/seat-hold.md §5 '만료 인덱스 관리'·'만료 및 해제 처리'·'방금 놓은 좌석', docs/data.md §3 좌석 키 표,
// BUILD_ORDER PRF-135, ADR-0086 결정 9). 만료는 두 단계다: ① 앱이 만료 인덱스와 홀드 Hash 세 칸을 읽고(SeatExpiries.dueExpiries)
// ② 읽은 값을 기대값으로 넘겨 만료 Lua가 펜싱을 다시 확인하며 한 번에 푼다(SeatExpiries.expire). 도메인 층이라 프레임워크·플랫폼 형을 가져오지 않는다.
import { KEY_PART, type SeatRef } from './hold.js';

/** 만료 Lua 한 번에 넘기는 좌석 수의 상한이자 1단계에서 한 번에 읽는 수(ZRANGE … LIMIT 0 100, ADR-0086 결정 9, S-T27) */
export const EXPIRY_BATCH_SIZE = 100;
/** 한 틱에 회차 하나를 돌리는 묶음 수의 상한 20 [가정](100석 × 20 = 틱마다 회차당 2,000석) */
export const EXPIRY_MAX_BATCHES_PER_TICK = 20;
/** 만료 반복 주기 1초 [가정, Phase 2 부하 시험에서 확정](seat-hold.md §5 '만료 인덱스 관리') */
export const EXPIRY_TICK_MS = 1000;
/** 회차별 만료 임대 s:{event:E}:sweep의 수명 3초 [가정](잡은 파드가 멈추면 늦어도 이만큼 뒤 다른 파드가 잡는다) */
export const SWEEP_LEASE_TTL_MS = 3000;
/** 한 틱에 동시에 돌리는 회차 수의 상한 4 [가정](추천 적용 2026-11-04 M5) */
export const EXPIRY_CONCURRENCY = 4;
/** 직전 틱에서 UNAVAILABLE·ERROR였던 회차를 쉬는 시간 5초 [가정](추천 적용 2026-11-04 M5, 결과 BACKOFF) */
export const EXPIRY_BACKOFF_MS = 5000;
/** 메모리 부족 경고 로그를 파드마다 남기는 최소 간격 1초(추천 적용 2026-11-04 L6) */
export const OOM_WARN_INTERVAL_MS = 1000;
/** 파드 ID(만료 임대 값)에 쓰는 HOSTNAME 앞부분의 길이 상한 57자(뒤에 '-' + 16진 6자리를 붙여 KEY_PART 64자 안, 추천 적용 2026-11-04 L5) */
export const POD_ID_HOST_CHARS = 57;
/** saleEvents가 회차 ID 모양이 아닌 값을 걸렀다는 경고를 파드마다 남기는 최소 간격 60초(1초 반복이 읽을 때마다 한 줄씩 쌓이지 않게, 추천 적용 2026-11-04 C3) */
export const SALE_EVENTS_WARN_INTERVAL_MS = 60_000;

/**
 * 표준 10진 정수인가(추천 적용 2026-11-04 A1): '0'이거나 첫 자리가 1~9인 18자리 이하의 10진 글.
 * INCRBY·HINCRBY가 건드릴 값(보유 수 키 `quota`의 값, 바뀔 구역의 `secver` 칸 값)의 모양이다. Redis는 앞 0·소수·빈 글·int64 밖의 값을 받지 않아
 * 쓰다가 중간에 실패하므로, 홀드·만료 Lua는 쓰기 전에 이 모양을 본다(Lua의 `canon`과 같다. 메모리 구현이 같은 규칙을 따른다)
 */
export function isStandardInt(text: string): boolean {
  return text === '0' || /^[1-9][0-9]{0,17}$/.test(text);
}

/**
 * 만료 Lua가 받는 홀드 Hash의 `fence` 칸 모양인가(추천 적용 2026-11-04 A2): 앞 0 없는 양의 10진 정수이고 2^53 − 1(9007199254740991) 이하.
 * 앱의 `fencingTokenOf`가 안전한 정수만 받으므로, 모양만 보고 풀면 푼 뒤에 앱이 던진다. 15자리 이하는 통과하고 16자리는 글 비교로 그 값 이하일 때만 통과한다
 * (Lua의 `safeFence`와 같다. 1단계 읽기(dueExpiries)도 같은 규칙으로 망가진 홀드를 가른다)
 */
export function isExpirableFence(text: string): boolean {
  if (!/^[1-9][0-9]*$/.test(text)) return false;
  return text.length < 16 || (text.length === 16 && text <= '9007199254740991');
}

/**
 * 회차 하나를 이번 틱에 어디까지 돌렸는가(ExpirySweeper의 회차 보고, 지표 seat_expiry_ticks_total{outcome}의 값).
 * - DRAINED: 1단계 읽기가 100석보다 적었다(빈 읽기 포함). 지난 좌석을 다 돌렸다
 * - BATCH_LIMIT: EXPIRY_MAX_BATCHES_PER_TICK(20)묶음을 다 돌렸다(남은 것은 다음 틱. 반복이 켜져 있으면 다음 틱을 바로 연다, M1)
 * - NO_PROGRESS: 한 묶음에서 푼 것·고아가 모두 0이었다(앞줄이 그대로라 다시 읽어도 같다. 연장된 홀드·망가진 좌석뿐이거나 저장소 시각이 앱보다 늦은 때 등)
 * - NOT_LEASED: 다른 파드가 임대를 가졌다(그 회차를 돌지 않았다)
 * - NO_CONFIG: 좌석맵 판에 그 회차 설정이 없다(keepUntil을 못 정해 돌지 않았다. 임대 키도 쓰지 않는다, L3)
 * - NOT_READY: 만료 Lua가 NOT_READY(세대 키 없음)
 * - UNAVAILABLE: 좌석 Redis 일시 장애·메모리 부족(SeatStoreUnavailable)
 * - ERROR: 그 밖의 오류(키 전체가 망가짐·스크립트 오류 같은 버그, 모양 오류)
 * - BACKOFF: 직전 틱에서 UNAVAILABLE·ERROR였던 회차라 EXPIRY_BACKOFF_MS(5초) 동안 건너뛰었다(아무것도 부르지 않았다, M5)
 * - STOPPED: 돌던 중 stop()이 불려 남은 묶음을 돌지 않았다(L4)
 */
export type SweepOutcome = 'DRAINED' | 'BATCH_LIMIT' | 'NO_PROGRESS' | 'NOT_LEASED' | 'NO_CONFIG' | 'NOT_READY' | 'UNAVAILABLE' | 'ERROR' | 'BACKOFF' | 'STOPPED';

/** SeatExpiries.dueExpiries의 입력 */
export interface DueExpiriesInput {
  /** 회차 ID(KEY_PART 모양) */
  eventId: string;
  /** 앱의 지금(주입 Clock.now(), epoch ms). 만료 인덱스 점수가 이 값 이하인 좌석을 읽는다 */
  nowMs: number;
  /** 읽을 좌석 수의 상한(1 ~ EXPIRY_BATCH_SIZE의 정수) */
  limit: number;
}

/** 1단계에서 읽은 홀드 Hash s:{event:E}:hold:{색인}의 세 칸(만료 Lua의 기대값) */
export interface DueHold {
  holdId: string;
  /** 펜싱 토큰(Hash의 fence 칸 글 그대로. 앞 0 없는 10진 정수 글) */
  fencingToken: string;
  /** 소유 계정(Hash의 owner 칸) */
  owner: string;
}

/** 1단계에서 읽은 만료 좌석 하나 */
export interface DueExpiry {
  /** 좌석 색인(만료 인덱스 멤버) */
  index: number;
  /** 만료 인덱스 점수(epoch ms) */
  expiresAtMs: number;
  /** 홀드 Hash의 holdId·fence·owner. 세 칸이 모두 없으면(Hash가 없음, 고아 멤버) null. corrupt면 null */
  hold: DueHold | null;
  /**
   * 망가진 홀드(추천 적용 2026-11-04 M2): 세 칸 가운데 일부만 있거나, owner가 KEY_PART 모양이 아니거나, fence가 만료 Lua가 받지 못하는 모양이거나(A2,
   * isExpirableFence), 홀드 키의 형이 틀려 읽기가 WRONGTYPE이다(B1). 이때만 true를 싣고(정상 좌석에는 칸이 없다)
   * hold는 null이다. 만료 반복은 이 좌석을 만료 Lua에 넘기지 않고 corrupt로 센다(다음 틱에 다시 본다)
   */
  corrupt?: true;
}

/** 만료 Lua에 넘기는 좌석 하나 */
export interface ExpireSeat {
  /** 좌석 색인 */
  index: number;
  /** 1단계에서 읽은 홀드(기대값). 1단계에서 고아였으면 null */
  expected: DueHold | null;
  /**
   * 좌석맵 판의 그 색인 좌석(SeatMapIndex.byIndex). EXPIRED 사건의 seatId·tierId·sectionId와 secver·샤드 Pub/Sub의 구역 색인·구역 안 거리에 쓴다.
   * 없어도 된다: 고아는 ZREM만 하고, 좌석맵 판에 없는 색인(추천 적용 2026-11-04)은 기대값이 맞으면 그대로 풀되 EXPIRED의 seatId·tierId·sectionId·
   * sectionVersion이 빈 글이고 그 좌석 몫의 secver 올리기·샤드 Pub/Sub는 없다
   */
  seat?: SeatRef;
}

/** SeatExpiries.expire의 입력 */
export interface ExpireInput {
  /** 회차 ID(KEY_PART 모양) */
  eventId: string;
  /** 회차 키의 만료 시각(epoch ms) = 판매 종료 + KEEP_AFTER_SALE_END_MS. stream·secver 수명을 이 시각으로 늘린다 */
  keepUntilMs: number;
  /** 1 ~ EXPIRY_BATCH_SIZE개, 색인이 겹치지 않는다. Lua는 이 차례로 본다 */
  seats: readonly ExpireSeat[];
}

/** 만료 Lua가 푼 홀드 하나 */
export interface ExpiredHold {
  /** 좌석 색인 */
  index: number;
  /** 푼 홀드의 펜싱 토큰(Hash의 fence를 Number로. 안전한 정수가 아니면 어댑터가 Error) */
  fencingToken: number;
}

/**
 * SeatExpiries.expire의 결과(만료 Lua가 돌려주는 값을 옮긴 것).
 * - NOT_READY: 세대 키 s:{event:E}:epoch의 epoch 칸이 없다. 아무것도 쓰지 않았다
 * - OK: nowUs = 저장소 시각(Lua TIME의 µs, 메모리는 Clock.now() × 1000). released + skipped + orphans + corrupt = seats 수.
 *   corrupt(추천 적용 2026-11-04 M2)는 망가진 좌석·계정 몫이라 건드리지 않은 좌석 수다. Lua 답에는 없고 어댑터가 seats 수 − (푼 + 건너뛴 + 고아)로 센다.
 *   expired는 푼 좌석만 seats 차례로(released개)다. 고아·건너뛴·망가진 좌석은 싣지 않는다
 */
export type ExpireResult =
  | { kind: 'OK'; nowUs: number; released: number; skipped: number; orphans: number; corrupt: number; expired: ExpiredHold[] }
  | { kind: 'NOT_READY' };

/** 회차 ID 모양 검사(키 이름의 해시 태그에 들어간다) */
function assertEventId(eventId: unknown): void {
  if (typeof eventId !== 'string' || !KEY_PART.test(eventId)) throw new RangeError(`회차 ID 모양이 키 조각이 아니다: ${String(eventId)}`);
}

/**
 * SeatExpiries.dueExpiries 입력의 모양 검사(메모리·Redis 구현이 함께 쓴다).
 * @throws RangeError eventId가 KEY_PART가 아님, limit이 1 ~ EXPIRY_BATCH_SIZE의 정수가 아님
 */
export function assertDueExpiriesInput(i: DueExpiriesInput): void {
  assertEventId(i.eventId);
  if (!Number.isInteger(i.limit) || i.limit < 1 || i.limit > EXPIRY_BATCH_SIZE) throw new RangeError(`limit은 1 ~ ${EXPIRY_BATCH_SIZE}의 정수다: ${i.limit}`);
}

/**
 * SeatExpiries.expire 입력의 모양 검사(메모리·Redis 구현이 함께 쓴다).
 * @throws RangeError eventId가 KEY_PART가 아님, seats가 비었거나 EXPIRY_BATCH_SIZE개를 넘음, 색인이 0 이상의 정수가 아니거나 겹침,
 *   expected.owner가 KEY_PART가 아님
 */
export function assertExpireInput(i: ExpireInput): void {
  assertEventId(i.eventId);
  if (i.seats.length < 1 || i.seats.length > EXPIRY_BATCH_SIZE) throw new RangeError(`만료 좌석 수는 1 ~ ${EXPIRY_BATCH_SIZE}다: ${i.seats.length}`);
  const seen = new Set<number>();
  for (const s of i.seats) {
    if (!Number.isSafeInteger(s.index) || s.index < 0) throw new RangeError(`좌석 색인은 0 이상의 정수다: ${s.index}`);
    if (seen.has(s.index)) throw new RangeError(`좌석 색인이 겹친다: ${s.index}`);
    seen.add(s.index);
    if (s.expected && (typeof s.expected.owner !== 'string' || !KEY_PART.test(s.expected.owner))) throw new RangeError(`좌석 ${s.index}의 소유 계정 모양이 키 조각이 아니다`);
  }
}

/**
 * SweepLeases.acquire 입력의 모양 검사(메모리·Redis 구현이 함께 쓴다).
 * @throws RangeError eventId·owner가 KEY_PART가 아님, ttlMs가 1 이상의 안전한 정수가 아님
 */
export function assertSweepLeaseArgs(eventId: string, owner: string, ttlMs: number): void {
  assertEventId(eventId);
  if (typeof owner !== 'string' || !KEY_PART.test(owner)) throw new RangeError('파드 ID 모양이 키 조각이 아니다');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new RangeError(`임대 수명은 1 이상의 안전한 정수(ms)다: ${ttlMs}`);
}
