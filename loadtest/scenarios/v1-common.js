// v1 시나리오가 함께 쓰는 k6 부분(docs/verification.md §3.9 'v1 경로', BUILD_ORDER PRF-215). k6에서만 돈다. 계산은 ../lib/v1.mjs·purchase-auth.mjs에 있다.
// 게이트웨이가 없어 k6가 합본 Service로 바로 보내고 신원 머리를 넣는다(§3.8 '게이트웨이 없음'). 대기 상태 파일은 nginx 캐시(STATE_BASE)로 읽는다.
// 환경 값(실행 도구가 /work/run.env로 넘긴다): QUEUE_BASE STATE_BASE PURCHASE_BASE EVENT_ID RUN_TAG OUT_DIR CLIENT_KEY SHARED_SECRET_HEX CONSENT_VERSION
import http from 'k6/http';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { overTargets } from '../lib/targets.mjs';
import { admitResult, queueOpRecord, resultOf } from '../lib/records.mjs';
import { accountRef } from '../lib/users.mjs';
import { hexToBytes, PurchaseSigner } from '../lib/purchase-auth.mjs';
import { nextPurchaseSeq, preverifyResult, v1Headers } from '../lib/v1.mjs';
import { emit, envStr, jsonOf, scenarioErrors } from './common.js';

export { emit, envInt, envStr, jsonOf, markEnd, markScenarios, markStart, scenarioErrors, writeSummary } from './common.js';

export const QUEUE_BASE = envStr('QUEUE_BASE', 'http://bundle.v1.svc.cluster.local:8080');
export const STATE_BASE = envStr('STATE_BASE', 'http://queue-state-cache.v1.svc.cluster.local:8080');
export const PURCHASE_BASE = envStr('PURCHASE_BASE', 'http://bundle.v1.svc.cluster.local:8081');
/** BAT-032: 홀드 전용 워커(별도 이벤트 루프). 값이 없으면 예전처럼 구매 포트로 보낸다 */
export const HOLD_BASE = envStr('HOLD_BASE', PURCHASE_BASE);
export const RUN_TAG = envStr('RUN_TAG', 'local');
const CLIENT_KEY = envStr('CLIENT_KEY', '');
const SHARED_SECRET = __ENV.SHARED_SECRET_HEX ? hexToBytes(__ENV.SHARED_SECRET_HEX) : new Uint8Array(0);
export const CONSENT_VERSION = envStr('CONSENT_VERSION', 'lt-v1-2026-11');

const overTarget = new Counter('over_target');

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
/** k6/crypto로 만든 원시 함수(Node 시험은 node:crypto로 같은 것을 넘긴다, loadtest/test/purchase-auth.test.mjs) */
export const k6Crypto = {
  hmacSha256: (key, data) => hexToBytes(crypto.hmac('sha256', ab(key), ab(data), 'hex')),
  sha256: (data) => hexToBytes(crypto.sha256(ab(data), 'hex')),
};

