// R-622 독립 회귀 시험: scanner 앱 C1-06·C1-07·C1-08·C1-09·C1-12 계약.
// 앱은 vitest가 아니라 node --test를 쓰므로 package.json test 목록에도 이 파일을 넣는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dpopProof, generateDpopKey, type DpopKey } from '../src/api/dpop.ts';
import { enrollWithNewDeviceKey } from '../src/api/key-store.ts';
import {
  reloginRequired,
  serverClockOffsetMs,
  sessionExpiryDelayMs,
  syncChangePages,
} from '../src/api/live.ts';
import type { ScannerChangesResponse, ScannerVersionVector } from '../src/api/client.ts';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const HOUR = 60 * 60_000;

const vector = (over: Partial<ScannerVersionVector> = {}): ScannerVersionVector => ({
  eventId: 'ev-1',
  seq: 10,
  ticketSeq: 4,
  keySeq: 5,
  policySeq: 1,
  placementSeq: 2,
  flagSeq: 3,
  issuedAt: new Date(NOW).toISOString(),
  maxOfflineMs: 24 * HOUR,
  ...over,
});

const page = (i: {
  changes: ScannerChangesResponse['changes'];
  lastSeq: number;
  hasMore: boolean;
}): ScannerChangesResponse => ({ ...i, versionVector: vector({ seq: i.lastSeq }) });

const decode = (part: string): Record<string, unknown> => {
  const pad = part.length % 4 === 0 ? '' : '='.repeat(4 - (part.length % 4));
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8')) as Record<string, unknown>;
};

test('R-622 C1-06 저장한 마지막 번호부터 변경분 페이지를 끝까지 받는다', async () => {
  const pages = new Map<number, ScannerChangesResponse>([
    [7, page({ changes: [{ seq: 8, kind: 'TICKET_STATUS', payload: {} }], lastSeq: 8, hasMore: true })],
    [8, page({ changes: [{ seq: 9, kind: 'SCAN_STATE', payload: {} }, { seq: 10, kind: 'FLAG', payload: {} }], lastSeq: 10, hasMore: false })],
  ]);
  const seen: number[] = [];
  const r = await syncChangePages({
    snapshot: { eventId: 'ev-1', lastSeq: 7, syncedAtMs: NOW - 1_000 },
    after: 7,
    deviceId: 'dev-1',
    nowMs: NOW,
    fetchPage: async (after) => {
      seen.push(after);
      const p = pages.get(after);
      assert.ok(p, `예상하지 않은 커서 ${after}`);
      return p;
    },
  });
  assert.deepEqual(seen, [7, 8]);
  assert.equal(r.snapshot.lastSeq, 10);
  assert.equal(r.snapshot.syncedAtMs, NOW);
  assert.equal(r.last?.lastSeq, 10);
  assert.equal(r.pages, 2);
});

test('R-622 C1-06·C1-09 SESSION_TERMINATED를 만나면 그 페이지를 적용하지 않고 멈춘다', async () => {
  const seen: number[] = [];
  const r = await syncChangePages({
    snapshot: { eventId: 'ev-1', lastSeq: 7, syncedAtMs: NOW - 1_000 },
    after: 7,
    deviceId: 'dev-1',
    nowMs: NOW,
    fetchPage: async (after) => {
      seen.push(after);
      if (after === 7) return page({ changes: [{ seq: 8, kind: 'TICKET_STATUS', payload: {} }], lastSeq: 8, hasMore: true });
      return page({
        changes: [
          { seq: 9, kind: 'SCAN_STATE', payload: {} },
          { seq: 10, kind: 'SESSION_TERMINATED', payload: { v: 1, deviceId: 'dev-1', reason: 'DEVICE_REVOKED' } },
        ],
        lastSeq: 10,
        hasMore: true,
      });
    },
  });
  assert.deepEqual(seen, [7, 8]);
  assert.deepEqual(r.terminated, { reason: 'DEVICE_REVOKED' });
  // 종료를 발견한 페이지는 반영하지 않는다. 다음 동기화가 같은 자리에서 재로그인으로 간다.
  assert.equal(r.snapshot.lastSeq, 8);
  assert.equal(r.pages, 2);
});

