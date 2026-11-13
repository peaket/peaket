// 좌석 Redis 운영 계약을 측정 도구가 같은 규칙으로 부르게 하는 작은 순수 함수(S-T27 다시 재기, docs/features/seat-hold.md §3·§5·§8, BUILD_ORDER PRF-135).
// 정본 조립은 services/purchase-svc/src/modules/inventory/adapters/redis-seat-store.ts(RedisSeatStore)이고, Lua의 KEYS·ARGV 차례는
// hold-lua.ts·expire-lua.ts의 머리 주석이 계약이다. 조립 코드를 복사하지 않고 같은 규칙을 다시 적었다. 같은 결과를 내는지는
// loadtest/test/poc-seat.test.mjs가 운영 RedisSeatStore를 가짜 HotRedis로 불러 견준다(다르면 시험이 실패한다).
// 의존성이 없어 측정 컨테이너(bench/)와 뿌리의 node --test가 함께 읽는다.

/** 좌석 키 이름(docs/data.md §3, redis-seat-store.ts seatKeys와 같은 규칙) */
export const seatKeys = {
  ordered: (e) => `s:{event:${e}}:ordered`,
  paused: (e) => `s:{event:${e}}:paused`,
  bitmap: (e) => `s:{event:${e}}:bitmap`,
  hold: (e, index) => `s:{event:${e}}:hold:${index}`,
  expiry: (e) => `s:{event:${e}}:expiry`,
  quota: (e, account) => `s:{event:${e}}:quota:${account}`,
  stream: (e) => `s:{event:${e}}:stream`,
  idem: (e, account, key) => `s:{event:${e}}:idem:${account}:${key}`,
  epoch: (e) => `s:{event:${e}}:epoch`,
  ctl: (e) => `s:{event:${e}}:ctl`,
  rel: (e, account) => `s:{event:${e}}:rel:${account}`,
  secver: (e) => `s:{event:${e}}:secver`,
  fence: (e) => `s:{event:${e}}:fence`,
  section: (e, sectionId) => `s:{event:${e}}:sec:${sectionId}`,
  ctlEvents: () => 's:ctl:events',
  rebuild: (e) => `s:{event:${e}}:rebuild`,
  failed: (e, holdId) => `s:{event:${e}}:failed:${holdId}`,
  sweep: (e) => `s:{event:${e}}:sweep`,
  sessions: (e) => `s:{event:${e}}:sessions`,
  sessionSweep: (e) => `s:{event:${e}}:sesweep`,
  saleSweep: (e) => `s:{event:${e}}:salesweep`,
  autoCur: (e) => `s:{event:${e}}:auto_cur`,
};

/** 만료 1단계에서 한 번에 읽는 수이자 만료 Lua 한 번의 좌석 상한(domain/expiry.ts EXPIRY_BATCH_SIZE, ADR-0176 결정 3) */
export const EXPIRY_BATCH_SIZE = 100;
/** 한 틱에 회차 하나를 돌리는 묶음 수의 상한 20 [가정](domain/expiry.ts EXPIRY_MAX_BATCHES_PER_TICK) */
export const EXPIRY_MAX_BATCHES_PER_TICK = 20;
// 아래 셋은 만료 반복의 값이다. 정의는 운영 domain/expiry.ts에 있고 application/expiry-sweeper.ts가 쓴다. 여기 값은 같은 값을 두 번 정한 것이 아니라
// 컨테이너(이 폴더만 있다)에서 TS 원문을 못 읽어 옮겨 적은 것이라, 운영 값과 같은지는 loadtest/test/poc-seat.test.mjs가 운영 값과 견준다(다르면 시험이 실패한다).
/** 만료 반복 주기 1초 [가정](domain/expiry.ts EXPIRY_TICK_MS. 운영 expiry-sweeper.ts start()가 setInterval에 쓴다) */
export const EXPIRY_TICK_MS = 1000;
/** 한 틱에 동시에 돌리는 회차 수의 상한 4 [가정](domain/expiry.ts EXPIRY_CONCURRENCY. 운영 expiry-sweeper.ts tick()이 Math.min(이 값, 회차 수)개 칸으로 돈다) */
export const EXPIRY_CONCURRENCY = 4;
/** 직전 틱에서 오류가 난 회차를 쉬는 시간 5초 [가정](domain/expiry.ts EXPIRY_BACKOFF_MS. 운영 expiry-sweeper.ts #sweepEvent의 BACKOFF) */
export const EXPIRY_BACKOFF_MS = 5000;
/** 다시 잡기 대기 30초 [가정](domain/hold.ts REHOLD_WAIT_MS, ADR-0161 결정 2). 만료 Lua ARGV 1 */
export const REHOLD_WAIT_MS = 30_000;

