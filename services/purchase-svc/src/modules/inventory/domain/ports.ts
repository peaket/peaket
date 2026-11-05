// inventory 컨텍스트의 포트: 좌석 저장소(좌석 Redis), 만료 저장소, 만료 임대, 좌석맵 판, 구매 세션, 홀드 시도 기록, 좌석 Lua 지표.
// 운영 어댑터: 좌석 저장소·만료 저장소는 RedisSeatStore, 만료 임대는 RedisSweepLeases, 구매 세션 저장소는 RedisPurchaseSessionStore(PRF-136),
// 구매 세션 읽기·플랫폼 요청 인증 포트는 StoredPurchaseSessions(PRF-136). 좌석맵 판은 PRF-130 ①에서 메모리 대역뿐이고(운영 구현은 PRF-137),
// 홀드 시도 기록의 Kafka·Avro 보내기는 BAS-030이다. 도메인 층이라 프레임워크·플랫폼 형을 가져오지 않는다.
import type { DueExpiriesInput, DueExpiry, ExpireInput, ExpireResult, SweepOutcome } from './expiry.js';
import type { HoldInput, HoldResult, ReplayInput, ReplayResult, SeatRef } from './hold.js';
import type { SeatLuaErrorCode, SeatLuaScript } from './lua-errors.js';
import type { EndedSession, OpenSessionInput, OpenSessionResult, SessionEndedEntry, SessionEndReason, SessionStartedEntry, StoredSession, SweepSessionResult } from './purchase-session.js';
import type { SectionRange } from './seat-layout.js';
import type { ReserveInput, ReserveResult, SeatSaleOrder, SeatSaleRelease } from './seat-sale.js';
import type { LedgerHoldEvent, SeatStreamEntry, StreamDropReason, TradeTopic } from './seat-event.js';
import type { PinInput, PinResult, ReleaseFailedInput, ReleaseFailedResult, RetireResult } from './pin.js';
import type { RebuildFinishInput, RebuildHold, RebuildLedgerRow, RebuildPinnedOrder, RebuildSale, RebuildSaleOrder, RebuildSeat, RebuildStep } from './rebuild.js';

/** 요청 처리 중 좌석 Redis 호출 하나의 선택값(BUILD_ORDER PRF-135, guidelines §5) */
export interface SeatCallOptions {
  /**
   * 이 호출의 마감(ms, 1 이상의 정수). HoldSeats가 min(요청의 남은 시간, SEAT_CALL_CAP_MS)을 내림한 정수(1 이상)로 준다. 없으면 플랫폼 기본(REDIS_CALL_DEADLINE_MS 100).
   * Redis 구현은 platform HotRedis의 deadlineMs로 넘긴다(넘기면 RedisDeadlineError → SeatStoreUnavailable). 메모리 구현은 보지 않는다
   */
  deadlineMs?: number;
}

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
   * 쓰기 전 지킴(추천 적용 2026-11-04, HoldResult 설명의 5와 6 사이): keepUntilMs가 저장소 시각 이하, 보유 수 값이 표준 10진 정수(isStandardInt: '0' 또는
   * 첫 자리 1~9에 18자리 이하. INCRBY가 받는 값, A1)가 아님, fence 값이 ^%d+$가 아님(SET만 하는 값이라 앞 0은 받는다), expiry·stream·secver·
   * hold:{색인}의 키 형이 틀림이면 아무것도 쓰지 않고 일시 장애가 아닌 Error(PEAKET_KEEP_UNTIL_PAST·PEAKET_CORRUPT_KEY)를 던진다.
   * 덧붙인 지킴(PRF-130 리뷰 낮음 3, PRF-135): secver의 바뀔 구역 칸 값이 있는데 표준 10진 정수(HINCRBY가 받는 값, A1)가 아니면 같은 PEAKET_CORRUPT_KEY(HoldResult 설명).
   * 토큰 넘침의 오류 글에는 PEAKET_FENCE_OVERFLOW가 있다(메모리 구현도 같다).
   *
   * 멱등 재생(IDEM_REPLAY)은 처음 응답을 그대로 준다(같은 holdId·토큰·heldAtMs·expiresAtMs). 아무것도 쓰지 않는다(보유 수·Stream·fence 그대로).
   * 멱등 기록은 잡았을 때만 적으므로 CONFLICT·REHOLD_WAIT·QUOTA_EXCEEDED 뒤 같은 키로 다시 부르면 새로 시도한다. 다른 계정의 같은 키는 다른 기록이다.
   *
   * @param o 호출 마감(SeatCallOptions, PRF-135). Redis 구현만 쓴다
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애(isRedisUnavailable, reason 'unavailable'). 이때 쓰였는지는 모른다(같은 멱등 키로 다시 부르면 재생되거나 새로 잡는다).
   *   좌석 Redis 메모리 부족(platform isRedisOutOfMemory, reason 'oom', PRF-135)도 이것이다(아무것도 쓰지 않았다)
   * @throws Error 스크립트 오류 같은 버그(모르는 결과 값, 안전한 정수가 아닌 토큰, 위 쓰기 전 지킴 포함)
   */
  hold(i: HoldInput, o?: SeatCallOptions): Promise<HoldResult>;

  /**
   * 멱등 재생 읽기(추천 적용 2026-11-04). HoldSeats가 앱 쪽 거절(판매 종료 410, 좌석맵에 없는 좌석 422, 회차 설정 없음 503) 전에 부른다.
   * 같은 슬롯의 멱등 기록 s:{event:E}:idem:{account}:{key} 하나만 읽고 아무것도 쓰지 않는다.
   * @param o 호출 마감(SeatCallOptions, PRF-135). Redis 구현만 쓴다
   * @returns 같은 지문이면 처음 응답(IDEM_REPLAY, hold의 재생과 같은 값), 다른 지문이면 IDEM_REUSED, 기록이 없거나 수명(7분)이 지났으면 null.
   *   다른 계정의 같은 키는 null이다(범위가 계정 × 키)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애
   * @throws Error 기록의 처음 응답 모양이 틀렸거나 토큰이 안전한 정수가 아님
   */
  replay(i: ReplayInput, o?: SeatCallOptions): Promise<ReplayResult>;

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

export const SEAT_EXPIRIES = Symbol('purchase.SeatExpiries');
/**
 * 만료 저장소(BUILD_ORDER PRF-135, seat-hold.md §5 '만료 인덱스 관리'·'만료 및 해제 처리', 만료 Lua 계약은 adapters/expire-lua.ts).
 * SeatStore와 같은 객체가 맡는다(RedisSeatStore·MemorySeatStore가 둘 다 구현한다). SeatStore에 넣지 않은 것은 홀드만 쓰는 쪽(HoldSeats와 그 시험 대역)이
 * 만료 메서드를 갖지 않아도 되게 하려는 것이다. 메모리 구현과 Redis 구현은 같은 사례에서 같은 결과를 낸다.
 *
 * 만료는 두 단계다(앱이 읽고 Lua가 다시 확인한다): ① dueExpiries가 만료 인덱스 앞줄과 그 홀드 Hash 세 칸을 읽는다 ② 만료 반복(ExpirySweeper)이 좌석맵 판으로
 * 좌석 정보를 붙여 expire를 부르고, 만료 Lua가 ①에서 읽은 값을 기대값으로 펜싱을 다시 확인해 맞는 것만 한 번에 푼다.
 * ①과 ② 사이에 풀리고 다시 잡힌 홀드(holdId·fence가 다름)는 건드리지 않는다(ASVS 15.4.2).
 */
