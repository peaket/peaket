// F-05-4 회차 목록 상태와 변경분 반영 시험(계획 docs/review/plans/F-05-4.md §4 package-state.ts·§6).
// 정본: docs/features/offline-gate.md §6.3 '변경분 판 1의 모양과 스캐너 반영'·§6.4 '스캐너 앱 판정 첫 구현'(목록을 다시 받아도 늦은 입장 상태를 남김), O-T15·O-T23·O-T24·O-T25.
// 반영 뒤 판정까지 본다(판정 모듈도 진짜를 쓴다). 새 모듈은 동적 불러오기로 읽는다: 모듈이 없으면 각 시험이 '함수가 있다'는 단언에서 떨어진다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScannerChangesResponse, ScannerPackageResponse } from '../src/api/client.ts';
import type { EntryState, PackageState, Placement } from '../src/storage/package-state.ts';
import { DEVICE, OTHER_DEVICE, QR_MS, QR_SEC, packageOf, pageOf, qrText, vectorOf, walletKey } from './scanner-fixture.ts';

type StateModule = {
  packageStateOf(pkg: ScannerPackageResponse, placement: Placement, keepLocal?: ReadonlyMap<string, EntryState>): PackageState;
  applyChangePage(state: PackageState, page: ScannerChangesResponse, deviceId: string): PackageState;
  withLocalEntry(state: PackageState, ticketId: string, entry: EntryState): PackageState;
};
type JudgeModule = { judgeScan(i: { raw: string; state: PackageState; nowMs: number; clockOffsetMs: number }): Promise<Record<string, unknown>> };
const STATE = '../src/storage/package-state.ts';
const JUDGE = '../src/judge/judge.ts';
const stateLoaded = (await import(STATE).catch(() => ({}))) as Partial<StateModule>;
const judgeLoaded = (await import(JUDGE).catch(() => ({}))) as Partial<JudgeModule>;
function m(): StateModule {
  for (const name of ['packageStateOf', 'applyChangePage', 'withLocalEntry'] as const) assert.equal(typeof stateLoaded[name], 'function', `${STATE}의 ${name}가 없다`);
  return stateLoaded as StateModule;
}
function judgeScan(raw: string, state: PackageState, nowMs = QR_MS): Promise<Record<string, unknown>> {
  assert.equal(typeof judgeLoaded.judgeScan, 'function', `${JUDGE}의 judgeScan이 없다`);
  return judgeLoaded.judgeScan!({ raw, state, nowMs, clockOffsetMs: 0 });
}
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

const T = '0190f3a1-7c2e-7a00-8b2a-6c1d5e710001';
const T2 = '0190f3a1-7c2e-7a00-8b2a-6c1d5e710002';
const T3 = '0190f3a1-7c2e-7a00-8b2a-6c1d5e710003';
const key = await walletKey();
const lateKey = await walletKey();
const oldKey = await walletKey();
const IN_PLACEMENT: Placement = { gateZone: '동문', mode: 'IN', version: 5 };

function pkg(over: { reentryAllowed?: boolean; t2LastAt?: string } = {}): ScannerPackageResponse {
  return packageOf({
    reentryAllowed: over.reentryAllowed ?? false,
    tickets: [
      { ticketId: T, gateZone: '동문', seatLabel: 'R구역 12열 8번', status: 'ACTIVE', keys: [{ keyId: key.keyId, publicKey: key.publicKey }] },
      {
        ticketId: T2,
        gateZone: '동문',
        seatLabel: 'R구역 12열 9번',
        status: 'ACTIVE',
        keys: [{ keyId: key.keyId, publicKey: key.publicKey }],
        scanState: { lastDirection: 'IN', lastAt: over.t2LastAt ?? '2026-11-23T09:50:00.000Z', lastGateZone: '동문' },
      },
      { ticketId: T3, gateZone: '서문', seatLabel: 'S구역 1열 1번', status: 'ACTIVE', keys: [] },
    ],
    revokedKeyIds: [oldKey.keyId],
    lastSeq: 40,
  });
}
const scanState = (seq: number, ticketId: string, direction: 'IN' | 'OUT', at: string, deviceId = OTHER_DEVICE) => ({
  seq,
  kind: 'SCAN_STATE',
  payload: { v: 1, ticketId, direction, scannedAtDevice: at, gateZone: '동문', deviceId },
});

