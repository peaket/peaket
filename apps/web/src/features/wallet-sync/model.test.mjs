// 월렛 상태별 카드와 QR 자리 시험(FIX-wallet-tickets, O-T48 ⑥, B15·B16).
// 정본: docs/frontend.md §4.2.4 '월렛 목록 세부' 상태별 카드, §3.7 QR v1, docs/planning/03-policies-glossary.md §2.5, docs/features/offline-gate.md §11 O-T48 ⑥.
// 계획 docs/review/plans/FIX-wallet-tickets.md §8.3(WalletCard·WalletBadge·qrLabel) 모양 그대로다. 시험 담당(fwal-test-2e9a)이 구현 전에 썼다.
// - 카드는 진짜 받기(syncWallet)가 저장한 스냅샷으로 만든다(스냅샷 칸 이름에 기대지 않는다). 바꿔 끼우는 것은 팬 API(globalThis.fetch)와 fake-indexeddb뿐이다.
// - 회전 QR은 기기 키 등록(진짜 enrollment.ts)과 QR v1 프레임(진짜 frame.ts)으로 만들고, 시각은 Date 가짜 시계다.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { CreateTicketDeviceKeyResponse, ListTicketsResponse } from '@peaket/contracts/openapi/tickets';
import { ORIGINS } from '../../shared/config/origins.ts';
import { enrollDeviceKey } from '../wallet-device-key/enrollment.ts';
import { createQrFrame, qrFrameIndex, qrTimeSeconds } from '../wallet-device-key/frame.ts';
import { decodeQrV1, keyIdFromBase64Url, keyIdToBase64Url } from '../wallet-device-key/qr-v1.ts';
import { listTicketSnapshots, loadDeviceKey, walletDatabase } from '../wallet-device-key/store.ts';
import { walletCardOf } from './model.ts';
import { loadWalletCards, syncWallet } from './sync.ts';

const API = 'https://api.fwal-model.test';
const NOW = Date.parse('2026-11-23T03:00:07.000Z');
const DAY = 24 * 3_600_000;
const LIVE = '0193f2c0-0000-7000-8000-0000000fe101';
const PAST = '0193f2c0-0000-7000-8000-0000000fe102';

let n = 0;
const nextTicket = () => `0190f3a1-7c2e-7a00-8000-${String(481_000 + n++).padStart(12, '0')}`;

function item(ticketId, o = {}) {
  const startsAt = new Date(o.startsAtMs ?? NOW + 7 * DAY).toISOString();
  const out = { ticketId, eventId: o.eventId ?? LIVE, status: o.status ?? 'ISSUED', transferLocked: false, eventStartsAt: startsAt, cancelDeadline: startsAt };
  if (!o.received) out.receivedFromNickname = null;
  return out;
}

function summary(eventId, startsAtMs, endsAtMs) {
  return {
    eventId,
    title: `공연 ${eventId.slice(-3)}`,
    startsAt: new Date(startsAtMs).toISOString(),
    sellerName: '주식회사 피켓 시험',
    placeName: `장소 ${eventId.slice(-3)}`,
    entryOpensAt: new Date(startsAtMs - 3_600_000).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 정본의 keyId 식: 공개키 SPKI DER의 SHA-256 앞 8바이트(base64url 11자, offline-gate §2·§3) */
function keyIdOfJwk(jwk) {
  const spki = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest().subarray(0, 8).toString('base64url');
}

/** 가짜 팬 API: 목록 한 쪽, 회차 요약(진행 중·지난 회차), 기기 키 등록 201(받은 공개키의 keyId) */
function fakeFanApi(items) {
  const calls = { deviceKeys: [], unexpected: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/tickets') return json(200, ListTicketsResponse.parse({ items, nextCursor: null }));
    if (url.pathname === `/v1/events/${LIVE}`) return json(200, summary(LIVE, NOW + 7 * DAY, NOW + 7 * DAY + 3 * 3_600_000));
    if (url.pathname === `/v1/events/${PAST}`) return json(200, summary(PAST, NOW - 2 * DAY, NOW - 2 * DAY + 3 * 3_600_000));
    if (/^\/v1\/tickets\/[^/]+\/device-keys$/.test(url.pathname) && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      calls.deviceKeys.push({ path: url.pathname, body });
      return json(201, CreateTicketDeviceKeyResponse.parse({ keyId: keyIdOfJwk(body.publicKeyJwk) }));
    }
    calls.unexpected.push(String(input));
    return json(599, { title: '시험이 준비하지 않은 요청' });
  };
  return calls;
}

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
  mock.restoreAll();
});

