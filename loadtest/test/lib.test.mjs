// loadtest/lib 네 모듈(시험 기록 줄·가상 사용자·좌석 고르기·오픈 모델)의 계약 시험(docs/verification.md §2.5 '기록 형식', §3.9).
// 각 내보낸 함수의 JSDoc이 명세다. 서버 쪽 정본과도 대조한다:
// - 조회 간격: services/v0-monolith/src/modules/queue/domain/polling.ts pollIntervalMs
// - 좌석 차례·KST 시각: services/v0-monolith/src/modules/inventory/domain/inventory.ts seatGrid·kstIso
// - 기록 줄 형식: services/invariant-checker/src/records.ts parseRecords(매개변수 속성이 있어 형 지우기만으로는 못 읽는다.
//   자식 node를 --experimental-transform-types로 띄워 실제 소스를 읽힌다)
// - 쿠키 이름: services/v0-monolith/src/gateway/token.ts ACCESS_COOKIE(소스 글에서 읽는다)
// 난수는 쓰지 않는다. u 값은 시험이 정한 격자로 넣는다.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { QUEUE_OP_KINDS, MARK_NAMES, kstIso, resultOf, admitResult, queueOpRecord, queueServingRecord, markRecord } from '../lib/records.mjs';
import { MAX_USERS, ACCESS_COOKIE, userIp, assertRunTag, accountRef, pidOf, sidOf, fanHeaders } from '../lib/users.mjs';
import { HOLD_MODES, MAX_SEATS, seatCount, seatIdAt, userSeats, pickHoldSeats } from '../lib/seats.mjs';
import {
  POLL_TABLE,
  CALLED_WINDOW_S,
  STEP_S,
  ROUTE_PATTERN,
  pollAfterMs,
  enteredAt,
  servingAt,
  pollGroups,
  pollRate,
  pickPollUser,
  pollStages,
  openPhases,
  rampingPhases,
  phaseThresholds,
  mainPhaseSummary,
} from '../lib/model.mjs';

// ───────────────────────── 도움 함수 ─────────────────────────

const ROOT = new URL('../../', import.meta.url);
const repoUrl = (p) => new URL(p, ROOT);