test('R-622 C1-06 maxPages에서 멈추고, 커서가 전진하지 않으면 무한 반복하지 않는다', async () => {
  const seen: number[] = [];
  const capped = await syncChangePages({
    snapshot: { eventId: 'ev-1', lastSeq: 0, syncedAtMs: 0 },
    after: 0,
    deviceId: 'dev-1',
    nowMs: NOW,
    maxPages: 3,
    fetchPage: async (after) => {
      seen.push(after);
      return page({ changes: [{ seq: after + 1, kind: 'SCAN_STATE', payload: {} }], lastSeq: after + 1, hasMore: true });
    },
  });
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(capped.pages, 3);
  assert.equal(capped.snapshot.lastSeq, 3);

  const stuckSeen: number[] = [];
  const stuck = await syncChangePages({
    snapshot: { eventId: 'ev-1', lastSeq: 4, syncedAtMs: NOW },
    after: 4,
    deviceId: 'dev-1',
    nowMs: NOW,
    fetchPage: async (after) => {
      stuckSeen.push(after);
      return page({ changes: [], lastSeq: after, hasMore: true });
    },
  });
  assert.deepEqual(stuckSeen, [4]);
  assert.equal(stuck.pages, 1);
  assert.equal(stuck.snapshot.lastSeq, 4);
});

test('R-622 C1-07 서버 시각 차이를 DPoP iat에 적용하면 서버 초와 같아진다', async () => {
  const deviceNow = Date.parse('2026-11-15T00:00:00.000Z');
  const serverTime = '2026-11-15T00:05:00.000Z';
  const offset = serverClockOffsetMs(serverTime, deviceNow);
  assert.equal(offset, 5 * 60_000);
  assert.equal(serverClockOffsetMs('2026-11-15T00:00:00.000Z', deviceNow + 1_600), -1_600);
  assert.equal(serverClockOffsetMs('깨진 시각', deviceNow), 0);

  const key = await generateDpopKey();
  const proof = await dpopProof({
    key,
    method: 'GET',
    url: 'https://scanner-api.peaket.example/v1/scanner/shift',
    nowMs: deviceNow + offset,
  });
  const payload = decode(proof.split('.')[1]!);
  assert.equal(payload.iat, Math.floor(Date.parse(serverTime) / 1000));
});

test('R-622 C1-08 세션 만료까지 남은 시간은 지난 뒤 0, 모르면 undefined다', () => {
  assert.equal(sessionExpiryDelayMs(NOW + 1, NOW), 1);
  assert.equal(sessionExpiryDelayMs(NOW, NOW), 0);
  assert.equal(sessionExpiryDelayMs(NOW - 1, NOW), 0);
  assert.equal(sessionExpiryDelayMs(Number.MAX_SAFE_INTEGER, NOW), undefined);
  assert.equal(sessionExpiryDelayMs(Number.NaN, NOW), undefined);
  assert.equal(sessionExpiryDelayMs(Number.POSITIVE_INFINITY, NOW), undefined);
});

test('R-622 C1-09 401·기기 폐기·세션 종료만 재로그인으로 돌린다', () => {
  assert.equal(reloginRequired(401, 'invalid_token'), true);
  assert.equal(reloginRequired(401, 'invalid_dpop_proof'), true);
  assert.equal(reloginRequired(403, 'device-revoked'), true);
  assert.equal(reloginRequired(403, 'invalid_token'), true);
  assert.equal(reloginRequired(403, 'scanner-override-forbidden'), false);
  assert.equal(reloginRequired(403, 'scanner-event-mismatch'), false);
  assert.equal(reloginRequired(400, 'invalid_token'), false);
  assert.equal(reloginRequired(503, 'scanner-auth-unavailable'), false);
});

test('R-622 C1-12 기기 재등록은 새 키를 만들고 등록 성공 뒤에만 저장한다', async () => {
  const first = { jkt: 'first' } as unknown as DpopKey;
  const second = { jkt: 'second' } as unknown as DpopKey;
  const events: string[] = [];
  let saved: DpopKey | undefined;
  const run = (key: DpopKey, fail = false) =>
    enrollWithNewDeviceKey({
      generate: async () => {
        events.push('generate');
        return key;
      },
      enroll: async (k) => {
        events.push('enroll');
        assert.equal(k, key);
        if (fail) throw new Error('등록 거절');
      },
      save: async (k) => {
        events.push('save');
        saved = k;
      },
    });

  assert.equal(await run(first), first);
  assert.deepEqual(events, ['generate', 'enroll', 'save']);
  assert.equal(saved, first);

  // 두 번째 등록도 저장된 옛 키를 재사용하지 않고 새 키를 만든다.
  events.length = 0;
  saved = undefined;
  assert.equal(await run(second), second);
  assert.deepEqual(events, ['generate', 'enroll', 'save']);
  assert.equal(saved, second);

  // 등록이 실패하면 저장하지 않아 옛 키가 그대로 남는다.
  events.length = 0;
  saved = undefined;
  await assert.rejects(run(first, true), /등록 거절/);
  assert.deepEqual(events, ['generate', 'enroll']);
  assert.equal(saved, undefined);
});

