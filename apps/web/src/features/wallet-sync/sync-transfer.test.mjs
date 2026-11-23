// F-05-2 월렛 동기화가 진행 중 양도 요청 칸을 저장하는 시험(계획 docs/review/plans/F-05-2.md §1 한다 10·§5 T17).
// 시험 담당(lane2-f052-test)이 구현 전에 썼다(ADR-0372·0381). 같은 틀의 선례는 sync.test.mjs(FIX-wallet-tickets)다.
// 정본: docs/api/openapi.yaml Ticket.pendingTransfer(결제자 표의 OFFERED 요청만 객체, 그 밖은 null, 계획 감독 결정 3-(가)),
//       docs/security/asvs/transfer-refund.md(14.3.3: 브라우저 저장소에는 요청 ID와 상태만), docs/design/d5-screen-blueprint.md §5.13('양도 요청 중' ( 요청 보기 › )).
// - 바꿔 끼우는 것은 팬 API 경계(globalThis.fetch)와 IndexedDB(fake-indexeddb), Date 가짜 시계뿐이다. 받기(sync.ts)·저장소는 진짜다.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { ORIGINS } from '../../shared/config/origins.ts';
import { loadTicketSnapshot, walletDatabase } from '../../entities/wallet/index.ts';
import { syncWallet } from './sync.ts';

const API = 'https://api.f052-sync.test';
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const STARTS = Date.parse('2026-12-02T10:37:00.000Z');
const EVENT = '0193f2c0-0000-7000-8000-00000052fe01';
const PENDING = '0190f3a1-7c2e-7a00-8000-000000052101';
const PLAIN = '0190f3a1-7c2e-7a00-8000-000000052102';
const RECEIVED = '0190f3a1-7c2e-7a00-8000-000000052103';
const OFFER = '6c0e2a4b-9d1f-4a3e-8b5c-0f5205210001';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const item = (ticketId, o = {}) => ({ ticketId, eventId: EVENT, status: 'ACTIVE', transferLocked: false, eventStartsAt: new Date(STARTS).toISOString(), cancelDeadline: new Date(STARTS).toISOString(), receivedFromNickname: null, pendingTransfer: null, ...o });

const realFetch = globalThis.fetch;
const realApi = ORIGINS.api;
beforeEach(async () => {
  ORIGINS.api = API;
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const db = walletDatabase();
  await db.tickets.clear();
  await db.deviceKeys.clear();
  await db.meta.clear();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  ORIGINS.api = realApi;
  mock.timers.reset();
});

test('F-05-2 T17 ④ [ASVS v5.0.0-14.3.3] 진행 중 요청이 있는 표는 요청 ID만 저장하고, 없는 표·받은 표에는 그 칸이 없다', async () => {
  const pendingItem = item(PENDING, { status: 'TRANSFER_PENDING', pendingTransfer: { offerId: OFFER, expiresAt: new Date(NOW + 48 * 3_600_000).toISOString() } });
  const { receivedFromNickname: _r, ...receivedItem } = item(RECEIVED);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/tickets') return json(200, { items: [pendingItem, item(PLAIN), receivedItem], nextCursor: null });
    if (url.pathname.startsWith('/v1/events/')) return json(200, { eventId: EVENT, title: '공연 052', startsAt: new Date(STARTS).toISOString(), sellerName: '주식회사 피켓 시험' });
    return json(599, {});
  };
  assert.deepEqual(await syncWallet(), { kind: 'ok', count: 3 });
  const p = await loadTicketSnapshot(PENDING);
  assert.equal(p?.status, 'TRANSFER_PENDING');
  assert.deepEqual(p?.pendingTransfer, { offerId: OFFER });
  // 저장 값에 요청 기한 등 다른 요청 값이 없다(요청 ID와 상태만)
  assert.equal(JSON.stringify(p).includes(pendingItem.pendingTransfer.expiresAt), false);
  const plain = await loadTicketSnapshot(PLAIN);
  assert.equal(plain !== undefined && 'pendingTransfer' in plain, false);
  const received = await loadTicketSnapshot(RECEIVED);
  assert.equal(received?.received, true);
  assert.equal(received !== undefined && 'pendingTransfer' in received, false);
});
