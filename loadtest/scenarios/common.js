// 시나리오가 함께 쓰는 k6 부분(docs/verification.md §3.9). k6에서만 돈다(k6 모듈을 가져온다). 계산은 ../lib/*.mjs에 있다.
// 환경 값은 실행 도구가 /work/run.env로 넘긴다(loadtest/runner/manifests.mjs runEnvFile).
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { handleSummary as ledgerSummary } from '../../tools/perf-ledger/k6-summary.js';
import { mainPhaseSummary, phaseThresholds } from '../lib/model.mjs';
import { markRecord, queueOpRecord, resultOf, admitResult } from '../lib/records.mjs';
import { accountRef, fanHeaders, userIp } from '../lib/users.mjs';

/** 시나리오가 잘못 보낸 요청 수(잘못된 좌석 ID, 준비 구간 입장 실패). 하나라도 있으면 실행 도구가 그 실행을 무효로 한다(withScenarioErrors) */
export const scenarioErrors = new Counter('scenario_errors');

/** 정수 환경 값(없으면 기본값, 틀리면 시작하지 않는다) */
export function envInt(name, def) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') {
    if (def === undefined) throw new Error(`환경 값 ${name}이 없다`);
    return def;
  }
  if (!/^\d+$/.test(raw)) throw new Error(`환경 값 ${name}은 0 이상 정수다`);
  return Number(raw);
}

export function envStr(name, def) {
  const v = __ENV[name];
  if (v === undefined || v === '') {
    if (def === undefined) throw new Error(`환경 값 ${name}이 없다`);
    return def;
  }
  return v;
}

export const BASE = envStr('BASE', 'https://v0-gateway.v0.svc.cluster.local:8443');
export const ORIGIN = envStr('ORIGIN', 'https://127.0.0.1:8443');
export const RUN_TAG = envStr('RUN_TAG', 'local');
export const OUT_DIR = envStr('OUT_DIR', '.');
const USERS_FILE = envStr('USERS_FILE', '/work/users.json');

/** 가상 사용자 토큰(번호 → 토큰). 가상 사용자마다 사본을 만들지 않게 SharedArray로 읽는다 */
const tokens = new SharedArray('tokens', () => JSON.parse(open(USERS_FILE)));
export const userCount = () => tokens.length;

/** 가상 사용자 i */
export function user(i) {
  return { i, token: tokens[i], ip: userIp(i) };
}

/**
 * 입구로 보내는 요청 하나. route 꼬리표를 달고, expected 상태만 실패가 아닌 것으로 센다(http_req_failed).
 * 업무상 기대한 거절(홀드의 409·422)은 expected에 넣는다(docs/verification.md §3.9 '오픈 모델과 요약')
 */
export function call(method, path, o) {
  const headers = fanHeaders({ token: o.user.token, ip: o.user.ip, origin: ORIGIN, write: method !== 'GET', json: o.body !== undefined });
  return http.request(method, `${BASE}${path}`, o.body === undefined ? null : JSON.stringify(o.body), {
    headers,
    tags: { route: o.route },
    responseCallback: http.expectedStatuses(...o.expected),
  });
}

/** 응답 본문 JSON(못 읽으면 undefined) */
export function jsonOf(r) {
  try {
    return r.body ? JSON.parse(r.body) : undefined;
  } catch {
    return undefined;
  }
}

/** 시험 기록 한 줄을 콘솔(--console-output)로 낸다 */
export function emit(record) {
  console.log(JSON.stringify(record));
}

/** 요청 ID(실행·가상 사용자·반복마다 다르다) */
export const requestId = (prefix, i) => `${prefix}-${RUN_TAG}-${i}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}`;