const qrLabelHead = (ticketId) => `입장 QR, 티켓 ${ticketId}, 15초마다 바뀝니다`;

test('O-T48 ⑥ ISSUED·ACTIVE만 QR 자리이고 나머지 다섯은 배지·문장만이다(받은 표·지난 공연 포함)', async () => {
  const t = {
    issued: nextTicket(),
    active: nextTicket(),
    transferPending: nextTicket(),
    cancelRequested: nextTicket(),
    refunded: nextTicket(),
    flagged: nextTicket(),
    voided: nextTicket(),
    received: nextTicket(),
    past: nextTicket(),
  };
  const items = [
    item(t.issued, { status: 'ISSUED' }),
    item(t.active, { status: 'ACTIVE' }),
    item(t.transferPending, { status: 'TRANSFER_PENDING' }),
    item(t.cancelRequested, { status: 'CANCEL_REQUESTED' }),
    item(t.refunded, { status: 'REFUNDED' }),
    item(t.flagged, { status: 'FLAGGED' }),
    item(t.voided, { status: 'VOIDED' }),
    item(t.received, { status: 'ACTIVE', received: true }),
    item(t.past, { status: 'ISSUED', eventId: PAST, startsAtMs: NOW - 2 * DAY }),
  ];
  const calls = fakeFanApi(items);
  assert.deepEqual(await syncWallet(), { kind: 'ok', count: items.length });
  assert.deepEqual(calls.unexpected, []);

  const cards = await loadWalletCards(NOW);
  // 서버 목록 차례 그대로
  assert.deepEqual(cards.map((c) => c.ticketId), items.map((i) => i.ticketId));
  const by = new Map(cards.map((c) => [c.ticketId, c]));
  // [ticketId, 배지, QR 자리, 문장] — 배지·문장은 docs/frontend.md §4.2.4 '상태별 카드'의 글 그대로. 따옴표 문장이 없는 상태는 null
  const want = [
    [t.issued, '사용 가능', true, null],
    [t.active, '사용 가능', true, null],
    [t.transferPending, '양도 요청 중', false, null],
    [t.cancelRequested, '취소 접수됨', false, '입장 기록 마감 뒤 환급됩니다'],
    [t.refunded, '환급됨', false, null],
    [t.flagged, '확인 중', false, '현장에서 입장 기록을 확인하고 있습니다'],
    [t.voided, '무효', false, '입금이 확인되지 않아 티켓이 무효가 되었습니다'],
    [t.received, '받은 티켓', true, null],
  ];
  for (const [id, badge, showQr, note] of want) {
    const c = by.get(id);
    assert.deepEqual({ badge: c.badge, showQr: c.showQr, note: c.note }, { badge, showQr, note }, `${id} ${badge}`);
    assert.equal(c.eventId, LIVE, id);
    assert.equal(c.title, '공연 101', id);
    assert.equal(c.placeName, '장소 101', id);
  }
  // 회차 공개 요약의 공연 종료가 지났으면 <지난 공연>이고 QR 자리가 없다
  assert.deepEqual({ badge: by.get(t.past).badge, showQr: by.get(t.past).showQr }, { badge: '지난 공연', showQr: false });
  // QR 자리가 있는 카드의 대체 글은 그 표의 티켓 ID로 시작한다(데모가 aria-label^="입장 QR"로 찾는다)
  for (const id of [t.issued, t.active, t.received]) assert.ok(by.get(id).qrLabel.startsWith(qrLabelHead(id)), `${id} qrLabel ${by.get(id).qrLabel}`);
  // QR 자리 수는 셋(ISSUED·ACTIVE·받은 ACTIVE)뿐이다
  assert.equal(cards.filter((c) => c.showQr).length, 3);
});

