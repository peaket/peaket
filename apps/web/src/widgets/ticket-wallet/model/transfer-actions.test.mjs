// F-05-2 SCR-013 마이 티켓의 돌려주기·받은 요청 카드 시험(계획 docs/review/plans/F-05-2.md §1 한다 10·§5 T11·T13·T14·T17).
// 시험 담당(lane2-f052-test)이 구현 전에 썼다(ADR-0372·0381). 대상 모듈 transfer-actions.ts는 아직 없다(기준 트리에서 가져오기부터 실패한다).
// 정본: docs/design/d5-screen-blueprint.md §5.13(⑦ 받은 티켓 [결제자에게 돌려주기]·⑬ 받은 요청 카드·상태 표 '받은 티켓'·'받은 양도 요청')·§9.2(돌려주기 409),
//       docs/features/transfer-refund.md §3.1·§4(돌려주기), docs/features/identity.md I-T54 ④, docs/security/authz-matrix.md §6(ticket-return),
//       docs/api/openapi.yaml(createTicketReturn·listTransfers), docs/security/asvs/transfer-refund.md 3.3.4·11.1.1.
// - 바꿔 끼우는 것은 팬 API 경계(주입한 fetch), 브라우저 IndexedDB(fake-indexeddb), 시각(nowMs)뿐이다. 월렛 저장소(entities/wallet)는 진짜다.
import 'fake-indexeddb/auto';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDeviceKey } from '../../../features/wallet-device-key/device-key.ts';
import { loadDeviceKey, saveDeviceKey, walletDatabase } from '../../../entities/wallet/index.ts';
import {
  RETURN_CONFIRM_TEXT,
  canReturn,
  loadReceivedOffers,
  reauthProviderFor,
  receivedOfferCardsOf,
  returnFailureOf,
  returnReauthTarget,
  returnTicket,
} from './transfer-actions.ts';

const API = 'https://api.f052.test';
const PROBLEM = 'https://peaket.example/problems/';
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const STARTS = Date.parse('2026-12-02T10:37:00.000Z');
const TICKET = '0190f3a1-7c2e-7a00-8000-000000052013';
const KEY = '3f6a8c1e-5b7d-4e9f-8a2c-0f5205213001';
const TOKEN = 'eyJ0eXAiOiJyZWF1dGgrand0In0.f052-return-token.sig';

const json = (status, body, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status, name) => json(status, { type: `${PROBLEM}${name}`, title: '서버 제목', status }, 'application/problem+json');
function fakeApi(...replies) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body === undefined ? undefined : String(init.body), credentials: init.credentials });
    const r = replies[calls.length - 1];
    if (!r) return json(599, { title: '시험이 준비하지 않은 요청' });
    return r();
  };
  return { calls, fetch };
}

beforeEach(async () => {
  const db = walletDatabase();
  await db.tickets.clear();
  await db.deviceKeys.clear();
  await db.meta.clear();
});

async function seedKey(ticketId) {
  const key = await generateDeviceKey();
  await saveDeviceKey({ ticketId, keyId: key.keyIdText, privateKey: key.privateKey, publicKeyJwk: key.publicKeyJwk, createdAt: NOW, reason: 'TRANSFER', registration: 'REGISTERED' });
  return key.keyIdText;
}

test('F-05-2 T17 ① 받은 티켓만 돌려주기가 보이고 입장 시작 뒤에는 숨긴다(입장 시작 − 1ms 보임, 0ms 숨김)', () => {
  const received = { ticketId: TICKET, status: 'ACTIVE', received: true, eventStartsAt: new Date(STARTS).toISOString() };
  assert.equal(canReturn(received, STARTS - 1), true);
  assert.equal(canReturn(received, STARTS), false);
  // 입장 시작 시각을 공개 요약으로 알면 그 시각이 경계다
  const withEntry = { ...received, entryOpensAt: new Date(STARTS - HOUR).toISOString() };
  assert.equal(canReturn(withEntry, STARTS - HOUR - 1), true);
  assert.equal(canReturn(withEntry, STARTS - HOUR), false);
  // 결제자 표·끝난 표는 돌려주기가 없다
  assert.equal(canReturn({ ...received, received: false }, NOW), false);
  for (const status of ['REFUNDED', 'VOIDED', 'CANCEL_REQUESTED', 'FLAGGED']) assert.equal(canReturn({ ...received, status }, NOW), false, status);
  assert.equal(RETURN_CONFIRM_TEXT, '돌려주면 이 휴대폰의 입장 키가 지워집니다');
});

test('F-05-2 T14 I-T54 ④ 돌려주기 재인증도 카카오 먼저이고 purpose는 ticket-return, 돌아오는 주소에는 티켓 ID만 있다', () => {
  assert.equal(reauthProviderFor(['naver', 'kakao']), 'kakao');
  assert.equal(reauthProviderFor(['naver']), 'naver');
  assert.deepEqual(returnReauthTarget(TICKET), { purpose: 'ticket-return', returnTo: `/my/tickets/${TICKET}` });
});

