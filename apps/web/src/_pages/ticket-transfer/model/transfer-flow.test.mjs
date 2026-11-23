// F-05-2 SCR-014 티켓 양도 실제 흐름 시험(계획 docs/review/plans/F-05-2.md §4 '웹 모듈'·§5 T9·T10·T13·T14·T15).
// 시험 담당(lane2-f052-test)이 구현 전에 썼다(ADR-0372·0381). 대상 모듈 transfer-flow.ts는 아직 없다(기준 트리에서 가져오기부터 실패한다).
// 정본: docs/design/d5-screen-blueprint.md §5.14(그림·상태 표)·§9.2(양도 요청 409 transfer-locked, 재인증 403), docs/features/transfer-refund.md §4(받는 사람 참조 10분),
//       docs/features/identity.md §7.1·I-T54 ④, docs/security/authz-matrix.md §6(transfer-request), docs/security/asvs/transfer-refund.md 3.3.4·14.2.1,
//       docs/api/openapi.yaml(getTicket·createTransferRecipientLookup·createTicketTransfer·createTransferWithdrawal), docs/api/guidelines.md §4.
// - 바꿔 끼우는 것은 팬 API 경계(주입한 fetch)와 시각(인자로 넘기는 nowMs)뿐이다. 화면 상태 → 구역 표(view.ts transferView)는 진짜다.
// - 화면 문구는 d5에서 옮겨 단언하고 코드 상수를 가져오지 않는다. 시험 값은 정본 예와 다르게 고른다(회원 코드 QZ7-4K2M, 공연 시작 19:37).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTransferTicket,
  lookupRecipient,
  recipientRefUsable,
  reauthProviderFor,
  remainingText,
  sendTransferRequest,
  transferAttemptFor,
  transferFailureOf,
  transferReauthTarget,
  transferStateOf,
  withdrawTransferRequest,
} from './transfer-flow.ts';
import { transferView } from './view.ts';

const API = 'https://api.f052.test';
const PROBLEM = 'https://peaket.example/problems/';
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const STARTS = Date.parse('2026-12-02T10:37:00.000Z');
const DEADLINE = new Date(STARTS - 2 * HOUR).toISOString();
const TICKET = '0190f3a1-7c2e-7a00-8000-000000052014';
const OFFER = '5b1e6f0c-8d2a-4c3e-9f41-0f5205214001';
const KEY = '7d4c2a91-3e5b-4f60-8a17-0f5205214002';
const TOKEN = 'eyJ0eXAiOiJyZWF1dGgrand0In0.f052-reauth-token.sig';
const REF = 'iv0.f052-recipient-ref.tag0';

/** 결제자 표의 상세(openapi Ticket, GET /v1/tickets/{ticketId}) */
const payerTicket = (o = {}) => ({
  ticketId: TICKET,
  eventId: '0193f2c0-0000-7000-8000-00000052e001',
  status: 'ACTIVE',
  transferable: true,
  transferLocked: false,
  transferLockExpiresAt: null,
  transferDeadline: DEADLINE,
  eventStartsAt: new Date(STARTS).toISOString(),
  cancelDeadline: new Date(STARTS).toISOString(),
  receivedFromNickname: null,
  pendingTransfer: null,
  ...o,
});

const json = (status, body, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status, name, extra = {}) => new Response(JSON.stringify({ type: `${PROBLEM}${name}`, title: '서버 제목', status }), { status, headers: { 'content-type': 'application/problem+json', ...extra } });

/** 팬 API 경계의 가짜 fetch: 부른 요청을 모두 적고 준 응답을 차례로 쓴다 */
function fakeApi(...replies) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url: String(input), method: init.method ?? 'GET', headers: Object.fromEntries(headers.entries()), body: init.body === undefined ? undefined : String(init.body), credentials: init.credentials });
    const r = replies[calls.length - 1];
    if (!r) return json(599, { title: '시험이 준비하지 않은 요청' });
    return r();
  };
  return { calls, fetch };
}

