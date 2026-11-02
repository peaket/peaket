// 시험 기록 줄(docs/verification.md §2.5 '기록 형식', §3.9). k6 시나리오와 Node 시험이 같은 파일을 읽는다.
// 시각은 부르는 쪽이 넘긴 유닉스 밀리초이고(시계 주입), 줄의 시각은 KST(+09:00)로 쓴다.

/** 시험 기록 종류(검사기가 읽는 둘)와 구간 표시 */
export const QUEUE_OP_KINDS = Object.freeze(['queue_entry', 'queue_admit']);
export const MARK_NAMES = Object.freeze(['main_start', 'main_end']);

const RESULTS = ['ok', 'fail', 'unknown'];

const KST_OFFSET_MS = 9 * 3600 * 1000;

const pad = (n, w = 2) => String(n).padStart(w, '0');

const MAX_MS = 253402268399999;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REF = /^[\x21-\x7e]{1,200}$/;

const isMs = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_MS;

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

const httpStatus = (status) => {
  if (!Number.isInteger(status) || status < 0 || status > 999) throw new TypeError(`HTTP 상태는 0~999 정수다: ${status}`);
  return status;
};

/**
 * 유닉스 밀리초 → KST ISO 8601(`YYYY-MM-DDTHH:mm:ss.SSS+09:00`, 밀리초 세 자리 늘 씀).
 * 0 이상 253,402,268,399,999(KST 9999-12-31T23:59:59.999) 이하 정수가 아니면 RangeError. 예: kstIso(0) === '1970-01-01T09:00:00.000+09:00'
 * @param {number} ms
 * @returns {string}
 */
export function kstIso(ms) {
  if (!isMs(ms)) throw new RangeError(`시각은 0 이상 ${MAX_MS} 이하 정수 밀리초여야 한다: ${ms}`);
  // KST는 서머타임이 없어 늘 +9시간이다. 9시간을 더한 시각의 UTC 칸을 읽으면 KST 칸이다
  const d = new Date(ms + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+09:00`;
}

/**
 * HTTP 상태 → 결과. expected에 든 상태면 'ok'(expected를 먼저 본다), 0(연결 실패·시간 초과)이거나 500 이상이면 'unknown', 그 밖은 'fail'.
 * expected는 비지 않은 정수 목록, status는 0~999 정수여야 한다(아니면 TypeError)
 * @param {number} status
 * @param {number[]} expected
 * @returns {'ok' | 'fail' | 'unknown'}
 */
export function resultOf(status, expected) {
  if (!Array.isArray(expected) || expected.length === 0 || !expected.every((s) => Number.isInteger(s))) throw new TypeError('기대 상태 목록이 비었거나 정수가 아니다');
  httpStatus(status);
  if (expected.includes(status)) return 'ok';
  if (status === 0 || status >= 500) return 'unknown';
  return 'fail';
}

/**
 * 입장 확정 응답 → 결과. 200이고 본문 status가 'ADMITTED'면 'ok', 0과 500 이상은 'unknown'(결과를 모른다),
 * 그 밖(200의 다른 status(NOT_YET 등)·다른 2xx·3xx·4xx)은 'fail'. status가 0~999 정수가 아니면 TypeError
 * @param {number} status
 * @param {string | undefined} bodyStatus
 * @returns {'ok' | 'fail' | 'unknown'}
 */
export function admitResult(status, bodyStatus) {
  httpStatus(status);
  if (status === 0 || status >= 500) return 'unknown';
  return status === 200 && bodyStatus === 'ADMITTED' ? 'ok' : 'fail';
}

/**
 * queue_entry·queue_admit 한 줄(객체). 칸은 검사기 형식과 같은 순서다:
 * { kind, event_id, account_ref, request_id, result, seq, generation, started_at, ended_at }.
 * seq·generation이 undefined면 null로 쓴다. 다음이면 Error: kind가 둘 밖, result가 ok·fail·unknown 밖,
 * result가 ok인데 seq나 generation이 null, seq·generation이 0 이상 안전한 정수도 null도 아님, startedMs·endedMs가 kstIso가 받는 값이 아님,
 * endedMs < startedMs, eventId가 UUID가 아님, accountRef·requestId가 출력 가능한 ASCII 1~200자(`^[!-~]{1,200}$`)가 아님
 * @param {'queue_entry' | 'queue_admit'} kind
 * @param {{ eventId: string, accountRef: string, requestId: string, result: string, seq?: number | null, generation?: number | null, startedMs: number, endedMs: number }} o
 * @returns {Record<string, unknown>}
 */
export function queueOpRecord(kind, o) {
  if (!QUEUE_OP_KINDS.includes(kind)) throw new Error(`모르는 기록 종류: ${kind}`);
  if (!RESULTS.includes(o.result)) throw new Error(`result는 ok·fail·unknown 가운데 하나다: ${o.result}`);
  const opt = (name, v) => {
    if (v === undefined || v === null) return null;
    if (!isCount(v)) throw new Error(`${name}는 0 이상 정수이거나 없어야 한다: ${v}`);
    return v;
  };
  const seq = opt('seq', o.seq);
  const generation = opt('generation', o.generation);
  if (o.result === 'ok' && (seq === null || generation === null)) throw new Error('result가 ok면 seq와 generation이 있어야 한다');
  if (typeof o.eventId !== 'string' || !UUID.test(o.eventId)) throw new Error('event_id가 UUID가 아니다');
  if (typeof o.accountRef !== 'string' || !REF.test(o.accountRef)) throw new Error('account_ref는 출력 가능한 ASCII 1~200자다');
  if (typeof o.requestId !== 'string' || !REF.test(o.requestId)) throw new Error('request_id는 출력 가능한 ASCII 1~200자다');
  if (!isMs(o.startedMs) || !isMs(o.endedMs)) throw new Error('시작·끝 시각은 kstIso가 받는 정수 밀리초다');
  if (o.endedMs < o.startedMs) throw new Error('끝 시각이 시작 시각보다 앞이다');
  return {
    kind,
    event_id: o.eventId,
    account_ref: o.accountRef,
    request_id: o.requestId,
    result: o.result,
    seq,
    generation,
    started_at: kstIso(o.startedMs),
    ended_at: kstIso(o.endedMs),
  };
}

/**
 * queue_serving 한 줄: { kind: 'queue_serving', event_id, serving, observed_at: kstIso(atMs) }.
 * serving이 0 이상 정수가 아니면 RangeError
 * @param {{ eventId: string, serving: number, atMs: number }} o
 * @returns {Record<string, unknown>}
 */
export function queueServingRecord(o) {
  if (!isCount(o.serving)) throw new RangeError(`serving은 0 이상 정수다: ${o.serving}`);
  return { kind: 'queue_serving', event_id: o.eventId, serving: o.serving, observed_at: kstIso(o.atMs) };
}

/**
 * 구간 표시 줄: { kind: 'mark', name, at_ms }. name이 MARK_NAMES 밖이거나 atMs가 0 이상 정수가 아니면 Error.
 * 실행 도구가 본구간의 경계로 쓰고 시험 기록 파일로 옮기지 않는다
 * @param {string} name
 * @param {number} atMs
 * @returns {{ kind: 'mark', name: string, at_ms: number }}
 */
export function markRecord(name, atMs) {
  if (!MARK_NAMES.includes(name)) throw new Error(`모르는 구간 표시: ${name}`);
  if (!isMs(atMs)) throw new Error(`구간 표시 시각은 0 이상 정수 밀리초다: ${atMs}`);
  return { kind: 'mark', name, at_ms: atMs };
}