/**
 * 홀드 Lua 한 번의 KEYS·ARGV(hold-lua.ts 계약, RedisSeatStore.hold와 같은 차례).
 * 운영은 ARGV 6에 HOLD_TTL_MS(7분)를 넣는다. 측정은 홀드가 끝없이 쌓이지 않게 ttlMs를 짧게 준다(ADR-0176 결정 3: 큰 회차 5초·중형 3초).
 * @param {{ eventId: string, accountId: string, purchaseSessionId: string, holdId: string, idempotencyKey: string, fingerprint: string,
 *   seats: readonly { seatId: string, index: number, sectionId: string, sectionIndex: number, seatOffset: number, tierId: string }[],
 *   limit: number, keepUntilMs: number, ttlMs: number }} i
 * @returns {{ keys: string[], args: string[] }}
 */
export function holdCall(i) {
  const e = i.eventId;
  const a = i.accountId;
  return {
    keys: [
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.quota(e, a),
      seatKeys.stream(e),
      seatKeys.idem(e, a, i.idempotencyKey),
      seatKeys.epoch(e),
      seatKeys.ctl(e),
      seatKeys.rel(e, a),
      seatKeys.secver(e),
      seatKeys.fence(e),
      ...i.seats.map((s) => seatKeys.hold(e, s.index)),
    ],
    args: [
      a,
      i.purchaseSessionId,
      i.holdId,
      i.fingerprint,
      String(i.limit),
      String(i.ttlMs),
      String(i.keepUntilMs),
      seatKeys.section(e, ''),
      ...i.seats.flatMap((s) => [String(s.index), String(s.sectionIndex), String(s.seatOffset), s.seatId, s.tierId, s.sectionId]),
    ],
  };
}

/** 틀린 좌석 요청의 재생 읽기(RedisSeatStore.replay: 멱등 기록 하나를 HMGET, 쓰지 않음, seat-hold §3) */
export function replayCommand(eventId, accountId, idempotencyKey) {
  const key = seatKeys.idem(eventId, accountId, idempotencyKey);
  // 자동 배정 기록이면 seats·assign이 함께 있다(redis-seat-store.ts replay). 직접 선택 기록에는 없어 null로 온다.
  return { key, args: ['HMGET', key, 'fp', 'resp', 'seats', 'assign'] };
}

/**
 * 만료 1단계 ①: 시간이 지난 좌석 색인을 앞에서 limit개(seat-hold §5 '두 단계로 나눈다' 1, redis-seat-store.ts dueExpiries 주석의 WITHSCORES).
 * @param {string} eventId
 * @param {number} nowMs 앱의 지금(epoch ms)
 * @param {number} limit 1 ~ EXPIRY_BATCH_SIZE
 */
export function dueRangeCommand(eventId, nowMs, limit) {
  const key = seatKeys.expiry(eventId);
  return { key, args: ['ZRANGE', key, '-inf', String(nowMs), 'BYSCORE', 'LIMIT', '0', String(limit), 'WITHSCORES'] };
}