test('F-05-2 T15 ① 상세로 화면 상태를 고른다: 결제자 표는 받는 사람 확인, 진행 중 요청은 요청 보냄, 잠김·마감·양도 불가는 양식을 숨긴다', () => {
  assert.equal(transferStateOf(payerTicket(), NOW), '받는 사람 확인');
  assert.equal(transferView('받는 사람 확인').form, true);
  const pending = payerTicket({ status: 'TRANSFER_PENDING', pendingTransfer: { offerId: OFFER, expiresAt: new Date(NOW + 48 * HOUR).toISOString() } });
  assert.equal(transferStateOf(pending, NOW), '요청 보냄');
  assert.equal(transferView('요청 보냄').sentSec, true);
  // 부정 예매 조사로 잠김: ③④⑤를 숨긴다(d5 §5.14)
  const locked = payerTicket({ transferLocked: true, transferLockExpiresAt: new Date(NOW + 9 * 24 * HOUR).toISOString() });
  assert.equal(transferStateOf(locked, NOW), '부정 예매 조사로 잠김');
  assert.equal(transferView(transferStateOf(locked, NOW)).form, false);
  // 마감 경계(POL-017): 마감 − 1ms는 양식, 마감 0ms는 '마감 지남'
  assert.equal(transferStateOf(payerTicket(), STARTS - 2 * HOUR - 1), '받는 사람 확인');
  assert.equal(transferStateOf(payerTicket({ transferable: false }), STARTS - 2 * HOUR), '양도 불가 · 마감 지남');
  assert.equal(transferStateOf(payerTicket(), STARTS - 2 * HOUR), '양도 불가 · 마감 지남');
  // 결제자 표인데 서버가 transferable 거짓을 주면 양식을 열지 않는다(상품 정책)
  assert.equal(transferStateOf(payerTicket({ transferable: false }), NOW), '양도 불가 상품');
  // 칸이 없으면 '양도 가능'으로 읽지 않는다(계획 §10 '확인할 수 없음을 통과로 읽지 않기')
  const { transferable: _t, ...noFlag } = payerTicket();
  const unknown = transferStateOf(noFlag, NOW);
  assert.equal(transferView(unknown).form, false, `칸이 없는데 ${unknown}`);
  assert.equal(transferView(unknown).sendSec, false);
});

test('F-05-2 T9 R-T1 ① 진행 중 요청의 48시간 기한 경계: 기한 − 1ms는 요청 보냄, 기한 0ms·서버가 null을 주면 양도 양식이 다시 열린다', () => {
  const expiresAt = NOW + 48 * HOUR;
  const pending = payerTicket({ status: 'TRANSFER_PENDING', pendingTransfer: { offerId: OFFER, expiresAt: new Date(expiresAt).toISOString() } });
  assert.equal(transferStateOf(pending, expiresAt - 1), '요청 보냄');
  assert.equal(transferStateOf(pending, expiresAt), '받는 사람 확인');
  // 서버 만료 정비 뒤 상세(pendingTransfer null, transferable 참)
  assert.equal(transferStateOf(payerTicket({ pendingTransfer: null }), expiresAt + MIN), '받는 사람 확인');
  // ⑥ 카드의 남은 시간(d5 §5.14 '<수락 대기 · 47:12 남음>' 꼴, 시:분)
  assert.equal(remainingText(new Date(expiresAt).toISOString(), expiresAt - (47 * HOUR + 12 * MIN)), '47:12');
  assert.equal(remainingText(new Date(expiresAt).toISOString(), expiresAt - (3 * HOUR + 5 * MIN + 59_999)), '3:05');
  assert.equal(remainingText(new Date(expiresAt).toISOString(), expiresAt), '0:00');
  assert.equal(remainingText(new Date(expiresAt).toISOString(), expiresAt + HOUR), '0:00');
});

test('F-05-2 T10 R-T2 ① 받은 티켓은 d5 받은 티켓 상태이고 ③④⑤가 없으며, 요청이 409 reoffer-not-allowed여도 같은 문구다', () => {
  const received = payerTicket({ transferable: false, receivedFromNickname: '회원' });
  const st = transferStateOf(received, NOW);
  assert.equal(st, '양도 불가 · 받은 티켓');
  const v = transferView(st);
  assert.equal(v.form, false);
  assert.equal(v.sendSec, false);
  assert.equal(v.blockRecv, true);
  // 잠겼어도·진행 중 칸이 있어도 받은 티켓이 먼저다(받은 사람은 다시 양도할 수 없다)
  assert.equal(transferStateOf({ ...received, transferLocked: true }, NOW), '양도 불가 · 받은 티켓');
  const f = transferFailureOf('request', { status: 409, type: `${PROBLEM}reoffer-not-allowed` });
  assert.deepEqual(f, { state: '양도 불가 · 받은 티켓', text: '받은 티켓은 다시 양도할 수 없고 결제한 분에게 돌려주기만 할 수 있습니다', relookup: false });
});