/** 멱등 키(UUID v4) */
export function uuid4() {
  const b = new Uint8Array(crypto.randomBytes(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * 요청 하나. route 꼬리표를 달고 expected 상태만 실패가 아닌 것으로 센다. phase를 주면 구간 꼬리표를 덮는다(반복 안의 입장 준비를 본구간 판정에서 빼려고).
 * 경로 목표(lib/targets.mjs)가 있으면 목표를 넘은 수를 센다
 * @param {string} base @param {string} method @param {string} path
 * noTarget이면 이 요청의 시간으로 목표를 세지 않는다(부르는 쪽이 여러 요청에 걸친 시간으로 센다, countOverTarget)
 * @param {{ i: number, route: string, expected: number[], body?: string, headers?: Record<string, string>, phase?: string, timeout?: string, anonymous?: boolean, noTarget?: boolean }} o
 */
export function vcall(base, method, path, o) {
  const headers = { ...(o.anonymous ? {} : v1Headers(RUN_TAG, o.i, { json: o.body !== undefined })), ...(o.headers ?? {}) };
  if (o.anonymous && o.body !== undefined) headers['content-type'] = 'application/json';
  const tags = { route: o.route, ...(o.phase ? { phase: o.phase } : {}) };
  const r = http.request(method, `${base}${path}`, o.body === undefined ? null : o.body, { headers, tags, responseCallback: http.expectedStatuses(...o.expected), ...(o.timeout ? { timeout: o.timeout } : {}) });
  if (!o.noTarget) for (const le of overTargets(o.route, r.timings.duration)) overTarget.add(1, { ...tags, le: String(le) });
  return r;
}

/** 여러 요청에 걸친 시간(ms)으로 경로 목표를 넘었는지 센다. over가 참이면 시간과 상관없이 모든 목표를 넘은 것으로 센다(끝 상태가 아닌 빠른 답 등) */
export function countOverTarget(route, durationMs, tags, over = false) {
  for (const le of over ? overTargets(route, Number.MAX_SAFE_INTEGER) : overTargets(route, durationMs)) overTarget.add(1, { route, ...tags, le: String(le) });
}

const segmentOf = (seq) => Math.floor((seq - 1) / 1000);

/** 사전 검증 → 진입. 진입 결과(대기표·순번·구역)를 돌려준다(실패면 undefined). record면 시험 기록 queue_entry를 낸다 */
export function enterV1(eventId, i, o = {}) {
  const pv = vcall(QUEUE_BASE, 'POST', `/v1/queues/${eventId}/pre-verifications`, { i, route: 'preverify', body: '{}', expected: [201], ...(o.phase ? { phase: o.phase } : {}) });
  const preverifyToken = pv.status === 201 ? jsonOf(pv)?.preverifyToken : undefined;
  if (!check(pv, { '사전 검증 201': () => typeof preverifyToken === 'string' })) {
    // 사전 검증에서 멈춘 사람도 실패한 진입으로 기록한다(진입 점검이 남은 사람만으로 통과하지 않게, 코드 리뷰 H3)
    if (o.record) {
      const now = Date.now();
      emit(queueOpRecord('queue_entry', { eventId, accountRef: accountRef(RUN_TAG, i), requestId: `pv-${RUN_TAG}-${i}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}`, result: preverifyResult(pv.status, preverifyToken), seq: null, generation: null, startedMs: now - Math.max(0, Math.round(pv.timings.duration)), endedMs: now }));
    }
    return undefined;
  }
  const started = Date.now();
  const r = vcall(QUEUE_BASE, 'POST', `/v1/queues/${eventId}/entries`, { i, route: 'entry', body: JSON.stringify({ preverifyToken }), expected: [201], ...(o.phase ? { phase: o.phase } : {}) });
  const ended = Date.now();
  const body = r.status === 201 ? jsonOf(r) : undefined;
  const result = resultOf(r.status, [201]);
  if (o.record) {
    emit(
      queueOpRecord('queue_entry', {
        eventId,
        accountRef: accountRef(RUN_TAG, i),
        requestId: `ent-${RUN_TAG}-${i}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}`,
        result: result === 'ok' && (body?.seq === undefined || body?.generation === undefined) ? 'unknown' : result,
        seq: body?.seq ?? null,
        generation: body?.generation ?? null,
        startedMs: started,
        endedMs: Math.max(ended, started),
      }),
    );
  }
  if (!check(r, { '진입 201': () => typeof body?.queueTicket === 'string' && Number.isSafeInteger(body?.seq) })) return undefined;
  return { queueTicket: body.queueTicket, seq: body.seq, generation: body.generation, segment: body.segment ?? segmentOf(body.seq) };
}

/** 대기 상태 파일 하나(캐시로). 본문의 serving을 돌려준다(못 읽으면 -1) */
export function stateServing(eventId, segment, o = {}) {
  const r = vcall(STATE_BASE, 'GET', `/v1/queues/${eventId}/segment-states/${segment}.json`, { i: 0, route: 'status', expected: [200], anonymous: true, ...(o.phase ? { phase: o.phase } : {}) });
  check(r, { '대기 상태 200': (x) => x.status === 200 });
  const s = r.status === 200 ? jsonOf(r) : undefined;
  return { serving: Number.isSafeInteger(s?.serving) ? s.serving : -1, pollHintMs: Number.isSafeInteger(s?.pollHintMs) ? s.pollHintMs : 500 };
}

/** 입장 확정 한 번. 본문을 돌려준다. record면 시험 기록 queue_admit(순번·세대는 진입 결과)을 낸다 */
export function admitV1(eventId, i, entry, o = {}) {
  const started = Date.now();
  const r = vcall(QUEUE_BASE, 'POST', `/v1/queues/${eventId}/admission`, { i, route: 'admission', body: JSON.stringify({ queueTicket: entry.queueTicket }), expected: [200], ...(o.phase ? { phase: o.phase } : {}) });
  const ended = Date.now();
  const body = jsonOf(r);
  let result = admitResult(r.status, body?.status);
  if (result === 'ok' && !Number.isSafeInteger(entry.seq)) result = 'unknown';
  if (o.record) {
    emit(
      queueOpRecord('queue_admit', {
        eventId,
        accountRef: accountRef(RUN_TAG, i),
        requestId: `adm-${RUN_TAG}-${i}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}`,
        result,
        seq: result === 'ok' ? entry.seq : null,
        generation: result === 'ok' ? entry.generation : null,
        startedMs: started,
        endedMs: Math.max(ended, started),
      }),
    );
  }
  return body;
}

/**
 * 진입 → 차례가 올 때까지 대기 상태 파일을 읽고(서버가 준 간격) → 입장 확정 → 구매 세션 열기(좌석 스냅샷, 클라이언트 키). 모두 phase 꼬리표를 단다.
 * 성공하면 { admissionToken, entry }, 실패하면 undefined(시나리오 오류로 센다)
 */
export function admitAndOpen(eventId, i, o = { phase: 'prep', waitS: 120 }) {
  const entry = enterV1(eventId, i, { phase: o.phase, record: o.record });
  if (!entry) return fail();
  const until = Date.now() + o.waitS * 1000;
  for (;;) {
    const s = stateServing(eventId, entry.segment, { phase: o.phase });
    if (s.serving >= entry.seq) break;
    if (Date.now() > until) return fail();
    sleep(Math.min(Math.max(s.pollHintMs, 200), 5000) / 1000);
  }
  let token;
  while (Date.now() <= until) {
    const b = admitV1(eventId, i, entry, { phase: o.phase, record: o.record });
    if (b?.status === 'ADMITTED' && typeof b.admissionToken === 'string') {
      token = b.admissionToken;
      break;
    }
    sleep(b?.retryAfterMs ? Math.min(b.retryAfterMs, 2000) / 1000 : 0.5);
  }
  if (!token) return fail();
  const snap = vcall(PURCHASE_BASE, 'GET', `/v1/events/${eventId}/seatmap-snapshot`, { i, route: 'snapshot', expected: [200], headers: { 'x-admission-token': token, 'x-client-ephemeral-key': CLIENT_KEY }, phase: o.phase });
  if (!check(snap, { '구매 세션 열기 200': (x) => x.status === 200 })) return fail();
  return { admissionToken: token, entry };
}

function fail() {
  scenarioErrors.add(1);
  return undefined;
}

/**
 * 구매 세션 하나의 서명 요청 도우미. 일련번호는 시각 기반으로 늘 커진다(lib/v1.mjs nextPurchaseSeq, 같은 세션을 VU가 차례로 이어 써도 앞 번호보다 크다)
 */
export class V1Session {
  constructor(i, admissionToken) {
    this.i = i;
    this.token = admissionToken;
    this.signer = new PurchaseSigner(k6Crypto, SHARED_SECRET, admissionToken);
  }

  /** 서명한 요청(본문은 JSON 글 그대로 보낸다) */
  call(method, path, bodyObj, o) {
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    this.signer.seq = nextPurchaseSeq(this.signer.seq, Date.now()) - 1;
    const sig = this.signer.sign(method, path, body);
    return vcall(o.base ?? PURCHASE_BASE, method, path, {
      i: this.i,
      route: o.route,
      expected: o.expected,
      ...(bodyObj === undefined ? {} : { body }),
      headers: { ...sig, 'x-admission-token': this.token, 'idempotency-key': uuid4() },
      ...(o.phase ? { phase: o.phase } : {}),
      ...(o.timeout ? { timeout: o.timeout } : {}),
    });
  }
}