export interface SeatExpiries {
  /**
   * 좌석 비트맵이 있는 회차 목록 s:ctl:events(회차 태그 없는 다른 슬롯, SMEMBERS 한 번. 메모리는 MemorySeatDb.ctlEvents)를 읽는다.
   * 회차 ID 모양(KEY_PART)이 아닌 값은 거른다(해시 태그를 깨는 값이 임대·만료 키에 들어가지 않게, 추천 적용 2026-11-04 L8). 거른 값이 있으면
   * 서비스 로그 warn 한 줄({ dropped: 거른 수 })을 남긴다(값 자체는 싣지 않는다. 저장소에 로거를 넘겼을 때만).
   * @returns 회차 ID들(겹침 없음, 모두 KEY_PART 모양, 차례는 정하지 않는다. 비었으면 [])
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애·메모리 부족(읽기라 메모리 부족은 나지 않는다)
   */
  saleEvents(): Promise<string[]>;

  /**
   * 1단계: 만료 인덱스 s:{event:E}:expiry에서 점수가 nowMs 이하인 좌석을 점수 오름차순(같은 점수는 멤버 글의 바이트 순, ZRANGE 순서)으로 limit개까지 읽고
   * (ZRANGE expiry -inf nowMs BYSCORE LIMIT 0 limit WITHSCORES, 건너뛰기 0), 좌석마다 홀드 Hash s:{event:E}:hold:{색인}의 holdId·fence·owner를 읽는다
   * (HMGET, 같은 슬롯이라 함께 보낸다). 아무것도 쓰지 않는다. 세대 키는 보지 않는다(NOT_READY는 2단계에서 가른다).
   * - 결과는 읽은 차례 그대로다. 만료 인덱스가 없거나 지난 좌석이 없으면 [].
   * - 세 칸이 모두 없으면(Hash 없음) hold = null(고아 멤버).
   * - 세 칸 가운데 일부만 있거나, owner가 KEY_PART 모양이 아니거나, fence가 만료 Lua가 받지 못하는 모양(앞 0 없는 양의 10진 정수가 아니거나 2^53 − 1 초과,
   *   isExpirableFence, A2)이면 던지지 않고 그 좌석만 { index, expiresAtMs, hold: null, corrupt: true }로 싣는다
   *   (망가진 키 격리, 추천 적용 2026-11-04 M2. 같은 읽기의 다른 좌석은 그대로).
   * - 홀드 키의 형이 틀려 그 좌석의 HMGET이 WRONGTYPE이면(B1) 같은 방식으로 그 좌석만 corrupt: true다(Redis 구현만. 메모리는 키 형이 정해져 있다).
   *   다른 종류의 오류(스크립트 버그·일시 장애·메모리 부족)와 만료 인덱스 키(ZRANGE) 자체의 오류는 읽기 전체 오류라 그대로 던진다.
   * - 멤버가 앞 0 없는 0 이상의 10진 정수 글('0' 또는 첫 자리 1~9)이 아니면 Error(PEAKET_CORRUPT_KEY, expiry 키. 색인을 몰라 좌석 몫으로 가를 수 없다.
   *   '007'을 색인 7로 받으면 만료 Lua가 String(색인)으로 조회해 지우지 못하고 정상 '7'과 겹친다).
   * 메모리 구현: MemorySeatEvent.expiry(색인 → exp)에서 exp ≤ nowMs인 것을 (exp, 색인 10진 글) 오름차순으로, holds에서 세 칸.
   * @throws RangeError limit이 1 ~ EXPIRY_BATCH_SIZE의 정수가 아님, eventId가 KEY_PART가 아님(아무것도 부르지 않는다)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애
   * @throws Error 위의 망가진 멤버
   */
  dueExpiries(i: DueExpiriesInput): Promise<DueExpiry[]>;