test('F-05-2 T15 ② 오류를 d5 문구로 가른다: 조회 404·429, 재인증 403, 잠김 409, 마감 409, 철회 409, 받는 사람 참조 만료', () => {
  const cases = [
    ['lookup', { status: 404, type: 'recipient-not-found' }, '비회원·본인확인 전', '본인확인을 마친 피켓 회원에게만 양도할 수 있습니다', false],
    ['lookup', { status: 429, type: 'too-many-requests' }, '확인 시도 초과', '잠시 뒤 다시 확인해 주세요', false],
    ['request', { status: 403, type: 'reauth-required' }, '재인증 만료', '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 로그인해 주세요', false],
    ['request', { status: 409, type: 'transfer-closed' }, '양도 불가 · 마감 지남', '양도 가능 시간이 지났습니다', false],
    ['withdraw', { status: 409, type: 'transfer-not-offered' }, '철회 불가', '이미 처리된 요청입니다', false],
  ];
  for (const [step, p, state, text, relookup] of cases) {
    assert.deepEqual(transferFailureOf(step, { ...p, type: `${PROBLEM}${p.type}` }), { state, text, relookup }, `${step} ${p.status} ${p.type}`);
  }
  // 조회 404·429 동안에는 ⑦ 법정 고지·⑤ 확인·보내기를 숨긴다(d5 §5.14 '위 두 확인 오류 공통')
  for (const st of ['비회원·본인확인 전', '확인 시도 초과']) assert.equal(transferView(st).sendSec, false, st);
  // 409 transfer-locked: §9.2 문구, 기한 자리에 실제 기한이 들어간다(자리 표시 글을 그대로 내지 않는다)
  const locked = transferFailureOf('request', { status: 409, type: `${PROBLEM}transfer-locked` }, { lockExpiresAt: '2026-12-01T05:19:00.000Z' });
  assert.equal(locked.state, '오류 · transfer-locked');
  assert.match(locked.text, /^부정 예매 조사가 끝날 때까지 이 티켓은 양도할 수 없습니다\. 늦어도 .+에 풀립니다\. 입장과 직접 취소는 그대로 할 수 있습니다$/);
  assert.equal(locked.text.includes('{'), false);
  assert.equal(transferView(locked.state).form, false);
  // 받는 사람 참조(10분)가 지나 요청이 400으로 거절되면 다시 찾게 한다
  const stale = transferFailureOf('request', { status: 400, type: `${PROBLEM}invalid-body` });
  assert.equal(stale.relookup, true);
  assert.equal(stale.state, '받는 사람 확인');
  // 서버 title·detail은 문구에 섞이지 않는다
  for (const [step, p] of cases) assert.equal(transferFailureOf(step, p).text.includes('서버 제목'), false);
});

test('F-05-2 T15 ③ 받는 사람 참조 10분 경계와 같은 요청의 같은 멱등 키', () => {
  const at = NOW + 7 * MIN;
  assert.equal(recipientRefUsable(at, at + 10 * MIN - 1), true);
  assert.equal(recipientRefUsable(at, at + 10 * MIN), false);
  let n = 0;
  const make = () => `k-${++n}`;
  const first = transferAttemptFor(null, REF, make);
  assert.deepEqual(first, { recipientRef: REF, key: 'k-1' });
  // 같은 받는 사람 참조로 다시 보내면(재인증을 새로 받아도) 같은 키다
  assert.deepEqual(transferAttemptFor(first, REF, make), first);
  assert.equal(n, 1);
  // 받는 사람을 다시 찾으면(참조가 바뀌면) 새 키다
  assert.deepEqual(transferAttemptFor(first, 'iv1.other-ref.tag1', make), { recipientRef: 'iv1.other-ref.tag1', key: 'k-2' });
});

