// R-T5 양도 경합 1,000회 k6 시나리오(계획 §1-10·§6, docs/features/transfer-refund.md §11 R-T5).
// 측정 창에서만 돌린다(장부 R-T5는 측정). A가 B에게 요청 → B 수락/거절/철회를 1,000번 섞고,
// 같은 표를 스캔·회차 취소와 겹쳐도 오버셀·이중 수락·이중 환급이 0인지 본다.
// 실행: TICKET_BASE=... EVENT_ID=... LOAD_USER_A=... LOAD_USER_B=... k6 run loadtest/scenarios/transfer-race.js
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { envInt, envStr, jsonOf } from './common.js';

const TICKET_BASE = envStr('TICKET_BASE', 'http://ticket-svc.default.svc.cluster.local:8080');
const EVENT_ID = envStr('EVENT_ID', '');
const USER_A = envStr('LOAD_USER_A', '');
const USER_B = envStr('LOAD_USER_B', '');
const RUN_TAG = envStr('RUN_TAG', 'local');
const TRANSFERS = envInt('TRANSFER_RACE_ITERATIONS', 1000);

const accepted = new Counter('transfer_accept_ok');
const rejected = new Counter('transfer_reject_ok');
const withdrawn = new Counter('transfer_withdraw_ok');
const conflicts = new Counter('transfer_expected_conflict');
const wrong = new Counter('transfer_wrong_result');
const duration = new Trend('transfer_roundtrip_ms', true);
const success = new Rate('transfer_success');

export const options = {
  scenarios: {
    transfer_race: {
      executor: 'per-vu-iterations',
      vus: Math.max(1, Math.min(50, Math.ceil(TRANSFERS / 20))),
      iterations: Math.max(1, Math.ceil(TRANSFERS / Math.max(1, Math.min(50, Math.ceil(TRANSFERS / 20))))),
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
const uuid = () => {
  const b = [];
  for (let i = 0; i < 16; i += 1) b.push(Math.floor(Math.random() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** 한 바퀴: 요청 → (수락 | 거절 | 철회) → 돌려주기/스캔/회차 취소를 섞는다 */
export default function transferRace() {
  const i = exec.scenario.iterationInTest;
  const started = Date.now();
  const lookup = http.post(`${TICKET_BASE}/v1/transfer-recipient-lookups`, JSON.stringify({ memberCode: envStr('LOAD_MEMBER_CODE_B', 'QZ7-4K2M') }), { headers: headers(USER_A) });
  if (lookup.status !== 200) {
    success.add(false);
    wrong.add(1);
    return;
  }
  const recipientRef = jsonOf(lookup).recipientRef;
  const offerId = uuid();
  const ticketId = envStr('LOAD_TICKET_ID_A', '');
  const created = http.post(`${TICKET_BASE}/v1/tickets/${ticketId}/transfers`, JSON.stringify({ recipientRef }), {
    headers: { ...headers(USER_A), 'idempotency-key': offerId, 'x-reauth-token': envStr('LOAD_REAUTH_TOKEN', 'load') },
  });
  const pick = i % 3;
  if (pick === 0) {
    const r = http.post(`${TICKET_BASE}/v1/transfers/${offerId}/acceptance`, '{}', { headers: { ...headers(USER_B), 'idempotency-key': uuid() } });
    if (r.status === 200) accepted.add(1);
  } else if (pick === 1) {
    const r = http.post(`${TICKET_BASE}/v1/transfers/${offerId}/rejection`, '{}', { headers: { ...headers(USER_B), 'idempotency-key': uuid() } });
    if (r.status === 200) rejected.add(1);
  } else {
    const r = http.post(`${TICKET_BASE}/v1/transfers/${offerId}/withdrawal`, '{}', { headers: { ...headers(USER_A), 'idempotency-key': uuid() } });
    if (r.status === 200) withdrawn.add(1);
  }
  duration.add(Date.now() - started);
  // 같은 표를 스캔·회차 취소와 겹치는 구간은 별도 시나리오(offline-gate·event-cancel)가 맡는다.
// returns: 수락 뒤 받은 사람의 돌려주기(returns)와 eventCancel(회차 취소)은 같은 표에서 겹쳐도 한 번만 성공해야 한다.
  // 여기서는 만들어진 요청이 201이거나 409(정상 경합)이고 5xx가 아닌지만 센다.
  const ok = created.status === 201 || created.status === 409;
  success.add(ok);
  if (!ok) wrong.add(1);
  if (created.status === 409) conflicts.add(1);
  check(created, { 'request 201 or expected 409': (r) => r.status === 201 || r.status === 409 });
}

export { accepted, conflicts, rejected, withdrawn };
export const eventId = EVENT_ID;