test('GAT-140 목록 응답을 상태로 옮긴다: 티켓·유효 키·폐기 keyId·입장 상태(출처 PACKAGE)·마지막 번호·벡터·배치', () => {
  const p = pkg();
  const s = m().packageStateOf(p, IN_PLACEMENT);
  assert.equal(s.eventId, p.eventId);
  assert.equal(s.reentryAllowed, false);
  assert.deepEqual(s.gateZones, ['동문', '서문']);
  assert.deepEqual([...s.tickets.keys()].sort(), [T, T2, T3]);
  // type-escape: StoredTicket을 칸 고르기 도우미(Record)에 넘기려고 넓힌다(값은 그대로) F-05-4 RV-16
  assert.deepEqual(pick(s.tickets.get(T)! as unknown as Record<string, unknown>, ['ticketId', 'gateZone', 'seatLabel', 'status', 'keys']), {
    ticketId: T,
    gateZone: '동문',
    seatLabel: 'R구역 12열 8번',
    status: 'ACTIVE',
    keys: [{ keyId: key.keyId, publicKey: key.publicKey }],
  });
  assert.deepEqual([...s.revoked], [oldKey.keyId]);
  assert.deepEqual([...s.entries], [[T2, { lastDirection: 'IN', lastAtMs: Date.parse('2026-11-23T09:50:00.000Z'), gateZone: '동문', source: 'PACKAGE' }]]);
  assert.equal(s.lastSeq, 40);
  assert.deepEqual(s.versionVector, p.versionVector);
  assert.deepEqual(s.placement, IN_PLACEMENT);
  assert.equal(s.resyncRequired, false);
});

test('GAT-140 변경분 반영: 저장한 마지막 번호 이하의 변경은 버리고 마지막 번호는 그 쪽의 끝 번호가 된다', () => {
  const s = m().packageStateOf(pkg(), IN_PLACEMENT);
  const stale = m().applyChangePage(s, pageOf([
    { seq: 39, kind: 'POLICY', payload: { v: 1, reentryAllowed: true } },
    { seq: 40, kind: 'TICKET_STATUS', payload: { v: 1, ticketId: T, status: 'REFUNDED', version: 99 } },
  ], 38), DEVICE);
  assert.equal(stale.reentryAllowed, false);
  assert.equal(stale.tickets.get(T)!.status, 'ACTIVE');
  assert.equal(stale.lastSeq, 40);
  const next = m().applyChangePage(s, pageOf([{ seq: 41, kind: 'POLICY', payload: { v: 1, reentryAllowed: true } }]), DEVICE);
  assert.equal(next.reentryAllowed, true);
  assert.equal(next.lastSeq, 41);
});

test('GAT-140 변경분 반영: 같은 쪽을 두 번 반영해도 상태가 같고, 넘긴 상태는 바꾸지 않는다', () => {
  const s = m().packageStateOf(pkg(), IN_PLACEMENT);
  const before = structuredClone(s);
  const page = pageOf([
    { seq: 41, kind: 'KEY_REGISTERED', payload: { v: 1, ticketId: T3, keyId: lateKey.keyId, publicKey: lateKey.publicKey } },
    { seq: 42, kind: 'KEY_REVOKED', payload: { v: 1, ticketId: T, keyId: key.keyId } },
    scanState(43, T, 'IN', '2026-11-23T09:55:00.000Z'),
    { seq: 44, kind: 'TICKET_STATUS', payload: { v: 1, ticketId: T2, status: 'CANCEL_REQUESTED', version: 7 } },
    { seq: 45, kind: 'POLICY', payload: { v: 1, reentryAllowed: true } },
    { seq: 46, kind: 'PLACEMENT', payload: { v: 1, deviceId: DEVICE, gateZone: '서문', mode: 'OUT', version: 6 } },
  ]);
  const once = m().applyChangePage(s, page, DEVICE);
  const twice = m().applyChangePage(once, page, DEVICE);
  assert.deepEqual(twice, once);
  assert.deepEqual(s, before, '넘긴 상태가 그대로다');
  assert.notDeepEqual(once, s);
});

