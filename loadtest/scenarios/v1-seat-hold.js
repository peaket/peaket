// K2·K3 좌석 홀드 시나리오의 v1 쪽(S-T1·S-T10, docs/verification.md §3.9 'v1 경로'). 실행: node loadtest/run.mjs v1 seat-hold …(인자는 v0 seat-hold와 같다)
// 준비(setup, 측정에서 뺌): 가상 사용자 USERS명을 사전 검증·진입·차례 기다림·입장 확정·구매 세션 열기(좌석 스냅샷)까지 묶음으로 보낸다(http.batch, PREP_BATCH명씩).
// 동시 입장 목표가 5,000명이라(v1 입장 제어, §3.9 '준비 구간의 입장') USERS는 5,000명 이하다.
// 그 뒤 홀드를 정한 도착률로 보낸다(route:hold, phase:warm → main). 좌석 고르기는 v0와 같다(spread·hot·crossed, lib/seats.mjs의 격자를 v1 좌석 UUID로 바꾼다).
// 구매 요청은 서명한다(일련번호는 시각 기반, lib/v1.mjs). 같은 구매 세션을 두 VU가 함께 쓰지 않게 사용자 u는 u mod USERS == VU 번호 mod USERS인 VU만 쓴다.
// 발생기를 나누면(k6 실행 구간) setup()이 발생기마다 따로 돈다. 그래서 준비는 그 발생기의 사용자 몫(lib/v1.mjs segmentUsers)만 하고, 홀드도 그 몫의 사용자를
// 발생기 안 VU 번호(idInInstance)로 고른다(VU 번호 idInTest는 발생기 사이에 줄무늬로 나뉘어 몫과 맞지 않는다, BAT-025 측정에서 찾은 결함).
// 잡은 홀드는 정한 시간(기본 0초) 뒤 놓는다(route:release, DELETE /v1/holds/{holdId}). --keep이면 놓지 않는다.
// 환경 값: EVENT_ID USERS RATE WARM_S MAIN_S MODE HOLD_SIZE HOT_COUNT PAIRS RELEASE_MS KEEP SECTIONS ROWS PER_ROW PRE_VUS MAX_VUS PREP_BATCH PREP_TIMEOUT_S
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { openPhases } from '../lib/model.mjs';
import { pickHoldSeats } from '../lib/seats.mjs';
import { ownedUser, segmentUsers, v1Headers, v1SeatIds } from '../lib/v1.mjs';
import { baseOptions } from './common.js';
import { envInt, envStr, jsonOf, markScenarios, PURCHASE_BASE, QUEUE_BASE, RUN_TAG, scenarioErrors, STATE_BASE, V1Session, writeSummary } from './v1-common.js';

export { markEnd, markStart } from './v1-common.js';

const EVENT_ID = envStr('EVENT_ID');
const USERS = envInt('USERS');
const RATE = envInt('RATE');
const WARM_S = envInt('WARM_S');
const MAIN_S = envInt('MAIN_S');
/** 모든 발생기가 준비를 마친 뒤 같은 시각에 예열을 시작하는 절대 시각(ms, 0이면 기다리지 않는다, BAT-028 D) */
const WARM_START_AT_MS = envInt('WARM_START_AT_MS', 0);
const MODE = envStr('MODE', 'spread');
const HOLD_SIZE = envInt('HOLD_SIZE', 2);
const HOT_COUNT = envInt('HOT_COUNT', 1);
const PAIRS = envInt('PAIRS', 1);
const RELEASE_MS = envInt('RELEASE_MS', 0);
const KEEP = envInt('KEEP', 0) === 1;
const GRID = { sections: envStr('SECTIONS').split(','), rows: envInt('ROWS'), perRow: envInt('PER_ROW') };
const PRE_VUS = envInt('PRE_VUS', 50);
const MAX_VUS = envInt('MAX_VUS', 500);
const PREP_BATCH = envInt('PREP_BATCH', 100);
const PREP_TIMEOUT_S = envInt('PREP_TIMEOUT_S', 900);
const CLIENT_KEY = envStr('CLIENT_KEY');
/** 이 발생기가 맡는 사용자 [MINE_FROM, MINE_TO)(실행 구간이 없으면 전체) */
const [MINE_FROM, MINE_TO] = segmentUsers(USERS, __ENV.K6_EXECUTION_SEGMENT);
const MINE = MINE_TO - MINE_FROM;

const holds = openPhases({ exec: 'hold', rate: RATE, warmS: WARM_S, mainS: MAIN_S, startS: 0, preVUs: PRE_VUS, maxVUs: MAX_VUS });

export const options = {
  ...baseOptions({ warm: holds.warm, main: holds.main, ...markScenarios(WARM_S, WARM_S + MAIN_S) }, ['hold', 'release']),
  setupTimeout: `${PREP_TIMEOUT_S}s`,
};
// 준비 진입의 시행·실패(발생기를 나눠도 사람마다 한 번인지 실행 도구·리허설이 요약에서 본다)
options.thresholds['http_reqs{phase:prep,route:entry}'] = ['count>=0'];
options.thresholds['http_req_failed{phase:prep,route:entry}'] = ['rate>=0'];

const json = (i) => ({ headers: v1Headers(RUN_TAG, i, { json: true }), tags: { phase: 'prep' } });
const post = (url, i, body, route) => ['POST', url, JSON.stringify(body), { ...json(i), tags: { phase: 'prep', route } }];

