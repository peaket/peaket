// F-05-6 중복 입장 '몰랐음/알고도 통과'를 앞 기록 번호(state_seq)와 견주는 시험 — 메모리 짝(BUILD_ORDER GAT-180, O-T2 ①, 감사 C1-03).
// 정본: docs/features/offline-gate.md §7.1 '앞 기록 번호'(나중 기록의 knownSeq를 회차의 지금 마지막 번호가 아니라 정상으로 남은
// 가장 이른 기록의 state_seq와 견준다. knownSeq < state_seq면 CONCURRENT, ≥면 KNOWN. 늦게 올라온 더 이른 기록이 앞 기록을 내리면
// 내려간 기록은 새 정상의 state_seq로 견준다), §11 O-T2 ①, docs/data.md scan_event.state_seq.
// 같은 시험의 실제 PostgreSQL 쪽은 test-int/scanner-gate-awareness.int.test.ts다(state_seq가 빈 옛 행과 3,000건은 그쪽).
// 정상 기록의 state_seq는 바깥에서 본다: 그 기록으로 적힌 SCAN_STATE 변경의 일련번호(변경분 changes)다.
// 갈림이 '지금 마지막 번호'와 견주는 옛 동작과 다르게 나오도록, 나중 기록을 올리기 전에 다른 티켓 기록으로 회차 번호를 더 올려 둔다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f0621';
const DEVICE_A = '0190f3a1-7c2e-7a00-8000-0000000f0622';
const DEVICE_B = '0190f3a1-7c2e-7a00-8000-0000000f0623';

interface Rig {
  store: MemoryScannerGateStore;
  eventId: string;
  ticket(): string;
}

function rig(): Rig {
  const store = new MemoryScannerGateStore();
  const eventId = randomUUID();
  let n = 0;
  return {
    store,
    eventId,
    ticket() {
      const ticketId = randomUUID();
      store.seedTicket({ ticketId, eventId, seatId: `A-${++n}`, gateZone: '동문', status: 'ACTIVE' });
      return ticketId;
    },
  };
}

let deviceSeq = 0;
const scanOf = (eventId: string, ticketId: string, atMs: number, knownSeq: number): ScanEventInput => ({
  id: randomUUID(),
  eventId,
  ticketId,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone: '동문',
  scannedAtDevice: new Date(atMs).toISOString(),
  knownSeq,
  deviceSeq: ++deviceSeq,
});

const upload = (r: Rig, deviceId: string, scan: ScanEventInput) =>
  r.store.acceptScans({ eventId: r.eventId, deviceId, sessionId: SESSION, scans: [scan], nowMs: T0 + 600_000 });

/** 그 기록으로 적힌 SCAN_STATE 변경의 일련번호(= 그 기록의 state_seq) */
async function stateSeqOf(r: Rig, scan: ScanEventInput): Promise<number> {
  const c = await r.store.changes({ eventId: r.eventId, after: 0, limit: 10_000 });
  const hits = c.changes.filter((x) => x.kind === 'SCAN_STATE' && x.payload.ticketId === scan.ticketId && x.payload.scannedAtDevice === scan.scannedAtDevice);
  expect(hits, 'SCAN_STATE 변경 하나').toHaveLength(1);
  return hits[0]!.seq;
}

/** 다른 티켓 기록 셋으로 회차 마지막 번호를 올린다 */
async function bump(r: Rig): Promise<void> {
  for (let i = 0; i < 3; i++) await upload(r, DEVICE_A, scanOf(r.eventId, r.ticket(), T0 + i, 0));
}

