// F-05-4 회차 입장 정책 사본과 POLICY 변경분 시험(계획 docs/review/plans/F-05-4.md §4 서버·§6 O-T15).
// 정본: docs/features/offline-gate.md §6.3 'POLICY를 적는 곳'(사본 조건부 갱신, 사본 없음 → 만들기만, core 못 닿음 → 사본 그대로, 같은 바뀜은 한 줄),
// docs/data.md scanner_event_policy(policy_seq는 처음 만들 때 0), §10.2(중복 업로드는 duplicate로 센다: ScanBatchResult.duplicateIds).
// 저장소는 진짜 메모리 어댑터(MemoryScannerGateStore), core-svc 정책은 ScannerEventPolicyProvider 포트를 구현한 대역이다(외부 서비스 경계).
import { fakeClock } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { ScannerGate } from '../src/modules/scanner/application/scanner-gate.js';
import type { ScannerEventPolicy, ScannerEventPolicyProvider, ScannerGateStore } from '../src/modules/scanner/domain/ports.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';

const NOW = Date.parse('2026-11-23T09:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f5401';
const TICKET = '0190f3a1-7c2e-7a00-8000-0000000f5402';
const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f5403';
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f5404';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000f5405';

/** 계획 §4의 새 저장소 메서드(구현 전에는 없다) */
type SyncPolicy = (i: { eventId: string; coreReentryAllowed?: boolean; atMs: number }) => Promise<{ reentryAllowed?: boolean; changedSeq?: number }>;
function syncPolicyOf(store: ScannerGateStore): SyncPolicy {
  const f = (store as ScannerGateStore & { syncPolicy?: SyncPolicy }).syncPolicy;
  expect(typeof f, 'MemoryScannerGateStore.syncPolicy가 없다').toBe('function');
  return f!.bind(store);
}

/** core-svc 회차 정책 대역: 값을 바꾸고, 닿지 못하게(던짐) 할 수 있다 */
class CorePolicy implements ScannerEventPolicyProvider {
  reentryAllowed: boolean | 'down' | 'missing' = false;
  calls = 0;
  async get(): Promise<ScannerEventPolicy | undefined> {
    this.calls++;
    if (this.reentryAllowed === 'down') throw new Error('시험이 넣은 core-svc 끊김');
    if (this.reentryAllowed === 'missing') return undefined;
    return { promoterId: PROMOTER, reentryAllowed: this.reentryAllowed };
  }
}

let store: MemoryScannerGateStore;
let core: CorePolicy;
let gate: ScannerGate;

const policyChanges = () => (store.changeLog.get(EVENT) ?? []).filter((c) => c.kind === 'POLICY');

beforeEach(() => {
  store = new MemoryScannerGateStore();
  store.seedTicket({ ticketId: TICKET, eventId: EVENT, seatId: 'A-1', gateZone: '동문', status: 'ACTIVE' });
  core = new CorePolicy();
  gate = new ScannerGate({ store, clock: fakeClock({ now: NOW }), policy: core });
});

describe('입장 정책 사본 syncPolicy [O-T15]', () => {
  test('O-T15 사본이 없으면 그때 core 값으로 만들기만 하고 POLICY 변경분은 적지 않는다', async () => {
    const sync = syncPolicyOf(store);
    expect(await sync({ eventId: EVENT, coreReentryAllowed: false, atMs: NOW })).toEqual({ reentryAllowed: false });
    expect(policyChanges()).toEqual([]);
    expect(store.lastSeq(EVENT)).toBe(0);
  });

  test('O-T15 사본과 core 값이 다르면 POLICY 한 줄 {v:1, reentryAllowed:true}를 적고 그 번호를 돌려주며, 벡터 policySeq가 그 번호다', async () => {
    const sync = syncPolicyOf(store);
    await sync({ eventId: EVENT, coreReentryAllowed: false, atMs: NOW });
    store.appendChange(EVENT, 'TICKET_STATUS', { v: 1, ticketId: TICKET, status: 'ACTIVE', version: 2 });
    const r = await sync({ eventId: EVENT, coreReentryAllowed: true, atMs: NOW + 1_000 });
    expect(r).toEqual({ reentryAllowed: true, changedSeq: 2 });
    expect(policyChanges()).toEqual([{ seq: 2, kind: 'POLICY', payload: { v: 1, reentryAllowed: true } }]);
    expect((await store.versionVector(EVENT, NOW)).policySeq).toBe(2);
  });

  test('O-T15 같은 값을 다시 보면 변경분이 없고, core에 닿지 못하면(값 없음) 사본 값을 쓰며 변경분이 없다', async () => {
    const sync = syncPolicyOf(store);
    await sync({ eventId: EVENT, coreReentryAllowed: false, atMs: NOW });
    await sync({ eventId: EVENT, coreReentryAllowed: true, atMs: NOW + 1 });
    expect(await sync({ eventId: EVENT, coreReentryAllowed: true, atMs: NOW + 2 })).toEqual({ reentryAllowed: true });
    expect(await sync({ eventId: EVENT, atMs: NOW + 3 })).toEqual({ reentryAllowed: true });
    expect(policyChanges()).toHaveLength(1);
  });

  test('O-T15 사본도 없고 core도 모르면 reentryAllowed가 없고 변경분도 없다', async () => {
    expect(await syncPolicyOf(store)({ eventId: EVENT, atMs: NOW })).toEqual({});
    expect(policyChanges()).toEqual([]);
  });

  test('O-T15 같은 바뀜을 두 요청이 함께 보아도 POLICY는 한 줄이다', async () => {
    const sync = syncPolicyOf(store);
    await sync({ eventId: EVENT, coreReentryAllowed: false, atMs: NOW });
    const [a, b] = await Promise.all([sync({ eventId: EVENT, coreReentryAllowed: true, atMs: NOW + 1 }), sync({ eventId: EVENT, coreReentryAllowed: true, atMs: NOW + 1 })]);
    expect(policyChanges()).toHaveLength(1);
    expect([a.changedSeq, b.changedSeq].filter((x) => x !== undefined)).toEqual([1]);
    expect([a.reentryAllowed, b.reentryAllowed]).toEqual([true, true]);
  });
});

describe('목록·변경분이 정책을 맞춘다 [O-T15]', () => {
  test('O-T15 처음 목록은 사본을 만들고(core false) reentryAllowed false, core가 true로 바뀐 뒤 변경분 요청에 POLICY가 실려 온다', async () => {
    expect((await gate.package(EVENT, EVENT)).reentryAllowed).toBe(false);
    expect(policyChanges()).toEqual([]);
    core.reentryAllowed = true;
    const c = await gate.changes(EVENT, '0', '100', EVENT);
    expect(c.changes).toEqual([{ seq: 1, kind: 'POLICY', payload: { v: 1, reentryAllowed: true } }]);
    expect(c.versionVector.policySeq).toBe(1);
    expect((await gate.package(EVENT, EVENT)).reentryAllowed).toBe(true);
    expect(policyChanges()).toHaveLength(1);
  });

  test('O-T15 core에 닿지 못하면 목록의 reentryAllowed는 마지막 사본 값(true)이고 변경분은 늘지 않는다', async () => {
    await gate.package(EVENT, EVENT);
    core.reentryAllowed = true;
    await gate.changes(EVENT, '0', '100', EVENT);
    core.reentryAllowed = 'down';
    expect((await gate.package(EVENT, EVENT)).reentryAllowed).toBe(true);
    core.reentryAllowed = 'missing';
    expect((await gate.package(EVENT, EVENT)).reentryAllowed).toBe(true);
    expect(policyChanges()).toHaveLength(1);
  });

  test('O-T15 사본이 없고 core도 모르면 목록의 reentryAllowed는 false다(닫힌 쪽)', async () => {
    core.reentryAllowed = 'down';
    expect((await gate.package(EVENT, EVENT)).reentryAllowed).toBe(false);
    expect(policyChanges()).toEqual([]);
  });
});

describe('중복 업로드 가르기 [O-T10]', () => {
  const scan = (n: number): ScanEventInput => ({
    id: `0190f3a1-7c2e-7f00-8000-${String(n).padStart(12, '0')}`,
    eventId: EVENT,
    ticketId: TICKET,
    scannerSessionId: SESSION,
    direction: 'IN',
    method: 'QR',
    result: n === 1 ? 'PASS' : 'REJECT',
    ...(n === 1 ? {} : { reason: 'ALREADY_IN' }),
    gateZone: '동문',
    scannedAtDevice: new Date(NOW + n * 1_000).toISOString(),
    knownSeq: 0,
    deviceSeq: n,
  });

  test('O-T10 같은 묶음을 두 번 올리면 두 번째 결과의 duplicateIds가 그 ID 전부이고 첫 번째는 비었다(응답 acceptedIds는 둘 다 전부)', async () => {
    const batch = [scan(1), scan(2)];
    const first = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, body: batch });
    const second = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, body: batch });
    const ids = batch.map((s) => s.id);
    expect(first.acceptedIds).toEqual(ids);
    expect(second.acceptedIds).toEqual(ids);
    expect((first as typeof first & { duplicateIds?: string[] }).duplicateIds).toEqual([]);
    expect((second as typeof second & { duplicateIds?: string[] }).duplicateIds).toEqual(ids);
    expect(store.scans.size).toBe(2);
  });
});
