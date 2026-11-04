// inventory 컨텍스트의 포트: 좌석 저장소(좌석 Redis), 만료 저장소, 만료 임대, 좌석맵 판, 구매 세션, 홀드 시도 기록, 좌석 Lua 지표.
// 운영 어댑터: 좌석 저장소·만료 저장소는 RedisSeatStore, 만료 임대는 RedisSweepLeases. 좌석맵 판·구매 세션은 PRF-130 ①에서 메모리 대역뿐이고
// (실제 구매 세션 s:session은 PRF-136), 홀드 시도 기록의 Kafka·Avro 보내기는 BAS-030이다. 도메인 층이라 프레임워크·플랫폼 형을 가져오지 않는다.
import type { DueExpiriesInput, DueExpiry, ExpireInput, ExpireResult, SweepOutcome } from './expiry.js';
import type { HoldInput, HoldResult, ReplayInput, ReplayResult, SeatRef } from './hold.js';
import type { SeatLuaErrorCode, SeatLuaScript } from './lua-errors.js';

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
  acquire(eventId: string, owner: string, ttlMs: number): Promise<boolean>;
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
}

/** 지표를 버리는 구현(시험·지표를 달지 않은 조립의 기본값) */
export const noSeatSignals: SeatSignals = {
  luaError: () => undefined,
  expiryLag: () => undefined,
  expiryTick: () => undefined,
};
