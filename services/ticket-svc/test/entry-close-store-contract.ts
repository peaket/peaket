// 입장 기록 마감 저장소 계약(BUILD_ORDER GAT-180, O-T29 ①②④). 메모리 짝(test/entry-close-tick.test.ts)과
// 실제 PostgreSQL 어댑터(test-int/entry-close.int.test.ts)에 같은 시험을 돌린다(짝 가짜, peaket-test-antipatterns 원칙 3).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'(큐 비움 보고·로그인했던 기기·비웠다는 보고·판단·한 번만·미보고 스캐너 건),
// docs/data.md scanner_queue_report·entry_close·scanner_unreported_case, 계획 docs/review/plans/F-05-6.md §4 EntryCloseStore.
// 로그인했던 기기는 근무 준비 보고(ScannerShiftStore.reportReadiness), 배치는 ScannerShiftStore.putPlacement로 심는다(기존 포트).
// 공유 DB에서도 다른 시험의 회차와 섞이지 않게 회차 ID는 시험마다 새로 만들고, 후보 고르기 시험은 1990년대 회차 시작을 쓴다.
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { EntryCloseStore, ScannerShiftStore } from '../src/modules/scanner/domain/ports.js';

export interface EntryCloseHarness {
  readonly store: EntryCloseStore;
  /** 근무 준비 보고·기기 배치를 심는 기존 포트(같은 저장소 뒤를 본다) */
  readonly shifts: ScannerShiftStore;
  /** 그 회차의 티켓 하나를 발권 때 받은 회차 시작(ticket.event_starts_at)과 함께 심는다 */
  seedEvent(eventId: string, startsAtMs: number): Promise<void>;
}

/** 정본 '역할 유효 끝은 ends_at + 2시간' */
const ROLE_END_AFTER_ENDS_MS = 7_200_000;
/** 정본 '24시간 [가정]' */
const UNREPORTED_WAIT_MS = 86_400_000;
const ENDS = Date.parse('2026-11-23T12:17:43.219Z');
const R = ENDS + ROLE_END_AFTER_ENDS_MS;
const STARTS = ENDS - 3 * 3_600_000;
const STAFF = '0190f3a1-7c2e-7a00-8000-0000000f06ff';