test('F-05-2 T14 I-T54 ④ 카카오와 네이버를 함께 연결했으면 카카오 재인증, 네이버만이면 네이버이고 purpose는 transfer-request다', () => {
  assert.equal(reauthProviderFor(['kakao', 'naver']), 'kakao');
  assert.equal(reauthProviderFor(['naver', 'kakao']), 'kakao');
  assert.equal(reauthProviderFor(['naver']), 'naver');
  assert.equal(reauthProviderFor([]), undefined);
  const target = transferReauthTarget(TICKET);
  assert.deepEqual(target, { purpose: 'transfer-request', returnTo: `/my/tickets/${TICKET}/transfer` });
});

test('F-05-2 T15 ④ [ASVS v5.0.0-14.2.1] 재인증 왕복의 돌아오는 주소에는 티켓 ID만 있고 회원 코드·참조·닉네임이 없다', () => {
  const { returnTo } = transferReauthTarget(TICKET);
  assert.equal(returnTo.includes('?'), false);
  assert.equal(returnTo.includes('#'), false);
  for (const v of ['QZ7-4K2M', REF, '하*']) assert.equal(returnTo.includes(v), false, v);
});

test('F-05-2 T15 ⑤ 상세·조회·요청·철회는 팬 API로 쿠키와 함께 보내고 요청은 Idempotency-Key·recipientRef만 싣는다', async () => {
  const offerBody = { offerId: OFFER, ticketId: TICKET, role: 'SENDER', status: 'OFFERED', expiresAt: new Date(NOW + 48 * HOUR).toISOString() };
  const api = fakeApi(
    () => json(200, payerTicket()),
    () => json(200, { recipientRef: REF, nicknameMasked: '하*' }),
    () => json(201, offerBody),
    () => json(200, { ...offerBody, status: 'WITHDRAWN' }),
  );
  const o = { origin: API, fetch: api.fetch };
  assert.deepEqual(await loadTransferTicket({ ticketId: TICKET, ...o }), { kind: 'ok', body: payerTicket() });
  assert.deepEqual(await lookupRecipient({ memberCode: 'QZ7-4K2M', ...o }), { kind: 'ok', body: { recipientRef: REF, nicknameMasked: '하*' } });
  assert.deepEqual(await sendTransferRequest({ ticketId: TICKET, recipientRef: REF, reauthToken: TOKEN, idempotencyKey: KEY, ...o }), { kind: 'ok', body: offerBody });
  const wKey = 'a1c3e5f7-2b4d-4e6f-8a0c-0f5205214003';
  assert.deepEqual((await withdrawTransferRequest({ offerId: OFFER, idempotencyKey: wKey, ...o })).kind, 'ok');
  const [detail, lookup, send, withdraw] = api.calls;
  assert.deepEqual([detail.method, detail.url, detail.credentials], ['GET', `${API}/v1/tickets/${TICKET}`, 'include']);
  assert.deepEqual([lookup.method, lookup.url, lookup.credentials], ['POST', `${API}/v1/transfer-recipient-lookups`, 'include']);
  assert.deepEqual(JSON.parse(lookup.body), { memberCode: 'QZ7-4K2M' });
  assert.deepEqual([send.method, send.url, send.credentials], ['POST', `${API}/v1/tickets/${TICKET}/transfers`, 'include']);
  assert.equal(send.headers['idempotency-key'], KEY);
  assert.equal(send.headers['x-reauth-token'], TOKEN);
  assert.deepEqual(JSON.parse(send.body), { recipientRef: REF });
  assert.deepEqual([withdraw.method, withdraw.url, withdraw.headers['idempotency-key']], ['POST', `${API}/v1/transfers/${OFFER}/withdrawal`, wKey]);
  assert.equal(withdraw.headers['x-reauth-token'], undefined, '철회에는 재인증 토큰을 싣지 않는다');
});