/** 대기열 진입 한 번과 시험 기록 queue_entry */
export function enterQueue(eventId, u, record = true) {
  const started = Date.now();
  const r = call('POST', `/v1/queues/${eventId}/entries`, { user: u, route: 'entry', expected: [201] });
  const ended = Date.now();
  const body = r.status === 201 ? jsonOf(r) : undefined;
  const result = resultOf(r.status, [201]);
  if (record) emit(
    queueOpRecord('queue_entry', {
      eventId,
      accountRef: accountRef(RUN_TAG, u.i),
      requestId: requestId('ent', u.i),
      result: result === 'ok' && (body?.seq === undefined || body?.generation === undefined) ? 'unknown' : result,
      seq: body?.seq ?? null,
      generation: body?.generation ?? null,
      startedMs: started,
      endedMs: Math.max(ended, started),
    }),
  );
  check(r, { '진입 201': (x) => x.status === 201 });
  return r;
}

/** 입장 확정 한 번과 시험 기록 queue_admit. 본문 status를 돌려준다 */
export function admitQueue(eventId, u, record = true) {
  const started = Date.now();
  const r = call('POST', `/v1/queues/${eventId}/admission`, { user: u, route: 'admission', expected: [200] });
  const ended = Date.now();
  const body = jsonOf(r);
  const seq = Number.isSafeInteger(body?.seq) && body.seq >= 0 ? body.seq : null;
  let result = admitResult(r.status, body?.status);
  if (result === 'ok' && seq === null) result = 'unknown';
  if (record) emit(
    queueOpRecord('queue_admit', {
      eventId,
      accountRef: accountRef(RUN_TAG, u.i),
      requestId: requestId('adm', u.i),
      result,
      seq,
      // v0는 세대가 늘 0이다(queue-admission §13 '시험 기록')
      generation: seq === null ? null : 0,
      startedMs: started,
      endedMs: Math.max(ended, started),
    }),
  );
  return body?.status;
}

/** 본구간 경계 표시(실행 도구가 발생기 지표의 창으로 쓴다) */
export function markScenarios(mainStartS, mainEndS) {
  const one = (exec, at) => ({ executor: 'shared-iterations', vus: 1, iterations: 1, startTime: `${at}s`, exec, tags: { phase: 'ctl' } });
  return { mark_start: one('markStart', mainStartS), mark_end: one('markEnd', mainEndS) };
}
export function markStart() {
  emit(markRecord('main_start', Date.now()));
}
export function markEnd() {
  emit(markRecord('main_end', Date.now()));
}

/** k6 공통 옵션 */
export function baseOptions(scenarios, routes) {
  // 반복을 시작하지 못한 수를 구간마다도 남긴다(무효일 때 어느 구간인지 보려고). 판정은 합계로 한다
  const perScenario = Object.fromEntries(Object.keys(scenarios).map((name) => [`dropped_iterations{scenario:${name}}`, ['count>=0']]));
  return {
    scenarios,
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    thresholds: { ...phaseThresholds(routes), ...perScenario },
  };
}

/** 요약: 본구간 값으로 바꿔 OUT_DIR/summary.json에 쓴다(tools/perf-ledger/k6-summary.js). 본구간 요청률은 본구간 길이로 다시 나눈다 */
export function writeSummary(data, mainS) {
  const out = ledgerSummary({ ...data, metrics: mainPhaseSummary(data.metrics, mainS) });
  return { [`${OUT_DIR}/summary.json`]: out['summary.json'], stdout: out.stdout };
}

/** 준비 구간(측정에서 뺌): 가상 사용자를 진입시키고, 차례가 오면 입장시킨다. 회차는 부르는 속도를 크게 열어 둔다 */
export function prepScenarios(users, rate) {
  const entryS = Math.ceil(users / rate);
  // 진입은 짧고, 입장 확정은 차례가 아직이면 0.5초씩 기다려 다시 묻는다(대개 한 번에 끝난다)
  const vus = Math.max(10, Math.min(rate, 1000));
  const phase = (exec, start) => ({
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration: `${entryS}s`,
    startTime: `${start}s`,
    preAllocatedVUs: vus,
    maxVUs: vus * 4,
    exec,
    tags: { phase: 'prep' },
  });
  // 입장 루프는 1초 칸마다 부른다. 진입이 끝나고 2초 뒤 입장 확정을 시작한다
  return { scenarios: { prep_entry: phase('prepEntry', 0), prep_admit: phase('prepAdmit', entryS + 2) }, prepS: 2 * entryS + 3 };
}