test('GAT-140 변경분 반영: 모르는 종류·판은 건너뛰고(다른 칸 그대로) 번호만 앞으로 간다', () => {
  const s = m().packageStateOf(pkg(), IN_PLACEMENT);
  const after = m().applyChangePage(s, pageOf([
    { seq: 41, kind: 'BRAND_NEW_KIND', payload: { v: 1, ticketId: T } },
    { seq: 42, kind: 'POLICY', payload: { v: 2, reentryAllowed: true } },
    { seq: 43, kind: 'TICKET_STATUS', payload: { ticketId: T, status: 'REFUNDED', version: 50 } },
  ]), DEVICE);
  assert.deepEqual({ ...after, lastSeq: s.lastSeq, versionVector: s.versionVector }, s);
  assert.equal(after.lastSeq, 43);
});

test('GAT-140 변경분 반영: TICKET_STATUS는 판이 저장값보다 클 때만, KEY_REVOKED는 keyId가 null이면 무시한다', () => {
  const s = m().packageStateOf(pkg(), IN_PLACEMENT);
  const v3 = m().applyChangePage(s, pageOf([{ seq: 41, kind: 'TICKET_STATUS', payload: { v: 1, ticketId: T, status: 'FLAGGED', version: 3 } }]), DEVICE);
  assert.equal(v3.tickets.get(T)!.status, 'FLAGGED');
  assert.equal(v3.tickets.get(T)!.statusVersion, 3);
  const lower = m().applyChangePage(v3, pageOf([
    { seq: 42, kind: 'TICKET_STATUS', payload: { v: 1, ticketId: T, status: 'REFUNDED', version: 2 } },
    { seq: 43, kind: 'TICKET_STATUS', payload: { v: 1, ticketId: T, status: 'VOIDED', version: 3 } },
  ], 41), DEVICE);
  assert.equal(lower.tickets.get(T)!.status, 'FLAGGED', '작은 판·같은 판은 무시');
  const higher = m().applyChangePage(lower, pageOf([{ seq: 44, kind: 'TICKET_STATUS', payload: { v: 1, ticketId: T, status: 'REFUNDED', version: 4 } }], 43), DEVICE);
  assert.equal(higher.tickets.get(T)!.status, 'REFUNDED');

  const nullKey = m().applyChangePage(s, pageOf([{ seq: 41, kind: 'KEY_REVOKED', payload: { v: 1, ticketId: T, keyId: null } }]), DEVICE);
  assert.deepEqual({ ...nullKey, lastSeq: s.lastSeq, versionVector: s.versionVector }, s);
  const revoked = m().applyChangePage(s, pageOf([{ seq: 41, kind: 'KEY_REVOKED', payload: { v: 1, ticketId: T, keyId: key.keyId } }]), DEVICE);
  assert.equal(revoked.revoked.has(key.keyId), true);
  assert.deepEqual(revoked.tickets.get(T)!.keys, []);
});

test('O-T25 KEY_REGISTERED(publicKey 있음) 반영 뒤 같은 QR이 통과하고, publicKey가 없으면 여전히 KEY_UNKNOWN이며 다시 받기 표시가 선다', async () => {
  const raw = await qrText(lateKey, { ticketId: T3, timestampSec: QR_SEC });
  const s = m().packageStateOf(pkg(), { gateZone: '서문', mode: 'IN', version: 5 });
  assert.equal((await judgeScan(raw, s)).reason, 'KEY_UNKNOWN');
  const registered = m().applyChangePage(s, pageOf([{ seq: 41, kind: 'KEY_REGISTERED', payload: { v: 1, ticketId: T3, keyId: lateKey.keyId, publicKey: lateKey.publicKey } }]), DEVICE);
  assert.deepEqual(registered.tickets.get(T3)!.keys, [{ keyId: lateKey.keyId, publicKey: lateKey.publicKey }]);
  assert.equal(registered.resyncRequired, false);
  assert.deepEqual(pick(await judgeScan(raw, registered), ['result', 'direction', 'ticketId', 'keyId']), { result: 'PASS', direction: 'IN', ticketId: T3, keyId: lateKey.keyId });

  const noPublic = m().applyChangePage(s, pageOf([{ seq: 41, kind: 'KEY_REGISTERED', payload: { v: 1, ticketId: T3, keyId: lateKey.keyId } }]), DEVICE);
  assert.deepEqual(pick(await judgeScan(raw, noPublic), ['result', 'reason']), { result: 'REJECT', reason: 'KEY_UNKNOWN' });
  assert.equal(noPublic.resyncRequired, true);
});

