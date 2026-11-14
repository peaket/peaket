// 월렛 Dexie 저장소 시험(BAT-350, FR-012, offline-gate §2·§4). fake-indexeddb로 실제 IndexedDB API를 흉내 낸다.
// 기기 키·티켓 스냅샷·마지막 동기화 시각이 `peaket-wallet`에 남고 같은 티켓 키를 덮어쓰는지 본다.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deleteDeviceKey,
  isWalletSnapshotStale,
  loadDeviceKey,
  loadLastSyncedAt,
  loadTicketSnapshot,
  loadWalletVersionVector,
  saveDeviceKey,
  saveLastSyncedAt,
  saveTicketSnapshot,
  saveWalletVersionVector,
  WALLET_DB_NAME,
  walletDatabase,
} from './store.ts';

const TICKET = '0190f3a1-7c2e-7a00-8000-000000000101';

test('Dexie peaket-wallet은 기기 키·티켓 스냅샷·마지막 동기화 시각을 남기고 키를 덮어쓴다', async () => {
  const db = walletDatabase();
  assert.equal(db?.name, WALLET_DB_NAME);
  assert.equal(WALLET_DB_NAME, 'peaket-wallet');
  assert.equal(walletDatabase(), db);

  await saveDeviceKey({
    ticketId: TICKET,
    keyId: 'XLBMt79W8SU',
    privateKey: { type: 'private', extractable: false, algorithm: { name: 'ECDSA', namedCurve: 'P-256' } },
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
    createdAt: 1_700_000_000_000,
    reason: 'ISSUE',
    registration: 'LOCAL',
  });
  const loaded = await loadDeviceKey(TICKET);
  assert.equal(loaded?.keyId, 'XLBMt79W8SU');
  assert.equal(loaded?.privateKey.extractable, false);
  assert.equal(loaded?.publicKeyJwk.kty, 'EC');
  assert.equal(loaded?.registration, 'LOCAL');

  await saveDeviceKey({ ...loaded, keyId: 'AAAAAAAAAAA', registration: 'REGISTERED', createdAt: 1_700_000_001_000 });
  const replaced = await loadDeviceKey(TICKET);
  assert.equal(replaced?.keyId, 'AAAAAAAAAAA');
  assert.equal(replaced?.registration, 'REGISTERED');
  assert.equal((await db.deviceKeys.count()), 1);

  await saveTicketSnapshot({ ticketId: TICKET, title: 'LUMEN 콘서트 2026 서울', whenText: '10/25(일) 18:00', venueName: '피켓 아레나', seat: 'R구역 12열 7번', gate: '동문', updatedAt: 1_700_000_002_000 });
  const snapshot = await loadTicketSnapshot(TICKET);
  assert.equal(snapshot?.seat, 'R구역 12열 7번');
  assert.equal(snapshot?.updatedAt, 1_700_000_002_000);

  await saveLastSyncedAt(1_700_000_003_000);
  assert.equal(await loadLastSyncedAt(), 1_700_000_003_000);

  await saveWalletVersionVector({
    eventId: 'ev-1',
    seq: 10,
    ticketSeq: 4,
    keySeq: 5,
    policySeq: 1,
    placementSeq: 2,
    flagSeq: 3,
    issuedAt: new Date(1_700_000_003_000).toISOString(),
    maxOfflineMs: 24 * 3_600_000,
  });
  const vector = await loadWalletVersionVector();
  assert.equal(vector?.seq, 10);
  assert.equal(vector?.maxOfflineMs, 24 * 3_600_000);
  assert.equal(isWalletSnapshotStale(vector, 1_700_000_003_000, 1_700_000_003_000 + 24 * 3_600_000), false);
  assert.equal(isWalletSnapshotStale(vector, 1_700_000_003_000, 1_700_000_003_000 + 24 * 3_600_000 + 1), true);

  await deleteDeviceKey(TICKET);
  assert.equal(await loadDeviceKey(TICKET), undefined);
  assert.equal(await db.deviceKeys.count(), 0);
});