describe('중복 입장 갈림의 앞 기록 번호(O-T2 ①, offline-gate §7.1)', () => {
  test('O-T2 ① 정상 기록 state_seq가 s일 때 나중 기록의 knownSeq가 s−1이면 CONCURRENT, s이면 KNOWN이다(회차 번호가 s보다 커진 뒤에도)', async () => {
    for (const [offset, awareness] of [
      [-1, 'CONCURRENT'],
      [0, 'KNOWN'],
    ] as const) {
      const r = rig();
      const ticketId = r.ticket();
      const first = scanOf(r.eventId, ticketId, T0, 0);
      expect((await upload(r, DEVICE_A, first)).flags).toEqual([]);
      const s = await stateSeqOf(r, first);
      await bump(r);
      const lastSeq = (await r.store.changes({ eventId: r.eventId, after: 0, limit: 10_000 })).lastSeq;
      expect(lastSeq, '회차 번호가 s보다 크다').toBeGreaterThan(s);
      const later = scanOf(r.eventId, ticketId, T0 + 60_000, s + offset);
      const res = await upload(r, DEVICE_B, later);
      expect(res.flags.map((f) => ({ ticketId: f.ticketId, kind: f.kind, awareness: f.awareness })), `knownSeq s${offset === 0 ? '' : offset}`).toEqual([{ ticketId, kind: 'DUPLICATE', awareness }]);
    }
  });

  /**
   * 내림 장면 하나: 새 회차에 늦은 기록(knownSeq k)을 먼저 올리고, 다른 티켓으로 번호를 올린 뒤(bump), 이른 기록을 올린다.
   * L = bump 뒤 회차 마지막 번호, sLate·sEarly = 두 기록의 state_seq(SCAN_STATE 번호). 회차마다 번호가 1부터라 같은 장면이면 L·sEarly − L이 같다
   */
  async function demotion(k: number) {
    const r = rig();
    const ticketId = r.ticket();
    const late = scanOf(r.eventId, ticketId, T0 + 60_000, k);
    expect((await upload(r, DEVICE_B, late)).flags).toEqual([]);
    const sLate = await stateSeqOf(r, late);
    await bump(r);
    const L = (await r.store.changes({ eventId: r.eventId, after: 0, limit: 10_000 })).lastSeq;
    const early = scanOf(r.eventId, ticketId, T0, 0);
    const res = await upload(r, DEVICE_A, early);
    const sEarly = await stateSeqOf(r, early);
    return { r, late, early, res, sLate, L, sEarly };
  }

  test('O-T2 ① 늦은 기록을 먼저 올린 뒤 이른 기록이 오면 정상이 바뀌고, 내려간 기록의 갈림은 새 정상의 state_seq로 본다: knownSeq가 s_late 이상·s_early 미만이면 CONCURRENT, s_early면 KNOWN(시험 리뷰 RV-02)', async () => {
    // 먼저 같은 장면을 한 번 돌려 번호를 잰다(knownSeq 값은 번호에 닿지 않는다)
    const probe = await demotion(0);
    expect(probe.L, '번호를 올렸다').toBeGreaterThan(probe.sLate);
    expect(probe.sEarly, '새 정상의 번호는 bump 뒤').toBeGreaterThan(probe.L);
    const gap = probe.sEarly - probe.L;
    for (const [k, awareness] of [
      // s_late ≤ k < s_early: 내려간 기록 자기 번호(s_late)와 견주는 틀린 구현과 지금 마지막 번호(L)와 견주는 옛 구현은 KNOWN을 낸다
      [probe.L + gap - 1, 'CONCURRENT'],
      [probe.L + gap, 'KNOWN'],
    ] as const) {
      const d = await demotion(k);
      // 장면이 같아 번호도 같다(다르면 이 시험의 고른 값이 무효다)
      expect({ L: d.L, sEarly: d.sEarly, sLate: d.sLate }, `k=${k}`).toEqual({ L: probe.L, sEarly: probe.sEarly, sLate: probe.sLate });
      expect(k, `k=${k}`).toBeGreaterThanOrEqual(d.sLate);
      expect(d.res.flags.map((f) => ({ ticketId: f.ticketId, kind: f.kind, awareness: f.awareness })), `k=${k}`).toEqual([{ ticketId: d.late.ticketId, kind: 'DUPLICATE', awareness }]);
      // 정상은 보정 시각이 가장 이른 기록이고 늦은 기록은 중복으로 내려갔다
      expect(d.r.store.scans.get(d.early.id)).toMatchObject({ result: 'PASS', flag: 'NONE' });
      expect(d.r.store.scans.get(d.late.id)).toMatchObject({ result: 'REJECT', reason: 'ALREADY_IN', flag: 'DUPLICATE' });
    }
  });

  test('O-T2 ① 가장 이른 정상 기록이 state_seq 없는 옛 행이면 나중 기록의 갈림은 CONCURRENT다(운영 PG와 같은 규칙, IR-06)', async () => {
    const r = rig();
    const ticketId = r.ticket();
    const first = scanOf(r.eventId, ticketId, T0, 0);
    expect((await upload(r, DEVICE_A, first)).flags).toEqual([]);
    // state_seq를 적기 전에 쌓인 옛 행처럼 심는다(운영은 scan_event.state_seq IS NULL)
    const stored = r.store.scans.get(first.id)!;
    expect(stored.stateSeq, '먼저 정상 기록의 state_seq를 확인한다').toBeTypeOf('number');
    delete stored.stateSeq;
    await bump(r);
    // 지금 마지막 번호로 물러나면 KNOWN이 되는 knownSeq를 골라 두 규칙을 가른다
    const lastSeq = (await r.store.changes({ eventId: r.eventId, after: 0, limit: 10_000 })).lastSeq;
    const later = scanOf(r.eventId, ticketId, T0 + 60_000, lastSeq);
    const res = await upload(r, DEVICE_B, later);
    expect(res.flags.map((f) => ({ ticketId: f.ticketId, kind: f.kind, awareness: f.awareness }))).toEqual([{ ticketId, kind: 'DUPLICATE', awareness: 'CONCURRENT' }]);
  });

  test('O-T2 ① 두 오프라인 스캐너(knownSeq 같음)의 1분 간격 중복은 올리는 차례를 바꿔도 표시 하나·정상은 이른 기록·나중 기록은 CONCURRENT다', async () => {
    for (const order of ['early-first', 'late-first'] as const) {
      const r = rig();
      const ticketId = r.ticket();
      const early = scanOf(r.eventId, ticketId, T0, 0);
      const late = scanOf(r.eventId, ticketId, T0 + 60_000, 0);
      const [a, b] = order === 'early-first' ? [early, late] : [late, early];
      const flags = [...(await upload(r, DEVICE_A, a)).flags, ...(await upload(r, DEVICE_B, b)).flags];
      expect(flags.map((f) => ({ kind: f.kind, awareness: f.awareness })), order).toEqual([{ kind: 'DUPLICATE', awareness: 'CONCURRENT' }]);
      expect(r.store.scans.get(early.id)?.result, order).toBe('PASS');
      expect(r.store.scans.get(late.id)?.result, order).toBe('REJECT');
    }
  });
});
