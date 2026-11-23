// F-05-6 입장 기록 마감 배경 작업 EntryCloseTick 시험(BUILD_ORDER GAT-180, O-T29 ①②⑥)과 메모리 저장소의 계약 시험.
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'(판단 1분·회차 50개·ends_at을 모르면 건너뜀·core 알림·미보고 스캐너 건·다시 보내기),
// asyncapi CaseRequested(ADR-0364 결정 4), 계획 docs/review/plans/F-05-6.md §4 EntryCloseTick·EntryCloseCoreSink·ScannerCaseSink.
// 저장소는 메모리 짝(MemoryEntryCloseStore, 같은 계약을 실제 PostgreSQL에도 돌린다), 바깥 경계(core-svc 판매 설정·core 알림·ops CS 건)만
// 포트를 implements한 대역이다. 시계는 가짜 시계다(고정 대기 없음). 단언 값은 정본에서 숫자로 적는다.
// 새 모듈은 아직 없으므로 시험마다 동적으로 불러온다.
import { createHash, randomUUID } from 'node:crypto';
import { fakeClock, type FakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import type { EntryCloseCoreSink, EntryCloseStore, ScannerCaseSink, ScannerEventPolicy, ScannerEventPolicyProvider } from '../src/modules/scanner/domain/ports.js';
import { entryCloseStoreContract, type EntryCloseHarness } from './entry-close-store-contract.js';

type TickModule = typeof import('../src/modules/scanner/application/entry-close.js');
type MemoryModule = typeof import('../src/modules/scanner/adapters/memory-entry-close-store.js');
const loadTick = (): Promise<TickModule> => import('../src/modules/scanner/application/entry-close.js');
const loadMemory = (): Promise<MemoryModule> => import('../src/modules/scanner/adapters/memory-entry-close-store.js');

/** 정본 '역할 유효 끝은 ends_at + 2시간' */
const ROLE_END_AFTER_ENDS_MS = 7_200_000;
/** 정본 '24시간 [가정]' */
const UNREPORTED_WAIT_MS = 86_400_000;
const ENDS = Date.parse('2026-11-23T12:17:43.219Z');
const R = ENDS + ROLE_END_AFTER_ENDS_MS;
const STARTS = ENDS - 3 * 3_600_000;
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000f06a0';
const STAFF = '0190f3a1-7c2e-7a00-8000-0000000f06a1';

const unreportedKey = (eventId: string, deviceId: string): string => {
  const h = createHash('sha256').update(`scanner-unreported:${eventId}:${deviceId}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

// ---- 메모리 저장소의 계약 ----
async function memoryHarness(): Promise<EntryCloseHarness & { store: EntryCloseStore }> {
  const { MemoryEntryCloseStore } = await loadMemory();
  const shifts = new MemoryScannerShiftStore(new MemoryScannerGateStore());
  const store = new MemoryEntryCloseStore({ shifts });
  return { store, shifts, seedEvent: async (eventId, startsAtMs) => store.seedEventStart(eventId, startsAtMs) };
}

entryCloseStoreContract('메모리', memoryHarness);

// ---- 바깥 경계 대역(포트를 implements한다) ----
/** core-svc 판매 설정. 회차마다 답(정책·undefined·던짐)을 정하고 물은 회차를 적는다 */
class FakePolicy implements ScannerEventPolicyProvider {
  readonly answers = new Map<string, ScannerEventPolicy | 'throw'>();
  readonly asked: string[] = [];
  async get(eventId: string): Promise<ScannerEventPolicy | undefined> {
    this.asked.push(eventId);
    const a = this.answers.get(eventId);
    if (a === 'throw') throw new Error('core-svc 판매 설정을 읽지 못했다(시험이 넣은 장애)');
    return a;
  }
}

type CoreAnswer = Awaited<ReturnType<EntryCloseCoreSink['notify']>>;
/** core-svc 내부 입구. 답 차례를 정하고(없으면 받은 값 그대로 200) 받은 알림을 적는다 */
class FakeCore implements EntryCloseCoreSink {
  readonly calls: { eventId: string; closedAtMs: number }[] = [];
  readonly queue: CoreAnswer[] = [];
  async notify(eventId: string, closedAtMs: number): Promise<CoreAnswer> {
    this.calls.push({ eventId, closedAtMs });
    return this.queue.shift() ?? { ok: true, storedAtMs: closedAtMs };
  }
}

type CaseBody = Parameters<ScannerCaseSink['open']>[0];
/** ops-svc CS 처리함 내부 입구. 답 차례(true = 2xx ∧ accepted true)를 정하고 받은 본문을 적는다 */
class FakeCases implements ScannerCaseSink {
  readonly bodies: CaseBody[] = [];
  readonly queue: boolean[] = [];
  async open(c: CaseBody): Promise<boolean> {
    this.bodies.push(c);
    return this.queue.shift() ?? true;
  }
}

/** 모든 부름을 적는 기록기(pino 꼴 info·warn·error) */
class Log {
  readonly lines: string[] = [];
  info = (...a: unknown[]): void => void this.lines.push(`info ${JSON.stringify(a)}`);
  warn = (...a: unknown[]): void => void this.lines.push(`warn ${JSON.stringify(a)}`);
  error = (...a: unknown[]): void => void this.lines.push(`error ${JSON.stringify(a)}`);
  debug = (...a: unknown[]): void => void this.lines.push(`debug ${JSON.stringify(a)}`);
}

const policyOf = (endsAtMs: number | undefined): ScannerEventPolicy => ({ promoterId: PROMOTER, reentryAllowed: false, ...(endsAtMs !== undefined ? { endsAtMs } : {}) });

interface Rig {
  h: EntryCloseHarness;
  clock: FakeClock;
  policy: FakePolicy;
  core: FakeCore;
  cases: FakeCases;
  log: Log;
  tick: InstanceType<TickModule['EntryCloseTick']>;
  /** 회차(시작 STARTS, ends_at ENDS)와 로그인한 배치 기기 n대 */
  event(devices: number, o?: { endsAtMs?: number | undefined; startsAtMs?: number }): Promise<{ eventId: string; deviceIds: string[] }>;
}

async function rig(nowMs: number): Promise<Rig> {
  const { EntryCloseTick } = await loadTick();
  const h = await memoryHarness();
  const clock = fakeClock({ now: nowMs });
  const policy = new FakePolicy();
  const core = new FakeCore();
  const cases = new FakeCases();
  const log = new Log();
  const tick = new EntryCloseTick({ store: h.store, policy, core, cases, clock, log });
  return {
    h,
    clock,
    policy,
    core,
    cases,
    log,
    tick,
    async event(devices, o = {}) {
      const eventId = randomUUID();
      await h.seedEvent(eventId, o.startsAtMs ?? STARTS);
      policy.answers.set(eventId, policyOf('endsAtMs' in o ? o.endsAtMs : ENDS));
      const deviceIds: string[] = [];
      for (let n = 0; n < devices; n++) {
        const deviceId = randomUUID();
        await h.shifts.putPlacement({ eventId, deviceId, gateZone: '동문', mode: 'IN', setBy: STAFF, atMs: STARTS - 3_600_000, expectedVersion: 0 });
        await h.shifts.reportReadiness({ eventId, deviceId, packageSeq: 1, clockOffsetMs: 0, pendingUploads: 0, reportedBy: STAFF, atMs: STARTS - 1_800_000 });
        deviceIds.push(deviceId);
      }
      return { eventId, deviceIds };
    },
  };
}

describe('판단 주기(offline-gate §7.3 판단)', () => {
  test('O-T29 ① 배경 작업 주기는 1분(60,000ms)이다', async () => {
    const { ENTRY_CLOSE_EVERY_MS } = await loadTick();
    expect(ENTRY_CLOSE_EVERY_MS).toBe(60_000);
  });
});

describe('EntryCloseTick 마감(O-T29 ①②)', () => {
  test('O-T29 ① 모든 기기가 역할 유효 끝에 비움을 보고하면 그 판단에 ALL_REPORTED로 마감하고 마감 시각을 core에 알리며 CS 건은 없다', async () => {
    const r = await rig(R);
    const { eventId, deviceIds } = await r.event(2);
    for (const deviceId of deviceIds) expect(await r.h.store.putQueueReport({ eventId, deviceId, pendingUploads: 0, nowMs: R })).toBe('stored');
    expect(await r.tick.run()).toEqual({ closed: 1, coreSynced: 1, casesOpened: 0 });
    expect(await r.h.store.closedAt(eventId)).toBe(R);
    expect(r.core.calls).toEqual([{ eventId, closedAtMs: R }]);
    expect(r.cases.bodies).toEqual([]);
    expect((await r.h.store.pendingCoreSync(100)).map((p) => p.eventId)).not.toContain(eventId);
    // 다음 판단은 다시 마감하지 않고 core에도 다시 알리지 않는다
    r.clock.advance(60_000);
    expect(await r.tick.run()).toEqual({ closed: 0, coreSynced: 0, casesOpened: 0 });
    expect(r.core.calls).toHaveLength(1);
  });

  test('O-T29 ① 로그인했던 기기가 없는 회차는 R−1ms 판단에 마감되지 않고, 1ms 뒤 판단에 마감된다', async () => {
    const r = await rig(R - 1);
    const { eventId } = await r.event(0);
    expect(await r.tick.run()).toEqual({ closed: 0, coreSynced: 0, casesOpened: 0 });
    expect(await r.h.store.closedAt(eventId)).toBeUndefined();
    expect(r.policy.asked).toContain(eventId);
    r.clock.advance(1);
    expect(await r.tick.run()).toEqual({ closed: 1, coreSynced: 1, casesOpened: 0 });
    expect(await r.h.store.closedAt(eventId)).toBe(R);
  });

  test('O-T29 ② 한 대 미보고면 R+86,400,000ms 1ms 전 미마감, 그때 TIMEOUT이고 ops가 받은 건은 그 기기 하나(kind·sourceId·category·createdAt=dueBaseAt=마감 시각·eventKey)다', async () => {
    const r = await rig(R + UNREPORTED_WAIT_MS - 1);
    const { eventId, deviceIds } = await r.event(2);
    const [reported, silent] = deviceIds as [string, string];
    await r.h.store.putQueueReport({ eventId, deviceId: reported, pendingUploads: 0, nowMs: R + 1 });
    expect(await r.tick.run()).toEqual({ closed: 0, coreSynced: 0, casesOpened: 0 });
    r.clock.advance(1);
    expect(await r.tick.run()).toEqual({ closed: 1, coreSynced: 1, casesOpened: 1 });
    const at = R + UNREPORTED_WAIT_MS;
    expect(await r.h.store.closedAt(eventId)).toBe(at);
    expect(r.cases.bodies).toEqual([
      { eventKey: unreportedKey(eventId, silent), kind: 'SCANNER_UNREPORTED', sourceId: `${eventId}/${silent}`, category: 'UNREPORTED_AT_CLOSE', createdAt: new Date(at).toISOString(), dueBaseAt: new Date(at).toISOString() },
    ]);
    // 건에는 기기·회차 ID만 있다(스태프·관객 정보 없음)
    expect(JSON.stringify(r.cases.bodies)).not.toContain(STAFF);
    expect((await r.h.store.pendingCases(100)).filter((c) => c.eventId === eventId)).toEqual([]);
  });

  test('O-T29 ② 마지막 보고의 pendingUploads가 1이면 대기 끝에 TIMEOUT이고 그 기기의 건이 열린다', async () => {
    const r = await rig(R + 60_000);
    const { eventId, deviceIds } = await r.event(1);
    await r.h.store.putQueueReport({ eventId, deviceId: deviceIds[0]!, pendingUploads: 1, nowMs: R + 30_000 });
    expect((await r.tick.run()).closed).toBe(0);
    r.clock.advance(UNREPORTED_WAIT_MS - 60_000);
    expect(await r.tick.run()).toEqual({ closed: 1, coreSynced: 1, casesOpened: 1 });
    expect(r.cases.bodies.map((b) => b.sourceId)).toEqual([`${eventId}/${deviceIds[0]}`]);
  });

  test('O-T29 ② 대기 사이에 그 기기가 비웠다고 보고하면 그 판단에서 ALL_REPORTED로 마감되고 건은 0이다', async () => {
    const r = await rig(R + 60_000);
    const { eventId, deviceIds } = await r.event(2);
    await r.h.store.putQueueReport({ eventId, deviceId: deviceIds[0]!, pendingUploads: 0, nowMs: R });
    expect((await r.tick.run()).closed).toBe(0);
    r.clock.advance(3_600_000);
    await r.h.store.putQueueReport({ eventId, deviceId: deviceIds[1]!, pendingUploads: 0, nowMs: r.clock.now() });
    r.clock.advance(60_000);
    expect(await r.tick.run()).toEqual({ closed: 1, coreSynced: 1, casesOpened: 0 });
    expect(r.cases.bodies).toEqual([]);
  });

  test('O-T29 ① 한 판단은 회차를 시작이 오래된 차례로 50개까지 본다(51번째는 다음 판단)', async () => {
    const r = await rig(R);
    const ids: string[] = [];
    for (let n = 0; n < 51; n++) ids.push((await r.event(0, { startsAtMs: STARTS - (51 - n) * 1_000 })).eventId);
    const newest = ids.at(-1)!;
    expect(await r.tick.run()).toMatchObject({ closed: 50 });
    expect(r.policy.asked).not.toContain(newest);
    expect(await r.h.store.closedAt(newest)).toBeUndefined();
    for (const id of ids.slice(0, 50)) expect(await r.h.store.closedAt(id), id).toBe(R);
    r.clock.advance(60_000);
    expect(await r.tick.run()).toMatchObject({ closed: 1 });
    expect(await r.h.store.closedAt(newest)).toBe(R + 60_000);
  });
});

describe('EntryCloseTick 장애·되돌림(O-T29 ⑥)', () => {
  test('O-T29 ⑥ core 내부 입구가 503을 두 번 주면 마감은 ticket-svc에 남고 다시 보내 세 번째에 알린 것으로 적는다(세 번 모두 같은 마감 시각)', async () => {
    const r = await rig(R);
    const { eventId } = await r.event(0);
    r.core.queue.push({ ok: false, status: 503 }, { ok: false, status: 503 });
    expect(await r.tick.run()).toEqual({ closed: 1, coreSynced: 0, casesOpened: 0 });
    expect((await r.h.store.pendingCoreSync(100)).filter((p) => p.eventId === eventId)).toEqual([{ eventId, closedAtMs: R }]);
    r.clock.advance(60_000);
    expect(await r.tick.run()).toEqual({ closed: 0, coreSynced: 0, casesOpened: 0 });
    r.clock.advance(60_000);
    expect(await r.tick.run()).toEqual({ closed: 0, coreSynced: 1, casesOpened: 0 });
    expect(r.core.calls).toEqual([
      { eventId, closedAtMs: R },
      { eventId, closedAtMs: R },
      { eventId, closedAtMs: R },
    ]);
    expect((await r.h.store.pendingCoreSync(100)).filter((p) => p.eventId === eventId)).toEqual([]);
    expect(await r.h.store.closedAt(eventId)).toBe(R);
  });

  test('O-T29 ⑥ core가 이미 다른 마감 시각을 돌려주면 자기 마감 시각은 그대로 두고 알린 것으로 적으며 경고 로그(entry-close.core-mismatch)를 남긴다', async () => {
    const r = await rig(R + 5);
    const { eventId } = await r.event(0);
    r.core.queue.push({ ok: true, storedAtMs: R - 1_000 });
    expect(await r.tick.run()).toEqual({ closed: 1, coreSynced: 1, casesOpened: 0 });
    expect(await r.h.store.closedAt(eventId)).toBe(R + 5);
    expect((await r.h.store.pendingCoreSync(100)).filter((p) => p.eventId === eventId)).toEqual([]);
    expect(r.log.lines.some((l) => l.startsWith('warn') && l.includes('entry-close.core-mismatch') && l.includes(eventId))).toBe(true);
  });

  test('O-T29 ⑥ core 판매 설정을 읽지 못하거나(던짐·undefined) ends_at이 없으면 그 회차는 마감하지 않고, 다른 회차는 마감한다. 되살리면 다음 판단에 마감한다', async () => {
    const r = await rig(R + 1_000);
    const ok = await r.event(0);
    const down = await r.event(0);
    const missing = await r.event(0);
    const noEnds = await r.event(0, { endsAtMs: undefined });
    r.policy.answers.set(down.eventId, 'throw');
    r.policy.answers.delete(missing.eventId);
    expect(await r.tick.run()).toMatchObject({ closed: 1 });
    expect(await r.h.store.closedAt(ok.eventId)).toBe(R + 1_000);
    for (const e of [down, missing, noEnds]) {
      expect(r.policy.asked, e.eventId).toContain(e.eventId);
      expect(await r.h.store.closedAt(e.eventId), e.eventId).toBeUndefined();
    }
    r.policy.answers.set(down.eventId, policyOf(ENDS));
    r.clock.advance(60_000);
    expect(await r.tick.run()).toMatchObject({ closed: 1 });
    expect(await r.h.store.closedAt(down.eventId)).toBe(R + 61_000);
    expect(await r.h.store.closedAt(missing.eventId)).toBeUndefined();
    expect(await r.h.store.closedAt(noEnds.eventId)).toBeUndefined();
  });

  test('O-T29 ⑥ ops가 503·accepted false로 답하면 건 행이 남아 다음 판단마다 같은 eventKey로 다시 보내고, 받은 뒤에는 보내지 않는다(결국 한 건)', async () => {
    const r = await rig(R + UNREPORTED_WAIT_MS);
    const { eventId, deviceIds } = await r.event(1);
    r.cases.queue.push(false, false);
    expect(await r.tick.run()).toEqual({ closed: 1, coreSynced: 1, casesOpened: 0 });
    expect((await r.h.store.pendingCases(100)).filter((c) => c.eventId === eventId)).toHaveLength(1);
    r.clock.advance(60_000);
    expect(await r.tick.run()).toEqual({ closed: 0, coreSynced: 0, casesOpened: 0 });
    r.clock.advance(60_000);
    expect(await r.tick.run()).toEqual({ closed: 0, coreSynced: 0, casesOpened: 1 });
    r.clock.advance(60_000);
    expect(await r.tick.run()).toEqual({ closed: 0, coreSynced: 0, casesOpened: 0 });
    expect(r.cases.bodies).toHaveLength(3);
    expect(new Set(r.cases.bodies.map((b) => b.eventKey))).toEqual(new Set([unreportedKey(eventId, deviceIds[0]!)]));
    // 다시 보낸 본문도 처음과 같다(createdAt·dueBaseAt은 마감 시각 그대로)
    for (const b of r.cases.bodies) expect(b).toEqual(r.cases.bodies[0]);
    expect((await r.h.store.pendingCases(100)).filter((c) => c.eventId === eventId)).toEqual([]);
  });

  test('O-T29 ⑥ core 알림이 던져도(연결 끊김) 판단은 다른 회차의 마감·건 보내기를 잇는다', async () => {
    const r = await rig(R + UNREPORTED_WAIT_MS);
    const a = await r.event(0);
    const b = await r.event(1);
    const thrower: EntryCloseCoreSink = {
      notify: async (eventId, closedAtMs) => {
        r.core.calls.push({ eventId, closedAtMs });
        throw new Error('core-svc 연결이 끊겼다(시험이 넣은 장애)');
      },
    };
    const { EntryCloseTick } = await loadTick();
    const tick = new EntryCloseTick({ store: r.h.store, policy: r.policy, core: thrower, cases: r.cases, clock: r.clock, log: r.log });
    expect(await tick.run()).toEqual({ closed: 2, coreSynced: 0, casesOpened: 1 });
    expect(r.core.calls.map((c) => c.eventId).sort()).toEqual([a.eventId, b.eventId].sort());
    expect((await r.h.store.pendingCoreSync(100)).map((p) => p.eventId).sort()).toEqual([a.eventId, b.eventId].sort());
    expect(r.cases.bodies.map((x) => x.sourceId)).toEqual([`${b.eventId}/${b.deviceIds[0]}`]);
  });
});