  /**
   * 2단계: 만료 Lua 한 번(전부 한 원자 연산, 키 계약은 adapters/expire-lua.ts). 결과 꼴은 ExpireResult.
   *
   * 차례(seat-hold.md §5 '검사' 1~4, 추천 적용 2026-11-04 M2: 키 전체의 망가짐은 묶음 전체 오류, 좌석·계정 몫의 망가짐은 그 좌석만 건너뜀):
   * 1. 세대 키 s:{event:E}:epoch의 epoch 칸이 없음 → NOT_READY(아무것도 쓰지 않는다).
   * 2. 저장소 시각을 한 번만 읽는다(Lua TIME, 메모리는 Clock: nowUs = now × 1000). now = floor(nowUs / 1000)ms를 아래 모두에 쓴다.
   * 3. 쓰기 전 지킴(입력 전체로 본다):
   *    a. 묶음 전체 오류(걸리면 아무것도 쓰지 않고 일시 장애가 아닌 Error, 고아 ZREM도 하지 않는다):
   *       keepUntilMs ≤ now → PEAKET_KEEP_UNTIL_PAST. 키 전체의 형이 틀림(bitmap string, expiry zset, stream stream, secver hash. 키가 없으면 통과, L1)
   *       → PEAKET_CORRUPT_KEY {키}.
   *    b. 좌석·계정 몫의 망가짐(그 좌석만 망가짐(corrupt)으로 두고 건드리지 않는다. 나머지는 4로 간다):
   *       - 계정: quota:{owner}가 string이 아니거나 값이 표준 10진 정수(isStandardInt, INCRBY가 받는 값, A1)가 아님, rel:{owner}가 zset이 아님
   *         → 그 계정이 expected.owner인 좌석 모두
   *       - 구역: secver에서 seat가 있는 입력 좌석의 구역 칸 값이 있는데 표준 10진 정수(HINCRBY가 받는 값, A1)가 아님 → 그 구역의 좌석 모두(입력에 없는 구역 칸은 보지 않는다)
   *       - 좌석: hold:{색인}이 hash도 없음도 아님, 또는 Hash가 있는데 holdId·owner·fence·exp 가운데 하나라도 없거나 exp가 ^%d+$가 아님,
   *         또는 fence가 isExpirableFence가 아님(앞 0 없는 양의 10진 정수가 아니거나 2^53 − 1 초과, A2. 모양만 보고 풀면 푼 뒤 앱의 토큰 변환이 던진다)
   *       단, 홀드 Hash가 없는 좌석은 계정·구역 몫과 관계없이 4의 고아·건너뜀으로 간다(ZREM만 하므로 망가진 계정·구역 키를 건드리지 않는다).
   *    (메모리 구현은 키 형이 정해져 있어 형 검사는 없고, 값 검사는 isStandardInt(String(값))인지, fence는 isExpirableFence(String(값))인지, Hash 칸은 undefined인지 본다)
   * 4. 망가지지 않은 좌석마다(seats 차례) 펜싱 확인으로 셋 가운데 하나로 가른다(아직 쓰지 않는다):
   *    - 푼다(released): 홀드 Hash가 있고, 그 holdId·fence·owner가 expected와 모두 같고, Hash의 exp ≤ now이고, 만료 인덱스에 그 멤버가 있다(ZMSCORE).
   *    - 고아(orphans): 홀드 Hash가 없는데 만료 인덱스에 그 멤버가 있다(expected와 관계없이). ZREM만 한다(비트·보유 수·rel·Stream·Pub/Sub 그대로).
   *    - 건너뜀(skipped): 그 밖 모두(expected가 null인데 Hash가 생김, holdId·fence·owner가 다름(읽은 뒤 풀리고 다시 잡힌 홀드), exp > now(연장됨),
   *      Hash도 멤버도 없음(이미 풀림)). 아무것도 바꾸지 않는다.
   * 5. 쓰기(푼 좌석만, released > 0일 때. 고아 ZREM은 released와 관계없이):
   *    - 좌석마다: 비트 0, 홀드 Hash 지움, 만료 인덱스에서 뺌(Lua는 BITFIELD SET u1 한 번·DEL 한 번·ZREM 한 번에 몰아 부른다, M4).
   *    - 계정마다(푼 좌석 k개): 보유 수 −k. 결과가 0 이하면 키를 지우고(DEL), 아니면 SET … KEEPTTL(수명 그대로).
   *    - 계정마다 방금 놓은 좌석 rel:{owner}(REHOLD_WAIT_MS 30초): ZREMRANGEBYSCORE -inf now(지난 멤버를 먼저 지움) → 푼 좌석들을 ZADD 한 번(점수 now + 30000)
   *      → PEXPIRE 30000(키 수명은 마지막으로 넣은 때부터 30초. 메모리는 expireAt[rel 키] = now + 30000).
   *    - 바뀐 구역마다(seat가 있는 푼 좌석 차례로 처음 나온 차례) secver 그 구역 색인 칸 += 1(HINCRBY).
   *    - 좌석마다 Stream에 EXPIRED 한 건(MAXLEN 없음): type 'EXPIRED', seatIdx, seatId·tierId·sectionId(seat에서), holdId, holdKind(Hash kind),
   *      purchaseSessionId(Hash psid), accountId(Hash owner), fencingToken(그 홀드의 토큰 = Hash fence 글. 새 토큰을 내지 않는다, S-T5),
   *      sectionVersion(올린 뒤 번호), seatEpoch, occurredAtMs(= now), expiresAtMs(Hash exp). 값은 모두 글이다.
   *    - 바뀐 구역마다 샤드 Pub/Sub 한 건: 채널 s:{event:E}:sec:{구역 색인}, 글 '1 {seatEpoch} {구역 색인} {구역 번호} {now} {seatOffset}:0 …'
   *      (그 구역의 푼 좌석을 seats 차례로, 상태 0 = SEAT_STATE_AVAILABLE).
   *    - seat가 없는 푼 좌석(좌석맵 판에 없는 색인, 추천 적용 2026-11-04)은 멈추지 않고 그대로 푼다: EXPIRED의 seatId·tierId·sectionId·sectionVersion이
   *      빈 글이고, 그 좌석 몫의 secver 올리기·샤드 Pub/Sub는 없다(비트·Hash·만료 인덱스·보유 수·rel은 다른 좌석과 같다).
   *    - stream·secver 수명: 홀드 Lua와 같은 규칙으로 keepUntilMs까지 늘린다(PEXPIRETIME < keepUntil이면 PEXPIREAT). 다른 키의 수명은 바꾸지 않는다.
   *    - fence·세대 키·멱등 기록·구매 세션의 홀드 목록(s:session)·ordered·paused·망가진 좌석과 그 계정·구역 키는 건드리지 않는다.
   * 6. 결과: { kind: 'OK', nowUs, released, skipped, orphans, corrupt, expired: 푼 좌석의 (색인, 토큰) seats 차례 }.
   *    corrupt = seats 수 − (released + skipped + orphans)(Lua 답에는 없고 어댑터가 센다). 푼 좌석이 0이어도(고아만·건너뜀만·망가짐만) OK다.
   *
   * @throws RangeError seats가 비었거나 EXPIRY_BATCH_SIZE개를 넘음, 색인이 0 이상의 정수가 아니거나 겹침, expected.owner가 KEY_PART가 아님,
   *   eventId가 KEY_PART가 아님(아무것도 부르지 않는다)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애(reason 'unavailable', 쓰였는지 모른다) 또는 메모리 부족(reason 'oom', 아무것도 쓰지 않았다.
   *   allow-oom을 쓰지 않으므로 메모리 부족이면 만료도 거절된다, RB-06)
   * @throws Error 3a의 묶음 전체 오류(PEAKET_KEEP_UNTIL_PAST·PEAKET_CORRUPT_KEY), 모르는 결과 값, 안전한 정수가 아닌 토큰, 푼·건너뛴·고아 수의 합이 seats 수보다 큼
   */
  expire(i: ExpireInput): Promise<ExpireResult>;
}

export const SWEEP_LEASES = Symbol('purchase.SweepLeases');
/**
 * 회차별 만료 임대 s:{event:E}:sweep(문자열, 값 = 잡은 파드 ID, 회차 슬롯, docs/data.md §3, BUILD_ORDER PRF-135). 모든 파드가 1초마다 회차마다 부르고,
 * 잡은 파드만 그 회차의 만료를 돌린다. 한 번에 끝나는 작은 Lua 하나로 잡는다(추천 적용 2026-11-04 L2, adapters/expire-lua.ts SWEEP_LEASE_LUA):
 * 읽은 뒤 키가 사라지고 다른 파드가 잡아도 남의 임대를 늘리지 않는다.
 */
export interface SweepLeases {
  /**
   * 임대를 잡거나 늘린다. 시각은 저장소 시각(Redis, 메모리는 주입 Clock)이다. 한 원자 연산:
   * - 값이 owner이면: 수명을 지금부터 ttlMs로 다시 건다(PEXPIRE ttlMs) → true
   * - 키가 없거나 수명이 다했으면: 값 owner로 ttlMs 수명을 걸어 만든다(SET NX PX ttlMs) → true
   * - 다른 owner이면: 아무것도 바꾸지 않는다 → false
   * 놓는 메서드는 없다(멈춘 파드의 임대는 ttlMs 뒤 저절로 풀린다).
   * @param eventId 회차 ID(KEY_PART 모양)
   * @param owner 파드 ID(KEY_PART 모양, podIdFrom)
   * @param ttlMs 수명(1 이상의 안전한 정수, 보통 SWEEP_LEASE_TTL_MS)
   * @throws RangeError 위 모양이 아님(아무것도 부르지 않는다)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애(reason 'unavailable') 또는 메모리 부족(`#!lua` 스크립트가 시작 전에 거절됨, reason 'oom')
   * @throws Error 모르는 답·스크립트 오류
   */
  acquire(eventId: string, owner: string, ttlMs: number, lane?: SweepLane): Promise<boolean>;
}

/** 임대 줄: 'expiry'(기본, 만료 반복 s:{event:E}:sweep)와 'session'(구매 세션 정리 반복 s:{event:E}:sesweep, BUILD_ORDER PRF-138) */
export type SweepLane = 'expiry' | 'session';

export const SEAT_SNAPSHOTS = Symbol('purchase.SeatSnapshots');
/** 스냅샷 읽기 입력(SeatSnapshots.read) */
export interface SnapshotReadInput {
  eventId: string;
  /** 읽을 첫 비트(좌석 색인). 바이트 범위는 floor(firstBit / 8) ~ floor((firstBit + bitCount − 1) / 8)이다 */
  firstBit: number;
  /** 읽을 비트 수(1 이상) */
  bitCount: number;
  /** 구역 일련번호를 읽을 구역 색인들(0 ~ 65535, 겹치지 않음, 1개 이상) */
  sectionIndexes: readonly number[];
}
/** 스냅샷 읽기 결과 */
export type SnapshotReadResult =
  /** 세대 키의 epoch 칸이 없다(좌석 저장소가 준비되지 않음). 아무것도 읽지 않았다 */
  | { kind: 'NOT_READY' }
  | {
      kind: 'OK';
      /** 회차 세대(0 ~ 2^32 − 1) */
      seatEpoch: number;
      /** 비트맵 바이트들: 첫 바이트가 비트맵의 floor(firstBit / 8)번째 바이트이고, 마지막 바이트까지 길이는 항상 (끝 바이트 − 첫 바이트 + 1)이다. 비트맵이 짧거나 없으면 모자란 바이트는 0으로 채운다 */
      bytes: Buffer;
      /** 구역 일련번호들(sectionIndexes와 같은 차례, 칸이 없으면 0, 0 ~ 2^32 − 1) */
      sectionVersions: readonly number[];
    };