test('O-T23 다른 기기의 SCAN_STATE IN을 반영하면 같은 티켓이 ALREADY_IN이고 lastEntry에 그 시각·구역이 실린다', async () => {
  const s = m().packageStateOf(pkg(), IN_PLACEMENT);
  const at = '2026-11-23T09:58:00.000Z';
  const after = m().applyChangePage(s, pageOf([scanState(41, T, 'IN', at)]), DEVICE);
  const lastEntry = { lastDirection: 'IN', lastAtMs: Date.parse(at), gateZone: '동문', source: 'CHANGES' };
  assert.deepEqual(after.entries.get(T), lastEntry);
  const o = await judgeScan(await qrText(key, { ticketId: T, timestampSec: QR_SEC }), after);
  assert.deepEqual(pick(o, ['result', 'reason', 'ticketId', 'lastEntry']), { result: 'REJECT', reason: 'ALREADY_IN', ticketId: T, lastEntry });
});

test('O-T23 더 이른 시각의 SCAN_STATE는 입장 상태를 바꾸지 않고, 같은 시각은 바꾼다', () => {
  const s = m().packageStateOf(pkg(), IN_PLACEMENT);
  const at = '2026-11-23T09:58:00.000Z';
  const first = m().applyChangePage(s, pageOf([scanState(41, T, 'IN', at)]), DEVICE);
  const earlier = m().applyChangePage(first, pageOf([scanState(42, T, 'OUT', '2026-11-23T09:57:59.999Z')], 41), DEVICE);
  assert.deepEqual(earlier.entries.get(T), { lastDirection: 'IN', lastAtMs: Date.parse(at), gateZone: '동문', source: 'CHANGES' });
  const same = m().applyChangePage(earlier, pageOf([scanState(43, T, 'OUT', at)], 42), DEVICE);
  assert.deepEqual(same.entries.get(T), { lastDirection: 'OUT', lastAtMs: Date.parse(at), gateZone: '동문', source: 'CHANGES' });
  // 목록이 실은 입장 상태보다 이른 변경분도 무시한다
  const pkgEarlier = m().applyChangePage(s, pageOf([scanState(41, T2, 'OUT', '2026-11-23T09:49:59.000Z')]), DEVICE);
  assert.deepEqual(pkgEarlier.entries.get(T2), s.entries.get(T2));
});

test('O-T24 재입장 허용 회차에서 기기 X의 퇴장(SCAN_STATE OUT)을 반영한 기기 Y는 그 티켓을 통과(IN)시킨다', async () => {
  const s = m().packageStateOf(pkg({ reentryAllowed: true }), IN_PLACEMENT);
  const raw = await qrText(key, { ticketId: T2, timestampSec: QR_SEC });
  assert.deepEqual(pick(await judgeScan(raw, s), ['result', 'reason']), { result: 'CHECK', reason: 'NO_EXIT_RECORD' });
  const after = m().applyChangePage(s, pageOf([scanState(41, T2, 'OUT', '2026-11-23T09:59:00.000Z')]), DEVICE);
  assert.deepEqual(pick(await judgeScan(raw, after), ['result', 'direction', 'ticketId']), { result: 'PASS', direction: 'IN', ticketId: T2 });
});

test('O-T15 POLICY true를 반영하면 입장 기록(IN)이 있는 티켓이 ALREADY_IN에서 NO_EXIT_RECORD(확인 필요)로 바뀐다', async () => {
  const s = m().packageStateOf(pkg({ reentryAllowed: false }), IN_PLACEMENT);
  const raw = await qrText(key, { ticketId: T2, timestampSec: QR_SEC });
  assert.deepEqual(pick(await judgeScan(raw, s), ['result', 'reason']), { result: 'REJECT', reason: 'ALREADY_IN' });
  const after = m().applyChangePage(s, pageOf([{ seq: 41, kind: 'POLICY', payload: { v: 1, reentryAllowed: true } }]), DEVICE);
  assert.equal(after.reentryAllowed, true);
  assert.deepEqual(pick(await judgeScan(raw, after), ['result', 'reason']), { result: 'CHECK', reason: 'NO_EXIT_RECORD' });
});