/** 만료 1단계 ②: 좌석 하나의 홀드 Hash 세 칸(holdId·fence·owner) */
export function dueHoldCommand(eventId, index) {
  const key = seatKeys.hold(eventId, index);
  return { key, args: ['HMGET', key, 'holdId', 'fence', 'owner'] };
}

const text = (v) => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/**
 * ZRANGE … WITHSCORES 답을 (색인, 점수) 짝으로. RESP2(평평한 배열)와 RESP3([멤버, 점수] 짝 배열)를 모두 받는다.
 * @returns {{ index: number, expiresAtMs: number }[]}
 */
export function parseDueRange(reply) {
  if (!Array.isArray(reply)) throw new Error(`ZRANGE 답이 배열이 아니다: ${String(reply)}`);
  const pairs = reply.length > 0 && Array.isArray(reply[0]) ? reply : Array.from({ length: reply.length / 2 }, (_, k) => [reply[2 * k], reply[2 * k + 1]]);
  return pairs.map(([m, s]) => {
    const index = Number(text(m));
    const expiresAtMs = Number(text(s));
    if (!Number.isSafeInteger(index) || index < 0) throw new Error(`만료 인덱스 멤버가 좌석 색인이 아니다: ${text(m)}`);
    return { index, expiresAtMs };
  });
}

/**
 * HMGET hold:{i} holdId fence owner 답 → 기대값(domain/expiry.ts DueHold) 또는 null(세 칸 모두 없음 = 고아).
 * 세 칸 가운데 일부만 있으면 Error(PEAKET_CORRUPT_KEY와 같은 뜻, PRF-135 결정 목록 '뒤에 정한 것')
 */
export function parseDueHold(reply, index) {
  const [holdId, fence, owner] = (Array.isArray(reply) ? reply : []).map(text);
  const have = [holdId, fence, owner].filter((v) => v !== null && v !== undefined).length;
  if (have === 0) return null;
  if (have !== 3) throw new Error(`PEAKET_CORRUPT_KEY 홀드 Hash 칸이 일부만 있다(좌석 색인 ${index})`);
  return { holdId, fencingToken: fence, owner };
}

/**
 * 만료 Lua 한 번의 KEYS·ARGV(expire-lua.ts 계약). 계정 m개는 seats의 expected.owner를 처음 나온 차례로 겹침 없이 둔다(고아는 계정이 없다).
 * 고아(expected null)는 기대 holdId·토큰 = ''·계정 번호 = '0'이고, seat가 없으면 좌석 칸 다섯(구역 색인·구역 안 거리·좌석 ID·등급 ID·구역 ID) = ''다.
 * @param {{ eventId: string, keepUntilMs: number, reholdWaitMs?: number,
 *   seats: readonly { index: number, expected: { holdId: string, fencingToken: string, owner: string } | null,
 *     seat?: { seatId: string, sectionId: string, sectionIndex: number, seatOffset: number, tierId: string } }[] }} i
 * @returns {{ keys: string[], args: string[], owners: string[] }}
 */
export function expireCall(i) {
  const e = i.eventId;
  const owners = [];
  const ownerNo = new Map();
  for (const s of i.seats) {
    if (s.expected && !ownerNo.has(s.expected.owner)) {
      owners.push(s.expected.owner);
      ownerNo.set(s.expected.owner, owners.length);
    }
  }
  const keys = [
    seatKeys.bitmap(e),
    seatKeys.expiry(e),
    seatKeys.stream(e),
    seatKeys.epoch(e),
    seatKeys.secver(e),
    ...i.seats.map((s) => seatKeys.hold(e, s.index)),
    ...owners.map((a) => seatKeys.quota(e, a)),
    ...owners.map((a) => seatKeys.rel(e, a)),
    seatKeys.ordered(e),
  ];
  const args = [
    String(i.reholdWaitMs ?? REHOLD_WAIT_MS),
    seatKeys.section(e, ''),
    String(i.keepUntilMs),
    String(owners.length),
    '',
    ...owners,
    ...i.seats.flatMap((s) => [
      String(s.index),
      s.expected ? s.expected.holdId : '',
      s.expected ? s.expected.fencingToken : '',
      s.expected ? String(ownerNo.get(s.expected.owner)) : '0',
      ...(s.seat ? [String(s.seat.sectionIndex), String(s.seat.seatOffset), s.seat.seatId, s.seat.tierId, s.seat.sectionId] : ['', '', '', '', '']),
    ]),
  ];
  return { keys, args, owners };
}