/**
 * 좌석 스냅샷 읽기 포트(BUILD_ORDER PRF-137, docs/features/seat-hold.md §2 '스냅샷 읽기 Lua', adapters/snapshot-lua.ts의 계약).
 * SeatStore와 같은 객체가 맡는다(RedisSeatStore·MemorySeatStore가 둘 다 구현한다). 두 구현은 같은 사례에서 같은 결과를 낸다.
 */
export interface SeatSnapshots {
  /**
   * 세대 키·비트맵 바이트·구역 일련번호를 한 원자 연산으로 읽는다(Redis는 쓰기 없는 Lua 한 번). 아무것도 쓰지 않는다.
   * @throws RangeError eventId가 KEY_PART가 아님, firstBit·bitCount·sectionIndexes가 위 범위가 아님(아무것도 부르지 않는다)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애
   * @throws Error 세대·구역 일련번호가 u32 이하의 표준 10진 정수가 아님(PEAKET_CORRUPT_KEY), 모르는 결과 값
   */
  read(i: SnapshotReadInput, o?: SeatCallOptions): Promise<SnapshotReadResult>;
}

export const SEAT_MAP_SECTIONS = Symbol('purchase.SeatMapSections');
/** 회차 판의 구역 비트맵 범위(스냅샷 API가 구역 수 검사와 구역 하나 읽기에 쓴다). SeatMap과 같은 객체가 맡는다 */
export interface SeatMapSections {
  /** 구역(구역 색인 오름차순, seatIndexRange가 있는 구역만). 그 회차의 판이 없으면 undefined */
  sections(eventId: string): Promise<readonly SectionRange[] | undefined>;
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
  /**
   * 등급 ID → 가격(원, 0 이상 정수). 판 파일의 선택 칸 tierPrices({등급 ID: 원})이고 없으면 이 칸도 없다(주문 생성이 그 등급을 가격 없음 500으로 본다,
   * docs/features/payment.md §2 '주문 생성의 첫 구현' 금액, BUILD_ORDER PRF-161). 해석은 seat-layout.ts parseTierPrices다
   */
  tierPrices?: Readonly<Record<string, number>>;
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

/**
 * 좌석맵 판의 '색인 → 좌석'(BUILD_ORDER PRF-135, 만료 반복이 EXPIRED 사건·델타에 좌석 정보를 붙일 때 쓴다).
 * SeatMap과 같은 객체가 맡는다(MemorySeatMap이 둘 다 구현한다). SeatMap에 넣지 않은 것은 홀드만 쓰는 쪽의 대역이 이 메서드를 갖지 않아도 되게 하려는 것이다
 */
export interface SeatMapIndex {
  /**
   * 색인들을 지금 판의 좌석으로 바꾼다. 결과는 입력과 같은 길이·같은 차례이고, 그 판에 없는 색인(0 ~ seatCount − 1 밖, 판에 좌석이 없는 자리)과
   * 넣지 않은 회차는 그 자리가 undefined다. resolve와 달리 판매 제외석도 좌석을 준다(잡힌 뒤 판이 바뀌어 제외된 좌석도 풀어야 하므로).
   * 같은 색인이 두 번 오면 두 자리 모두 같은 좌석이다. 돌려주는 SeatRef에 판매 제외 표시는 싣지 않는다. 던지지 않는다
   */
  byIndex(eventId: string, indexes: readonly number[]): Promise<(SeatRef | undefined)[]>;
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
 * 함께 맡는다(같은 세션을 보게, adapters/memory-purchase-sessions.ts의 PurchaseSessionAccess). 운영 구현은 StoredPurchaseSessions(PRF-136), 시험 대역은 MemoryPurchaseSessions다
 */
export interface PurchaseSessions {
  /** 구매 세션 상태. 없거나 끝났으면 undefined */
  get(sessionId: string): Promise<PurchaseSessionInfo | undefined>;
}

export const PURCHASE_SESSION_STORE = Symbol('purchase.PurchaseSessionStore');
/**
 * 구매 세션 저장소(BUILD_ORDER PRF-136, docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', docs/data.md §3 s:jti·s:session, Lua 계약은 adapters/purchase-session-lua.ts).
 * 구매 세션 ID는 입장 토큰의 jti다. 재사용 차단 표지 s:jti:{jti}와 세션 상태 s:session:{jti}는 해시 태그가 같아 한 슬롯이고, 열기·일련번호 올리기는 각각 Lua 한 번이다.
 * 시각 판단은 모두 저장소 시각(Redis TIME, 메모리 구현은 주입 Clock)이다. 메모리 구현과 Redis 구현은 같은 사례에서 같은 결과를 낸다(test/purchase-session-cases.ts).
 */
export interface PurchaseSessionStore {
  /**
   * 구매 세션을 연다(한 원자 연산). 결과의 뜻과 차례는 OpenSessionResult의 설명이다: 최대 체류 지남(TOKEN_EXPIRED) → 표지가 있으면 세션 상태를 견줘
   * REPLAY·MISMATCH·ENDED → 표지가 없으면 첫 사용 기한(FIRST_USE_EXPIRED) → 세션 상태(수명 = 최대 체류 + 60초, 칸은 docs/data.md §3)와 표지(값 = 연 시각,
   * 수명 = reissueUntilMs + 60초)를 함께 만든다. 형이 틀린 세션 키에는 아무것도 쓰지 않고 오류를 던진다(표지만 남기지 않는다).
   * @throws RangeError 입력 모양이 틀림(assertOpenInput. 아무것도 부르지 않는다)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애(reason 'unavailable', 쓰였는지 모른다. 같은 입력으로 다시 부르면 REPLAY나 CREATED다) 또는 메모리 부족(reason 'oom', 아무것도 쓰지 않았다)
   * @throws Error 스크립트 오류·모르는 결과 값
   */
  open(i: OpenSessionInput): Promise<OpenSessionResult>;

  /**
   * 세션 상태를 읽는다(시간으로 거르지 않는다: 최대 체류가 지났어도 키가 있으면 준다. 거르는 것은 부르는 쪽이다). 없으면 undefined.
   * @throws RangeError jti가 키 조각 모양이 아님
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애
   * @throws Error 칸이 망가졌음(모르는 모양)
   */
  read(jti: string): Promise<StoredSession | undefined>;

  /**
   * 일련번호를 올린다(한 원자 연산): 세션이 있고 최대 체류 앞이며 seq가 마지막 번호보다 클 때만 seq를 쓰고 유휴 시한을 지금 + 5분으로 다시 쓰고 true.
   * 그 밖(세션 없음, 최대 체류 지남, seq가 마지막 번호 이하)은 아무것도 바꾸지 않고 false.
   * @throws RangeError jti가 키 조각 모양이 아니거나 seq가 1 이상의 안전한 정수가 아님
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애(쓰였는지 모른다)
   * @throws Error seq·max 칸이 망가졌음(PEAKET_CORRUPT_KEY)
   */
  advance(jti: string, seq: number): Promise<boolean>;