test('O-T48 ⑥ 지난 공연 판정의 경계: 공연 종료 시각 직전은 사용 가능, 지나면 지난 공연이다', async () => {
  const id = nextTicket();
  fakeFanApi([item(id, { status: 'ACTIVE', eventId: PAST, startsAtMs: NOW - 2 * DAY })]);
  assert.deepEqual(await syncWallet(), { kind: 'ok', count: 1 });
  const endsAt = NOW - 2 * DAY + 3 * 3_600_000;
  const [before] = await loadWalletCards(endsAt - 1);
  assert.deepEqual({ badge: before.badge, showQr: before.showQr }, { badge: '사용 가능', showQr: true }, '종료 1ms 전');
  const [after] = await loadWalletCards(endsAt + 1);
  assert.deepEqual({ badge: after.badge, showQr: after.showQr }, { badge: '지난 공연', showQr: false }, '종료 1ms 뒤');
});

test('O-T48 ⑥ walletCardOf는 저장된 스냅샷 하나를 같은 카드로 만든다(loadWalletCards와 같다)', async () => {
  const ids = [nextTicket(), nextTicket()];
  fakeFanApi([item(ids[0]), item(ids[1], { status: 'VOIDED' })]);
  assert.deepEqual(await syncWallet(), { kind: 'ok', count: 2 });
  const snapshots = await listTicketSnapshots();
  assert.deepEqual(snapshots.map((s) => s.ticketId), ids);
  assert.deepEqual(snapshots.map((s) => walletCardOf(s, NOW)), await loadWalletCards(NOW));
});

test('O-T48 ⑥ 회전 QR: 등록된 키의 QR v1은 목록의 ticketId·이 기기 keyId를 싣고 15초 경계에서만 바뀐다', async () => {
  const id = nextTicket();
  const calls = fakeFanApi([item(id, { status: 'ISSUED' })]);
  assert.deepEqual(await syncWallet(), { kind: 'ok', count: 1 });
  const [card] = await loadWalletCards(NOW);
  assert.equal(card.showQr, true);

  // '이 휴대폰을 입장용으로 등록'(진짜 등록 흐름, 서버 201·같은 keyId)
  const status = await enrollDeviceKey(card.ticketId);
  assert.equal(status.phase, 'ready');
  assert.equal(calls.deviceKeys.length, 1);
  assert.equal(calls.deviceKeys[0].path, `/v1/tickets/${id}/device-keys`);
  const key = await loadDeviceKey(card.ticketId);
  assert.equal(key.registration, 'REGISTERED');

  const signer = { privateKey: key.privateKey, keyId: keyIdFromBase64Url(key.keyId), keyIdText: key.keyId };
  const frame = await createQrFrame(signer, card.ticketId, qrTimeSeconds(Date.now()));
  const decoded = decodeQrV1(frame.bytes);
  assert.equal(decoded.ticketId, id, 'QR의 티켓 ID가 목록의 ticketId가 아니다');
  assert.equal(keyIdToBase64Url(decoded.keyId), key.keyId, 'QR의 keyId가 이 기기 등록 키가 아니다');
  assert.ok(card.qrLabel.includes(id), '대체 글에 티켓 ID가 없다');

  // 15초 프레임(POL-018, offline-gate §3): 03:00:07은 03:00:00~03:00:15 프레임이다. 경계 값은 정본의 15초로 적는다(코드 함수로 구하지 않는다, TR-04)
  const index = qrFrameIndex(Date.now());
  mock.timers.setTime(Date.parse('2026-11-23T03:00:14.999Z'));
  assert.equal(qrFrameIndex(Date.now()), index, '경계 1ms 전인데 프레임이 바뀌었다');
  assert.equal(qrTimeSeconds(Date.now()) - qrTimeSeconds(NOW), 7);
  mock.timers.setTime(Date.parse('2026-11-23T03:00:15.000Z'));
  assert.equal(qrFrameIndex(Date.now()), index + 1, '15초 경계에서 다음 프레임이 아니다');
  const next = await createQrFrame(signer, card.ticketId, qrTimeSeconds(Date.now()));
  assert.notEqual(next.text, frame.text);
  assert.equal(decodeQrV1(next.bytes).ticketId, id);

  // QR 글자는 저장소에 남지 않는다(QR은 그때그때 서명해 그린다)
  const db = walletDatabase();
  const dump = JSON.stringify([await db.tickets.toArray(), await db.meta.toArray()]);
  assert.equal(dump.includes(frame.text), false);
  assert.equal(dump.includes(next.text), false);
});