/** 준비: 이 발생기의 사용자 몫을 묶음마다 사전 검증 → 진입 → 차례 → 입장 확정 → 구매 세션 열기. 입장 토큰 목록(번호 = 가상 사용자, 몫 밖은 null)을 돌려준다 */
export function setup() {
  if (USERS > 5000) throw new Error('USERS는 5,000명 이하다(동시 입장 목표 5,000명)');
  if (MINE < 1) throw new Error(`이 발생기의 사용자 몫이 비었다(${MINE_FROM}~${MINE_TO})`);
  const tokens = new Array(USERS).fill(null);
  for (let from = MINE_FROM; from < MINE_TO; from += PREP_BATCH) {
    const ids = Array.from({ length: Math.min(PREP_BATCH, MINE_TO - from) }, (_, k) => from + k);
    const pv = http.batch(ids.map((i) => post(`${QUEUE_BASE}/v1/queues/${EVENT_ID}/pre-verifications`, i, {}, 'preverify')));
    const en = http.batch(ids.map((i, k) => post(`${QUEUE_BASE}/v1/queues/${EVENT_ID}/entries`, i, { preverifyToken: jsonOf(pv[k])?.preverifyToken ?? '' }, 'entry')));
    const entries = en.map((r) => (r.status === 201 ? jsonOf(r) : undefined));
    const maxSeq = Math.max(...entries.map((e) => e?.seq ?? 0));
    const segment = Math.floor((maxSeq - 1) / 1000);
    const until = Date.now() + 120_000;
    for (;;) {
      const s = jsonOf(http.get(`${STATE_BASE}/v1/queues/${EVENT_ID}/segment-states/${Math.max(segment, 0)}.json`, { tags: { phase: 'prep', route: 'status' } }));
      if ((s?.serving ?? -1) >= maxSeq || Date.now() > until) break;
      sleep(0.5);
    }
    let left = ids.map((i, k) => ({ i, e: entries[k] })).filter((x) => x.e);
    for (let attempt = 0; attempt < 20 && left.length > 0; attempt++) {
      const ad = http.batch(left.map((x) => post(`${QUEUE_BASE}/v1/queues/${EVENT_ID}/admission`, x.i, { queueTicket: x.e.queueTicket }, 'admission')));
      const next = [];
      left.forEach((x, k) => {
        const b = jsonOf(ad[k]);
        if (b?.status === 'ADMITTED') tokens[x.i] = b.admissionToken;
        else next.push(x);
      });
      left = next;
      if (left.length) sleep(0.5);
    }
    const open = ids.filter((i) => tokens[i]);
    const sn = http.batch(open.map((i) => ['GET', `${PURCHASE_BASE}/v1/events/${EVENT_ID}/seatmap-snapshot`, null, { headers: { ...v1Headers(RUN_TAG, i), 'x-admission-token': tokens[i], 'x-client-ephemeral-key': CLIENT_KEY }, tags: { phase: 'prep', route: 'snapshot' } }]));
    open.forEach((i, k) => {
      if (sn[k].status !== 200) tokens[i] = null;
    });
  }
  const ready = tokens.filter(Boolean).length;
  if (ready < MINE) throw new Error(`준비 구간에 구매 세션을 연 가상 사용자가 ${ready}/${MINE}명이다(이 발생기 몫 ${MINE_FROM}~${MINE_TO})`);
  // 모든 발생기가 준비를 마치고 같은 시각에 예열을 시작한다(BAT-028 D). 실행 도구가 이 시각을 부하 시작으로 센다
  if (WARM_START_AT_MS > 0) {
    const waitMs = WARM_START_AT_MS - Date.now();
    if (waitMs > 0) sleep(waitMs / 1000);
  }
  return { tokens };
}

/** VU 안의 구매 세션(사용자 번호 → 서명기) */
const sessions = new Map();

export function hold(data) {
  // 사용자는 이 발생기가 준비한 몫 안에서만, 발생기 안 VU 번호로 고른다
  const k = ownedUser(MINE, MINE, exec.vu.idInInstance, Math.random());
  if (k < 0) return;
  const u = MINE_FROM + k;
  let s = sessions.get(u);
  if (!s) sessions.set(u, (s = new V1Session(u, data.tokens[u])));
  const seatIds = v1SeatIds(GRID, pickHoldSeats(GRID, { mode: MODE, size: HOLD_SIZE, hotCount: HOT_COUNT, pairs: PAIRS, u1: Math.random(), u2: Math.random() }));
  const r = s.call('POST', `/v1/events/${EVENT_ID}/holds`, { seatIds }, { route: 'hold', expected: [201, 409, 422] });
  if (r.status === 422 && String(r.body).includes('invalid-seat')) scenarioErrors.add(1);
  if (r.status === 401) scenarioErrors.add(1);
  if (r.status !== 201) return;
  const holdId = jsonOf(r)?.holdId;
  if (typeof holdId !== 'string' || KEEP) return;
  if (RELEASE_MS > 0) sleep(RELEASE_MS / 1000);
  const d = s.call('DELETE', `/v1/holds/${holdId}`, undefined, { route: 'release', expected: [204] });
  check(d, { '해제 204': (x) => x.status === 204 });
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