  /**
   * SESSION_STARTED를 더했다는 표시를 세션 상태에 쓴다(한 원자 연산, sev 칸). 세션이 있으면 true, 없으면 아무것도 만들지 않고 false.
   * 열기가 REPLAY로 돌려주는 needsStarted가 이 표시를 본다: 표시가 없고 연 지 SESSION_STARTED_GRACE_MS(1초 [가정])가 지났으면 응답을 잃은 재시도(REPLAY)가 시작 사건을 한 번 더 더한다.
   * @throws RangeError jti가 키 조각 모양이 아님
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애·메모리 부족
   */
  markStarted(jti: string): Promise<boolean>;

  /**
   * 새로 잡은 홀드를 구매 세션 상태에 기록한다(작은 Lua 한 번, BUILD_ORDER PRF-137): `h:{holdId}` 칸 = 좌석 ID들을 쉼표로 이은 글을 더하고, 첫 홀드 표시 `fh`를 처음 한 번만 쓴다.
   * 세션이 없으면 아무것도 만들지 않는다.
   * @returns 세션이 있으면 이번이 이 세션의 첫 홀드인지(참·거짓), 세션이 없으면 null
   * @param o 호출 마감(SeatCallOptions). Redis 구현만 쓴다(넘기면 HotRedis의 deadlineMs, 없으면 플랫폼 기본)
   * @throws RangeError jti·holdId가 키 조각 모양이 아니거나 seatIds가 비었거나 좌석 ID 모양이 아님(아무것도 부르지 않는다)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애·메모리 부족(마감 초과 포함)
   */
  recordHold(jti: string, holdId: string, seatIds: readonly string[], o?: SeatCallOptions): Promise<boolean | null>;

  /**
   * 구매 세션을 끝낸다(BUILD_ORDER PRF-138, 한 원자 연산): 세션 상태 s:session:{jti}를 지우고(재사용 차단 표지는 남긴다) 그 세션의 회차 ID·여정 ID를 돌려준다.
   * 세션이 없으면 아무것도 만들지 않고 null이다(두 번 불러도 한 번만 끝난다). Active·Paying 모두 끝낸다. 끝낸 뒤 일련번호 올리기는 거짓이다.
   * @throws RangeError jti가 키 조각 모양이 아님
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애·메모리 부족
   */
  end(jti: string, o?: SeatCallOptions): Promise<EndedSession | null>;

  /**
   * 정리 점검(한 원자 연산): 세션 상태가 없으면 GONE, 지금 ≥ 최대 체류면 지우고 MAX_STAY로 ENDED, Paying이면 LIVE(다음 점검 = min(최대 체류, 지금 + 유휴 5분): 결제 실패로 Active에 돌아와도 유휴 정리가 밀리지 않게 5분마다 다시 본다),
   * 지금 ≥ 유휴 시한이면 지우고 IDLE로 ENDED, 아니면 LIVE(다음 점검 = min(최대 체류, 유휴 시한)). LIVE는 아무것도 바꾸지 않는다.
   * @throws RangeError jti가 키 조각 모양이 아님
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애·메모리 부족
   * @throws Error 세션 상태의 max·idle 칸이 망가짐(PEAKET_CORRUPT_KEY)
   */
  sweep(jti: string, o?: SeatCallOptions): Promise<SweepSessionResult>;

