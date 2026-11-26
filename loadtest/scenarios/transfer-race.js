// R-T5 양도 경합 1,000회 k6 시나리오(계획 §1-10·§6, docs/features/transfer-refund.md §11 R-T5).
// 측정 창에서만 돌린다(장부 R-T5는 측정). 준비된 표 여러 장(TICKET_IDS)과 회차 여러 개(EVENT_IDS)를 돌아가며
// 요청·수락·거절·철회·돌려주기·회차 취소 여섯 갈래를 실제로 호출한다. 조회는 setup에서 계정당 1회만 한다.
// 실행: TICKET_IDS=id1,id2,... EVENT_IDS=ev1,ev2,... TICKET_BASE=... PURCHASE_BASE=... k6 run loadtest/scenarios/transfer-race.js
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { envInt, envStr, jsonOf } from './common.js';

const TICKET_BASE = envStr('TICKET_BASE', 'http://ticket-svc.default.svc.cluster.local:8080');
const PURCHASE_BASE = envStr('PURCHASE_BASE', 'http://purchase-svc.default.svc.cluster.local:8080');
const TICKET_IDS = envStr('TICKET_IDS', '');
const TICKET_POOL = TICKET_IDS.split(',').map((s) => s.trim()).filter(Boolean);
const EVENT_IDS = envStr('EVENT_IDS', '');
const EVENT_POOL = EVENT_IDS.split(',').map((s) => s.trim()).filter(Boolean);
const USER_A = envStr('LOAD_USER_A', '');
const USER_B = envStr('LOAD_USER_B', '');
const MEMBER_CODE_B = envStr('LOAD_MEMBER_CODE_B', 'QZ7-4K2M');
const REAUTH_A = envStr('LOAD_REAUTH_TOKEN_A', 'load');
const REAUTH_B = envStr('LOAD_REAUTH_TOKEN_B', 'load');
const INTERNAL_TOKEN = envStr('PEAKET_INTERNAL_TOKEN', '');
const RUN_TAG = envStr('RUN_TAG', 'local');
const TRANSFER_RACE_ITERATIONS = envInt('TRANSFER_RACE_ITERATIONS', 1000);

const accepted = new Counter('transfer_accept_ok');
const rejected = new Counter('transfer_reject_ok');
const withdrawn = new Counter('transfer_withdraw_ok');
const returned = new Counter('transfer_return_ok');
const cancelled = new Counter('transfer_event_cancel_ok');
const conflicts = new Counter('transfer_expected_conflict');
const wrong = new Counter('transfer_wrong_result');
const duration = new Trend('transfer_roundtrip_ms', true);
const success = new Rate('transfer_success');

export const options = {
  scenarios: {
    transfer_race: {
      executor: 'per-vu-iterations',
      vus: Math.max(1, Math.min(50, Math.ceil(TRANSFER_RACE_ITERATIONS / 20))),
      iterations: Math.max(1, Math.ceil(TRANSFER_RACE_ITERATIONS / Math.max(1, Math.min(50, Math.ceil(TRANSFER_RACE_ITERATIONS / 20))))),
      maxDuration: '10m',
      tags: { scenario: 'transfer-race', run: RUN_TAG },
    },
  },
  thresholds: {
    transfer_wrong_result: ['count==0'],
    http_req_failed: ['rate<0.01'],
  },
};

const headers = (accountId) => ({ 'content-type': 'application/json', 'x-user-id': accountId, 'x-session-id': `${RUN_TAG}-session`, 'x-user-aud': 'fan' });
const internalHeaders = () => ({ 'content-type': 'application/json', ...(INTERNAL_TOKEN ? { 'x-peaket-internal-token': INTERNAL_TOKEN } : {}) });
const uuid = () => {
  const b = [];
  for (let i = 0; i < 16; i += 1) b.push(Math.floor(Math.random() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** 조회 한도(계정당 10회/60분)에 걸리지 않게 받는 사람 참조를 한 번만 만든다 */
export function setup() {
  if (TICKET_POOL.length === 0) throw new Error('TICKET_IDS(준비된 표 ID 목록)가 필요하다');
  if (EVENT_POOL.length === 0) throw new Error('EVENT_IDS(회차 ID 목록)가 필요하다');
  const lookup = http.post(`${TICKET_BASE}/v1/transfer-recipient-lookups`, JSON.stringify({ memberCode: MEMBER_CODE_B }), { headers: headers(USER_A) });
  if (lookup.status !== 200) throw new Error(`받는 사람 조회 실패: ${lookup.status}`);
  return { recipientRef: jsonOf(lookup).recipientRef };
}

export default function transferRace(data) {
  const i = exec.scenario.iterationInTest;
  const ticketId = TICKET_POOL[i % TICKET_POOL.length];
  const eventId = EVENT_POOL[i % EVENT_POOL.length];
  const started = Date.now();
  const offerId = uuid();
  const created = http.post(`${TICKET_BASE}/v1/tickets/${ticketId}/transfers`, JSON.stringify({ recipientRef: data.recipientRef }), {
    headers: { ...headers(USER_A), 'idempotency-key': offerId, 'x-reauth-token': REAUTH_A },
  });
  const ok = created.status === 201 || created.status === 409;
  if (!ok) wrong.add(1);
  if (created.status === 409) conflicts.add(1);

  const mode = i % 6;
  if (mode === 1 || mode === 4 || mode === 5) {
    const r = http.post(`${TICKET_BASE}/v1/transfers/${offerId}/acceptance`, '{}', { headers: { ...headers(USER_B), 'idempotency-key': uuid() } });
    if (r.status === 200) accepted.add(1);
  } else if (mode === 2) {
    const r = http.post(`${TICKET_BASE}/v1/transfers/${offerId}/rejection`, '{}', { headers: { ...headers(USER_B), 'idempotency-key': uuid() } });
    if (r.status === 200) rejected.add(1);
  } else if (mode === 3) {
    const r = http.post(`${TICKET_BASE}/v1/transfers/${offerId}/withdrawal`, '{}', { headers: { ...headers(USER_A), 'idempotency-key': uuid() } });
    if (r.status === 200) withdrawn.add(1);
  }

  // 돌려주기: 수락한 표를 받은 사람이 결제자에게 돌려준다(같은 표의 다음 반복은 다른 표를 고른다)
  if (mode === 4) {
    const r = http.post(`${TICKET_BASE}/v1/tickets/${ticketId}/returns`, '{}', {
      headers: { ...headers(USER_B), 'idempotency-key': uuid(), 'x-reauth-token': REAUTH_B },
    });
    if (r.status === 200) returned.add(1);
  }

  // 회차 취소: purchase 내부 입구가 ticket-svc EventCancelTickets로 그 회차 요청을 철회·환급한다
  if (mode === 5) {
    const r = http.post(
      `${PURCHASE_BASE}/internal/v1/event-refunds`,
      JSON.stringify({ eventId, requestId: uuid(), fault: 'ORGANIZER', ruledBy: 'load-commander', confirmedBy: 'load-operator', kind: 'CANCEL' }),
      { headers: internalHeaders() },
    );
    if (r.status === 200 || r.status === 202) cancelled.add(1);
  }

  duration.add(Date.now() - started);
  success.add(ok);
  check(created, { 'request 201 or expected 409': (r) => r.status === 201 || r.status === 409 });
}

export { accepted, cancelled, conflicts, rejected, returned, withdrawn };