const unreportedKey = (eventId: string, deviceId: string): string => {
  const h = createHash('sha256').update(`scanner-unreported:${eventId}:${deviceId}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

export function entryCloseStoreContract(name: string, make: () => Promise<EntryCloseHarness>): void {
  /** 회차 하나와 로그인한(근무 준비 보고) 배치 기기들 */
  async function eventWith(h: EntryCloseHarness, devices: number, o: { placed?: boolean } = {}): Promise<{ eventId: string; deviceIds: string[] }> {
    const eventId = randomUUID();
    await h.seedEvent(eventId, STARTS);
    const deviceIds: string[] = [];
    for (let n = 0; n < devices; n++) {
      const deviceId = randomUUID();
      if (o.placed !== false) await h.shifts.putPlacement({ eventId, deviceId, gateZone: '동문', mode: 'IN', setBy: STAFF, atMs: STARTS - 3_600_000, expectedVersion: 0 });
      await h.shifts.reportReadiness({ eventId, deviceId, packageSeq: 1, clockOffsetMs: 0, pendingUploads: 0, reportedBy: STAFF, atMs: STARTS - 1_800_000 });
      deviceIds.push(deviceId);
    }
    return { eventId, deviceIds };
  }

  const close = (h: EntryCloseHarness, eventId: string, nowMs: number, clockNow: () => number = () => nowMs) => h.store.close({ eventId, nowMs, endsAtMs: ENDS, clockNow });

  describe(`입장 기록 마감 저장소 계약 — ${name}`, () => {
    test('O-T29 ⑤ 배치가 없는 기기의 큐 보고는 no_placement이고 저장하지 않는다(그 뒤 판단에서 미보고), 배치된 뒤 보고는 stored다', async () => {
      const h = await make();
      const { eventId, deviceIds } = await eventWith(h, 1, { placed: false });
      const deviceId = deviceIds[0]!;
      expect(await h.store.putQueueReport({ eventId, deviceId, pendingUploads: 0, nowMs: R })).toBe('no_placement');
      expect(await close(h, eventId, R + 1)).toEqual({ closed: false, unreported: 0 });
      await h.shifts.putPlacement({ eventId, deviceId, gateZone: '동문', mode: 'IN', setBy: STAFF, atMs: R, expectedVersion: 0 });
      expect(await h.store.putQueueReport({ eventId, deviceId, pendingUploads: 0, nowMs: R + 2 })).toBe('stored');
      expect(await close(h, eventId, R + 3)).toEqual({ closed: true, reason: 'ALL_REPORTED', closedAtMs: R + 3, unreported: 0 });
    });

    test('O-T29 ① 기기·회차마다 마지막 보고 하나를 덮어쓴다(0 뒤 1이면 비우지 않음, 다시 0이면 비움). 같은 보고를 두 번 보내도 결과가 같다', async () => {
      const h = await make();
      const { eventId, deviceIds } = await eventWith(h, 1);
      const deviceId = deviceIds[0]!;
      expect(await h.store.putQueueReport({ eventId, deviceId, pendingUploads: 0, nowMs: R })).toBe('stored');
      expect(await h.store.putQueueReport({ eventId, deviceId, pendingUploads: 1, nowMs: R + 10 })).toBe('stored');
      expect(await close(h, eventId, R + 20)).toEqual({ closed: false, unreported: 0 });
      expect(await h.store.putQueueReport({ eventId, deviceId, pendingUploads: 0, nowMs: R + 30 })).toBe('stored');
      expect(await h.store.putQueueReport({ eventId, deviceId, pendingUploads: 0, nowMs: R + 30 })).toBe('stored');
      expect(await close(h, eventId, R + 40)).toEqual({ closed: true, reason: 'ALL_REPORTED', closedAtMs: R + 40, unreported: 0 });
    });

    test('O-T29 ⑤ 같은 기기의 값이 다른 보고 둘이 겹쳐도 둘 다 stored이고 던지지 않으며, 뒤의 판단은 둘 가운데 한 값대로다(10회, 시험 리뷰 RV-05)', async () => {
      const h = await make();
      for (let round = 0; round < 10; round++) {
        const { eventId, deviceIds } = await eventWith(h, 1);
        const deviceId = deviceIds[0]!;
        const results = await Promise.all([
          h.store.putQueueReport({ eventId, deviceId, pendingUploads: 0, nowMs: R + 1 }),
          h.store.putQueueReport({ eventId, deviceId, pendingUploads: 4, nowMs: R + 1 }),
        ]);
        expect(results, `회차 ${round}`).toEqual(['stored', 'stored']);
        const d = await close(h, eventId, R + 2);
        // 0이 남았으면 ALL_REPORTED로 마감, 4가 남았으면 대기 끝 전이라 마감 안 함. 그 밖의 답은 없다
        expect([JSON.stringify({ closed: true, reason: 'ALL_REPORTED', closedAtMs: R + 2, unreported: 0 }), JSON.stringify({ closed: false, unreported: 0 })], `회차 ${round}`).toContain(
          JSON.stringify(d.closed ? { closed: d.closed, reason: d.reason, closedAtMs: d.closedAtMs, unreported: d.unreported } : { closed: d.closed, unreported: d.unreported }),
        );
      }
    });

    test('O-T29 ① 역할 유효 끝 1ms 전에 받은 비움 보고는 세지 않는다(R 판단 미마감), 역할 유효 끝에 받은 보고는 센다', async () => {
      const h = await make();
      const early = await eventWith(h, 1);
      await h.store.putQueueReport({ eventId: early.eventId, deviceId: early.deviceIds[0]!, pendingUploads: 0, nowMs: R - 1 });
      expect(await close(h, early.eventId, R)).toEqual({ closed: false, unreported: 0 });
      const onTime = await eventWith(h, 1);
      await h.store.putQueueReport({ eventId: onTime.eventId, deviceId: onTime.deviceIds[0]!, pendingUploads: 0, nowMs: R });
      expect(await close(h, onTime.eventId, R)).toEqual({ closed: true, reason: 'ALL_REPORTED', closedAtMs: R, unreported: 0 });
    });

    test('O-T29 ① 로그인했던 기기가 없는 회차는 R−1ms 판단에 마감되지 않고 R 판단에 마감된다. 마감 시각은 잠금을 잡은 뒤 읽은 시각(clockNow)이다', async () => {
      const h = await make();
      const { eventId } = await eventWith(h, 0);
      expect(await close(h, eventId, R - 1)).toEqual({ closed: false, unreported: 0 });
      expect(await h.store.closedAt(eventId)).toBeUndefined();
      // 경계 판단은 nowMs로, 마감 시각은 clockNow로 한다(두 값을 다르게 골랐다)
      expect(await close(h, eventId, R, () => R + 7)).toEqual({ closed: true, reason: 'ALL_REPORTED', closedAtMs: R + 7, unreported: 0 });
      expect(await h.store.closedAt(eventId)).toBe(R + 7);
    });

    test('O-T29 ① 다른 회차의 근무 준비·보고는 이 회차 판단에 들지 않는다', async () => {
      const h = await make();
      const mine = await eventWith(h, 1);
      const other = await eventWith(h, 1);
      // 이 회차 기기가 다른 회차에 비움을 보고해도(배치가 없어 no_placement) 이 회차 보고가 아니다
      expect(await h.store.putQueueReport({ eventId: other.eventId, deviceId: mine.deviceIds[0]!, pendingUploads: 0, nowMs: R })).toBe('no_placement');
      expect(await h.store.putQueueReport({ eventId: other.eventId, deviceId: other.deviceIds[0]!, pendingUploads: 0, nowMs: R })).toBe('stored');
      expect(await close(h, mine.eventId, R + 1)).toEqual({ closed: false, unreported: 0 });
      expect(await close(h, other.eventId, R + 1)).toEqual({ closed: true, reason: 'ALL_REPORTED', closedAtMs: R + 1, unreported: 0 });
    });

    test('O-T29 ② 한 대 미보고면 R+86,400,000ms 1ms 전 미마감, 그때 TIMEOUT이고 미보고 건 행은 그 기기 하나뿐이다(eventKey·마감 시각)', async () => {
      const h = await make();
      const { eventId, deviceIds } = await eventWith(h, 2);
      const [reported, silent] = deviceIds as [string, string];
      await h.store.putQueueReport({ eventId, deviceId: reported, pendingUploads: 0, nowMs: R + 1 });
      expect(await close(h, eventId, R + UNREPORTED_WAIT_MS - 1)).toEqual({ closed: false, unreported: 0 });
      expect((await h.store.pendingCases(1000)).filter((c) => c.eventId === eventId)).toEqual([]);
      const at = R + UNREPORTED_WAIT_MS + 3;
      expect(await close(h, eventId, R + UNREPORTED_WAIT_MS, () => at)).toEqual({ closed: true, reason: 'TIMEOUT', closedAtMs: at, unreported: 1 });
      expect((await h.store.pendingCases(1000)).filter((c) => c.eventId === eventId)).toEqual([{ eventId, deviceId: silent, eventKey: unreportedKey(eventId, silent), createdAtMs: at }]);
    });

    test('O-T29 ② ALL_REPORTED 마감은 미보고 건 행을 만들지 않는다', async () => {
      const h = await make();
      const { eventId, deviceIds } = await eventWith(h, 2);
      for (const deviceId of deviceIds) await h.store.putQueueReport({ eventId, deviceId, pendingUploads: 0, nowMs: R + 5 });
      expect(await close(h, eventId, R + UNREPORTED_WAIT_MS + 10)).toMatchObject({ closed: true, reason: 'ALL_REPORTED', unreported: 0 });
      expect((await h.store.pendingCases(1000)).filter((c) => c.eventId === eventId)).toEqual([]);
    });

    test('O-T29 ④ 마감은 한 번만이다: 두 번째 close는 closed false이고 마감 시각·미보고 건 행이 그대로다', async () => {
      const h = await make();
      const { eventId, deviceIds } = await eventWith(h, 1);
      const first = R + UNREPORTED_WAIT_MS + 11;
      expect(await close(h, eventId, R + UNREPORTED_WAIT_MS, () => first)).toEqual({ closed: true, reason: 'TIMEOUT', closedAtMs: first, unreported: 1 });
      // 그 사이 기기가 보고했어도 두 번째 판단은 마감 행을 바꾸지 않는다
      await h.store.putQueueReport({ eventId, deviceId: deviceIds[0]!, pendingUploads: 0, nowMs: first + 1 });
      expect((await close(h, eventId, first + 2, () => first + 99)).closed).toBe(false);
      expect(await h.store.closedAt(eventId)).toBe(first);
      expect((await h.store.pendingCases(1000)).filter((c) => c.eventId === eventId)).toHaveLength(1);
    });

    test('O-T29 ④ 같은 저장소에서 같은 회차를 동시에 두 번 판단해도 마감 행·미보고 건 행은 하나씩이다', async () => {
      const h = await make();
      const { eventId, deviceIds } = await eventWith(h, 3);
      const results = await Promise.all([close(h, eventId, R + UNREPORTED_WAIT_MS), close(h, eventId, R + UNREPORTED_WAIT_MS)]);
      expect(results.filter((r) => r.closed)).toHaveLength(1);
      const cases = (await h.store.pendingCases(1000)).filter((c) => c.eventId === eventId);
      expect(cases.map((c) => c.deviceId).sort()).toEqual([...deviceIds].sort());
      expect(new Set(cases.map((c) => c.eventKey)).size).toBe(3);
    });

    test('O-T29 ⑥ core 알림 대기: 마감 행은 pendingCoreSync에 마감 시각과 함께 나오고 markCoreSynced 뒤 빠진다', async () => {
      const h = await make();
      const { eventId } = await eventWith(h, 0);
      await close(h, eventId, R, () => R + 21);
      expect((await h.store.pendingCoreSync(1000)).filter((p) => p.eventId === eventId)).toEqual([{ eventId, closedAtMs: R + 21 }]);
      await h.store.markCoreSynced(eventId, R + 60_000);
      expect((await h.store.pendingCoreSync(1000)).filter((p) => p.eventId === eventId)).toEqual([]);
      // 알린 뒤에도 마감 시각은 그대로다
      expect(await h.store.closedAt(eventId)).toBe(R + 21);
    });

    test('O-T29 ⑥ 미보고 건 대기: markCaseOpened는 그 기기 행만 빼고 같은 회차의 다른 기기 행은 남긴다', async () => {
      const h = await make();
      const { eventId, deviceIds } = await eventWith(h, 2);
      await close(h, eventId, R + UNREPORTED_WAIT_MS);
      await h.store.markCaseOpened(eventId, deviceIds[0]!, R + UNREPORTED_WAIT_MS + 1);
      expect((await h.store.pendingCases(1000)).filter((c) => c.eventId === eventId).map((c) => c.deviceId)).toEqual([deviceIds[1]]);
    });

    test('O-T29 ① 후보는 마감 행이 없고 회차 시작이 지금 이하인 회차를, 시작이 오래된 차례로 limit개까지 준다(시작 = 지금은 들고, 지금 + 1ms는 뺀다)', async () => {
      const h = await make();
      // 다른 시험의 회차(2026년)와 섞이지 않게 1990년대 시작을 쓴다
      const base = Date.parse('1991-03-04T05:06:07.089Z');
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const [e1, e2, e3, closedOne, future] = ids as [string, string, string, string, string];
      await h.seedEvent(e2, base + 2_000);
      await h.seedEvent(e1, base + 1_000);
      await h.seedEvent(closedOne, base + 500);
      await h.seedEvent(e3, base + 3_000);
      await h.seedEvent(future, base + 3_001);
      await h.store.close({ eventId: closedOne, nowMs: base + 10_000_000, endsAtMs: base, clockNow: () => base + 10_000_000 });
      const now = base + 3_000;
      expect(await h.store.candidates({ nowMs: now, limit: 2 })).toEqual([e1, e2]);
      expect(await h.store.candidates({ nowMs: now, limit: 50 })).toEqual([e1, e2, e3]);
    });
    test('O-T29 ① 돌아가며 보기: afterEventId를 주면 (회차 시작, 회차 ID) 차례에서 그 회차 다음부터 limit개를 주고, 시작이 같으면 회차 ID 차례다(시험 리뷰 RV-06)', async () => {
      const h = await make();
      // 앞 후보 시험(1991년)보다 이른 1989년 시작을 쓴다(공유 DB에서 그 시험의 회차가 섞이지 않게)
      const base = Date.parse('1989-07-08T09:10:11.012Z');
      // 시작이 같은 셋은 회차 ID 차례다(심는 차례는 거꾸로), 하나는 1ms 더 늦다
      const same = [randomUUID(), randomUUID(), randomUUID()];
      const ordered = [...same].sort();
      same.sort().reverse();
      const later = randomUUID();
      for (const id of same) await h.seedEvent(id, base);
      await h.seedEvent(later, base + 1);
      const now = base + 1;
      expect(await h.store.candidates({ nowMs: now, limit: 50 })).toEqual([...ordered, later]);
      expect(await h.store.candidates({ nowMs: now, limit: 2, afterEventId: ordered[0]! })).toEqual([ordered[1], ordered[2]]);
      expect(await h.store.candidates({ nowMs: now, limit: 2, afterEventId: ordered[2]! })).toEqual([later]);
      expect(await h.store.candidates({ nowMs: now, limit: 2, afterEventId: later })).toEqual([]);
    });
  });
}