test('F-05-2 T13 [ASVS v5.0.0-3.3.4] 재인증 토큰은 X-Reauth-Token 머리에만 있고 주소·본문·쿠키·브라우저 저장소에 없다', async () => {
  const writes = [];
  const storage = () => ({ getItem: () => null, setItem: (k, v) => void writes.push(`${k}=${v}`), removeItem: () => {}, clear: () => {}, key: () => null, length: 0 });
  const saved = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, document: globalThis.document };
  const cookies = [];
  Object.defineProperty(globalThis, 'localStorage', { value: storage(), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage(), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', {
    value: {
      get cookie() {
        return '';
      },
      set cookie(v) {
        cookies.push(v);
      },
    },
    configurable: true,
    writable: true,
  });
  try {
    const api = fakeApi(() => problem(403, 'reauth-required'));
    const r = await sendTransferRequest({ ticketId: TICKET, recipientRef: REF, reauthToken: TOKEN, idempotencyKey: KEY, origin: API, fetch: api.fetch });
    assert.deepEqual(r, { kind: 'problem', status: 403, type: 'reauth-required' });
    const [call] = api.calls;
    assert.equal(call.headers['x-reauth-token'], TOKEN);
    assert.equal(call.url.includes(TOKEN), false, '주소');
    assert.equal(call.body.includes(TOKEN), false, '본문');
    assert.equal(writes.some((w) => w.includes(TOKEN)), false, '브라우저 저장소');
    assert.equal(cookies.some((c) => c.includes(TOKEN)), false, '쿠키');
  } finally {
    for (const [k, v] of Object.entries(saved)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});

test('F-05-2 T15 ⑥ 장애 주입: 요청 응답을 잃으면(끊김) 성공으로 그리지 않고 network이며, 같은 키로 다시 보내면 서버 재생 201로 카드 하나다', async () => {
  const offerBody = { offerId: KEY, ticketId: TICKET, role: 'SENDER', status: 'OFFERED', expiresAt: new Date(NOW + 48 * HOUR).toISOString() };
  const api = fakeApi(
    () => {
      throw new TypeError('fetch failed');
    },
    () => json(201, offerBody),
  );
  const o = { origin: API, fetch: api.fetch };
  let n = 0;
  const attempt = transferAttemptFor(null, REF, () => (n++ === 0 ? KEY : 'bad-new-key'));
  assert.deepEqual(await sendTransferRequest({ ticketId: TICKET, recipientRef: attempt.recipientRef, reauthToken: TOKEN, idempotencyKey: attempt.key, ...o }), { kind: 'network' });
  // 새 재인증 토큰을 받아 같은 참조로 다시: 같은 키
  const retry = transferAttemptFor(attempt, REF, () => 'bad-new-key');
  const again = await sendTransferRequest({ ticketId: TICKET, recipientRef: retry.recipientRef, reauthToken: `${TOKEN}-2`, idempotencyKey: retry.key, ...o });
  assert.deepEqual(again, { kind: 'ok', body: offerBody });
  assert.deepEqual(api.calls.map((c) => c.headers['idempotency-key']), [KEY, KEY]);
  // 5xx·모르는 409도 성공이 아니다
  const bad = fakeApi(() => problem(503, 'reauth-unavailable'), () => problem(409, 'transfer-pending'));
  assert.deepEqual(await sendTransferRequest({ ticketId: TICKET, recipientRef: REF, reauthToken: TOKEN, idempotencyKey: KEY, origin: API, fetch: bad.fetch }), { kind: 'problem', status: 503, type: 'reauth-unavailable' });
  assert.deepEqual(await sendTransferRequest({ ticketId: TICKET, recipientRef: REF, reauthToken: TOKEN, idempotencyKey: KEY, origin: API, fetch: bad.fetch }), { kind: 'problem', status: 409, type: 'transfer-pending' });
});

test('F-05-2 T15 ⑦ 조회 429는 problem과 Retry-After 초를 돌려주고, 조회 끊김은 network다(404로 읽지 않는다)', async () => {
  const api = fakeApi(
    () => problem(429, 'too-many-requests', { 'retry-after': '1740' }),
    () => {
      throw new TypeError('fetch failed');
    },
  );
  const o = { origin: API, fetch: api.fetch };
  assert.deepEqual(await lookupRecipient({ memberCode: 'QZ7-4K2M', ...o }), { kind: 'problem', status: 429, type: 'too-many-requests', retryAfterSec: 1740 });
  assert.deepEqual(await lookupRecipient({ memberCode: 'QZ7-4K2M', ...o }), { kind: 'network' });
});