  /**
   * Paying 표시를 쓴다(한 원자 연산, T5·T8): paying true면 `pay` 칸을 '1'로 쓰고, false면 칸을 지우고 유휴 시한을 지금 + 5분으로 다시 쓴다.
   * 세션이 있으면 true, 없으면 아무것도 만들지 않고 false.
   * @throws RangeError jti가 키 조각 모양이 아님
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애·메모리 부족
   */
  setPaying(jti: string, paying: boolean, o?: SeatCallOptions): Promise<boolean>;
}

export const SESSION_ENDED_LOG = Symbol('purchase.SessionEndedLog');
/** SESSION_ENDED Stream 항목을 더하고 정리 색인에서 그 세션을 뺀다(docs/data.md §3 s:{event:E}:stream·sessions). 세션 키와 슬롯이 달라 끝내는 연산과 따로 부른다 */
export interface SessionEndedLog {
  /**
   * 그 회차 Stream에 항목 하나를 더하고(MAXLEN 없음) s:{event:E}:sessions에서 그 세션을 빼고(ZREM), 스트림 수명이 없거나 이르면 늘린다(시작 사건과 같은 규칙).
   * @throws RangeError 항목 모양이 틀림(assertEndedEntry)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애(더했는지 모른다)
   */
  appendEnded(e: SessionEndedEntry, o?: SeatCallOptions): Promise<void>;
}

export const SESSION_INDEX = Symbol('purchase.SessionIndex');
/** 구매 세션 정리 색인 s:{event:E}:sessions(정렬 집합, 멤버 jti, 점수 = 다음에 볼 시각 ms) */
export interface SessionIndex {
  /** 점수가 nowMs 이하인 멤버를 점수 오름차순(같은 점수는 멤버 글 순서)으로 limit개까지 읽는다. 아무것도 쓰지 않는다. 없으면 [] (limit은 1 이상의 정수) */
  due(eventId: string, nowMs: number, limit: number, o?: SeatCallOptions): Promise<string[]>;
  /** 멤버가 있을 때만 점수를 atMs로 바꾼다(ZADD XX). 없으면 아무것도 만들지 않는다(끝난 세션을 되살리지 않는다). eventId·jti가 KEY_PART가 아니거나 atMs가 0 이상의 안전한 정수가 아니면 RangeError */
  requeue(eventId: string, jti: string, atMs: number, o?: SeatCallOptions): Promise<void>;
  /** 멤버를 뺀다(ZREM). 없으면 아무 일도 없다. eventId·jti가 KEY_PART가 아니면 RangeError */
  drop(eventId: string, jti: string, o?: SeatCallOptions): Promise<void>;
}

export const SESSION_HOLDS = Symbol('purchase.SessionHolds');
/** 새로 잡은 홀드를 구매 세션 상태에 기록하는 포트(PurchaseSessionStore.recordHold의 부분. HoldSeats가 쓴다) */
export type SessionHolds = Pick<PurchaseSessionStore, 'recordHold'>;

export const SESSION_STARTED_LOG = Symbol('purchase.SessionStartedLog');
/** SESSION_STARTED Stream 항목을 더한다(docs/data.md §3 s:{event:E}:stream). 세션 키와 슬롯이 달라 열기와 따로 부른다 */
export interface SessionStartedLog {
  /**
   * 그 회차 Stream에 항목 하나를 더하고, 스트림 수명이 없거나 최대 체류 + 1일보다 이르면 그 시각까지 늘린다(더 늦은 수명은 둔다).
   * @throws RangeError 항목 모양이 틀림(assertStartedEntry)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애(더했는지 모른다)
   */
  appendStarted(e: SessionStartedEntry): Promise<void>;
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
  /** HELD일 때만, 구매 세션 상태에 홀드를 기록한 결과가 있을 때만: 이번 홀드가 이 구매 세션의 첫 홀드인가(PurchaseSessionStore.recordHold의 결과) */
  firstHeldInSession?: boolean;
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

export const SEAT_SIGNALS = Symbol('purchase.SeatSignals');
/**
 * 좌석 Lua 지표(BUILD_ORDER PRF-135 'PRF-130 리뷰 낮음 4', 경보 행은 docs/observability.md). 운영은 adapters/prom-seat-signals.ts의
 * seat_lua_errors_total{script,code}(카운터)다. 부른 쪽을 막거나 던지지 않는다
 */
export interface SeatSignals {
  /** seat_lua_errors_total{script, code}를 1 올린다 */
  luaError(script: SeatLuaScript, code: SeatLuaErrorCode): void;
  /**
   * 게이지 seat_expiry_lag_seconds를 seconds로 둔다(추천 적용 2026-11-04 M1): 이 파드가 이번 틱에 돈 회차 가운데 지금 − 가장 오래된 지난 점수(초)의 최댓값.
   * 밀린 것이 없으면 0. 이름표 없음. 선택 메서드다(없는 구현은 버린다)
   */
  expiryLag?(seconds: number): void;
  /** 카운터 seat_expiry_ticks_total{outcome}을 1 올린다: 회차의 틱 결과마다 하나(M1). 선택 메서드다 */
  expiryTick?(outcome: SweepOutcome): void;
  /** 카운터 purchase_sessions_ended_total{reason}를 1 올린다: 구매 세션을 끝낼 때마다 하나(BUILD_ORDER PRF-138). 선택 메서드다 */
  sessionEnded?(reason: SessionEndReason): void;
  /** 카운터 seat_hold_deferred_total{reason}을 1 올린다: 홀드 요청을 503으로 미룰 때마다(BUILD_ORDER PRF-143, ADR-0121). 선택 메서드다 */
  holdDeferred?(reason: 'not_ready' | 'store_unavailable'): void;
}

/** 지표를 버리는 구현(시험·지표를 달지 않은 조립의 기본값) */
export const noSeatSignals: SeatSignals = {
  luaError: () => undefined,
  expiryLag: () => undefined,
  expiryTick: () => undefined,
};

export const SEAT_SALES = Symbol('purchase.SeatSales');
/**
 * 판매 확정(Hard Sale) 저장소(BUILD_ORDER PRF-140 ①, docs/features/seat-hold.md §6 'Hard Sale 저장소의 첫 구현', docs/data.md §2 seat_sale·purchase_quota).
 * 운영 어댑터는 DrizzleSeatSales(purchase DB)다. 결제 접수 Saga(PRF-160)가 부른다. 모두 트랜잭션 하나이고, 잠그는 순서는 한도 행(purchase_quota) → 좌석 행이다.
 * 같은 호출을 두 번 해도 두 번째는 0행을 바꾼다(멱등). purchase DB가 늦거나 끊기면 던진다(좌석을 잡았다고 답하지 않는다).
 */
export interface SeatSales {
  /**
   * 결제 접수 예약: 한도 행을 조건부로 올리고(used + 좌석 수 <= limit) 좌석을 정렬 순서로 PENDING 삽입한다. 한 좌석이라도 활성 판매 행이 있으면 모두 되돌린다.
   * @throws RangeError 입력 모양이 틀림(좌석 ID가 소문자 UUID가 아님·중복·0개나 11개 이상, 한도가 양의 정수가 아님). 아무것도 부르지 않는다
   * @throws Error DB 오류(연결·시간 초과·풀 대기 초과 429 server-busy 포함). 아무것도 남기지 않았다
   */
  reserve(input: ReserveInput): Promise<ReserveResult>;
  /** 승인 성공: 그 주문의 PENDING 좌석 행을 SOLD로 바꾼다(pending_until을 비운다). 바꾼 행 수. PENDING이 없으면 0 */
  markSold(order: SeatSaleOrder): Promise<number>;
  /** 승인 실패·기한 초과: 그 주문의 PENDING 행을 지우고 한도 행의 used를 지운 행 수만큼 줄인다(0 밑으로 내려가지 않는다). 지운 행 수 */
  releasePending(release: SeatSaleRelease): Promise<number>;
  /** 취소·환불: 그 주문의 SOLD 행을 RETURNED로 바꾸고 used를 바꾼 행 수만큼 줄인다. 바꾼 행 수 */
  returnSold(release: SeatSaleRelease): Promise<number>;
}

/**
 * 좌석 Redis Stream 읽기(BUILD_ORDER PRF-141, docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현'). 운영 구현은 RedisSeatStreamSource다.
 * 소비자 그룹 stream-relay, 소비자 이름 relay 하나(리더 하나가 읽는다). 시험 대역은 시험이 만든다
 */
export interface SeatStreamSource {
  /** 좌석 비트맵이 있는 회차 목록(s:ctl:events) */
  events(): Promise<string[]>;
  /**
   * 그 회차 Stream에서 확인받지 못한 항목을 먼저, 없으면 새 항목을 count개까지 Stream ID 순으로 읽는다. 처음 보는 Stream이면 소비자 그룹을 만든다.
   * Stream이 없으면 빈 배열(키를 만들지 않는다)
   */
  read(eventId: string, count: number): Promise<SeatStreamEntry[]>;
  /** Kafka 확인을 받은 항목을 XACK하고 XTRIM MINID로 지운다 */
  ack(eventId: string, ids: string[]): Promise<void>;
}

/** Kafka로 보낼 레코드 하나 */
export interface TradeRecord {
  topic: TradeTopic;
  key: string;
  value: Buffer;
  headers: Record<string, string>;
}

/** 거래 토픽 보내기. 레코드는 준 차례대로 보내고 모두 확인받아야 끝난다. 실패·시간 초과면 던진다(일부만 나갔을 수 있다) */
export interface TradeEventPublisher {
  publish(records: TradeRecord[]): Promise<void>;
}

/** 사건 값 부호기. Avro 인코더(BAS-030)가 오기 전에는 JSON 대역(jsonTradeEventCodec)이다 */
export interface TradeEventCodec {
  encode(topic: TradeTopic, message: object): Buffer;
}

/** 좌석 Stream 릴레이 지표(seat_stream_relay_*, docs/observability.md). 부른 쪽을 막거나 던지지 않는다 */
export interface SeatStreamRelaySignals {
  sent(topic: TradeTopic, n: number): void;
  dropped(reason: StreamDropReason): void;
  failed(stage: 'read' | 'publish' | 'ack'): void;
}

/** 홀드 원장(seat_hold) 쓰기. 운영 구현은 DrizzleSeatHoldLedger다. 규칙은 seat-hold.md §6 '적재 소비자' */
export interface SeatHoldLedger {
  /** 사건 하나를 트랜잭션 하나로 적용한다. 같은 사건을 다시 받으면 아무것도 바꾸지 않는다. DB 오류는 던진다 */
  apply(event: LedgerHoldEvent): Promise<void>;
}

/** 주문 생성의 홀드 확인 입력(booking OrderHoldQuery와 같은 모양, BUILD_ORDER PRF-161) */
export interface OrderHoldQuery {
  /** 구매 세션의 회차(KEY_PART 모양이 아니면 NOT_FOUND) */
  eventId: string;
  /** 구매 세션 ID(= jti, KEY_PART 모양이 아니면 NOT_FOUND) */
  purchaseSessionId: string;
  /** 요청한 계정(홀드 Hash owner와 견준다) */
  accountId: string;
  /** 본문 holdId(받은 글 그대로. KEY_PART 모양이 아니면 저장소를 부르지 않고 NOT_FOUND) */
  holdId: string;
}

/** 주문 생성의 홀드 확인 결과(booking OrderHoldCheck와 같은 모양) */
export type OrderHoldCheck =
  /** heldAtMs: 홀드 Hash heldAt(좌석마다 같다). seats: 구매 세션의 h:{holdId}에 적힌 좌석 차례, 등급·구역은 좌석맵 판(SeatMap.resolve)에서 */
  | { status: 'OK'; heldAtMs: number; seats: { seatId: string; tierId: string; sectionId: string }[] }
  /** 목록에 없음·남의 것·다른 회차·끝난 것·좌석맵 판에 없는 좌석을 가리지 않는다 */
  | { status: 'NOT_FOUND' }
  /** 좌석 Redis 일시 장애·메모리 부족, 세대 키 없음(NOT_READY), 그 회차 좌석맵 판 없음 */
  | { status: 'STORE_UNAVAILABLE' };

export const ORDER_HOLDS = Symbol('purchase.OrderHolds');
/**
 * 주문 생성의 홀드 확인(docs/features/payment.md §2 '주문 생성의 첫 구현' 홀드 확인, Lua 계약은 adapters/order-hold-lua.ts, BUILD_ORDER PRF-161).
 * 운영 구현은 RedisOrderHolds, 시험 대역은 MemoryOrderHolds다(같은 사례에서 같은 결과). booking의 OrderHolds 포트를 구조로 맞춘다.
 * 차례: ① 구매 세션 상태 s:session:{sid}의 h:{holdId} 칸(좌석 ID 쉼표 목록, jti 슬롯 HGET 한 번)이 없으면 NOT_FOUND
 * ② 좌석맵 판으로 좌석 ID → 색인·등급·구역(판이 없으면 STORE_UNAVAILABLE, 판에 없는 좌석이 있으면 NOT_FOUND)
 * ③ 회차 슬롯의 읽기 전용 Lua 한 번(ORDER_HOLD_LUA): 세대 키 없음 → STORE_UNAVAILABLE, 좌석마다 홀드 Hash의 holdId·owner·psid가 같고 kind가 FAN이며 exp > Redis TIME이면 OK(heldAt), 아니면 NOT_FOUND.
 * 아무것도 쓰지 않는다. 던지지 않는다(좌석 Redis 장애는 STORE_UNAVAILABLE, 그 밖의 버그(모르는 결과 값·망가진 칸)는 Error)
 */
export interface OrderHoldReader {
  check(q: OrderHoldQuery, o?: SeatCallOptions): Promise<OrderHoldCheck>;
}

/**
 * 결제 접수의 회차 슬롯 읽기 결과(booking SeatSlotRead와 같은 모양, BUILD_ORDER PRF-162).
 * OK의 gen은 세대 키의 gen 칸(다시 만들기 판 번호, 칸이 없으면 INITIAL_SEAT_GEN = 1)이다
 */
export type SeatSlotRead = { status: 'OK'; gen: number } | { status: 'NOT_READY' } | { status: 'PAUSED' };

/**
 * 결제 접수의 회차 슬롯 읽기(docs/features/payment.md §2 '결제 접수의 첫 구현', Lua 계약은 adapters/seat-slot-lua.ts, BUILD_ORDER PRF-162).
 * 운영 구현은 RedisSeatSlots, 시험 대역은 MemorySeatSlots다(같은 사례에서 같은 결과). booking은 InventorySeatSlots 다리로 잇는다(오류 이름 바꾸기).
 * 세대 키의 epoch 칸이 없으면 NOT_READY, ctl의 paused·allPaused·suspended 가운데 하나라도 '1'이면 PAUSED, 아니면 OK(gen).
 * 아무것도 쓰지 않는다. eventId가 KEY_PART 모양이 아니면 저장소를 부르지 않고 RangeError(booking이 주문 행의 UUID를 넘기므로 코드 오류다).
 * @throws SeatStoreUnavailable 좌석 Redis 일시 장애(platform isRedisUnavailable, guard가 바꾼 것)
 * @throws Error 'PEAKET_CORRUPT_KEY {epoch 키}'(gen 칸 형식 틀림)·WRONGTYPE·모르는 결과
 */
export interface SeatSlotReader {
  read(eventId: string, o?: SeatCallOptions): Promise<SeatSlotRead>;
}

export const SEAT_PINS = Symbol('purchase.SeatPins');
/**
 * 판매 예약 앞의 좌석 묶기와 결제 실패 해제(BUILD_ORDER PRF-142, docs/features/seat-hold.md §6 '좌석 묶기와 실패 해제의 첫 구현', Lua 계약은 adapters/pin-lua.ts).
 * 운영 구현은 RedisSeatStore, 시험 대역은 MemorySeatStore다(같은 사례에서 같은 결과). 부르는 쪽은 결제 접수 Saga(PRF-160)와 좌석 해제 사건 소비자다.
 */
export interface SeatPins {
  /**
   * @throws RangeError 입력 모양이 틀림(assertPinInput. 아무것도 부르지 않는다)
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애(쓰였는지 모른다. 같은 입력으로 다시 부르면 모두 내 홀드라 OK다) 또는 메모리 부족
   */
  pin(input: PinInput, o?: SeatCallOptions): Promise<PinResult>;
  /** @throws RangeError 입력 모양이 틀림 · SeatStoreUnavailable 좌석 Redis 일시 장애(다시 부르면 남은 것만 푼다) */
  releaseFailed(input: ReleaseFailedInput, o?: SeatCallOptions): Promise<ReleaseFailedResult>;
}

/** 회차 목록 s:ctl:events에서 회차 빼기(판매 종료 정비, BUILD_ORDER PRF-142). 정비 잡이 하루 한 번 부른다(조립은 PRF-160) */
export interface SeatEventRetire {
  /** 판매 종료 + RETIRE_AFTER_SALE_END_MS가 지났고 그 회차 Stream의 길이·확인받지 못한 항목이 0일 때만 뺀다. 시각은 저장소 시각(주입 Clock) */
  retireEvent(input: { eventId: string; saleEndMs: number }): Promise<RetireResult>;
}

/** 판매 회차 목록의 회차 하나(BUILD_ORDER PRF-164, 다시 만들기 반복이 본다) */
export interface SaleEvent {
  /** 회차 ID(KEY_PART 모양) */
  eventId: string;
  /** 판매 종료 시각(epoch ms, 좌석맵 판의 saleEndsAt = EventSeatConfig.saleEndsAtMs) */
  saleEndsAtMs: number;
}

/**
 * 다시 만들기 반복(SeatRebuildLoop)이 볼 회차 목록(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 다시 만들기 반복).
 * 운영 구현은 SeatMapEventCatalog(좌석맵 판 폴더 PEAKET_SEATMAP_DIR의 회차와 그 판의 판매 종료)다. 판매 시작 시각은 아직 모른다(회차 설정은 LCH-080).
 * 전체 유실 뒤에는 좌석 Redis의 회차 목록 s:ctl:events도 사라지므로 좌석 Redis가 아닌 곳에서 읽는다
 */
export interface SaleEventCatalog {
  /**
   * 회차들(겹침 없음). 판 파일을 읽지 못한 회차(없음·모양 틀림·입출력 오류)는 목록에 넣지 않는다(던지지 않는다).
   * @throws Error 목록 자체를 읽지 못함(폴더를 읽지 못함 등)
   */
  list(): Promise<SaleEvent[]>;
}

/**
 * 판매를 연 기록(BUILD_ORDER PRF-164 리뷰 고침 M3, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 다시 만들기 반복). 기록은 purchase DB
 * seat_rebuild의 그 회차 행이다: 판매 열기를 부르는 쪽(LCH-080)이 판매 열기 전에 판 번호 1로 넣고, 다시 만들기가 한 번이라도 돈 회차도 행이 있다.
 * 다시 만들기 반복은 기록이 있는 회차만 다시 만든다(판매 열기 전의 NOT_READY 막음을 지우지 않고, 세대 키의 node·비트맵 길이·판 번호 1을 판매 열기가 쓰게 둔다).
 * 운영 구현은 DrizzleSeatRebuildSource다
 */
export interface SeatRebuildMarks {
  /**
   * 그 회차들 가운데 기록이 있는 회차(겹친 ID는 하나로). 빈 목록이면 DB를 부르지 않고 빈 모음이다
   * @throws RangeError 회차 ID가 소문자 UUID가 아님(DB를 부르기 전) · Error purchase DB 오류
   */
  opened(eventIds: readonly string[]): Promise<ReadonlySet<string>>;
  /**
   * 기록을 넣는다(판 번호 1, 임대 없음). 이미 행이 있으면(다시 불렀거나 다시 만들기가 돌았음) 아무것도 바꾸지 않는다. 판매 열기 전에 부른다
   * @throws RangeError 회차 ID가 소문자 UUID가 아님(DB를 부르기 전) · Error purchase DB 오류
   */
  markOpened(eventId: string): Promise<void>;
}

/** 다시 만들기의 purchase DB 쪽(BUILD_ORDER PRF-143). 운영 구현은 DrizzleSeatRebuildSource다 */
export interface SeatRebuildSource {
  /** 임대를 잡으면서 판 번호를 올려 커밋한다(한 문장). 다른 파드가 임대 중이면 null. 돌려주는 값은 올린 판 번호 */
  acquire(eventId: string, holder: string): Promise<number | null>;
  /** 회차의 활성 판매(PENDING·SOLD) */
  sales(eventId: string): Promise<RebuildSale[]>;
  /** 회차의 만료 전 원장 홀드(HELD, expires_at > now()) */
  holds(eventId: string): Promise<RebuildHold[]>;
  /**
   * 활성 판매(PENDING·SOLD)가 있는 좌석·그 판매 계정의 HELD 원장 행(만료 조건 없음). 판매 좌석의 holdId·구매 세션·토큰·시각을 대조한다
   * (묶인 홀드는 사건을 내지 않아 원장 행이 HELD인 채 처음 만료 시각이 지난다, 코드 리뷰 PRF-143)
   */
  saleHolds(eventId: string): Promise<RebuildHold[]>;
  /**
   * 그 회차·그 좌석들의 원장 행 전부(상태·holdId 상관없이: 좌석·holdId·상태·토큰, BUILD_ORDER PRF-167 리뷰 고침 M2). 다시 만들기가 묶인 주문 좌석을
   * 되살릴지(그 주문 holdId의 HELD 행이 있고 더 높은 토큰의 다른 홀드 행이 없는지)와 그 펜싱 토큰을 정한다. 좌석이 0개면 DB를 부르지 않고 []
   * @throws RangeError 회차·좌석 ID가 소문자 UUID가 아님 · Error purchase DB 오류
   */
  ledgerRows(eventId: string, seatIds: readonly string[]): Promise<RebuildLedgerRow[]>;
  /**
   * 임대를 비운다(그 holder일 때만). o.setGen이면 같은 문장에서 판 번호를 그 값으로 맞춘다: 임대를 잡은 뒤 세대 키가 이미 서 있던 경우(다른 곳이 먼저 끝냄)에
   * DB 판 번호를 세대 키의 gen과 같게 둔다(docs/features/seat-hold.md §6 '회차마다 하나와 판 번호')
   */
  release(eventId: string, holder: string, o?: { setGen?: number }): Promise<void>;
}

/**
 * 다시 만들기의 주문 근거(BUILD_ORDER PRF-167, docs/features/seat-hold.md §6 '주문 기준 되살리기', K1·K3). inventory가 booking 표를 직접 읽지 않도록
 * booking이 구현하고(운영 구현은 booking DrizzleRebuildOrders) 시작 파일이 SeatRebuilder에 꽂는다. 둘 다 트랜잭션 없이 읽기만 한다
 */
export interface RebuildOrderSource {
  /**
   * 주문 ID들(활성 판매 행의 order_id) → 그 주문의 holdId·psid(purchase_order.hold_id·purchase_session_id). 그 회차의 주문만 돌려주고, 없는 주문은 뺀다.
   * 주문 ID가 0개면 DB를 부르지 않고 []다
   * @throws RangeError 회차·주문 ID가 소문자 UUID가 아님 · Error purchase DB 오류
   */
  saleOrders(eventId: string, orderIds: readonly string[]): Promise<RebuildSaleOrder[]>;
  /**
   * 그 회차의 결제를 접수했고(status ACCEPTED) 묶인(pinned_at이 있음) 주문들과 그 좌석(주문 항목 전부, 줄 번호 차례). 원장은 보지 않는다:
   * 원장 대조는 SeatRebuilder가 SeatRebuildSource.ledgerRows로 읽어 planRebuild가 한다(리뷰 고침 M2)
   * @throws RangeError 회차 ID가 소문자 UUID가 아님 · Error purchase DB 오류
   */
  pinnedOrders(eventId: string): Promise<RebuildPinnedOrder[]>;
}

/**
 * 다시 만들기의 좌석 Redis 쪽(회차 슬롯의 Lua, 계약은 adapters/rebuild-lua.ts). 운영 구현은 RedisSeatStore, 시험 대역은 MemorySeatStore.
 * 시도마다 begin(gen) → writeSeats(gen)들 → finish(gen)이고, 쓰기는 rebuild 키의 판 번호가 내 gen일 때만 한다(아니면 STALE, 앞 시도·늦은 파드의 잔여 쓰기를 막는다)
 */
export interface SeatRebuildTarget {
  /** 세대 키가 있나(있으면 다시 만들 필요가 없다) */
  isReady(eventId: string): Promise<boolean>;
  /**
   * 시도를 연다: 세대 키가 있으면 READY(그 gen), rebuild 키의 판 번호 > gen이면 STALE, 아니면 bitmap·만료 인덱스를 지우고 rebuild 키 = gen(수명 keepUntil) → OK
   */
  begin(eventId: string, gen: number, keepUntilMs: number): Promise<RebuildStep>;
  /** 좌석들을 쓴다(REBUILD_BATCH 이하). 세대 키가 이미 있으면 READY, rebuild 키 ≠ gen이면 STALE(둘 다 아무것도 쓰지 않는다) */
  writeSeats(eventId: string, seats: readonly RebuildSeat[], keepUntilMs: number, gen: number): Promise<RebuildStep>;
  /**
   * 회차 목록에 회차를 먼저 넣고(결과와 관계없이), 계정마다 보유 수를 쓰고, 펜싱 카운터를 max(fence, maxToken)로 되살린 뒤 세대 키(epoch = TIME 초, node, gen)를 마지막에 쓴다.
   * 세대 키가 이미 있으면 READY, rebuild 키 ≠ gen이면 STALE
   */
  finish(eventId: string, input: RebuildFinishInput): Promise<RebuildStep>;
  /** 장애 조치 뒤 세대 올리기: node가 다를 때만 epoch = max(epoch + 1, TIME 초). 세대 키가 없으면 NOT_READY */
  bumpEpoch(eventId: string, node: string): Promise<{ result: 'BUMPED' | 'SAME'; epoch: number } | { result: 'NOT_READY' }>;
}