test('O-T15 PLACEMENT는 자기 기기·판이 큰 것만 모드를 바꾸고(다른 기기·같은 판·작은 판은 그대로), 바뀐 뒤 판정 방향이 OUT이다', async () => {
  const s = m().packageStateOf(pkg({ reentryAllowed: true }), IN_PLACEMENT);
  const placement = (seq: number, deviceId: string, version: number) => ({ seq, kind: 'PLACEMENT', payload: { v: 1, deviceId, gateZone: '동문', mode: 'OUT', version } });
  for (const [label, c] of [
    ['다른 기기', placement(41, OTHER_DEVICE, 9)],
    ['같은 판', placement(41, DEVICE, 5)],
    ['작은 판', placement(41, DEVICE, 4)],
  ] as const) {
    assert.deepEqual(m().applyChangePage(s, pageOf([c]), DEVICE).placement, IN_PLACEMENT, label);
  }
  const switched = m().applyChangePage(s, pageOf([placement(41, DEVICE, 6)]), DEVICE);
  assert.deepEqual(switched.placement, { gateZone: '동문', mode: 'OUT', version: 6 });
  const o = await judgeScan(await qrText(key, { ticketId: T2, timestampSec: QR_SEC }), switched);
  assert.deepEqual(pick(o, ['result', 'direction', 'ticketId']), { result: 'PASS', direction: 'OUT', ticketId: T2 });
});

test('GAT-140 목록을 다시 받아도 목록 값보다 늦은 이 기기(LOCAL) 입장 상태는 남고, 이른 것은 목록 값이 된다', () => {
  const first = m().packageStateOf(pkg(), IN_PLACEMENT);
  const late: EntryState = { lastDirection: 'IN', lastAtMs: Date.parse('2026-11-23T09:59:00.000Z'), gateZone: '동문', source: 'LOCAL' };
  const early: EntryState = { lastDirection: 'OUT', lastAtMs: Date.parse('2026-11-23T09:40:00.000Z'), gateZone: '동문', source: 'LOCAL' };
  const local = m().withLocalEntry(m().withLocalEntry(first, T, late), T2, early);
  assert.deepEqual(local.entries.get(T), late);
  assert.deepEqual(local.entries.get(T2), early);
  assert.equal(first.entries.has(T), false, '넘긴 상태가 그대로다');

  const reloaded = m().packageStateOf(pkg(), IN_PLACEMENT, local.entries);
  assert.deepEqual(reloaded.entries.get(T), late, '목록에 없던 이 기기 통과를 잃지 않는다');
  assert.deepEqual(reloaded.entries.get(T2), { lastDirection: 'IN', lastAtMs: Date.parse('2026-11-23T09:50:00.000Z'), gateZone: '동문', source: 'PACKAGE' });
});

test('GAT-140 FLAG·SESSION_TERMINATED 반영은 티켓·입장 상태·정책·배치를 바꾸지 않는다', () => {
  const s = m().packageStateOf(pkg(), IN_PLACEMENT);
  const after = m().applyChangePage(s, pageOf([
    { seq: 41, kind: 'FLAG', payload: { v: 1, flagId: '0190f3a1-7c2e-7a00-8b2a-6c1d5e71ff01', ticketId: T, kind: 'DUPLICATE', status: 'OPEN' } },
    { seq: 42, kind: 'SESSION_TERMINATED', payload: { v: 1, deviceId: OTHER_DEVICE, reason: 'DEVICE_REVOKED' } },
  ]), DEVICE);
  for (const k of ['tickets', 'revoked', 'entries', 'reentryAllowed', 'placement'] as const) assert.deepEqual(after[k], s[k], k);
});

test('GAT-160 쪽을 반영하면 저장 벡터와 마지막 번호는 그 쪽 응답의 versionVector·lastSeq가 된다(lastSeq와 벡터 seq가 달라도 따로)', () => {
  const s = m().packageStateOf(pkg(), IN_PLACEMENT);
  // 서버가 더 가진 변경이 있어(hasMore) 쪽 끝 번호(43)와 벡터의 seq(50)가 다르다
  const vv = vectorOf({ seq: 50, keySeq: 41, policySeq: 42, placementSeq: 30, ticketSeq: 43 });
  const page = { changes: [
    { seq: 41, kind: 'KEY_REGISTERED', payload: { v: 1, ticketId: T3, keyId: lateKey.keyId, publicKey: lateKey.publicKey } },
    { seq: 42, kind: 'POLICY', payload: { v: 1, reentryAllowed: true } },
    { seq: 43, kind: 'TICKET_STATUS', payload: { v: 1, ticketId: T, status: 'FLAGGED', version: 2 } },
  ], lastSeq: 43, hasMore: true, versionVector: vv };
  const after = m().applyChangePage(s, page, DEVICE);
  assert.equal(after.lastSeq, 43);
  assert.deepEqual(after.versionVector, vv);
  assert.notDeepEqual(s.versionVector, vv, '시험 값이 처음 벡터와 다르다');
  // 모르는 종류만 든 쪽도 벡터는 쪽 값이 된다
  const vv2 = vectorOf({ seq: 60 });
  const skipped = m().applyChangePage(after, { changes: [{ seq: 44, kind: 'BRAND_NEW_KIND', payload: { v: 1 } }], lastSeq: 44, hasMore: false, versionVector: vv2 }, DEVICE);
  assert.deepEqual([skipped.lastSeq, skipped.versionVector], [44, vv2]);
});