/** 10진 정수 글 → 안전한 정수. 아니면 Error */
function safeInt(v, what) {
  const s = text(v);
  const n = Number(s);
  if (s === null || !/^-?[0-9]+$/.test(s) || !Number.isSafeInteger(n)) throw new Error(`${what}이(가) 안전한 정수가 아니다: ${s}`);
  return n;
}

/**
 * 홀드 Lua 답 {'OK', 토큰 글, heldAt, exp} 등을 읽는다. OK면 토큰을 안전한 정수로(아니면 Error)
 * @returns {{ kind: string, fencingToken?: number, heldAtMs?: number, expiresAtMs?: number }}
 */
export function parseHold(reply) {
  if (!Array.isArray(reply)) throw new Error(`홀드 Lua가 모르는 값을 돌려줬다: ${String(reply)}`);
  const kind = text(reply[0]);
  if (kind !== 'OK') return { kind };
  return { kind, fencingToken: safeInt(reply[1], '펜싱 토큰'), heldAtMs: safeInt(reply[2], '잡은 시각'), expiresAtMs: safeInt(reply[3], '만료 시각') };
}

/**
 * 만료 Lua 답 {'OK', µs 글, 푼 수, 건너뛴 수, 고아 수, 색인₁, 토큰₁, …} 또는 {'NOT_READY'}(expire-lua.ts 계약 6).
 * 토큰·µs는 안전한 정수(약 1.7e15)로 바꾼다. 아니면 Error
 */
export function parseExpire(reply) {
  if (!Array.isArray(reply)) throw new Error(`만료 Lua가 모르는 값을 돌려줬다: ${String(reply)}`);
  const kind = text(reply[0]);
  if (kind === 'NOT_READY') return { kind };
  if (kind !== 'OK') throw new Error(`만료 Lua가 모르는 값을 돌려줬다: ${kind}`);
  const released = safeInt(reply[2], '푼 수');
  if (reply.length !== 5 + 2 * released) throw new Error(`만료 Lua 답의 길이(${reply.length})가 푼 수 ${released}와 맞지 않는다`);
  const expired = [];
  for (let k = 0; k < released; k += 1) expired.push({ index: safeInt(reply[5 + 2 * k], '좌석 색인'), fencingToken: safeInt(reply[6 + 2 * k], '펜싱 토큰') });
  return { kind, nowUs: safeInt(reply[1], '저장소 시각 µs'), released, skipped: safeInt(reply[3], '건너뛴 수'), orphans: safeInt(reply[4], '고아 수'), expired };
}

/**
 * 릴레이 흉내(docs/data.md §3 stream: Kafka 전송 확인을 받은 항목까지 지운 뒤 XTRIM … MINID). 앞 틱에 본 마지막 항목 ID보다 작은 것을 지운다.
 * MINID는 그 ID 미만을 지운다(그 ID는 남는다)
 */
export function relayTrimCommand(eventId, minId) {
  const key = seatKeys.stream(eventId);
  return { key, args: ['XTRIM', key, 'MINID', minId] };
}

/** 지금 Stream의 마지막 항목 ID를 읽는 명령(XREVRANGE + - COUNT 1) */
export function streamTailCommand(eventId) {
  const key = seatKeys.stream(eventId);
  return { key, args: ['XREVRANGE', key, '+', '-', 'COUNT', '1'] };
}