/** 1보다 작은 가장 큰 double */
const U_MAX = 1 - 2 ** -53;
const KST_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/;

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/** 결정적 난수열(시험 표본용, Math.random 대신) */
function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** values마다 fn(v)가 errorClass를 던지는지 */
function throwsFor(values, fn, errorClass, label) {
  for (const v of values) assert.throws(() => fn(v), errorClass, `${label}: ${show(v)}에 ${errorClass.name}가 나야 한다`);
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** 실제 검사기 소스(parseRecords)에 NDJSON을 넣고 { ok, value } 또는 { ok: false, name, message }를 받는다 */
function runChecker(ndjson) {
  const script = [
    `import { parseRecords } from ${JSON.stringify(repoUrl('services/invariant-checker/src/records.ts').href)};`,
    `let text = '';`,
    `process.stdin.setEncoding('utf8');`,
    `for await (const chunk of process.stdin) text += chunk;`,
    `try { process.stdout.write(JSON.stringify({ ok: true, value: parseRecords(text) })); }`,
    `catch (e) { process.stdout.write(JSON.stringify({ ok: false, name: e.name, message: e.message })); }`,
  ].join('\n');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', script], {
    input: ndjson,
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `검사기 파서를 띄우지 못했다: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// 시험에 쓰는 고정 시각(유닉스 밀리초)과 그 KST 글
const T0 = Date.UTC(2026, 10, 3, 1, 2, 3, 4); // 2026-11-03T10:02:03.004+09:00
const T0_KST = '2026-11-03T10:02:03.004+09:00';
const T1 = T0 + 1234; // 2026-11-03T10:02:04.238+09:00
const T1_KST = '2026-11-03T10:02:04.238+09:00';
const DAY_EDGE = Date.UTC(2026, 10, 2, 15, 0, 0, 0); // KST 2026-11-03 00:00:00.000
/** kstIso가 받는 가장 늦은 시각(KST 9999-12-31T23:59:59.999) */
const KST_MAX_MS = 253_402_268_399_999;
const EVENT = '5f0c6a2e-8a1b-4c3d-9e4f-0a1b2c3d4e5f';
/** 출력 가능한 ASCII(\x21~\x7e) 양 끝 글자와 200자: 검사기 account_ref·request_id 규칙의 경계 */
const REF_200 = '!' + 'x'.repeat(198) + '~';

const QUEUE_OP_KEYS = ['kind', 'event_id', 'account_ref', 'request_id', 'result', 'seq', 'generation', 'started_at', 'ended_at'];

/** 정상 queueOpRecord 입력(덮어쓸 칸만 넘긴다) */
const opInput = (over = {}) => ({
  eventId: EVENT,
  accountRef: 'acc-lt-r1-0',
  requestId: 'req-r1-0',
  result: 'ok',
  seq: 1,
  generation: 0,
  startedMs: T0,
  endedMs: T1,
  ...over,
});

// ───────────────────────── records.mjs ─────────────────────────

describe('records.mjs — 시험 기록 줄', () => {
  test('K1 Q-T2: kstIso는 유닉스 밀리초를 KST(+09:00) ISO 8601로 쓰고 밀리초는 늘 세 자리다', () => {
    assert.equal(kstIso(0), '1970-01-01T09:00:00.000+09:00');
    assert.equal(kstIso(1), '1970-01-01T09:00:00.001+09:00');
    assert.equal(kstIso(999), '1970-01-01T09:00:00.999+09:00');
    assert.equal(kstIso(1000), '1970-01-01T09:00:01.000+09:00');
    assert.equal(kstIso(Date.UTC(2026, 0, 1, 0, 0, 0, 7)), '2026-01-01T09:00:00.007+09:00');
    assert.equal(kstIso(Date.UTC(2026, 0, 1, 0, 0, 0, 50)), '2026-01-01T09:00:00.050+09:00');
    assert.equal(kstIso(T0), T0_KST);
    assert.equal(kstIso(T1), T1_KST);
    // -0도 0 이상의 안전한 정수다
    assert.equal(kstIso(-0), '1970-01-01T09:00:00.000+09:00');
  });

  test('K1 Q-T2: kstIso는 15:00Z에 KST 날짜가 다음 날로 넘어가고 해·윤일 경계도 맞다', () => {
    assert.equal(kstIso(DAY_EDGE - 1), '2026-11-02T23:59:59.999+09:00');
    assert.equal(kstIso(DAY_EDGE), '2026-11-03T00:00:00.000+09:00');
    assert.equal(kstIso(Date.UTC(2026, 11, 31, 14, 59, 59, 999)), '2026-12-31T23:59:59.999+09:00');
    assert.equal(kstIso(Date.UTC(2026, 11, 31, 15, 0, 0, 0)), '2027-01-01T00:00:00.000+09:00');
    assert.equal(kstIso(Date.UTC(2028, 1, 28, 15, 0, 0, 0)), '2028-02-29T00:00:00.000+09:00');
    assert.equal(kstIso(Date.UTC(2027, 1, 28, 15, 0, 0, 0)), '2027-03-01T00:00:00.000+09:00');
  });

  test('K1 Q-T2: kstIso는 서버 inventory.ts kstIso와 같은 글을 내고 같은 순간을 가리킨다(1970~2100 표본)', async () => {
    const server = await import(repoUrl('services/v0-monolith/src/modules/inventory/domain/inventory.ts').href);
    const rand = lcg(20261103);
    const samples = [0, 1, 999, 1000, DAY_EDGE - 1, DAY_EDGE, T0, T1, Date.UTC(2099, 11, 31, 14, 59, 59, 999), Date.UTC(2099, 11, 31, 15, 0, 0, 0)];
    for (let i = 0; i < 2000; i++) samples.push(Math.floor(rand() * 4_102_444_800) * 1000 + Math.floor(rand() * 1000));
    for (const ms of samples) {
      const got = kstIso(ms);
      assert.equal(got, server.kstIso(ms), `ms=${ms}`);
      assert.match(got, KST_RE, `ms=${ms}`);
      assert.equal(Date.parse(got), ms, `ms=${ms}: 같은 순간이어야 한다`);
    }
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: kstIso는 0~253,402,268,399,999(KST 9999-12-31T23:59:59.999) 정수가 아니면 RangeError', () => {
    assert.equal(kstIso(0), '1970-01-01T09:00:00.000+09:00');
    // 위 끝은 받고(네 자리 해의 마지막 순간), 1ms 뒤부터는 해가 다섯 자리(+010000)가 되어 거절한다
    assert.equal(KST_MAX_MS, Date.UTC(9999, 11, 31, 14, 59, 59, 999));
    assert.equal(kstIso(KST_MAX_MS), '9999-12-31T23:59:59.999+09:00');
    assert.equal(kstIso(KST_MAX_MS - 1), '9999-12-31T23:59:59.998+09:00');
    throwsFor(
      [KST_MAX_MS + 1, Date.UTC(9999, 11, 31, 23, 59, 59, 999), Number.MAX_SAFE_INTEGER, -1, -1000, -0.5, 1.5, NaN, Infinity, -Infinity, 2 ** 53, Number.MAX_SAFE_INTEGER + 2, 1e300, '0', '1000', null, undefined, true, {}, []],
      kstIso,
      RangeError,
      'kstIso',
    );
  });

  test('K1 Q-T2: resultOf는 기대 상태면 ok, 0·500 이상은 unknown, 그 밖은 fail', () => {
    const table = [
      [200, 'ok'],
      [201, 'ok'],
      [204, 'fail'],
      [302, 'fail'],
      [400, 'fail'],
      [401, 'fail'],
      [403, 'fail'],
      [404, 'fail'],
      [409, 'fail'],
      [410, 'fail'],
      [422, 'fail'],
      [429, 'fail'],
      [499, 'fail'],
      [0, 'unknown'],
      [500, 'unknown'],
      [502, 'unknown'],
      [503, 'unknown'],
      [504, 'unknown'],
      [599, 'unknown'],
    ];
    for (const [status, want] of table) assert.equal(resultOf(status, [200, 201]), want, `status=${status}`);
    // 업무상 기대한 거절(홀드의 409·422)을 기대 목록에 넣으면 ok
    assert.equal(resultOf(409, [201, 409, 422]), 'ok');
    assert.equal(resultOf(422, [201, 409, 422]), 'ok');
    assert.equal(resultOf(429, [201, 409, 422]), 'fail');
    assert.equal(resultOf(201, [201]), 'ok');
    assert.equal(resultOf(200, [201]), 'fail');
  });

  test('K1 Q-T2: resultOf는 expected를 먼저 본다(기대 목록에 든 0·5xx·429도 ok)와 상태 범위 양 끝', () => {
    assert.equal(resultOf(503, [503]), 'ok');
    assert.equal(resultOf(500, [201, 500]), 'ok');
    assert.equal(resultOf(429, [429]), 'ok');
    assert.equal(resultOf(0, [0]), 'ok');
    assert.equal(resultOf(503, [500]), 'unknown');
    // 1xx·3xx는 기대 목록에 없으면 fail, 범위 끝 999는 500 이상이라 unknown
    assert.equal(resultOf(100, [200]), 'fail');
    assert.equal(resultOf(199, [200]), 'fail');
    assert.equal(resultOf(499, [200]), 'fail');
    assert.equal(resultOf(600, [200]), 'unknown');
    assert.equal(resultOf(999, [200]), 'unknown');
    assert.equal(resultOf(999, [999]), 'ok');
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: resultOf는 기대 상태 목록이 비었거나 정수 목록이 아니면 TypeError', () => {
    assert.equal(resultOf(200, [200]), 'ok');
    throwsFor([[], undefined, null, 200, '200', ['200'], [200, '201'], {}, [null], [200.5], [NaN], [Infinity], [200, 1.5]], (e) => resultOf(200, e), TypeError, 'resultOf expected');
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: resultOf는 status가 0~999 정수가 아니면 기대 목록에 있어도 TypeError', () => {
    assert.equal(resultOf(0, [200]), 'unknown');
    assert.equal(resultOf(999, [200]), 'unknown');
    throwsFor([-1, 1000, 1.5, NaN, Infinity, -Infinity, '200', null, undefined, true, [200]], (s) => resultOf(s, [200]), TypeError, 'resultOf status');
    assert.throws(() => resultOf(1000, [1000]), TypeError);
    assert.throws(() => resultOf(-1, [-1]), TypeError);
  });

  test('K1 Q-T2: admitResult는 200+ADMITTED만 ok, 200의 다른 상태와 4xx는 fail, 0·500 이상은 unknown', () => {
    const table = [
      [200, 'ADMITTED', 'ok'],
      [200, 'NOT_YET', 'fail'],
      [200, 'CALLED', 'fail'],
      [200, 'WAITING', 'fail'],
      [200, undefined, 'fail'],
      [200, '', 'fail'],
      [200, 'admitted', 'fail'],
      [400, undefined, 'fail'],
      [401, undefined, 'fail'],
      [403, undefined, 'fail'],
      [404, undefined, 'fail'],
      [409, 'ADMITTED', 'fail'],
      [410, undefined, 'fail'],
      [410, 'ADMITTED', 'fail'],
      [422, undefined, 'fail'],
      [429, undefined, 'fail'],
      [0, undefined, 'unknown'],
      [0, 'ADMITTED', 'unknown'],
      [500, undefined, 'unknown'],
      [500, 'ADMITTED', 'unknown'],
      [502, undefined, 'unknown'],
      [503, undefined, 'unknown'],
      [504, undefined, 'unknown'],
      [599, undefined, 'unknown'],
      [999, 'ADMITTED', 'unknown'],
      // 200이 아닌 2xx·3xx·1xx는 본문이 ADMITTED여도 fail
      [201, 'ADMITTED', 'fail'],
      [202, 'ADMITTED', 'fail'],
      [204, undefined, 'fail'],
      [299, 'ADMITTED', 'fail'],
      [302, 'ADMITTED', 'fail'],
      [304, undefined, 'fail'],
      [100, 'ADMITTED', 'fail'],
      [499, 'ADMITTED', 'fail'],
    ];
    for (const [status, body, want] of table) assert.equal(admitResult(status, body), want, `status=${status}, body=${show(body)}`);
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: admitResult는 status가 0~999 정수가 아니면 TypeError', () => {
    assert.equal(admitResult(999, undefined), 'unknown');
    assert.equal(admitResult(0, undefined), 'unknown');
    throwsFor([-1, 1000, 1.5, NaN, Infinity, '200', null, undefined, true], (s) => admitResult(s, 'ADMITTED'), TypeError, 'admitResult status');
  });

  test('K1 Q-T2: queueOpRecord는 검사기와 같은 칸 순서로 한 줄을 만들고 시각을 KST로 쓴다', () => {
    const rec = queueOpRecord('queue_entry', opInput());
    assert.deepEqual(Object.keys(rec), QUEUE_OP_KEYS);
    assert.deepEqual(rec, {
      kind: 'queue_entry',
      event_id: EVENT,
      account_ref: 'acc-lt-r1-0',
      request_id: 'req-r1-0',
      result: 'ok',
      seq: 1,
      generation: 0,
      started_at: T0_KST,
      ended_at: T1_KST,
    });
    for (const kind of QUEUE_OP_KINDS) {
      const r = queueOpRecord(kind, opInput());
      assert.equal(r.kind, kind);
      assert.deepEqual(Object.keys(r), QUEUE_OP_KEYS);
    }
    // 날이 바뀌는 요청
    const cross = queueOpRecord('queue_admit', opInput({ startedMs: DAY_EDGE - 100, endedMs: DAY_EDGE + 100 }));
    assert.equal(cross.started_at, '2026-11-02T23:59:59.900+09:00');
    assert.equal(cross.ended_at, '2026-11-03T00:00:00.100+09:00');
    // JSON 한 줄로 쓸 수 있다(값이 모두 JSON 값)
    assert.deepEqual(JSON.parse(JSON.stringify(rec)), rec);
  });

  test('K1 Q-T2: queueOpRecord는 seq·generation이 없으면 null로 쓰고 0과 fail의 순번은 그대로 둔다', () => {
    const missing = queueOpRecord('queue_entry', opInput({ result: 'unknown', seq: undefined, generation: undefined }));
    assert.deepEqual(Object.keys(missing), QUEUE_OP_KEYS);
    assert.equal(missing.seq, null);
    assert.equal(missing.generation, null);
    const { seq: _s, generation: _g, ...noKeys } = opInput({ result: 'fail' });
    const absent = queueOpRecord('queue_admit', noKeys);
    assert.deepEqual(Object.keys(absent), QUEUE_OP_KEYS);
    assert.equal(absent.seq, null);
    assert.equal(absent.generation, null);
    const explicitNull = queueOpRecord('queue_admit', opInput({ result: 'fail', seq: null, generation: null }));
    assert.equal(explicitNull.seq, null);
    assert.equal(explicitNull.generation, null);
    const zero = queueOpRecord('queue_entry', opInput({ seq: 0, generation: 0 }));
    assert.equal(zero.seq, 0);
    assert.equal(zero.generation, 0);
    const failWithSeq = queueOpRecord('queue_admit', opInput({ result: 'fail', seq: 5, generation: 2 }));
    assert.equal(failWithSeq.result, 'fail');
    assert.equal(failWithSeq.seq, 5);
    assert.equal(failWithSeq.generation, 2);
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: queueOpRecord는 종류·결과가 정한 값 밖이면 던진다', () => {
    assert.equal(queueOpRecord('queue_entry', opInput()).kind, 'queue_entry');
    throwsFor(['queue_serving', 'mark', 'pg_charge', 'QUEUE_ENTRY', '', undefined, null], (k) => queueOpRecord(k, opInput()), Error, 'kind');
    throwsFor(['OK', 'timeout', 'success', '', undefined, null, 1], (r) => queueOpRecord('queue_entry', opInput({ result: r, seq: 1, generation: 1 })), Error, 'result');
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: queueOpRecord는 result가 ok인데 seq나 generation이 없으면 던진다', () => {
    assert.equal(queueOpRecord('queue_admit', opInput({ result: 'ok', seq: 3, generation: 1 })).result, 'ok');
    assert.throws(() => queueOpRecord('queue_admit', opInput({ seq: null })), Error);
    assert.throws(() => queueOpRecord('queue_admit', opInput({ seq: undefined })), Error);
    assert.throws(() => queueOpRecord('queue_admit', opInput({ generation: null })), Error);
    assert.throws(() => queueOpRecord('queue_admit', opInput({ generation: undefined })), Error);
    assert.throws(() => queueOpRecord('queue_entry', opInput({ seq: null, generation: null })), Error);
    const { seq: _s, ...noSeq } = opInput();
    assert.throws(() => queueOpRecord('queue_entry', noSeq), Error);
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: queueOpRecord는 seq·generation이 0 이상 정수도 null도 아니면 결과와 상관없이 던진다', () => {
    assert.equal(queueOpRecord('queue_entry', opInput({ result: 'fail', seq: 7, generation: 7 })).seq, 7);
    const bad = [-1, 1.5, NaN, Infinity, '1', true, {}];
    for (const result of ['ok', 'fail', 'unknown']) {
      throwsFor(bad, (v) => queueOpRecord('queue_entry', opInput({ result, seq: v, generation: 0 })), Error, `seq(${result})`);
      throwsFor(bad, (v) => queueOpRecord('queue_entry', opInput({ result, seq: 0, generation: v })), Error, `generation(${result})`);
    }
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: queueOpRecord는 끝 시각이 시작보다 앞이면 던지고 같으면 받으며 시각이 틀리면 던진다', () => {
    const same = queueOpRecord('queue_entry', opInput({ startedMs: T0, endedMs: T0 }));
    assert.equal(same.started_at, T0_KST);
    assert.equal(same.ended_at, T0_KST);
    assert.throws(() => queueOpRecord('queue_entry', opInput({ startedMs: T0, endedMs: T0 - 1 })), Error);
    assert.throws(() => queueOpRecord('queue_entry', opInput({ result: 'unknown', seq: null, generation: null, startedMs: T1, endedMs: T0 })), Error);
    // 시각은 KST 글로 써야 하므로 kstIso가 받지 않는 값은 줄이 될 수 없다(위 끝 KST_MAX_MS까지는 받는다)
    const last = queueOpRecord('queue_entry', opInput({ startedMs: KST_MAX_MS, endedMs: KST_MAX_MS }));
    assert.equal(last.started_at, '9999-12-31T23:59:59.999+09:00');
    assert.equal(last.ended_at, '9999-12-31T23:59:59.999+09:00');
    throwsFor([NaN, -1, 1.5, undefined, '0', null], (v) => queueOpRecord('queue_entry', opInput({ startedMs: v, endedMs: T1 })), Error, 'startedMs');
    throwsFor([NaN, 1.5, Infinity, KST_MAX_MS + 1, undefined, String(T1)], (v) => queueOpRecord('queue_entry', opInput({ startedMs: T0, endedMs: v })), Error, 'endedMs');
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: queueOpRecord는 eventId가 UUID가 아니면 던진다', () => {
    assert.equal(queueOpRecord('queue_entry', opInput()).event_id, EVENT);
    throwsFor(
      ['', 'not-a-uuid', EVENT.replaceAll('-', ''), `${EVENT}0`, EVENT.slice(1), ` ${EVENT}`, `${EVENT}\n`, `{${EVENT}}`, '5f0c6a2e-8a1b-4c3d-9e4f-0a1b2c3d4e5g', undefined, null, 123],
      (eventId) => queueOpRecord('queue_entry', opInput({ eventId })),
      Error,
      'eventId',
    );
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: queueOpRecord는 accountRef·requestId가 출력 가능 ASCII 1~200자가 아니면 던진다', () => {
    // 경계: 1자, 200자, 출력 가능 ASCII 양 끝 글자(! ~)는 받는다
    const ok = queueOpRecord('queue_admit', opInput({ accountRef: REF_200, requestId: '!' }));
    assert.equal(ok.account_ref, REF_200);
    assert.equal(ok.request_id, '!');
    assert.equal(queueOpRecord('queue_admit', opInput({ accountRef: '~', requestId: REF_200 })).request_id, REF_200);
    const bad = ['', 'x'.repeat(201), 'acc lt', ' acc', 'acc\t', 'acc\n', 'acc\u007f', 'é', '가', 'acc\u0000', undefined, null, 5, ['acc']];
    throwsFor(bad, (accountRef) => queueOpRecord('queue_entry', opInput({ accountRef })), Error, 'accountRef');
    throwsFor(bad, (requestId) => queueOpRecord('queue_entry', opInput({ requestId })), Error, 'requestId');
  });

  test('K1 Q-T2: queueServingRecord는 { kind, event_id, serving, observed_at } 순서로 쓰고 시각은 kstIso다', () => {
    const r0 = queueServingRecord({ eventId: EVENT, serving: 0, atMs: 0 });
    assert.deepEqual(Object.keys(r0), ['kind', 'event_id', 'serving', 'observed_at']);
    assert.deepEqual(r0, { kind: 'queue_serving', event_id: EVENT, serving: 0, observed_at: '1970-01-01T09:00:00.000+09:00' });
    assert.deepEqual(queueServingRecord({ eventId: EVENT, serving: 12345, atMs: T0 }), {
      kind: 'queue_serving',
      event_id: EVENT,
      serving: 12345,
      observed_at: T0_KST,
    });
    assert.equal(queueServingRecord({ eventId: EVENT, serving: 1, atMs: DAY_EDGE }).observed_at, '2026-11-03T00:00:00.000+09:00');
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: queueServingRecord는 serving이 0 이상 정수가 아니거나 시각이 틀리면 RangeError', () => {
    assert.equal(queueServingRecord({ eventId: EVENT, serving: 3, atMs: T0 }).serving, 3);
    throwsFor([-1, 1.5, NaN, Infinity, '3', null, undefined], (v) => queueServingRecord({ eventId: EVENT, serving: v, atMs: T0 }), RangeError, 'serving');
    throwsFor([-1, 1.5, NaN, '0', undefined], (v) => queueServingRecord({ eventId: EVENT, serving: 3, atMs: v }), RangeError, 'atMs');
  });

  test('NFR-013: markRecord는 { kind: mark, name, at_ms } 순서로 숫자 밀리초를 그대로 쓴다', () => {
    const start = markRecord('main_start', 0);
    assert.deepEqual(Object.keys(start), ['kind', 'name', 'at_ms']);
    assert.deepEqual(start, { kind: 'mark', name: 'main_start', at_ms: 0 });
    assert.deepEqual(markRecord('main_end', T0), { kind: 'mark', name: 'main_end', at_ms: T0 });
    for (const name of MARK_NAMES) assert.equal(markRecord(name, T1).name, name);
  });

  test('NFR-013 [ASVS v5.0.0-2.2.1]: markRecord는 이름이 MARK_NAMES 밖이거나 시각이 0 이상 정수가 아니면 던진다', () => {
    assert.equal(markRecord('main_start', T0).at_ms, T0);
    throwsFor(['main', 'warm_start', 'prep_start', 'MAIN_START', 'main_start ', '', undefined, null], (n) => markRecord(n, T0), Error, 'name');
    throwsFor([-1, 1.5, NaN, Infinity, '0', null, undefined], (v) => markRecord('main_end', v), Error, 'atMs');
  });

  test('K1 Q-T2: 만든 줄을 검사기 parseRecords(실제 소스)가 받고 값이 그대로 돌아온다', () => {
    // 대조 장치 확인: 실제 파서가 오프셋 없는 시각을 거절하고 손으로 쓴 줄은 받는다
    const handBad = { kind: 'queue_serving', event_id: EVENT, serving: 1, observed_at: '2026-11-03T10:02:03.004' };
    const handGood = { kind: 'queue_serving', event_id: EVENT, serving: 1, observed_at: T0_KST };
    assert.equal(runChecker(JSON.stringify(handBad) + '\n').ok, false, '검사기가 오프셋 없는 시각을 거절해야 대조가 뜻이 있다');
    assert.equal(runChecker(JSON.stringify(handGood) + '\n').ok, true);

    const lines = [
      queueOpRecord('queue_entry', opInput({ accountRef: 'acc-lt-r1-0', requestId: 'req-r1-0-entry', result: 'ok', seq: 1, generation: 0 })),
      queueOpRecord('queue_entry', opInput({ accountRef: 'acc-lt-r1-1', requestId: 'req-r1-1-entry', result: 'unknown', seq: undefined, generation: undefined, endedMs: T0 + 30_000 })),
      queueOpRecord('queue_admit', opInput({ accountRef: 'acc-lt-r1-0', requestId: 'req-r1-0-admit', result: 'fail', seq: 1, generation: 0, startedMs: DAY_EDGE - 100, endedMs: DAY_EDGE + 100 })),
      queueOpRecord('queue_admit', opInput({ accountRef: 'acc-lt-r1-0', requestId: 'req-r1-0-admit2', result: 'ok', seq: 1, generation: 0, startedMs: DAY_EDGE + 200, endedMs: DAY_EDGE + 200 })),
      queueServingRecord({ eventId: EVENT, serving: 0, atMs: 0 }),
      queueServingRecord({ eventId: EVENT, serving: 12345, atMs: DAY_EDGE }),
      // lib가 받는 경계 값(200자 가명·! ~ 글자·마지막 KST 시각)을 검사기도 받는다
      queueOpRecord('queue_entry', opInput({ accountRef: REF_200, requestId: '~', startedMs: KST_MAX_MS, endedMs: KST_MAX_MS })),
    ];
    const parsed = runChecker(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    assert.equal(parsed.ok, true, parsed.message);
    const strip = ({ kind: _k, ...rest }) => rest;
    assert.deepEqual(parsed.value.queue_entry, [strip(lines[0]), strip(lines[1]), strip(lines[6])]);
    assert.deepEqual(parsed.value.queue_admit, [strip(lines[2]), strip(lines[3])]);
    assert.deepEqual(parsed.value.queue_serving, [strip(lines[4]), strip(lines[5])]);
    assert.deepEqual(parsed.value.pg_charge, []);
    // 시각 글이 넘긴 순간을 그대로 가리킨다
    assert.equal(Date.parse(parsed.value.queue_entry[0].started_at), T0);
    assert.equal(Date.parse(parsed.value.queue_admit[0].started_at), DAY_EDGE - 100);
    assert.equal(Date.parse(parsed.value.queue_admit[0].ended_at), DAY_EDGE + 100);
    assert.equal(Date.parse(parsed.value.queue_serving[1].observed_at), DAY_EDGE);
  });
});

// ───────────────────────── users.mjs ─────────────────────────

describe('users.mjs — 가상 사용자 신원', () => {
  test('NFR-013: userIp는 JSDoc 표본대로 198.18.0.0/15에서 주소를 낸다', () => {
    const table = [
      [0, '198.18.0.0'],
      [1, '198.18.0.1'],
      [255, '198.18.0.255'],
      [256, '198.18.1.0'],
      [257, '198.18.1.1'],
      [65535, '198.18.255.255'],
      [65536, '198.19.0.0'],
      [65537, '198.19.0.1'],
      [131071, '198.19.255.255'],
    ];
    for (const [i, ip] of table) assert.equal(userIp(i), ip, `i=${i}`);
  });

  test('NFR-013: userIp는 0~MAX_USERS−1 전부에 서로 다른 198.18.0.0/15 주소를 내고 번호를 되돌릴 수 있다', () => {
    assert.equal(MAX_USERS, 131072);
    const seen = new Set();
    const re = /^198\.(18|19)\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
    for (let i = 0; i < MAX_USERS; i++) {
      const ip = userIp(i);
      const m = re.exec(ip);
      assert.ok(m, `i=${i}: ${ip}`);
      const [o2, o3, o4] = [Number(m[1]), Number(m[2]), Number(m[3])];
      assert.ok(o3 <= 255 && o4 <= 255, `i=${i}: ${ip}`);
      assert.equal(((o2 - 18) << 16) | (o3 << 8) | o4, i, `i=${i}: ${ip}`);
      seen.add(ip);
    }
    assert.equal(seen.size, MAX_USERS);
  });

  test('NFR-013 [ASVS v5.0.0-2.2.1]: userIp는 0 ≤ i < MAX_USERS 정수가 아니면 RangeError', () => {
    assert.equal(userIp(0), '198.18.0.0');
    throwsFor([MAX_USERS, 131073, -1, 1.5, NaN, Infinity, 2 ** 53, '1', null, undefined], userIp, RangeError, 'userIp');
  });

  test('NFR-013: assertRunTag는 영소문자·숫자 1~16자를 그대로 돌려준다', () => {
    for (const tag of ['a', '0', 'r1', 'run20261103', 'abcdefghij012345']) assert.equal(assertRunTag(tag), tag);
  });

  test('NFR-013 [ASVS v5.0.0-2.2.1]: assertRunTag는 규칙 밖 꼬리표(대문자·기호·17자·줄바꿈·문자열 아님)를 거절한다', () => {
    assert.equal(assertRunTag('r1'), 'r1');
    throwsFor(
      ['', 'abcdefghij0123456', 'A', 'Run1', 'r-1', 'r_1', 'r 1', 'r1\n', '\nr1', 'r1 ', 'ｒ1', '가', 'r.1', 'r/1', 123, null, undefined, ['r1']],
      assertRunTag,
      Error,
      'assertRunTag',
    );
  });

  test('NFR-013: accountRef·pidOf·sidOf는 acc-lt·pid-lt·sid-lt-<꼬리표>-<번호>를 낸다', () => {
    assert.equal(accountRef('r1', 0), 'acc-lt-r1-0');
    assert.equal(accountRef('r1', 42), 'acc-lt-r1-42');
    assert.equal(accountRef('abcdefghij012345', MAX_USERS - 1), 'acc-lt-abcdefghij012345-131071');
    assert.equal(pidOf('r1', 7), 'pid-lt-r1-7');
    assert.equal(pidOf('r1', MAX_USERS - 1), 'pid-lt-r1-131071');
    assert.equal(sidOf('r1', 7), 'sid-lt-r1-7');
    assert.equal(sidOf('r1', 0), 'sid-lt-r1-0');
    // 검사기 account_ref 규칙(1~200자 출력 가능 ASCII)에 든다
    assert.match(accountRef('abcdefghij012345', MAX_USERS - 1), /^[\x21-\x7e]{1,200}$/);
  });

  test('NFR-013 [ASVS v5.0.0-2.2.1]: accountRef·pidOf·sidOf는 번호가 틀리면 RangeError, 꼬리표가 틀리면 던진다', () => {
    for (const [name, fn] of [
      ['accountRef', accountRef],
      ['pidOf', pidOf],
      ['sidOf', sidOf],
    ]) {
      assert.match(fn('r1', 1), /^[a-z]{3}-lt-r1-1$/, name);
      throwsFor([MAX_USERS, -1, 1.5, NaN, Infinity, '1', null, undefined], (i) => fn('r1', i), RangeError, `${name} i`);
      throwsFor(['', 'R1', 'r-1', 'abcdefghij0123456', 'r1\n', undefined], (t) => fn(t, 1), Error, `${name} runTag`);
    }
  });

  test('NFR-013: fanHeaders는 쿠키·X-Forwarded-For를 늘 싣고 write·json일 때만 origin·content-type을 더한다(머리 이름 소문자)', () => {
    // 쿠키 이름은 입구(services/v0-monolith/src/gateway/token.ts)와 같아야 한다
    const tokenSrc = readFileSync(repoUrl('services/v0-monolith/src/gateway/token.ts'), 'utf8');
    const serverCookie = /export const ACCESS_COOKIE = '([^']+)'/.exec(tokenSrc)?.[1];
    assert.equal(serverCookie, '__Secure-peaket_at');
    assert.equal(ACCESS_COOKIE, serverCookie);

    const token = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig-_A1';
    const ip = '198.18.0.1';
    const origin = 'https://peaket.test';
    assert.deepEqual(fanHeaders({ token, ip }), { cookie: `${serverCookie}=${token}`, 'x-forwarded-for': ip });
    assert.deepEqual(fanHeaders({ token, ip, write: false, json: false }), { cookie: `${serverCookie}=${token}`, 'x-forwarded-for': ip });
    assert.deepEqual(fanHeaders({ token, ip, write: true, origin }), { cookie: `${serverCookie}=${token}`, 'x-forwarded-for': ip, origin });
    assert.deepEqual(fanHeaders({ token, ip, json: true }), {
      cookie: `${serverCookie}=${token}`,
      'x-forwarded-for': ip,
      'content-type': 'application/json',
    });
    const all = fanHeaders({ token, ip, write: true, json: true, origin });
    assert.deepEqual(all, { cookie: `${serverCookie}=${token}`, 'x-forwarded-for': ip, origin, 'content-type': 'application/json' });
    for (const k of Object.keys(all)) assert.equal(k, k.toLowerCase(), `머리 이름 ${k}는 소문자여야 한다`);
    // 입력을 바꾸지 않는다
    const input = Object.freeze({ token, ip, write: true, json: true, origin });
    assert.deepEqual(fanHeaders(input), all);
  });

  test('NFR-013: fanHeaders는 write가 거짓이면 origin을 주어도 싣지 않는다(읽기 요청)', () => {
    const token = 'tok';
    const ip = '198.18.0.1';
    const base = { cookie: `${ACCESS_COOKIE}=${token}`, 'x-forwarded-for': ip };
    assert.deepEqual(fanHeaders({ token, ip, origin: 'https://peaket.test' }), base);
    assert.deepEqual(fanHeaders({ token, ip, origin: 'https://peaket.test', write: false }), base);
    assert.deepEqual(fanHeaders({ token, ip, origin: 'https://peaket.test', write: false, json: true }), { ...base, 'content-type': 'application/json' });
    // 읽기에는 origin이 없어도 된다(빈 글도 싣지 않는다)
    assert.deepEqual(fanHeaders({ token, ip, origin: '' }), base);
  });

  test('NFR-013: fanHeaders는 점 넷 IPv4(각 0~255)면 측정 대역 밖 주소도 그대로 X-Forwarded-For에 싣는다', () => {
    for (const ip of ['0.0.0.0', '255.255.255.255', '10.0.0.1', '198.18.0.0', userIp(MAX_USERS - 1)]) {
      assert.equal(fanHeaders({ token: 'tok', ip })['x-forwarded-for'], ip, ip);
    }
  });

  test('NFR-013 [ASVS v5.0.0-2.2.1]: fanHeaders는 빈 토큰, 공백 글자(\\s 전부)·;·,가 든 토큰, 문자열 아닌 토큰, origin 없는 쓰기를 거절한다', () => {
    const ip = '198.18.0.1';
    assert.equal(fanHeaders({ token: 'tok', ip }).cookie, `${ACCESS_COOKIE}=tok`);
    throwsFor(
      [
        '', undefined, null, 123, {}, ['tok'],
        'a b', ' tok', 'tok ', 'a;b', 'a,b', 'a\tb', 'a\nb', 'tok\r\nx-evil: 1', 'a; other=1',
        // 정규식 \s가 잡는 그 밖의 공백 글자
        'a\vb', 'a\fb', 'a\rb', 'a b', 'a b', 'a b', 'a b', 'a b', 'a b', 'a　b', '﻿tok',
      ],
      (token) => fanHeaders({ token, ip }),
      Error,
      'token',
    );
    assert.throws(() => fanHeaders({ token: 'tok', ip, write: true }), Error);
    assert.throws(() => fanHeaders({ token: 'tok', ip, write: true, json: true }), Error);
    assert.throws(() => fanHeaders({ token: 'tok', ip, write: true, origin: '' }), Error);
    assert.throws(() => fanHeaders({ token: 'tok', ip, write: true, origin: undefined }), Error);
  });

  test('NFR-013 [ASVS v5.0.0-2.2.1]: fanHeaders는 ip가 점 넷 IPv4(각 0~255)가 아니면 던진다(머리 주입 포함)', () => {
    assert.equal(fanHeaders({ token: 'tok', ip: '198.18.0.1' })['x-forwarded-for'], '198.18.0.1');
    throwsFor(
      [
        '', '198.18.0', '198.18.0.1.5', '198.18.0.256', '256.0.0.1', '198.18.0.-1', '1.2.3.', '.1.2.3', '1..2.3', 'a.b.c.d', '198.18.0.1a',
        ' 198.18.0.1', '198.18.0.1 ', '198.18.0.1\r\nx-evil: 1', '198.18.0.1,10.0.0.1', '198.18.0.1;', '::1', '::ffff:198.18.0.1',
        '198.18.0.0/15', '１.2.3.4', undefined, null, 3_323_068_417, ['198.18.0.1'],
      ],
      (ip) => fanHeaders({ token: 'tok', ip }),
      Error,
      'ip',
    );
  });

  test('NFR-013 [ASVS v5.0.0-16.2.5]: fanHeaders 오류 메시지에 토큰(일부도)을 싣지 않는다', () => {
    const good = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJTRUNSRVRQQVlMT0FEIn0.SIGsecretSIG';
    assert.equal(fanHeaders({ token: good, ip: '198.18.0.1' }).cookie, `${ACCESS_COOKIE}=${good}`);
    const cases = [
      // 토큰 자체가 틀림
      { token: `${good} trailing`, ip: '198.18.0.1' },
      { token: `${good};other=1`, ip: '198.18.0.1' },
      { token: `SECRETPAYLOAD\nx`, ip: '198.18.0.1' },
      // 토큰은 바르고 다른 칸이 틀림
      { token: good, ip: '198.18.0.999' },
      { token: good, ip: '198.18.0.1', write: true },
    ];
    for (const o of cases) {
      assert.throws(
        () => fanHeaders(o),
        (e) => {
          assert.ok(e instanceof Error);
          for (const part of ['eyJhbGciOiJFUzI1NiJ9', 'eyJzdWIiOiJTRUNSRVRQQVlMT0FEIn0', 'SIGsecretSIG', 'SECRETPAYLOAD']) {
            assert.ok(!e.message.includes(part), `메시지에 토큰 일부가 있다: ${part}`);
          }
          return true;
        },
      );
    }
  });
});

// ───────────────────────── seats.mjs ─────────────────────────

/** JSDoc 표본 격자 */
const G = Object.freeze({ sections: Object.freeze(['A', 'B']), rows: 2, perRow: 3 });
const G_IDS = ['A-1-1', 'A-1-2', 'A-1-3', 'A-2-1', 'A-2-2', 'A-2-3', 'B-1-1', 'B-1-2', 'B-1-3', 'B-2-1', 'B-2-2', 'B-2-3'];
/** spread 훑기용 격자: 구역 3 × 열 5 = 15열, 열마다 8석 */
const G2 = Object.freeze({ sections: Object.freeze(['A', 'B', 'C']), rows: 5, perRow: 8 });

const SEAT_RE = /^([A-Za-z0-9]{1,8})-([1-9]\d*)-([1-9]\d*)$/;
const parseSeat = (id) => {
  const m = SEAT_RE.exec(id);
  assert.ok(m, `좌석 ID 꼴이 아니다: ${id}`);
  return { section: m[1], row: Number(m[2]), number: Number(m[3]) };
};

/** 틀린 격자 목록(각각 RangeError여야 한다) */
const BAD_GRIDS = [
  { sections: [], rows: 2, perRow: 3 },
  { sections: ['A', 'A'], rows: 2, perRow: 3 },
  { sections: [''], rows: 2, perRow: 3 },
  { sections: ['A-1'], rows: 2, perRow: 3 },
  { sections: ['A B'], rows: 2, perRow: 3 },
  { sections: ['A_'], rows: 2, perRow: 3 },
  { sections: ['ABCDEFGHI'], rows: 2, perRow: 3 },
  { sections: ['가'], rows: 2, perRow: 3 },
  { sections: 'AB', rows: 2, perRow: 3 },
  { sections: undefined, rows: 2, perRow: 3 },
  { sections: null, rows: 2, perRow: 3 },
  { sections: ['A'], rows: 0, perRow: 3 },
  { sections: ['A'], rows: -1, perRow: 3 },
  { sections: ['A'], rows: 1.5, perRow: 3 },
  { sections: ['A'], rows: NaN, perRow: 3 },
  { sections: ['A'], rows: '2', perRow: 3 },
  { sections: ['A'], rows: undefined, perRow: 3 },
  { sections: ['A'], rows: 10_001, perRow: 1 },
  { sections: ['A'], rows: 2, perRow: 0 },
  { sections: ['A'], rows: 2, perRow: 2.5 },
  { sections: ['A'], rows: 1, perRow: 10_001 },
  { sections: ['A'], rows: 11, perRow: 9091 }, // 100,001석
  { sections: ['A', 'B'], rows: 10_000, perRow: 10 }, // 200,000석
  // 객체가 아닌 격자
  null,
  undefined,
  'A',
  42,
  true,
  // 문자열이 아닌 구역 이름(글로 바꾸면 규칙에 맞는 것도 거절해야 한다: 1 → '1', ['A'] → 'A')
  { sections: [1], rows: 2, perRow: 3 },
  { sections: ['A', 2], rows: 2, perRow: 3 },
  { sections: [['A']], rows: 2, perRow: 3 },
  { sections: [null], rows: 2, perRow: 3 },
  { sections: [{}], rows: 2, perRow: 3 },
  { sections: [new String('A')], rows: 2, perRow: 3 },
];

describe('seats.mjs — 좌석 고르기', () => {
  test('K2 K7: seatCount는 구역 수 × rows × perRow이고 MAX_SEATS까지 받는다', () => {
    assert.equal(MAX_SEATS, 100_000);
    assert.equal(seatCount(G), 12);
    assert.equal(seatCount({ sections: ['A'], rows: 1, perRow: 1 }), 1);
    assert.equal(seatCount({ sections: ['ABCDEFGH', 'z9'], rows: 3, perRow: 7 }), 42);
    assert.equal(seatCount({ sections: ['a', 'A'], rows: 2, perRow: 2 }), 8);
    assert.equal(seatCount({ sections: ['A'], rows: 10_000, perRow: 10 }), MAX_SEATS);
    assert.equal(seatCount({ sections: ['A'], rows: 10, perRow: 10_000 }), MAX_SEATS);
    assert.equal(seatCount({ sections: ['A', 'B', 'C', 'D'], rows: 250, perRow: 100 }), MAX_SEATS);
  });

  test('K2 K7 [ASVS v5.0.0-2.2.1]: seatCount는 틀린 격자(구역 비거나 겹침·이름 규칙 밖·rows·perRow 범위 밖·합계 초과)를 RangeError로 거절한다', () => {
    assert.equal(seatCount(G), 12);
    throwsFor(BAD_GRIDS, seatCount, RangeError, 'seatCount');
  });

  test('K2 K7: seatIdAt는 구역 → 열 → 번호 순으로 ID를 낸다(JSDoc 표본과 12석 전부)', () => {
    assert.equal(seatIdAt(G, 0), 'A-1-1');
    assert.equal(seatIdAt(G, 3), 'A-2-1');
    assert.equal(seatIdAt(G, 6), 'B-1-1');
    for (let k = 0; k < G_IDS.length; k++) assert.equal(seatIdAt(G, k), G_IDS[k], `k=${k}`);
    const big = { sections: ['A', 'B', 'C', 'D'], rows: 250, perRow: 100 };
    assert.equal(seatIdAt(big, 12_345), 'A-124-46');
    assert.equal(seatIdAt(big, 25_000), 'B-1-1');
    assert.equal(seatIdAt(big, 99_999), 'D-250-100');
    assert.equal(seatIdAt({ sections: ['A'], rows: 10_000, perRow: 10 }, 99_999), 'A-10000-10');
  });

  test('K2 K7: seatIdAt·seatCount는 서버 seatGrid와 모든 k에서 같다', async () => {
    const { seatGrid } = await import(repoUrl('services/v0-monolith/src/modules/inventory/domain/inventory.ts').href);
    const grids = [
      G,
      { sections: ['VIP'], rows: 1, perRow: 1 },
      { sections: ['A', 'B', 'C'], rows: 3, perRow: 4 },
      { sections: ['F1', 'F2'], rows: 12, perRow: 25 },
      { sections: ['a', 'A'], rows: 2, perRow: 2 },
      { sections: ['Z'], rows: 1, perRow: 37 },
      { sections: ['A', 'B', 'C', 'D'], rows: 250, perRow: 100 },
    ];
    for (const grid of grids) {
      const ids = seatGrid({ ...grid, sections: [...grid.sections] }).map((s) => s.id);
      assert.equal(seatCount(grid), ids.length, JSON.stringify(grid));
      for (let k = 0; k < ids.length; k++) {
        const got = seatIdAt(grid, k);
        if (got !== ids[k]) assert.fail(`${JSON.stringify(grid)} k=${k}: ${got} ≠ 서버 ${ids[k]}`);
      }
    }
  });

  test('K2 K7 [ASVS v5.0.0-2.2.1]: seatIdAt는 0 ≤ k < 좌석 수 정수가 아니면 RangeError', () => {
    assert.equal(seatIdAt(G, 11), 'B-2-3');
    throwsFor([12, 13, -1, 1.5, NaN, Infinity, '0', null, undefined], (k) => seatIdAt(G, k), RangeError, 'seatIdAt k');
    throwsFor(BAD_GRIDS, (g) => seatIdAt(g, 0), RangeError, 'seatIdAt grid');
  });

  test('K7: userSeats는 i*n부터 붙은 n석을 주고 마지막 사용자는 꼭 맞으며 한 명 더면 RangeError', () => {
    assert.deepEqual(userSeats(G, 0, 1), ['A-1-1']);
    assert.deepEqual(userSeats(G, 11, 1), ['B-2-3']);
    assert.throws(() => userSeats(G, 12, 1), RangeError);
    assert.deepEqual(userSeats(G, 0, 2), ['A-1-1', 'A-1-2']);
    assert.deepEqual(userSeats(G, 1, 2), ['A-1-3', 'A-2-1']);
    assert.deepEqual(userSeats(G, 5, 2), ['B-2-2', 'B-2-3']);
    assert.throws(() => userSeats(G, 6, 2), RangeError);
    assert.deepEqual(userSeats(G, 0, 3), ['A-1-1', 'A-1-2', 'A-1-3']);
    assert.deepEqual(userSeats(G, 3, 3), ['B-2-1', 'B-2-2', 'B-2-3']);
    assert.throws(() => userSeats(G, 4, 3), RangeError);
    assert.deepEqual(userSeats(G, 0, 4), ['A-1-1', 'A-1-2', 'A-1-3', 'A-2-1']);
    assert.deepEqual(userSeats(G, 2, 4), ['B-1-3', 'B-2-1', 'B-2-2', 'B-2-3']);
    assert.throws(() => userSeats(G, 3, 4), RangeError);
    // 좌석 수가 n으로 나누어떨어지지 않을 때: 10석, n=3 → 3명까지(3*3=9 ≤ 10), 4번째는 4*3=12 > 10
    const ten = { sections: ['A'], rows: 2, perRow: 5 };
    assert.deepEqual(userSeats(ten, 2, 3), ['A-2-2', 'A-2-3', 'A-2-4']);
    assert.throws(() => userSeats(ten, 3, 3), RangeError);
  });

  test('K7: userSeats는 이웃 사용자끼리 겹치지 않고 모아 붙이면 좌석 차례와 같다', () => {
    const grid = { sections: ['A', 'B', 'C'], rows: 3, perRow: 4 }; // 36석
    const order = [];
    for (let k = 0; k < 36; k++) order.push(seatIdAt(grid, k));
    for (let n = 1; n <= 4; n++) {
      const users = Math.floor(36 / n);
      const all = [];
      let prev = null;
      for (let i = 0; i < users; i++) {
        const mine = userSeats(grid, i, n);
        assert.equal(mine.length, n);
        assert.deepEqual(mine, order.slice(i * n, i * n + n), `n=${n}, i=${i}`);
        if (prev) for (const s of mine) assert.ok(!prev.includes(s), `n=${n}: 사용자 ${i - 1}과 ${i}가 ${s}를 같이 가진다`);
        prev = mine;
        all.push(...mine);
      }
      assert.equal(new Set(all).size, users * n, `n=${n}: 좌석이 겹친다`);
      assert.throws(() => userSeats(grid, users, n), RangeError, `n=${n}: ${users}번째 사용자는 자리가 없다`);
    }
  });

  test('K7 [ASVS v5.0.0-2.2.1]: userSeats는 n이 1~4 정수가 아니거나 i가 0 이상 정수가 아니면 RangeError', () => {
    assert.deepEqual(userSeats(G, 0, 1), ['A-1-1']);
    throwsFor([0, 5, -1, 1.5, NaN, '2', null, undefined], (n) => userSeats(G, 0, n), RangeError, 'userSeats n');
    throwsFor([-1, 1.5, NaN, Infinity, '0', null, undefined], (i) => userSeats(G, i, 1), RangeError, 'userSeats i');
    throwsFor(BAD_GRIDS, (g) => userSeats(g, 0, 1), RangeError, 'userSeats grid');
  });

  test('K2: pickHoldSeats spread는 식대로 열 하나와 시작 번호를 고른다(손으로 센 표본)', () => {
    const spread = (grid, size, u1, u2) => pickHoldSeats(grid, { mode: 'spread', size, u1, u2 });
    // G: 열 4개(A-1, A-2, B-1, B-2), 열마다 3석
    assert.deepEqual(spread(G, 2, 0, 0), ['A-1-1', 'A-1-2']);
    assert.deepEqual(spread(G, 2, 0.5, 0.999999), ['B-1-2', 'B-1-3']);
    assert.deepEqual(spread(G, 3, 0.999999, 0.3), ['B-2-1', 'B-2-2', 'B-2-3']);
    assert.deepEqual(spread(G, 1, 0.25, 0.5), ['A-2-2']);
    assert.deepEqual(spread(G, 1, 0.2499999, 0.6667), ['A-1-3']);
    assert.deepEqual(spread(G, 3, U_MAX, U_MAX), ['B-2-1', 'B-2-2', 'B-2-3']);
    // G2: 15열, 열마다 8석
    assert.deepEqual(spread(G2, 4, 0.4, 0.75), ['B-2-4', 'B-2-5', 'B-2-6', 'B-2-7']);
    assert.deepEqual(spread(G2, 4, 0.999999, 0.999999), ['C-5-5', 'C-5-6', 'C-5-7', 'C-5-8']);
    assert.deepEqual(spread(G2, 4, U_MAX, U_MAX), ['C-5-5', 'C-5-6', 'C-5-7', 'C-5-8']);
    assert.deepEqual(spread(G2, 1, 0, U_MAX), ['A-1-8']);
    // 열마다 1석인 격자
    assert.deepEqual(spread({ sections: ['A'], rows: 3, perRow: 1 }, 1, 0.5, 0.9), ['A-2-1']);
  });

  test('K2: pickHoldSeats spread는 모든 u에서 한 열 안의 붙은 좌석이고 perRow를 넘지 않으며 열을 고르게 고른다', () => {
    const R = G2.sections.length * G2.rows;
    const u2s = [U_MAX, 0.999999];
    for (let k = 0; k < 50; k++) u2s.push(k / 50);
    for (let size = 1; size <= 4; size++) {
      const hits = new Array(R).fill(0);
      for (let j = 0; j < R; j++) {
        const u1 = (j + 0.5) / R;
        // 결과에서 읽은 열 번호로 센다(u1 하나에 한 번)
        const first = parseSeat(pickHoldSeats(G2, { mode: 'spread', size, u1, u2: 0.5 })[0]);
        hits[G2.sections.indexOf(first.section) * G2.rows + (first.row - 1)] += 1;
        for (const u2 of u2s) {
          const seats = pickHoldSeats(G2, { mode: 'spread', size, u1, u2 });
          assert.equal(seats.length, size);
          const parsed = seats.map(parseSeat);
          const start = 1 + Math.floor(u2 * (G2.perRow - size + 1));
          const section = G2.sections[Math.floor(j / G2.rows)];
          const row = (j % G2.rows) + 1;
          parsed.forEach((p, m) => {
            assert.equal(p.section, section, `size=${size} u1=${u1} u2=${u2}`);
            assert.equal(p.row, row, `size=${size} u1=${u1} u2=${u2}`);
            assert.equal(p.number, start + m, `size=${size} u1=${u1} u2=${u2}: 붙은 좌석이어야 한다`);
            assert.ok(p.number >= 1 && p.number <= G2.perRow, `size=${size} u1=${u1} u2=${u2}: ${seats[m]}`);
          });
        }
      }
      assert.deepEqual(hits, new Array(R).fill(1), `size=${size}: 열마다 한 번씩 골라야 한다`);
    }
    // 열 끝(u1이 1에 가까움)도 범위 안
    for (let size = 1; size <= 4; size++) {
      const seats = pickHoldSeats(G2, { mode: 'spread', size, u1: U_MAX, u2: U_MAX });
      assert.deepEqual(seats.map(parseSeat).map((p) => [p.section, p.row]), new Array(size).fill(['C', 5]));
      assert.equal(parseSeat(seats.at(-1)).number, G2.perRow);
    }
  });

  test('K2 [ASVS v5.0.0-2.2.1]: pickHoldSeats spread는 size가 1~4 정수가 아니거나 perRow보다 크면 RangeError', () => {
    assert.equal(pickHoldSeats(G, { mode: 'spread', size: 3, u1: 0, u2: 0 }).length, 3);
    throwsFor([0, 5, -1, 1.5, NaN, '2', null, undefined], (size) => pickHoldSeats(G2, { mode: 'spread', size, u1: 0, u2: 0 }), RangeError, 'spread size');
    assert.throws(() => pickHoldSeats(G, { mode: 'spread', size: 4, u1: 0, u2: 0 }), RangeError, 'perRow 3에 4석');
    assert.throws(() => pickHoldSeats({ sections: ['A'], rows: 3, perRow: 1 }, { mode: 'spread', size: 2, u1: 0, u2: 0 }), RangeError);
  });

  test('S-T1: pickHoldSeats hot은 첫 hotCount석 가운데 floor(u1 × hotCount)번째 한 석을 고른다', () => {
    const hot = (hotCount, u1, u2 = 0.5) => pickHoldSeats(G, { mode: 'hot', hotCount, u1, u2 });
    assert.deepEqual(hot(4, 0), ['A-1-1']);
    assert.deepEqual(hot(4, 0.2499), ['A-1-1']);
    assert.deepEqual(hot(4, 0.25), ['A-1-2']);
    assert.deepEqual(hot(4, 0.5), ['A-1-3']);
    assert.deepEqual(hot(4, 0.75), ['A-2-1']);
    assert.deepEqual(hot(4, 0.999999), ['A-2-1']);
    assert.deepEqual(hot(4, U_MAX), ['A-2-1']);
    // 인기 좌석 단 1석(S-T1)
    for (const u1 of [0, 0.3, 0.999999, U_MAX]) assert.deepEqual(hot(1, u1), ['A-1-1']);
    // hotCount = 좌석 수
    assert.deepEqual(hot(12, U_MAX), ['B-2-3']);
    for (const H of [1, 4, 7, 12]) {
      for (let j = 0; j < H; j++) assert.deepEqual(hot(H, (j + 0.5) / H), [G_IDS[j]], `H=${H}, j=${j}`);
    }
  });

  test('S-T1 [ASVS v5.0.0-2.2.1]: pickHoldSeats hot은 hotCount가 1 이상 정수가 아니거나 좌석 수보다 크면 RangeError', () => {
    assert.deepEqual(pickHoldSeats(G, { mode: 'hot', hotCount: 12, u1: 0, u2: 0 }), ['A-1-1']);
    throwsFor([13, 0, -1, 1.5, NaN, '4', null, undefined], (hotCount) => pickHoldSeats(G, { mode: 'hot', hotCount, u1: 0, u2: 0 }), RangeError, 'hotCount');
  });

  test('K3 S-T10: pickHoldSeats crossed는 쌍 floor(u2 × pairs)를 u1 < 0.5면 [앞, 뒤], 아니면 [뒤, 앞]으로 낸다', () => {
    const crossed = (pairs, u1, u2) => pickHoldSeats(G, { mode: 'crossed', pairs, u1, u2 });
    assert.deepEqual(crossed(3, 0.2, 0), ['A-1-1', 'A-1-2']);
    assert.deepEqual(crossed(3, 0, 0), ['A-1-1', 'A-1-2']);
    assert.deepEqual(crossed(3, 0.4999999, 0), ['A-1-1', 'A-1-2']);
    assert.deepEqual(crossed(3, 0.5, 0), ['A-1-2', 'A-1-1']);
    assert.deepEqual(crossed(3, U_MAX, 0), ['A-1-2', 'A-1-1']);
    assert.deepEqual(crossed(3, 0, 0.5), ['A-1-3', 'A-2-1']);
    assert.deepEqual(crossed(3, 0.9, 0.5), ['A-2-1', 'A-1-3']);
    assert.deepEqual(crossed(3, 0.1, 0.999999), ['A-2-2', 'A-2-3']);
    assert.deepEqual(crossed(3, 0.1, U_MAX), ['A-2-2', 'A-2-3']);
    // 2 × pairs = 좌석 수
    assert.deepEqual(crossed(6, 0.7, U_MAX), ['B-2-3', 'B-2-2']);
    // 쌍은 열을 건널 수 있다(G의 쌍 1 = A-1-3·A-2-1)
    assert.deepEqual(crossed(2, 0.3, 0.5), ['A-1-3', 'A-2-1']);
    // 쌍은 구역도 건널 수 있다: 구역마다 3석이면 쌍 1 = A-1-3·B-1-1
    const G3 = { sections: ['A', 'B'], rows: 1, perRow: 3 };
    assert.deepEqual(pickHoldSeats(G3, { mode: 'crossed', pairs: 3, u1: 0.3, u2: 0.5 }), ['A-1-3', 'B-1-1']);
    assert.deepEqual(pickHoldSeats(G3, { mode: 'crossed', pairs: 3, u1: 0.6, u2: 0.5 }), ['B-1-1', 'A-1-3']);
    assert.deepEqual(pickHoldSeats(G3, { mode: 'crossed', pairs: 3, u1: 0.6, u2: U_MAX }), ['B-1-3', 'B-1-2']);
    for (const P of [1, 3, 6]) {
      for (let j = 0; j < P; j++) {
        const u2 = (j + 0.5) / P;
        assert.deepEqual(crossed(P, 0.25, u2), [G_IDS[2 * j], G_IDS[2 * j + 1]], `P=${P}, j=${j}`);
        assert.deepEqual(crossed(P, 0.75, u2), [G_IDS[2 * j + 1], G_IDS[2 * j]], `P=${P}, j=${j}`);
      }
    }
  });

  test('K3 S-T10 [ASVS v5.0.0-2.2.1]: pickHoldSeats crossed는 pairs가 1 이상 정수가 아니거나 2 × pairs가 좌석 수보다 크면 RangeError', () => {
    assert.equal(pickHoldSeats(G, { mode: 'crossed', pairs: 6, u1: 0, u2: 0 }).length, 2);
    throwsFor([7, 0, -1, 1.5, NaN, '3', null, undefined], (pairs) => pickHoldSeats(G, { mode: 'crossed', pairs, u1: 0, u2: 0 }), RangeError, 'pairs');
  });

  test('K2 S-T1 S-T10 [ASVS v5.0.0-2.2.1]: pickHoldSeats는 모르는 방식, [0, 1) 밖의 u, 틀린 격자를 RangeError로 거절한다', () => {
    const ok = { spread: { size: 2 }, hot: { hotCount: 4 }, crossed: { pairs: 3 } };
    assert.deepEqual(HOLD_MODES, ['spread', 'hot', 'crossed']);
    for (const mode of HOLD_MODES) assert.ok(Array.isArray(pickHoldSeats(G, { mode, ...ok[mode], u1: 0, u2: 0 })), mode);
    throwsFor(['random', 'SPREAD', 'Hot', '', undefined, null], (mode) => pickHoldSeats(G, { mode, size: 2, hotCount: 4, pairs: 3, u1: 0, u2: 0 }), RangeError, 'mode');
    const badU = [1, 1.5, -1e-9, -1, NaN, Infinity, '0.5', null, undefined];
    for (const mode of HOLD_MODES) {
      throwsFor(badU, (u1) => pickHoldSeats(G, { mode, ...ok[mode], u1, u2: 0 }), RangeError, `${mode} u1`);
      throwsFor(badU, (u2) => pickHoldSeats(G, { mode, ...ok[mode], u1: 0, u2 }), RangeError, `${mode} u2`);
      throwsFor(BAD_GRIDS, (g) => pickHoldSeats(g, { mode, ...ok[mode], u1: 0, u2: 0 }), RangeError, `${mode} grid`);
    }
  });
});

// ───────────────────────── model.mjs ─────────────────────────

/** 손으로 센 기본 모델: 1만 명, 초당 1,000명 진입, 초당 10명 부름(5초 창 50명, 60초 600명, 300초 3,000명) */
const O = Object.freeze({ users: 10_000, entryRate: 1000, admitPerSecond: 10 });
/** 작은 모델: 1천 명, 초당 100명 진입, 초당 1명 부름 */
const O3 = Object.freeze({ users: 1000, entryRate: 100, admitPerSecond: 1 });
/** 부르는 속도가 진입보다 빠른 모델 */
const O2 = Object.freeze({ users: 100, entryRate: 2, admitPerSecond: 50 });

/** JSDoc 식을 그대로 옮긴 기대값(시각 훑기용). 0.5초 묶음의 앞은 차례가 온 시각으로 센다: servingAt(t − CALLED_WINDOW_S) */
function specGroups(t, o) {
  const eAt = (x) => (x < 0 ? 0 : Math.min(o.users, Math.floor(o.entryRate * x)));
  const sAt = (x) => (x < 0 ? 0 : Math.min(eAt(x), Math.floor(o.admitPerSecond * x)));
  const e = eAt(t);
  const s = sAt(t);
  const a = o.admitPerSecond;
  const n60 = s + Math.floor(60 * a) + 1;
  const n300 = s + Math.floor(300 * a) + 1;
  return [
    { from: sAt(t - CALLED_WINDOW_S), to: Math.min(e, n60), intervalMs: 500 },
    { from: n60, to: Math.min(e, n300), intervalMs: 5000 },
    { from: n300, to: e, intervalMs: 20000 },
  ].filter((g) => g.from < g.to);
}

/** 잘못된 모델 매개변수(각각 RangeError여야 한다) */
const BAD_MODELS = [
  { ...O, users: 0 },
  { ...O, users: -1 },
  { ...O, users: 1.5 },
  { ...O, users: NaN },
  { ...O, users: '10' },
  { ...O, users: undefined },
  { ...O, users: Infinity },
  { ...O, entryRate: 0 },
  { ...O, entryRate: 0.5 },
  { ...O, entryRate: 2.5 },
  { ...O, entryRate: NaN },
  { ...O, admitPerSecond: 0 },
  { ...O, admitPerSecond: 2.5 },
  { ...O, admitPerSecond: -3 },
  { ...O, admitPerSecond: undefined },
];

describe('model.mjs — 오픈 모델과 대기자 조회 도착률', () => {
  test('K1 Q-T2: pollAfterMs는 예상 대기 60초·300초 경계에서 서버 표대로 간격을 고른다', () => {
    const table = [
      [0, 1, 500],
      [59, 1, 500],
      [60, 1, 500],
      [61, 1, 5000],
      [299, 1, 5000],
      [300, 1, 5000],
      [301, 1, 20000],
      [30, 0.5, 500],
      [31, 0.5, 5000],
      [150, 0.5, 5000],
      [151, 0.5, 20000],
      [600, 10, 500],
      [601, 10, 5000],
      [3000, 10, 5000],
      [3001, 10, 20000],
      [60_000, 1000, 500],
      [60_001, 1000, 5000],
      [300_000, 1000, 5000],
      [300_001, 1000, 20000],
      [1_000_000, 1000, 20000],
    ];
    for (const [ahead, rate, want] of table) assert.equal(pollAfterMs(ahead, rate), want, `ahead=${ahead}, rate=${rate}`);
  });

  test('K1 Q-T2: pollAfterMs는 속도가 0.001보다 작으면 0.001로 보고 나눈다', () => {
    assert.equal(pollAfterMs(0, 0), 500); // 앞 인원 0 → 예상 대기 0
    assert.equal(pollAfterMs(0, 0.0005), 500);
    assert.equal(pollAfterMs(1, 0), 20000); // 1 ÷ 0.001 = 1,000초
    assert.equal(pollAfterMs(1, 0.0005), 20000);
    assert.equal(pollAfterMs(1, 0.001), 20000);
    assert.equal(pollAfterMs(1, 0.1), 500); // 10초
    assert.equal(pollAfterMs(1, 0.01), 5000); // 100초
  });

  test('K1 Q-T2: pollAfterMs는 서버 polling.ts pollIntervalMs와 경계·소수 속도·속도 0을 포함한 모든 표본에서 같다', async () => {
    const server = await import(repoUrl('services/v0-monolith/src/modules/queue/domain/polling.ts').href);
    const rates = [0, 0.0001, 0.0005, 0.001, 0.0015, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.3, 1 / 3, 0.5, 0.7, 1, 1.5, 2, 2.5, 3, 7, 9.99, 10, 28, 33.3, 100, 1000, 1234.5, 2000];
    const mismatches = [];
    let n = 0;
    for (const rate of rates) {
      const eff = Math.max(rate, 0.001);
      const aheads = new Set();
      for (let a = 0; a <= 400; a++) aheads.add(a);
      for (const edge of [60, 300]) {
        const c = Math.floor(edge * eff);
        for (let d = -3; d <= 3; d++) if (c + d >= 0) aheads.add(c + d);
      }
      for (const big of [1000, 10_000, 100_000, 1_000_000, 10_000_000]) aheads.add(big);
      for (const ahead of aheads) {
        n += 1;
        const got = pollAfterMs(ahead, rate);
        const want = server.pollIntervalMs(ahead, rate);
        if (got !== want) mismatches.push(`ahead=${ahead}, rate=${rate}: ${got} ≠ 서버 ${want}`);
      }
    }
    assert.deepEqual(mismatches.slice(0, 20), [], `${n}개 표본 가운데 ${mismatches.length}개가 다르다`);
    // 표 상수도 서버와 같다
    assert.deepEqual(
      POLL_TABLE.map((r) => r.intervalMs),
      [server.POLL_NEAR_MS, server.POLL_MID_MS, server.POLL_FAR_MS],
    );
    assert.deepEqual(
      POLL_TABLE.map((r) => r.maxEtaS),
      [60, 300, Infinity],
    );
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: pollAfterMs는 ahead가 0 이상 정수가 아니거나 속도가 0 이상 유한수가 아니면 RangeError', () => {
    assert.equal(pollAfterMs(1, 1), 500);
    throwsFor([-1, 1.5, NaN, Infinity, '1', null, undefined], (a) => pollAfterMs(a, 1), RangeError, 'ahead');
    throwsFor([-0.001, -1, NaN, Infinity, -Infinity, '1', null, undefined], (r) => pollAfterMs(1, r), RangeError, 'ratePerS');
  });

  test('K1 Q-T2: enteredAt은 min(users, floor(entryRate × t))이고 음수 시각은 0이다', () => {
    const table = [
      [-1, 0],
      [-0.5, 0],
      [0, 0],
      [0.0009, 0],
      [0.001, 1],
      [0.5, 500],
      [5, 5000],
      [9.9999, 9999],
      [10, 10_000],
      [20, 10_000],
      [1e6, 10_000],
    ];
    for (const [t, want] of table) assert.equal(enteredAt(t, O), want, `t=${t}`);
    assert.equal(enteredAt(0.4, O2), 0);
    assert.equal(enteredAt(0.5, O2), 1);
    assert.equal(enteredAt(60, O2), 100);
  });

  test('K1 Q-T2: servingAt은 min(진입 수, floor(admitPerSecond × t))이고 진입 수를 넘지 않는다', () => {
    const table = [
      [-3, 0],
      [0, 0],
      [0.05, 0],
      [0.1, 1],
      [0.15, 1],
      [5, 50],
      [20, 200],
      [999.5, 9995],
      [1000, 10_000],
      [2000, 10_000],
    ];
    for (const [t, want] of table) assert.equal(servingAt(t, O), want, `t=${t}`);
    // 부르는 속도가 진입보다 빠르면 진입 수에 막힌다
    assert.equal(servingAt(0.4, O2), 0);
    assert.equal(servingAt(0.5, O2), 1);
    assert.equal(servingAt(1, O2), 2);
    assert.equal(servingAt(10, O2), 20);
    assert.equal(servingAt(60, O2), 100);
    for (const o of [O, O2, O3]) {
      let pe = 0;
      let ps = 0;
      for (let t = 0; t <= 1200; t += 0.5) {
        const e = enteredAt(t, o);
        const s = servingAt(t, o);
        assert.ok(Number.isInteger(e) && Number.isInteger(s), `t=${t}`);
        assert.ok(s <= e && e <= o.users, `t=${t}: serving ${s}, entered ${e}`);
        assert.ok(e >= pe && s >= ps, `t=${t}: 줄면 안 된다`);
        pe = e;
        ps = s;
      }
    }
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: enteredAt·servingAt·pollGroups·pollStages는 users·entryRate·admitPerSecond가 1 이상 정수가 아니면 RangeError', () => {
    assert.equal(enteredAt(1, O), 1000);
    throwsFor(BAD_MODELS, (o) => enteredAt(1, o), RangeError, 'enteredAt');
    throwsFor(BAD_MODELS, (o) => servingAt(1, o), RangeError, 'servingAt');
    throwsFor(BAD_MODELS, (o) => pollGroups(1, o), RangeError, 'pollGroups');
    throwsFor(BAD_MODELS, (o) => pollStages({ ...o, startS: 0, durationS: 10, stepS: 10 }), RangeError, 'pollStages');
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: enteredAt·servingAt·pollGroups는 tS가 유한수가 아니면 RangeError(−Infinity도 0이 아니다)', () => {
    // 기준: 유한한 음수는 0, 아주 큰 유한수는 상한
    assert.equal(enteredAt(-1e9, O), 0);
    assert.equal(servingAt(-1e9, O), 0);
    assert.deepEqual(pollGroups(-1e9, O), []);
    assert.equal(enteredAt(1e15, O), O.users);
    const bad = [NaN, Infinity, -Infinity, '1', '0', null, undefined, true, [1]];
    throwsFor(bad, (t) => enteredAt(t, O), RangeError, 'enteredAt tS');
    throwsFor(bad, (t) => servingAt(t, O), RangeError, 'servingAt tS');
    throwsFor(bad, (t) => pollGroups(t, O), RangeError, 'pollGroups tS');
  });

  test('K1 Q-T2: pollGroups는 손으로 센 표본과 같다', () => {
    const g = (from, to, intervalMs) => ({ from, to, intervalMs });
    assert.deepEqual(pollGroups(0, O), []);
    assert.deepEqual(pollGroups(-5, O), []);
    assert.deepEqual(pollGroups(0.5, O), [g(0, 500, 500)]);
    assert.deepEqual(pollGroups(5, O), [g(0, 651, 500), g(651, 3051, 5000), g(3051, 5000, 20000)]);
    assert.deepEqual(pollGroups(10, O), [g(50, 701, 500), g(701, 3101, 5000), g(3101, 10_000, 20000)]);
    assert.deepEqual(pollGroups(20, O), [g(150, 801, 500), g(801, 3201, 5000), g(3201, 10_000, 20000)]);
    assert.deepEqual(pollGroups(700, O), [g(6950, 7601, 500), g(7601, 10_000, 5000)]);
    assert.deepEqual(pollGroups(990, O), [g(9850, 10_000, 500)]);
    // t=1000에 모두 불렸고(serving 10,000), 0.5초 묶음은 차례가 온 지 5초 안인 사람이다: servingAt(995) = 9,950
    assert.deepEqual(pollGroups(1000, O), [g(9950, 10_000, 500)]);
    // 모두 불린 지 5초가 지나면 아무도 조회하지 않는다
    assert.deepEqual(pollGroups(2000, O), []);
    // 가운데 묶음만 있고 먼 묶음이 빠지는 경우
    assert.deepEqual(pollGroups(1, O3), [g(0, 62, 500), g(62, 100, 5000)]);
    assert.deepEqual(pollGroups(3, O3), [g(0, 64, 500), g(64, 300, 5000)]);
    assert.deepEqual(pollGroups(10, O3), [g(5, 71, 500), g(71, 311, 5000), g(311, 1000, 20000)]);
    assert.deepEqual(pollGroups(1000, O3), [g(995, 1000, 500)]);
    assert.deepEqual(pollGroups(1003, O3), [g(998, 1000, 500)]);
    assert.deepEqual(pollGroups(1010, O3), []);
    // 부르는 속도가 진입보다 빠르면 serving이 진입 수에 막혀, 0.5초 묶음의 앞은 '5초 전의 serving'(= 5초 전 진입 수)이다.
    // 옛 식 s − floor(a × 5)였다면 0부터였다(차례가 온 지 오래된 사람까지 넣음)
    assert.deepEqual(pollGroups(10, O2), [g(10, 20, 500)]); // e=20, s=20, servingAt(5)=10
    assert.deepEqual(pollGroups(30, O2), [g(50, 60, 500)]);
    assert.deepEqual(pollGroups(52, O2), [g(94, 100, 500)]); // e=100, servingAt(47)=94
    assert.deepEqual(pollGroups(55, O2), []);
    assert.deepEqual(pollGroups(4, O2), [g(0, 8, 500)]);
  });

  test('K1 Q-T2: pollGroups의 0.5초 묶음은 모두 불린 뒤 5초(CALLED_WINDOW_S) 동안 줄어 비고, 조회 도착률도 0이 된다', () => {
    const g = (from, to, intervalMs) => ({ from, to, intervalMs });
    // O: t=1000에 마지막 사람(순번 10,000)이 불린다
    assert.equal(servingAt(1000, O), 10_000);
    assert.deepEqual(pollGroups(1001, O), [g(9960, 10_000, 500)]);
    assert.deepEqual(pollGroups(1004.5, O), [g(9995, 10_000, 500)]);
    assert.deepEqual(pollGroups(1005, O), []);
    assert.deepEqual(pollGroups(1e6, O), []);
    assert.ok(near(pollRate(pollGroups(1001, O)), 80));
    assert.equal(pollRate(pollGroups(1005, O)), 0);
    // 앞이 줄기만 하고 늘지 않는다(1000~1005초를 0.25초마다)
    let prevFrom = -1;
    for (let t = 1000; t <= 1005; t += 0.25) {
      const groups = pollGroups(t, O);
      assert.ok(groups.length <= 1, `t=${t}`);
      if (groups.length === 1) {
        assert.equal(groups[0].to, 10_000, `t=${t}`);
        assert.ok(groups[0].from > prevFrom, `t=${t}: 앞이 늘어야 한다`);
        prevFrom = groups[0].from;
      }
    }
    // 단계로 바꾸면 비는 칸의 target은 0이다
    assert.deepEqual(pollStages({ ...O, startS: 1000, durationS: 20, stepS: 10 }), {
      startRate: 100, // 50명 × 2/초
      stages: [
        { target: 0, duration: '10s' },
        { target: 0, duration: '10s' },
      ],
    });
  });

  test('K1 Q-T2: pollGroups는 빈 묶음을 빼고 간격 순으로 겹치지 않는 [0, 진입 수) 안의 범위를 낸다(시각 훑기)', () => {
    assert.equal(CALLED_WINDOW_S, 5);
    for (const o of [O, O2, O3]) {
      for (let t = -2; t <= 1300; t += 1.7) {
        const groups = pollGroups(t, o);
        assert.deepEqual(groups, specGroups(t, o), `t=${t}, o=${JSON.stringify(o)}`);
        const e = enteredAt(t, o);
        let lastTo = 0;
        let lastInterval = 0;
        for (const gr of groups) {
          assert.deepEqual(Object.keys(gr).sort(), ['from', 'intervalMs', 'to']);
          assert.ok(Number.isInteger(gr.from) && Number.isInteger(gr.to), `t=${t}`);
          assert.ok(gr.from < gr.to, `t=${t}: 빈 묶음`);
          assert.ok(gr.from >= lastTo, `t=${t}: 겹친다`);
          assert.ok(gr.intervalMs > lastInterval, `t=${t}: 간격 순이 아니다`);
          assert.ok(gr.from >= 0 && gr.to <= e && gr.to <= o.users, `t=${t}: 범위 밖`);
          assert.ok([500, 5000, 20000].includes(gr.intervalMs));
          lastTo = gr.to;
          lastInterval = gr.intervalMs;
        }
      }
    }
  });

  test('K1 Q-T2: pollRate는 Σ 인원 × 1000 ÷ 간격이다', () => {
    assert.equal(pollRate([]), 0);
    assert.ok(near(pollRate([{ from: 0, to: 10, intervalMs: 500 }]), 20));
    assert.ok(near(pollRate([{ from: 0, to: 1, intervalMs: 20000 }]), 0.05));
    assert.ok(near(pollRate([{ from: 0, to: 100, intervalMs: 500 }, { from: 100, to: 1100, intervalMs: 20000 }]), 250));
    const r5 = pollRate(pollGroups(5, O));
    assert.ok(near(r5, 1302 + 480 + 97.45), `t=5: ${r5}`);
    assert.ok(near(pollRate(pollGroups(1000, O)), 100)); // 50명 × 2/초
    assert.equal(pollRate(pollGroups(2000, O)), 0);
    assert.ok(near(pollRate(pollGroups(20, O)), 1302 + 480 + 339.95));
  });

  test('K1 Q-T2: pickPollUser는 한 묶음 안에서 from + floor(u2 × 인원)을 고르고 묶음이 없으면 -1', () => {
    assert.equal(pickPollUser([], 0, 0), -1);
    assert.equal(pickPollUser([], 0.5, 0.5), -1);
    const one = [{ from: 100, to: 200, intervalMs: 500 }];
    assert.equal(pickPollUser(one, 0.3, 0), 100);
    assert.equal(pickPollUser(one, 0.3, 0.5), 150);
    assert.equal(pickPollUser(one, 0.3, 0.123), 112);
    assert.equal(pickPollUser(one, 0.3, 0.999999), 199);
    assert.equal(pickPollUser(one, 0, U_MAX), 199);
    assert.equal(pickPollUser(one, U_MAX, U_MAX), 199);
    const single = [{ from: 7, to: 8, intervalMs: 20000 }];
    for (const u of [0, 0.5, U_MAX]) assert.equal(pickPollUser(single, u, u), 7);
  });

  test('K1 Q-T2: pickPollUser는 u1 격자에서 묶음마다 조회 도착률 몫만큼 고른다(인원 몫이 아니다)', () => {
    const K = 10_000;
    const cases = [
      // 인원은 100 : 1000이지만 도착률은 200 : 50 → 0.8 : 0.2
      [{ from: 0, to: 100, intervalMs: 500 }, { from: 100, to: 1100, intervalMs: 20000 }],
      // pollGroups(5, O)
      [{ from: 0, to: 651, intervalMs: 500 }, { from: 651, to: 3051, intervalMs: 5000 }, { from: 3051, to: 5000, intervalMs: 20000 }],
      // 같은 간격 두 묶음
      [{ from: 0, to: 30, intervalMs: 5000 }, { from: 30, to: 100, intervalMs: 5000 }],
    ];
    for (const groups of cases) {
      const rates = groups.map((g) => ((g.to - g.from) * 1000) / g.intervalMs);
      const total = rates.reduce((x, y) => x + y, 0);
      const counts = new Array(groups.length).fill(0);
      for (let j = 0; j < K; j++) {
        const u1 = (j + 0.5) / K;
        const u2 = (((j * 7919) % 1000) + 0.5) / 1000;
        const r = pickPollUser(groups, u1, u2);
        const gi = groups.findIndex((g) => r >= g.from && r < g.to);
        assert.ok(gi >= 0, `u1=${u1}: ${r}는 어느 묶음에도 없다`);
        const g = groups[gi];
        assert.equal(r, g.from + Math.floor(u2 * (g.to - g.from)), `u1=${u1}, u2=${u2}`);
        counts[gi] += 1;
      }
      counts.forEach((c, gi) => {
        const want = (K * rates[gi]) / total;
        assert.ok(Math.abs(c - want) <= 1, `${JSON.stringify(groups)}: 묶음 ${gi}를 ${c}번 골랐다(기대 ${want.toFixed(2)})`);
      });
      // u1 양 끝도 묶음 안의 사람을 고른다
      for (const u1 of [0, U_MAX]) {
        const r = pickPollUser(groups, u1, 0.5);
        assert.ok(groups.some((g) => r >= g.from && r < g.to), `u1=${u1}: ${r}`);
      }
    }
  });

  test('K1 Q-T2: pickPollUser는 묶음을 주어진 차례대로 [0, 1)에 이어 붙인다(간격 순이 아니어도)', () => {
    // 도착률 200 : 50 → [0, 0.8)은 앞 묶음, [0.8, 1)은 뒤 묶음
    const near5 = { from: 0, to: 100, intervalMs: 500 };
    const far20 = { from: 100, to: 1100, intervalMs: 20000 };
    assert.equal(pickPollUser([near5, far20], 0.7999, 0), 0);
    assert.equal(pickPollUser([near5, far20], 0.8001, 0), 100);
    assert.equal(pickPollUser([near5, far20], U_MAX, U_MAX), 1099);
    // 차례를 바꾸면 [0, 0.2)가 먼 묶음이다
    assert.equal(pickPollUser([far20, near5], 0.1999, 0), 100);
    assert.equal(pickPollUser([far20, near5], 0.2001, 0), 0);
    assert.equal(pickPollUser([far20, near5], 0, 0.5), 600);
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: pickPollUser는 u1·u2가 [0, 1) 밖이면 묶음이 없어도 RangeError', () => {
    const one = [{ from: 0, to: 10, intervalMs: 500 }];
    assert.equal(pickPollUser(one, 0, 0), 0);
    assert.equal(pickPollUser([], U_MAX, U_MAX), -1);
    const bad = [1, 1.5, -1e-9, -1, NaN, Infinity, '0.5', null, undefined];
    throwsFor(bad, (u1) => pickPollUser(one, u1, 0), RangeError, 'u1');
    throwsFor(bad, (u2) => pickPollUser(one, 0, u2), RangeError, 'u2');
    throwsFor(bad, (u1) => pickPollUser([], u1, 0), RangeError, 'u1(묶음 없음)');
    throwsFor(bad, (u2) => pickPollUser([], 0, u2), RangeError, 'u2(묶음 없음)');
  });

  test('K1 Q-T2: pollStages는 칸 끝 시각의 반올림 도착률을 target으로, 시작 시각의 도착률을 startRate로 낸다(손으로 센 표본)', () => {
    assert.deepEqual(pollStages({ ...O, startS: 0, durationS: 25, stepS: 10 }), {
      startRate: 0,
      stages: [
        { target: 2127, duration: '10s' }, // t=10: 1302 + 480 + 344.95
        { target: 2122, duration: '10s' }, // t=20: 1302 + 480 + 339.95
        { target: 2119, duration: '5s' }, // t=25: 1302 + 480 + 337.45
      ],
    });
    // stepS를 빼면 STEP_S(10초)
    assert.equal(STEP_S, 10);
    assert.deepEqual(pollStages({ ...O, startS: 5, durationS: 20 }), {
      startRate: 1879, // t=5: 1302 + 480 + 97.45
      stages: [
        { target: 2124, duration: '10s' }, // t=15: 1302 + 480 + 342.45
        { target: 2119, duration: '10s' }, // t=25
      ],
    });
    assert.deepEqual(pollStages({ ...O, startS: 0, durationS: 1, stepS: 10 }), {
      startRate: 0,
      stages: [{ target: 1300, duration: '1s' }], // t=1: 1222 + 77.8
    });
    assert.deepEqual(pollStages({ ...O3, startS: 0, durationS: 30, stepS: 10 }), {
      startRate: 0,
      stages: [
        { target: 214, duration: '10s' }, // t=10: 132 + 48 + 34.45
        { target: 214, duration: '10s' }, // t=20: 132 + 48 + 33.95
        { target: 213, duration: '10s' }, // t=30: 132 + 48 + 33.45
      ],
    });
  });

  test('K1 Q-T2: pollStages는 ceil(durationS ÷ stepS) 칸을 내고 길이 합이 durationS이며 마지막 칸만 짧다', () => {
    const cases = [
      [O, 0, 600, 10],
      [O, 0, 601, 10],
      [O, 3, 7, 3],
      [O, 0, 5, 1],
      [O3, 12, 95, 20],
      [O2, 0, 9, 10],
      [O, 100, 10, 10],
    ];
    for (const [o, startS, durationS, stepS] of cases) {
      const label = `startS=${startS}, durationS=${durationS}, stepS=${stepS}`;
      const { startRate, stages } = pollStages({ ...o, startS, durationS, stepS });
      assert.equal(stages.length, Math.ceil(durationS / stepS), label);
      let sum = 0;
      stages.forEach((st, j) => {
        assert.deepEqual(Object.keys(st).sort(), ['duration', 'target'], label);
        const m = /^([1-9]\d*)s$/.exec(st.duration);
        assert.ok(m, `${label}: duration ${st.duration}`);
        const len = Number(m[1]);
        const isLast = j === stages.length - 1;
        if (!isLast) assert.equal(len, stepS, label);
        else assert.equal(len, durationS - (stages.length - 1) * stepS, label);
        sum += len;
        assert.equal(st.target, Math.round(pollRate(pollGroups(startS + sum, o))), `${label}: 칸 ${j}`);
        assert.ok(Number.isInteger(st.target) && st.target >= 0, label);
      });
      assert.equal(sum, durationS, label);
      assert.equal(startRate, Math.round(pollRate(pollGroups(startS, o))), label);
    }
  });

  test('K1 Q-T2 [ASVS v5.0.0-2.2.1]: pollStages는 startS·durationS·stepS가 범위 밖이면 RangeError', () => {
    assert.equal(pollStages({ ...O, startS: 0, durationS: 1, stepS: 1 }).stages.length, 1);
    throwsFor([-1, 1.5, NaN, '0', undefined], (startS) => pollStages({ ...O, startS, durationS: 10, stepS: 10 }), RangeError, 'startS');
    throwsFor([0, -1, 1.5, NaN, '10', undefined], (durationS) => pollStages({ ...O, startS: 0, durationS, stepS: 10 }), RangeError, 'durationS');
    throwsFor([0, -1, 2.5, NaN, '10'], (stepS) => pollStages({ ...O, startS: 0, durationS: 10, stepS }), RangeError, 'stepS');
  });

  const PHASE_IN = Object.freeze({ rate: 200, warmS: 30, mainS: 120, startS: 0, preVUs: 50, maxVUs: 400, exec: 'status' });

  test('NFR-013: openPhases는 warm·main 두 constant-arrival-rate 구간을 정한 꼴로 낸다', () => {
    const common = { executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 400, exec: 'status' };
    assert.deepEqual(openPhases(PHASE_IN), {
      warm: { ...common, duration: '30s', startTime: '0s', tags: { phase: 'warm' } },
      main: { ...common, duration: '120s', startTime: '30s', tags: { phase: 'main' } },
    });
    const later = openPhases({ ...PHASE_IN, startS: 15 });
    assert.equal(later.warm.startTime, '15s');
    assert.equal(later.main.startTime, '45s');
    assert.equal(later.warm.duration, '30s');
    assert.equal(later.main.duration, '120s');
    // maxVUs = preVUs 허용, 1초 구간 허용
    const tight = openPhases({ ...PHASE_IN, warmS: 1, mainS: 1, preVUs: 1, maxVUs: 1, rate: 1 });
    assert.equal(tight.warm.maxVUs, 1);
    assert.equal(tight.main.startTime, '1s');
    // startS를 빼면 0
    const { startS: _s, ...noStart } = PHASE_IN;
    assert.deepEqual(openPhases(noStart), openPhases(PHASE_IN));
    assert.equal(openPhases(noStart).warm.startTime, '0s');
    assert.equal(openPhases(noStart).main.startTime, '30s');
  });

  test('NFR-013 [ASVS v5.0.0-2.2.1]: openPhases는 rate·구간 길이·VU·startS·exec가 틀리면 RangeError', () => {
    assert.equal(openPhases(PHASE_IN).main.exec, 'status');
    const bad = [
      { rate: 0 },
      { rate: -1 },
      { rate: 1.5 },
      { rate: NaN },
      { rate: '200' },
      { warmS: 0 },
      { warmS: 1.5 },
      { mainS: 0 },
      { mainS: -10 },
      { preVUs: 0 },
      { maxVUs: 0 },
      { maxVUs: 49 }, // preVUs 50보다 작다
      { startS: -1 },
      { startS: 1.5 },
      { startS: '0' },
      { exec: '' },
      { exec: undefined },
      { exec: 5 },
      { rate: Infinity },
      { warmS: '30' },
      { mainS: undefined },
      { preVUs: 1.5 },
      { preVUs: undefined },
      { maxVUs: '400' },
      { maxVUs: Infinity },
    ];
    throwsFor(bad, (over) => openPhases({ ...PHASE_IN, ...over }), RangeError, 'openPhases');
  });

  const RAMP_IN = Object.freeze({
    exec: 'status',
    startS: 10,
    warmS: 20,
    mainS: 25,
    warm: {
      startRate: 0,
      stages: [
        { target: 100, duration: '10s' },
        { target: 200, duration: '10s' },
      ],
    },
    main: {
      startRate: 200,
      stages: [
        { target: 300, duration: '10s' },
        { target: 300, duration: '10s' },
        { target: 250, duration: '5s' },
      ],
    },
    preVUs: 20,
    maxVUs: 100,
  });

  test('K1 Q-T2 NFR-013: rampingPhases는 두 ramping-arrival-rate 구간을 내고 main은 startS + warmS에 시작한다', () => {
    const common = { executor: 'ramping-arrival-rate', timeUnit: '1s', preAllocatedVUs: 20, maxVUs: 100, exec: 'status' };
    assert.deepEqual(rampingPhases(RAMP_IN), {
      warm: { ...common, startRate: 0, stages: RAMP_IN.warm.stages, startTime: '10s', tags: { phase: 'warm' } },
      main: { ...common, startRate: 200, stages: RAMP_IN.main.stages, startTime: '30s', tags: { phase: 'main' } },
    });
    // pollStages 결과를 그대로 넣을 수 있다
    const warm = pollStages({ ...O, startS: 0, durationS: 20 });
    const main = pollStages({ ...O, startS: 20, durationS: 35 });
    const out = rampingPhases({ exec: 'status', startS: 0, warmS: 20, mainS: 35, warm, main, preVUs: 10, maxVUs: 10 });
    assert.equal(out.warm.startTime, '0s');
    assert.equal(out.main.startTime, '20s');
    assert.equal(out.main.startRate, main.startRate);
    assert.deepEqual(out.main.stages, main.stages);
    assert.deepEqual(out.main.tags, { phase: 'main' });
  });

  test('K1 Q-T2 NFR-013 [ASVS v5.0.0-2.2.1]: rampingPhases는 stages 길이 합이 warmS·mainS와 다르면 RangeError', () => {
    assert.equal(rampingPhases(RAMP_IN).main.startTime, '30s');
    assert.throws(() => rampingPhases({ ...RAMP_IN, warmS: 30 }), RangeError);
    assert.throws(() => rampingPhases({ ...RAMP_IN, warmS: 19 }), RangeError);
    assert.throws(() => rampingPhases({ ...RAMP_IN, mainS: 20 }), RangeError);
    assert.throws(() => rampingPhases({ ...RAMP_IN, mainS: 26 }), RangeError);
    assert.throws(() => rampingPhases({ ...RAMP_IN, main: { startRate: 200, stages: [{ target: 300, duration: '24s' }] } }), RangeError);
    // 빈 stages는 합이 0이라 warmS(1 이상)와 다르다
    assert.throws(() => rampingPhases({ ...RAMP_IN, warm: { startRate: 0, stages: [] } }), RangeError);
  });

  test('K1 Q-T2 NFR-013: rampingPhases는 startS를 빼면 0부터다(openPhases와 같은 규칙)', () => {
    const { startS: _s, ...noStart } = RAMP_IN;
    const out = rampingPhases(noStart);
    assert.equal(out.warm.startTime, '0s');
    assert.equal(out.main.startTime, '20s');
  });

  test('K1 Q-T2 NFR-013 [ASVS v5.0.0-2.2.1]: rampingPhases는 duration이 <정수>s가 아니거나 target·startRate가 0 이상 정수가 아니면 길이 합이 맞아도 RangeError', () => {
    assert.equal(rampingPhases(RAMP_IN).warm.stages.length, 2);
    // 너그럽게 읽으면 10초로 읽히는 글(합이 그대로 맞는다)도 '<정수>s'가 아니면 거절한다
    for (const duration of ['10', '10.0s', '1e1s', '+10s', ' 10s', '10s ', '10S', '10 s', '10000ms', 10]) {
      const warm = { startRate: 0, stages: [{ target: 100, duration }, { target: 200, duration: '10s' }] };
      assert.throws(() => rampingPhases({ ...RAMP_IN, warm }), RangeError, `duration ${show(duration)}`);
    }
    // 분 단위('1m' = 60초)로 합을 맞춰도 거절한다
    const minute = { startRate: 0, stages: [{ target: 100, duration: '1m' }, { target: 200, duration: '10s' }] };
    assert.throws(() => rampingPhases({ ...RAMP_IN, warmS: 70, warm: minute }), RangeError, "duration '1m'");
    for (const target of [-1, 1.5, NaN, Infinity, '100', null, undefined]) {
      const main = { startRate: 200, stages: [{ target, duration: '10s' }, { target: 300, duration: '10s' }, { target: 250, duration: '5s' }] };
      assert.throws(() => rampingPhases({ ...RAMP_IN, main }), RangeError, `target ${show(target)}`);
    }
    for (const startRate of [-1, 1.5, NaN, '0', null, undefined]) {
      assert.throws(() => rampingPhases({ ...RAMP_IN, warm: { ...RAMP_IN.warm, startRate } }), RangeError, `warm startRate ${show(startRate)}`);
      assert.throws(() => rampingPhases({ ...RAMP_IN, main: { ...RAMP_IN.main, startRate } }), RangeError, `main startRate ${show(startRate)}`);
    }
    for (const warm of [undefined, null, { startRate: 0 }, { startRate: 0, stages: 'x' }, { startRate: 0, stages: { length: 2 } }]) {
      assert.throws(() => rampingPhases({ ...RAMP_IN, warm }), RangeError, `warm ${show(warm)}`);
    }
  });

  test('K1 Q-T2 NFR-013 [ASVS v5.0.0-2.2.1]: rampingPhases는 exec·startS·warmS·mainS·preVUs·maxVUs를 openPhases와 같이 검사한다', () => {
    assert.equal(rampingPhases(RAMP_IN).main.exec, 'status');
    const bad = [
      { exec: '' },
      { exec: undefined },
      { exec: 5 },
      { startS: -1 },
      { startS: 1.5 },
      { preVUs: 0 },
      { preVUs: 1.5 },
      { maxVUs: 19 }, // preVUs 20보다 작다
      { maxVUs: 0 },
      { warmS: 0, warm: { startRate: 0, stages: [] } },
      { warmS: 20.5 },
      { mainS: -25 },
    ];
    throwsFor(bad, (over) => rampingPhases({ ...RAMP_IN, ...over }), RangeError, 'rampingPhases');
  });

  test('NFR-013: phaseThresholds는 본구간 지표 셋·경로마다 셋·dropped_iterations 키만 낸다', () => {
    const base = {
      'http_req_duration{phase:main}': ['max>=0'],
      'http_reqs{phase:main}': ['count>=0'],
      'http_req_failed{phase:main}': ['rate>=0'],
      dropped_iterations: ['count>=0'],
    };
    assert.deepEqual(phaseThresholds([]), base);
    assert.deepEqual(phaseThresholds(['entry', 'status']), {
      ...base,
      'http_req_duration{phase:main,route:entry}': ['max>=0'],
      'http_reqs{phase:main,route:entry}': ['count>=0'],
      'http_req_failed{phase:main,route:entry}': ['rate>=0'],
      'http_req_duration{phase:main,route:status}': ['max>=0'],
      'http_reqs{phase:main,route:status}': ['count>=0'],
      'http_req_failed{phase:main,route:status}': ['rate>=0'],
    });
    const routes = ['hold', 'release', 'order', 'sim_auth', 'payment', 'order_view', 'admission'];
    const many = phaseThresholds(routes);
    assert.equal(Object.keys(many).length, 4 + 3 * routes.length);
    for (const r of routes) assert.deepEqual(many[`http_req_duration{phase:main,route:${r}}`], ['max>=0'], r);
    const longest = 'a' + 'b'.repeat(31);
    assert.match(longest, ROUTE_PATTERN);
    assert.deepEqual(phaseThresholds([longest])[`http_reqs{phase:main,route:${longest}}`], ['count>=0']);
  });

  test('NFR-013 [ASVS v5.0.0-2.2.1]: phaseThresholds는 ROUTE_PATTERN에 맞지 않거나 겹치는 경로 이름을 RangeError로 거절한다', () => {
    assert.equal(Object.keys(phaseThresholds(['entry'])).length, 7);
    const bad = ['Entry', '1abc', '_a', 'a-b', 'a b', '', 'a:b', 'a,b', 'a}', 'a{', 'é', 'a' + 'b'.repeat(32), null, undefined, 5];
    throwsFor(bad, (r) => phaseThresholds(['entry', r]), RangeError, 'route');
    assert.throws(() => phaseThresholds(['entry', 'entry']), RangeError);
    assert.throws(() => phaseThresholds(['entry', 'status', 'entry']), RangeError);
  });

  test('NFR-013 [ASVS v5.0.0-2.2.1]: phaseThresholds는 경로 목록이 배열이 아니면 RangeError', () => {
    assert.equal(Object.keys(phaseThresholds([])).length, 4);
    throwsFor(['entry', undefined, null, 5, {}, { 0: 'entry', length: 1 }, new Set(['entry'])], phaseThresholds, RangeError, 'routes');
  });

  const SUMMARY_IN = () => ({
    http_req_duration: { values: { avg: 10, max: 50, 'p(95)': 30 } },
    'http_req_duration{phase:main}': { values: { avg: 12, max: 40, 'p(95)': 28 } },
    'http_req_duration{phase:main,route:status}': { values: { avg: 11, max: 39, 'p(95)': 27 } },
    http_reqs: { values: { count: 1000, rate: 100 } },
    'http_reqs{phase:main}': { values: { count: 600, rate: 60 } },
    http_req_failed: { values: { rate: 0.01, passes: 10, fails: 990 } },
    'http_req_failed{phase:main}': { values: { rate: 0.005, passes: 3, fails: 597 } },
    dropped_iterations: { values: { count: 2, rate: 0.1 } },
    'dropped_iterations{phase:main}': { values: { count: 1, rate: 0.05 } },
    iterations: { values: { count: 1000, rate: 100 } },
  });

  test('NFR-013: mainPhaseSummary는 세 지표를 본구간 값으로 바꾸고 원래 값을 _all로 남기며 dropped_iterations는 합 그대로 둔다', () => {
    const input = SUMMARY_IN();
    const out = mainPhaseSummary(input);
    assert.notEqual(out, input);
    for (const name of ['http_req_duration', 'http_reqs', 'http_req_failed']) {
      assert.deepEqual(out[name], input[`${name}{phase:main}`], name);
      assert.deepEqual(out[`${name}_all`], input[name], `${name}_all`);
    }
    assert.deepEqual(out.dropped_iterations, { values: { count: 2, rate: 0.1 } });
    // 다른 지표(경로별 본구간 지표 포함)는 그대로 남는다
    assert.deepEqual(out['http_req_duration{phase:main,route:status}'], input['http_req_duration{phase:main,route:status}']);
    assert.deepEqual(out.iterations, input.iterations);
    // 결과 전체: 바꾼 셋·_all 셋 말고는 입력 키 그대로(본구간 꼬리표 지표도 남는다), 더 만든 키는 없다
    assert.deepEqual(out, {
      ...input,
      http_req_duration: input['http_req_duration{phase:main}'],
      http_reqs: input['http_reqs{phase:main}'],
      http_req_failed: input['http_req_failed{phase:main}'],
      http_req_duration_all: input.http_req_duration,
      http_reqs_all: input.http_reqs,
      http_req_failed_all: input.http_req_failed,
    });
  });

  test('NFR-013: mainPhaseSummary는 다른 키를 얕게 복사한다(값 객체를 그대로 둔다)', () => {
    const input = SUMMARY_IN();
    const out = mainPhaseSummary(input);
    for (const k of ['iterations', 'http_req_duration{phase:main,route:status}', 'dropped_iterations{phase:main}', 'dropped_iterations']) {
      assert.equal(out[k], input[k], `${k}는 같은 값 객체여야 한다(얕은 복사)`);
    }
  });

  test('NFR-013: mainPhaseSummary는 본구간·dropped_iterations 지표가 없으면 정한 기본값을 쓴다', () => {
    const noMain = {
      http_req_duration: { values: { avg: 10, max: 50 } },
      http_reqs: { values: { count: 5, rate: 1 } },
      http_req_failed: { values: { rate: 0 } },
    };
    const out = mainPhaseSummary(noMain);
    assert.deepEqual(out.http_reqs, { values: { count: 0, rate: 0 } });
    assert.deepEqual(out.http_req_duration, { values: {} });
    assert.deepEqual(out.http_req_failed, { values: {} });
    assert.deepEqual(out.dropped_iterations, { values: { count: 0, rate: 0 } });
    assert.deepEqual(out.http_req_duration_all, noMain.http_req_duration);
    assert.deepEqual(out.http_reqs_all, noMain.http_reqs);
    assert.deepEqual(out.http_req_failed_all, noMain.http_req_failed);
    // 일부만 있을 때
    const partial = mainPhaseSummary({ ...noMain, 'http_reqs{phase:main}': { values: { count: 3, rate: 0.5 } } });
    assert.deepEqual(partial.http_reqs, { values: { count: 3, rate: 0.5 } });
    assert.deepEqual(partial.http_req_duration, { values: {} });
    assert.deepEqual(partial.http_req_failed, { values: {} });
    // 빈 요약: 원래 지표가 없으면 _all을 만들지 않는다
    const empty = mainPhaseSummary({});
    assert.deepEqual(empty, {
      http_req_duration: { values: {} },
      http_reqs: { values: { count: 0, rate: 0 } },
      http_req_failed: { values: {} },
      dropped_iterations: { values: { count: 0, rate: 0 } },
    });
  });

  test('NFR-013: mainPhaseSummary는 원래 지표가 없는 이름에 _all을 만들지 않고, 본구간 dropped_iterations만 있으면 합을 기본값으로 둔다', () => {
    const onlyMain = {
      'http_req_duration{phase:main}': { values: { max: 9 } },
      'http_reqs{phase:main}': { values: { count: 4, rate: 2 } },
      http_req_failed: { values: { rate: 0.5 } },
      'dropped_iterations{phase:main}': { values: { count: 1, rate: 0.1 } },
    };
    const out = mainPhaseSummary(onlyMain);
    assert.equal(Object.hasOwn(out, 'http_req_duration_all'), false);
    assert.equal(Object.hasOwn(out, 'http_reqs_all'), false);
    assert.deepEqual(out.http_req_failed_all, { values: { rate: 0.5 } });
    assert.deepEqual(out.http_req_duration, { values: { max: 9 } });
    assert.deepEqual(out.http_reqs, { values: { count: 4, rate: 2 } });
    assert.deepEqual(out.http_req_failed, { values: {} });
    // dropped_iterations는 모든 구간의 합이다. 본구간 값으로 바꾸지 않는다
    assert.deepEqual(out.dropped_iterations, { values: { count: 0, rate: 0 } });
    assert.deepEqual(out['dropped_iterations{phase:main}'], { values: { count: 1, rate: 0.1 } });
    assert.deepEqual(Object.keys(out).sort(), [...Object.keys(onlyMain), 'http_req_duration', 'http_reqs', 'dropped_iterations', 'http_req_failed_all'].sort());
  });

  test('NFR-013: mainPhaseSummary는 입력을 바꾸지 않는다(깊게 얼린 입력도 받는다)', () => {
    const input = SUMMARY_IN();
    const before = structuredClone(input);
    const out = mainPhaseSummary(input);
    assert.deepEqual(input, before);
    assert.equal(out.http_reqs.values.count, 600);
    const frozen = deepFreeze(SUMMARY_IN());
    const out2 = mainPhaseSummary(frozen);
    assert.deepEqual(frozen, before);
    assert.deepEqual(out2.http_reqs_all, before.http_reqs);
  });
});

// ───────────────────────── k6 호환 ─────────────────────────

describe('k6 호환 — lib는 k6와 Node가 같이 읽는다', () => {
  test('NFR-013 ADR-0057: 네 lib 파일은 Node 내장 모듈·npm 꾸러미·require·Node 전역·Intl을 쓰지 않고 ./ 상대 경로 .mjs만 가져온다', () => {
    for (const file of ['records.mjs', 'users.mjs', 'seats.mjs', 'model.mjs']) {
      const src = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
      // 주석을 지운 코드만 본다
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
      const specs = [
        ...[...code.matchAll(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"]+)\1/g)].map((m) => m[2]),
        ...[...code.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)].map((m) => m[2]),
      ];
      for (const s of specs) assert.match(s, /^\.\/[\w.-]+\.mjs$/, `${file}: 가져오기 ${s}는 ./ 상대 경로 .mjs여야 한다`);
      assert.doesNotMatch(code, /['"`]node:/, `${file}: node: 모듈`);
      assert.doesNotMatch(code, /\brequire\s*\(/, `${file}: require`);
      assert.doesNotMatch(code, /\bimport\s*\(/, `${file}: 동적 import`);
      assert.doesNotMatch(code, /\bprocess\s*\./, `${file}: process`);
      assert.doesNotMatch(code, /\bBuffer\b/, `${file}: Buffer`);
      assert.doesNotMatch(code, /\b__dirname\b|\b__filename\b/, `${file}: CommonJS 전역`);
      // k6 런타임(Sobek)에는 Intl(ICU)이 없어 시간대 변환은 고정 +9시간 셈으로 해야 한다
      assert.doesNotMatch(code, /\bIntl\b|\btoLocale\w*\s*\(|\btimeZone\b/, `${file}: Intl·toLocale*·timeZone`);
    }
  });
});