test('O-T23 이 기기(LOCAL) 통과보다 이른 다른 기기 SCAN_STATE는 입장 상태를 바꾸지 않는다', () => {
  const local: EntryState = { lastDirection: 'IN', lastAtMs: Date.parse('2026-11-23T09:59:00.000Z'), gateZone: '동문', source: 'LOCAL' };
  const s = m().withLocalEntry(m().packageStateOf(pkg(), IN_PLACEMENT), T, local);
  const after = m().applyChangePage(s, pageOf([scanState(41, T, 'OUT', '2026-11-23T09:58:59.999Z')]), DEVICE);
  assert.deepEqual(after.entries.get(T), local);
});

test('O-T25 읽히지 않는 publicKey의 KEY_REGISTERED는 그 키를 모름으로 두어 KEY_UNKNOWN이고 다시 받기 표시가 선다', async () => {
  const raw = await qrText(lateKey, { ticketId: T3, timestampSec: QR_SEC });
  const s = m().packageStateOf(pkg(), { gateZone: '서문', mode: 'IN', version: 5 });
  const bad = m().applyChangePage(s, pageOf([{ seq: 41, kind: 'KEY_REGISTERED', payload: { v: 1, ticketId: T3, keyId: lateKey.keyId, publicKey: 'AAAA' } }]), DEVICE);
  assert.deepEqual(pick(await judgeScan(raw, bad), ['result', 'reason']), { result: 'REJECT', reason: 'KEY_UNKNOWN' });
  assert.equal(bad.resyncRequired, true);
});

test('GAT-140 판 번호·변경 번호는 수로 견준다(PLACEMENT 판 9 → 10, 변경 번호 99 → 100)', () => {
  const p = packageOf({ tickets: pkg().tickets, lastSeq: 99, versionVector: vectorOf({ seq: 99 }) });
  const s = m().packageStateOf(p, { gateZone: '동문', mode: 'IN', version: 9 });
  const after = m().applyChangePage(s, pageOf([{ seq: 100, kind: 'PLACEMENT', payload: { v: 1, deviceId: DEVICE, gateZone: '동문', mode: 'OUT', version: 10 } }], 99), DEVICE);
  assert.deepEqual(after.placement, { gateZone: '동문', mode: 'OUT', version: 10 });
  assert.equal(after.lastSeq, 100);
  // 100 다음에 오는 99 이하는 버린다
  const stale = m().applyChangePage(after, pageOf([{ seq: 99, kind: 'POLICY', payload: { v: 1, reentryAllowed: true } }], 98), DEVICE);
  assert.equal(stale.reentryAllowed, after.reentryAllowed);
});

test('GAT-140 목록을 다시 받을 때 이 기기 입장 상태가 목록 값과 같은 시각이면 목록 값이 된다(늦은 것만 남긴다)', () => {
  const same: EntryState = { lastDirection: 'OUT', lastAtMs: Date.parse('2026-11-23T09:50:00.000Z'), gateZone: '동문', source: 'LOCAL' };
  const local = m().withLocalEntry(m().packageStateOf(pkg(), IN_PLACEMENT), T2, same);
  const reloaded = m().packageStateOf(pkg(), IN_PLACEMENT, local.entries);
  assert.deepEqual(reloaded.entries.get(T2), { lastDirection: 'IN', lastAtMs: Date.parse('2026-11-23T09:50:00.000Z'), gateZone: '동문', source: 'PACKAGE' });
});