test('F-05-2 T17 ② [ASVS v5.0.0-11.1.1] transfer-refund:v5.0.0-11.1.1 돌려주기 200이면 이 기기의 그 표 입장 키를 지우고 다른 표 키는 둔다', async () => {
  const other = '0190f3a1-7c2e-7a00-8000-000000052099';
  await seedKey(TICKET);
  const otherKey = await seedKey(other);
  const api = fakeApi(() => json(200, { ticketId: TICKET, status: 'RETURNED' }));
  const r = await returnTicket({ ticketId: TICKET, reauthToken: TOKEN, idempotencyKey: KEY, origin: API, fetch: api.fetch });
  assert.deepEqual(r, { kind: 'ok', body: { ticketId: TICKET, status: 'RETURNED' } });
  assert.equal(await loadDeviceKey(TICKET), undefined, '돌려준 표의 입장 키가 남았다');
  assert.equal((await loadDeviceKey(other))?.keyId, otherKey);
  const [call] = api.calls;
  assert.deepEqual([call.method, call.url, call.credentials], ['POST', `${API}/v1/tickets/${TICKET}/returns`, 'include']);
  assert.equal(call.headers['idempotency-key'], KEY);
  assert.equal(call.headers['x-reauth-token'], TOKEN);
});

test('F-05-2 T13 [ASVS v5.0.0-3.3.4] 돌려주기의 재인증 토큰은 X-Reauth-Token 머리에만 있고 주소·본문·월렛 저장소에 없다', async () => {
  await seedKey(TICKET);
  const api = fakeApi(() => problem(403, 'reauth-required'));
  const r = await returnTicket({ ticketId: TICKET, reauthToken: TOKEN, idempotencyKey: KEY, origin: API, fetch: api.fetch });
  assert.deepEqual(r, { kind: 'problem', status: 403, type: 'reauth-required' });
  const [call] = api.calls;
  assert.equal(call.url.includes(TOKEN), false);
  assert.equal((call.body ?? '').includes(TOKEN), false);
  const db = walletDatabase();
  const dump = JSON.stringify([await db.tickets.toArray(), await db.meta.toArray(), (await db.deviceKeys.toArray()).map(({ privateKey: _p, ...k }) => k)]);
  assert.equal(dump.includes(TOKEN), false);
});

test('F-05-2 T11 R-T17 ② 돌려주기가 실패하면 입장 키를 지우지 않고 d5 문구를 고른다: 409 입장 시작, 403 다시 로그인, 끊김은 network', async () => {
  const keyId = await seedKey(TICKET);
  const api = fakeApi(
    () => problem(409, 'entry-started'),
    () => problem(403, 'reauth-required'),
    () => {
      throw new TypeError('fetch failed');
    },
  );
  const o = { ticketId: TICKET, reauthToken: TOKEN, idempotencyKey: KEY, origin: API, fetch: api.fetch };
  const entry = await returnTicket(o);
  assert.deepEqual(entry, { kind: 'problem', status: 409, type: 'entry-started' });
  assert.equal(returnFailureOf(entry).text, '입장이 시작되어 돌려줄 수 없습니다');
  const reauth = await returnTicket(o);
  assert.match(returnFailureOf(reauth).text, /다시 로그인해 주세요$/);
  assert.deepEqual(await returnTicket(o), { kind: 'network' });
  assert.equal((await loadDeviceKey(TICKET))?.keyId, keyId, '실패했는데 입장 키를 지웠다');
  // 서버 title은 문구에 섞이지 않는다
  assert.equal(returnFailureOf(entry).text.includes('서버 제목'), false);
});

test('F-05-2 T17 ③ 받은 요청 카드: GET /v1/transfers?status=OFFERED를 쿠키와 함께 읽고, 기한 전 OFFERED만 SCR-041로 잇는다', async () => {
  const items = [
    { offerId: '11111111-1111-4111-8111-0f5205213011', ticketId: TICKET, role: 'RECIPIENT', status: 'OFFERED', expiresAt: new Date(NOW + 5 * HOUR).toISOString(), eventId: 'e1' },
    { offerId: '22222222-2222-4222-8222-0f5205213012', ticketId: TICKET, role: 'RECIPIENT', status: 'OFFERED', expiresAt: new Date(NOW).toISOString(), eventId: 'e2' },
    { offerId: '33333333-3333-4333-8333-0f5205213013', ticketId: TICKET, role: 'RECIPIENT', status: 'WITHDRAWN', withdrawReason: 'SENDER', expiresAt: new Date(NOW + 5 * HOUR).toISOString(), eventId: 'e3' },
  ];
  const api = fakeApi(() => json(200, { items, nextCursor: null }));
  const r = await loadReceivedOffers({ origin: API, fetch: api.fetch });
  assert.equal(r.kind, 'ok');
  const [call] = api.calls;
  assert.equal(call.method, 'GET');
  assert.equal(call.credentials, 'include');
  const url = new URL(call.url);
  assert.equal(`${url.origin}${url.pathname}`, `${API}/v1/transfers`);
  assert.equal(url.searchParams.get('status'), 'OFFERED');
  // 기한 − 1ms는 보이고 기한 0ms·OFFERED 아님은 보이지 않는다(d5 §5.13 '받은 양도 요청')
  assert.deepEqual(receivedOfferCardsOf(items, NOW), [{ offerId: items[0].offerId, eventId: 'e1', expiresAt: items[0].expiresAt, href: `/my/transfers/${items[0].offerId}` }]);
  assert.equal(receivedOfferCardsOf([items[1]], NOW - 1).length, 1);
  assert.equal(receivedOfferCardsOf([items[1]], NOW).length, 0);
  // 끊김은 빈 목록이 아니다
  const down = fakeApi(() => {
    throw new TypeError('fetch failed');
  });
  assert.deepEqual(await loadReceivedOffers({ origin: API, fetch: down.fetch }), { kind: 'network' });
});
